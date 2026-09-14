import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { latestAssistantMarkdown } from "../shared/latest-assistant-markdown.ts";
import { createCloudflareAccessTokenProvider, type CloudflaredExecutor } from "./cloudflared-access-token.ts";
import { parseServiceOrigin } from "./config.ts";
import { CfPasteError } from "./errors.ts";
import { createMarkdownPasteClient, type MarkdownPasteClient, type PublicationExpiry } from "./markdown-paste-client.ts";
import { createPlannotatorReviewer, type PlannotatorReviewer, type ReviewDecision } from "./plannotator-review.ts";
import { failure, type Result, success } from "./result.ts";

const MAX_MARKDOWN_BYTES = 1_048_576;
function isPublicationExpiry(value: string): value is PublicationExpiry {
	return value === "1d" || value === "7d" || value === "30d" || value === "90d" || value === "never";
}

export interface CfPasteExtensionOptions {
	readonly client?: MarkdownPasteClient;
	readonly reviewer?: PlannotatorReviewer;
}

function validatedMarkdown(bytes: Uint8Array): Result<string, CfPasteError> {
	if (bytes.byteLength > MAX_MARKDOWN_BYTES) return failure(new CfPasteError("validation", "CF Paste Markdown exceeds 1 MiB"));
	let markdown: string;
	try {
		markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (cause) {
		return failure(new CfPasteError("validation", "CF Paste requires valid UTF-8 Markdown", cause));
	}
	return markdown.trim() === "" ? failure(new CfPasteError("validation", "CF Paste requires non-empty Markdown")) : success(markdown);
}

function markdownPath(argument: string, cwd: string): Result<{ readonly path: string; readonly title: string; readonly markdown: string; readonly bytes: Uint8Array }, CfPasteError> | Promise<Result<{ readonly path: string; readonly title: string; readonly markdown: string; readonly bytes: Uint8Array }, CfPasteError>> {
	const pathArgument = argument.trim().replace(/^@/u, "");
	if (pathArgument === "") return failure(new CfPasteError("validation", "Usage: /cf-paste <markdown-file>"));
	const path = resolve(cwd, pathArgument);
	const extension = extname(path).toLowerCase();
	if (extension !== ".md" && extension !== ".markdown") return failure(new CfPasteError("validation", "CF Paste supports only .md and .markdown files"));
	return readFile(path).then((bytes) => {
		const validated = validatedMarkdown(bytes);
		return validated.ok ? success({ path, title: basename(path), markdown: validated.value, bytes }) : validated;
	}).catch((cause) => failure(new CfPasteError("validation", `Could not read Markdown file ${path}`, cause)));
}

function latestMarkdown(ctx: ExtensionCommandContext): Result<string, CfPasteError> {
	const markdown = latestAssistantMarkdown(ctx.sessionManager.getBranch());
	if (markdown === undefined) return failure(new CfPasteError("validation", "No assistant response is available"));
	const validated = validatedMarkdown(new TextEncoder().encode(markdown));
	return validated;
}

function interactive(ctx: ExtensionCommandContext): boolean {
	return ctx.mode === "tui" && ctx.hasUI;
}

function notifyFailure(ctx: ExtensionCommandContext, error: CfPasteError): void {
	ctx.ui.notify(error.message, error.reason === "validation" ? "warning" : "error");
}

function sendReviewFeedback(pi: ExtensionAPI, decision: ReviewDecision, ctx: ExtensionCommandContext): boolean {
	if (decision.decision === "annotated") {
		pi.sendUserMessage(decision.feedback);
		return true;
	}
	if (decision.decision === "dismissed") {
		ctx.ui.notify("Review dismissed; nothing was uploaded", "info");
		return true;
	}
	if (decision.approvalNotes !== undefined && decision.approvalNotes.trim() !== "") ctx.ui.notify(decision.approvalNotes, "info");
	return false;
}

function makeClient(pi: ExtensionAPI): Result<MarkdownPasteClient, CfPasteError> {
	const privateOrigin = parseServiceOrigin(process.env.CFPASTE_PRIVATE_ORIGIN);
	if (!privateOrigin.ok) return privateOrigin;
	const publicOrigin = process.env.CFPASTE_PUBLIC_ORIGIN === undefined ? undefined : parseServiceOrigin(process.env.CFPASTE_PUBLIC_ORIGIN, "CFPASTE_PUBLIC_ORIGIN");
	if (publicOrigin !== undefined && !publicOrigin.ok) return publicOrigin;
	const executor: CloudflaredExecutor = {
		async execute(args, options) {
			const result = await pi.exec("cloudflared", [...args], { timeout: options.timeout, ...(options.signal === undefined ? {} : { signal: options.signal }) });
			return { stdout: result.stdout, code: result.code };
		},
	};
	return success(createMarkdownPasteClient({ privateOrigin: privateOrigin.value, ...(publicOrigin?.ok === true ? { publicOrigin: publicOrigin.value } : {}), tokenProvider: createCloudflareAccessTokenProvider(executor, privateOrigin.value.origin) }));
}

async function upload(client: MarkdownPasteClient, input: { readonly markdown: string; readonly title: string; readonly sourceFilename: string | null; readonly provenance: "pi" | "plannotator-approved"; readonly publish: PublicationExpiry | null }, ctx: ExtensionCommandContext): Promise<void> {
	const result = await client.createDocument({ ...input, idempotencyKey: crypto.randomUUID(), interactive: interactive(ctx), ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) });
	if (!result.ok) return notifyFailure(ctx, result.error);
	if (result.value.publicUrl !== null) ctx.ui.notify(`Published Markdown: ${result.value.publicUrl}\nPrivate Document: ${result.value.privateUrl}`, "info");
	else ctx.ui.notify(`Created Markdown Document: ${result.value.privateUrl}`, "info");
}

