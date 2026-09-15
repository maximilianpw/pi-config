import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CfPasteError } from "./errors.ts";
import { failure, type Result, success } from "./result.ts";

export interface ProcessExecutor {
	execute(command: string, args: readonly string[], options: { readonly input?: Uint8Array; readonly signal?: AbortSignal }): Promise<{ readonly stdout: string; readonly code: number }>;
}

export type ReviewDecision =
	| { readonly decision: "approved"; readonly markdown: string; readonly approvalNotes?: string }
	| { readonly decision: "annotated"; readonly feedback: string }
	| { readonly decision: "dismissed" };

export interface PlannotatorReviewer {
	reviewFile(bytes: Uint8Array, signal?: AbortSignal): Promise<Result<ReviewDecision, CfPasteError>>;
	reviewLatest(markdown: string, signal?: AbortSignal): Promise<Result<ReviewDecision, CfPasteError>>;
}

export const processExecutor: ProcessExecutor = {
	execute(command, args, options) {
		return new Promise((resolve, reject) => {
			const child = spawn(command, [...args], { shell: false, stdio: ["pipe", "pipe", "ignore"], ...(options.signal === undefined ? {} : { signal: options.signal }) });
			let stdout = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => { stdout += chunk; });
			child.once("error", reject);
			child.once("close", (code) => resolve({ stdout, code: code ?? 2 }));
			if (options.input === undefined) child.stdin.end();
			else child.stdin.end(options.input);
		});
	},
};

function parseDecision(stdout: string): Result<{ readonly decision: "approved" | "annotated" | "dismissed"; readonly feedback?: string; readonly approvalNotes?: string }, CfPasteError> {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch (cause) {
		return failure(new CfPasteError("invalid-response", "Plannotator returned invalid decision JSON", cause));
	}
	if (typeof value !== "object" || value === null || !("decision" in value)) return failure(new CfPasteError("invalid-response", "Plannotator returned a malformed decision"));
	const decision = value.decision;
	if (decision !== "approved" && decision !== "annotated" && decision !== "dismissed") return failure(new CfPasteError("invalid-response", "Plannotator returned an unknown decision"));
	const feedback = "feedback" in value && typeof value.feedback === "string" ? value.feedback : undefined;
	const approvalNotes = "approvalNotes" in value && typeof value.approvalNotes === "string" ? value.approvalNotes : undefined;
	if (decision === "annotated" && (feedback === undefined || feedback.trim() === "")) return failure(new CfPasteError("invalid-response", "Plannotator annotation decision omitted feedback"));
	return success({ decision, ...(feedback === undefined ? {} : { feedback }), ...(approvalNotes === undefined ? {} : { approvalNotes }) });
}

function decodeUtf8(bytes: Uint8Array): Result<string, CfPasteError> {
	try {
		return success(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (cause) {
		return failure(new CfPasteError("validation", "Reviewed Markdown is not valid UTF-8", cause));
	}
}

function isCancelled(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

export function createPlannotatorReviewer(executor: ProcessExecutor = processExecutor): PlannotatorReviewer {
	return {
		async reviewFile(bytes, signal) {
			if (isCancelled(signal)) return failure(new CfPasteError("rejected-response", "Plannotator review was cancelled"));
			let directory: string | undefined;
			try {
				directory = await mkdtemp(join(tmpdir(), "pi-cfpaste-review-"));
				const sourcePath = join(directory, "review.md");
				const resultPath = join(directory, "decision.json");
				await writeFile(sourcePath, bytes, { flag: "wx", mode: 0o600 });
				const process = await executor.execute("plannotator", ["annotate", sourcePath, "--gate", "--json", "--require-approval", "--result-file", resultPath], { ...(signal === undefined ? {} : { signal }) });
				if (isCancelled(signal)) return failure(new CfPasteError("rejected-response", "Plannotator review was cancelled"));
				if (process.code === 2) return failure(new CfPasteError("rejected-response", "Plannotator could not start the approval gate"));
				if (process.code !== 0 && process.code !== 1) return failure(new CfPasteError("invalid-response", "Plannotator review returned an unexpected exit status"));
				const parsed = parseDecision(process.stdout);
				if (!parsed.ok) return parsed;
				const expectedCode = parsed.value.decision === "approved" ? 0 : 1;
				if (process.code !== expectedCode) return failure(new CfPasteError("invalid-response", "Plannotator decision did not match its exit status"));
				if (parsed.value.decision === "dismissed") return success({ decision: "dismissed" });
				if (parsed.value.decision === "annotated") return success({ decision: "annotated", feedback: parsed.value.feedback ?? "" });
				const reviewed = decodeUtf8(await readFile(sourcePath));
				if (!reviewed.ok) return reviewed;
				const approvalNotes = parsed.value.approvalNotes ?? parsed.value.feedback;
				return success({ decision: "approved", markdown: reviewed.value, ...(approvalNotes === undefined ? {} : { approvalNotes }) });
			} catch (cause) {
				return failure(new CfPasteError("rejected-response", "Plannotator review failed", cause));
			} finally {
				if (directory !== undefined) await rm(directory, { recursive: true, force: true });
			}
		},
		async reviewLatest(markdown, signal) {
			if (isCancelled(signal)) return failure(new CfPasteError("rejected-response", "Plannotator review was cancelled"));
			const bytes = new TextEncoder().encode(markdown);
			try {
				const process = await executor.execute("plannotator", ["annotate-last", "--stdin", "--gate", "--json"], { input: bytes, ...(signal === undefined ? {} : { signal }) });
				if (isCancelled(signal)) return failure(new CfPasteError("rejected-response", "Plannotator review was cancelled"));
				if (process.code === 2) return failure(new CfPasteError("rejected-response", "Plannotator could not start the approval gate"));
				if (process.code !== 0 && process.code !== 1) return failure(new CfPasteError("invalid-response", "Plannotator review returned an unexpected exit status"));
				const parsed = parseDecision(process.stdout);
				if (!parsed.ok) return parsed;
				if (parsed.value.decision === "dismissed") return success({ decision: "dismissed" });
				if (parsed.value.decision === "annotated") return success({ decision: "annotated", feedback: parsed.value.feedback ?? "" });
				if (process.code !== 0) return failure(new CfPasteError("invalid-response", "Plannotator approval returned an inconsistent exit status"));
				const approvalNotes = parsed.value.approvalNotes ?? parsed.value.feedback;
				return success({ decision: "approved", markdown, ...(approvalNotes === undefined ? {} : { approvalNotes }) });
			} catch (cause) {
				return failure(new CfPasteError("rejected-response", "Plannotator review failed", cause));
			}
		},
	};
}
