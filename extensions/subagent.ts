import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

async function writeTempPrompt(text: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-minimal-subagent-"));
	const file = path.join(dir, "system-prompt.md");
	await fs.promises.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
	return { dir, file };
}

function finalTextFromMessage(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

async function runSubagent(params: {
	task: string;
	systemPrompt?: string;
	model?: string;
	tools?: string[];
	cwd: string;
	signal?: AbortSignal;
}): Promise<{ output: string; stderr: string; exitCode: number }> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (params.model) args.push("--model", params.model);
	if (params.tools && params.tools.length > 0) args.push("--tools", params.tools.join(","));

	let tmp: { dir: string; file: string } | undefined;
	try {
		const systemPrompt = [
			"You are a delegated Pi subagent running in an isolated context.",
			"Complete the task independently. Return only the final result that the parent agent needs.",
			params.systemPrompt?.trim() ? `\nAdditional instructions:\n${params.systemPrompt.trim()}` : "",
		]
			.filter(Boolean)
			.join("\n");
		tmp = await writeTempPrompt(systemPrompt);
		args.push("--append-system-prompt", tmp.file, params.task);

		const invocation = getPiInvocation(args);
		let stderr = "";
		let buffer = "";
		let output = "";
		let aborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: params.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end") {
						const text = finalTextFromMessage(event.message);
						if (text) output = text;
					}
				} catch {
					// Ignore non-JSON noise.
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			const kill = () => {
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000).unref?.();
			};

			if (params.signal?.aborted) kill();
			else params.signal?.addEventListener("abort", kill, { once: true });
		});

		if (aborted) throw new Error("Subagent was aborted");
		return { output, stderr, exitCode };
	} finally {
		if (tmp) {
			await fs.promises.rm(tmp.dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a self-contained task to an isolated Pi subagent. The parent receives only the final answer, not intermediate context. Defaults to read-only tools; pass tools explicitly for edit/bash/write access.",
		promptSnippet: "Delegate self-contained research or implementation subtasks to an isolated Pi subagent",
		promptGuidelines: [
			"Use subagent for self-contained tasks where only the final result is needed and intermediate context would be noisy.",
			"The subagent tool defaults to read-only access; pass tools explicitly when the delegated task needs bash, edit, or write.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete task for the isolated subagent." }),
			systemPrompt: Type.Optional(Type.String({ description: "Optional extra instructions for the subagent." })),
			model: Type.Optional(Type.String({ description: "Optional Pi model id for the subagent." })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Tools to enable for the subagent. Defaults to ["read"]. Use e.g. ["read", "bash"] or ["read", "edit", "write", "bash"].',
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent. Defaults to the current Pi cwd." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runSubagent({
				task: params.task,
				systemPrompt: params.systemPrompt,
				model: params.model,
				tools: params.tools ?? ["read"],
				cwd: params.cwd ?? ctx.cwd,
				signal,
			});

			if (result.exitCode !== 0) {
				return {
					isError: true,
					content: [{ type: "text", text: result.stderr || `Subagent exited with code ${result.exitCode}.` }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: result.output || "(subagent produced no final text)" }],
				details: result,
			};
		},
	});
}