export function createCfPasteExtension(options: CfPasteExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		const reviewer = options.reviewer ?? createPlannotatorReviewer();
		const client = () => options.client === undefined ? makeClient(pi) : success(options.client);

		pi.registerCommand("cf-paste", {
			description: "Create a private CF Paste Document from Markdown",
			handler: async (args, ctx) => {
				await ctx.waitForIdle();
				const source = await markdownPath(args, ctx.cwd);
				if (!source.ok) return notifyFailure(ctx, source.error);
				const resolvedClient = client();
				if (!resolvedClient.ok) return notifyFailure(ctx, resolvedClient.error);
				await upload(resolvedClient.value, { markdown: source.value.markdown, title: source.value.title, sourceFilename: source.value.title, provenance: "pi", publish: null }, ctx);
			},
		});

		pi.registerCommand("cf-paste-last", {
			description: "Create a private CF Paste Document from the latest assistant response",
			handler: async (_args, ctx) => {
				await ctx.waitForIdle();
				const source = latestMarkdown(ctx);
				if (!source.ok) return notifyFailure(ctx, source.error);
				const resolvedClient = client();
				if (!resolvedClient.ok) return notifyFailure(ctx, resolvedClient.error);
				await upload(resolvedClient.value, { markdown: source.value, title: "Pi agent response", sourceFilename: null, provenance: "pi", publish: null }, ctx);
			},
		});

		pi.registerCommand("cf-review", {
			description: "Review a Markdown file before private upload",
			handler: async (args, ctx) => {
				await ctx.waitForIdle();
				const source = await markdownPath(args, ctx.cwd);
				if (!source.ok) return notifyFailure(ctx, source.error);
				const reviewed = await reviewer.reviewFile(source.value.bytes, ctx.signal);
				if (!reviewed.ok) return notifyFailure(ctx, reviewed.error);
				if (sendReviewFeedback(pi, reviewed.value, ctx)) return;
				if (reviewed.value.decision !== "approved") return;
				const resolvedClient = client();
				if (!resolvedClient.ok) return notifyFailure(ctx, resolvedClient.error);
				await upload(resolvedClient.value, { markdown: reviewed.value.markdown, title: source.value.title, sourceFilename: source.value.title, provenance: "plannotator-approved", publish: null }, ctx);
			},
		});

		pi.registerCommand("cf-review-last", {
			description: "Review the latest assistant response before private upload",
			handler: async (_args, ctx) => {
				await ctx.waitForIdle();
				const source = latestMarkdown(ctx);
				if (!source.ok) return notifyFailure(ctx, source.error);
				const reviewed = await reviewer.reviewLatest(source.value, ctx.signal);
				if (!reviewed.ok) return notifyFailure(ctx, reviewed.error);
				if (sendReviewFeedback(pi, reviewed.value, ctx)) return;
				if (reviewed.value.decision !== "approved") return;
				const resolvedClient = client();
				if (!resolvedClient.ok) return notifyFailure(ctx, resolvedClient.error);
				await upload(resolvedClient.value, { markdown: reviewed.value.markdown, title: "Pi agent response", sourceFilename: null, provenance: "plannotator-approved", publish: null }, ctx);
			},
		});

		pi.registerCommand("publish-last", {
			description: "Review and publish the latest assistant response",
			handler: async (args, ctx) => {
				await ctx.waitForIdle();
				const token = args.trim() === "" ? "30d" : args.trim();
				if (!isPublicationExpiry(token)) return ctx.ui.notify("Usage: /publish-last [1d|7d|30d|90d|never]", "warning");
				const source = latestMarkdown(ctx);
				if (!source.ok) return notifyFailure(ctx, source.error);
				const reviewed = await reviewer.reviewLatest(source.value, ctx.signal);
				if (!reviewed.ok) return notifyFailure(ctx, reviewed.error);
				if (sendReviewFeedback(pi, reviewed.value, ctx)) return;
				if (reviewed.value.decision !== "approved") return;
				const resolvedClient = client();
				if (!resolvedClient.ok) return notifyFailure(ctx, resolvedClient.error);
				await upload(resolvedClient.value, { markdown: reviewed.value.markdown, title: "Pi agent response", sourceFilename: null, provenance: "plannotator-approved", publish: token }, ctx);
			},
		});
	};
}

export default createCfPasteExtension();
