import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	type ExtensionActions,
	type ExtensionContextActions,
} from "@earendil-works/pi-coding-agent";

import type { CreateMarkdownDocumentInput, MarkdownPasteClient } from "../markdown-paste-client.ts";
import type { PlannotatorReviewer } from "../plannotator-review.ts";
import { success } from "../result.ts";

const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "cfpaste-test-extension.ts");

function assistant(markdown: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "thinking", thinking: "excluded" }, { type: "text", text: markdown }], api: "anthropic-messages", provider: "anthropic", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 };
}

function bindRunnerActions(runner: ExtensionRunner, feedback: string[]): void {
	runner.bindCore({
		sendMessage: () => undefined,
		sendUserMessage: (content) => feedback.push(typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("")),
		appendEntry: () => undefined,
		setSessionName: () => undefined,
		getSessionName: () => undefined,
		setLabel: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => undefined,
		refreshTools: () => undefined,
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => undefined,
	} satisfies ExtensionActions, {
		getModel: () => undefined,
		getScopedModels: () => [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
	} satisfies ExtensionContextActions);
}

test("/publish-last gates the exact active-branch Markdown and atomically requests a Publication", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-cfpaste-command-"));
	const inputs: CreateMarkdownDocumentInput[] = [];
	const previousPublicOrigin = process.env.CFPASTE_PUBLIC_ORIGIN;
	try {
		process.env.CFPASTE_PUBLIC_ORIGIN = "https://public.example";
		globalThis.cfpasteTestClient = { async createDocument(input) { inputs.push(input); return success({ documentId: "abcdefghijklmnopqrstuv", revisionId: "bcdefghijklmnopqrstuvw", publicationId: "cdefghijklmnopqrstuvwx", privateUrl: "https://private.example/documents/abcdefghijklmnopqrstuv", rawUrl: "https://private.example/documents/abcdefghijklmnopqrstuv/raw", downloadUrl: "https://private.example/documents/abcdefghijklmnopqrstuv/download", publicUrl: "https://public.example/cdefghijklmnopqrstuvwx" }); } } satisfies MarkdownPasteClient;
		let reviewed = "";
		globalThis.cfpasteTestReviewer = { reviewFile: async () => success({ decision: "dismissed" }), reviewLatest: async (markdown) => { reviewed = markdown; return success({ decision: "approved", markdown }); } } satisfies PlannotatorReviewer;
		const sessions = SessionManager.inMemory(cwd);
		const active = sessions.appendMessage(assistant("# Active"));
		sessions.appendMessage(assistant("# Abandoned"));
		sessions.branch(active);
		const loaded = await discoverAndLoadExtensions([extensionPath], cwd, join(cwd, ".agent"));
		assert.deepEqual(loaded.errors, []);
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessions, new ModelRegistry(runtime));
		const command = runner.getCommand("publish-last");
		assert.ok(command);
		await command.handler("7d", runner.createCommandContext());
		assert.equal(reviewed, "# Active");
		assert.equal(inputs.length, 1);
		assert.equal(inputs[0]?.markdown, "# Active");
		assert.equal(inputs[0]?.publish, "7d");
		assert.equal(inputs[0]?.provenance, "plannotator-approved");
		assert.match(inputs[0]?.idempotencyKey ?? "", /^[0-9a-f-]{36}$/u);
	} finally {
		if (previousPublicOrigin === undefined) delete process.env.CFPASTE_PUBLIC_ORIGIN;
		else process.env.CFPASTE_PUBLIC_ORIGIN = previousPublicOrigin;
		globalThis.cfpasteTestClient = undefined;
		globalThis.cfpasteTestReviewer = undefined;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("/publish-last rejects missing or invalid public configuration before review or upload", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-cfpaste-command-config-"));
	const previousPublicOrigin = process.env.CFPASTE_PUBLIC_ORIGIN;
	let reviews = 0;
	let uploads = 0;
	try {
		globalThis.cfpasteTestClient = {
			async createDocument() {
				uploads += 1;
				throw new Error("upload must not run");
			},
		} satisfies MarkdownPasteClient;
		globalThis.cfpasteTestReviewer = {
			reviewFile: async () => success({ decision: "dismissed" }),
			reviewLatest: async (markdown) => {
				reviews += 1;
				return success({ decision: "approved", markdown });
			},
		} satisfies PlannotatorReviewer;
		const sessions = SessionManager.inMemory(cwd);
		sessions.appendMessage(assistant("# Review me"));
		const loaded = await discoverAndLoadExtensions([extensionPath], cwd, join(cwd, ".agent"));
		assert.deepEqual(loaded.errors, []);
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessions, new ModelRegistry(runtime));
		const publishLast = runner.getCommand("publish-last");
		assert.ok(publishLast);

		delete process.env.CFPASTE_PUBLIC_ORIGIN;
		await publishLast.handler("30d", runner.createCommandContext());
		process.env.CFPASTE_PUBLIC_ORIGIN = "http://public.example";
		await publishLast.handler("30d", runner.createCommandContext());

		assert.equal(reviews, 0);
		assert.equal(uploads, 0);
	} finally {
		if (previousPublicOrigin === undefined) delete process.env.CFPASTE_PUBLIC_ORIGIN;
		else process.env.CFPASTE_PUBLIC_ORIGIN = previousPublicOrigin;
		globalThis.cfpasteTestClient = undefined;
		globalThis.cfpasteTestReviewer = undefined;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("commands never upload annotations or dismissals, validate expiry first, and preserve file bytes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-cfpaste-command-safety-"));
	const inputs: CreateMarkdownDocumentInput[] = [];
	const feedback: string[] = [];
	let latestReviews = 0;
	try {
		globalThis.cfpasteTestClient = { async createDocument(input) {
			inputs.push(input);
			return success({ documentId: "abcdefghijklmnopqrstuv", revisionId: "bcdefghijklmnopqrstuvw", publicationId: null, privateUrl: "https://private.example/documents/abcdefghijklmnopqrstuv", rawUrl: "https://private.example/documents/abcdefghijklmnopqrstuv/raw", downloadUrl: "https://private.example/documents/abcdefghijklmnopqrstuv/download", publicUrl: null });
		} } satisfies MarkdownPasteClient;
		globalThis.cfpasteTestReviewer = {
			reviewFile: async () => success({ decision: "dismissed" }),
			reviewLatest: async () => {
				latestReviews += 1;
				return success({ decision: "annotated", feedback: "Clarify the conclusion." });
			},
		} satisfies PlannotatorReviewer;
		const sessions = SessionManager.inMemory(cwd);
		sessions.appendMessage(assistant("# Review me"));
		const loaded = await discoverAndLoadExtensions([extensionPath], cwd, join(cwd, ".agent"));
		assert.deepEqual(loaded.errors, []);
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessions, new ModelRegistry(runtime));
		bindRunnerActions(runner, feedback);

		const reviewLast = runner.getCommand("cf-review-last");
		assert.ok(reviewLast);
		await reviewLast.handler("", runner.createCommandContext());
		assert.equal(inputs.length, 0);
		assert.deepEqual(feedback, ["Clarify the conclusion."]);

		const publishLast = runner.getCommand("publish-last");
		assert.ok(publishLast);
		await publishLast.handler("2d", runner.createCommandContext());
		assert.equal(latestReviews, 1, "invalid expiry must not open a review gate");
		assert.equal(inputs.length, 0);

		const bytes = new TextEncoder().encode("# Exact bytes\n\nTrailing spaces stay.  \n");
		await writeFile(join(cwd, "exact.md"), bytes);
		const paste = runner.getCommand("cf-paste");
		assert.ok(paste);
		await paste.handler("exact.md", runner.createCommandContext());
		assert.equal(inputs.length, 1);
		assert.equal(inputs[0]?.markdown, new TextDecoder().decode(bytes));
		assert.equal(inputs[0]?.title, "exact.md");
	} finally {
		globalThis.cfpasteTestClient = undefined;
		globalThis.cfpasteTestReviewer = undefined;
		await rm(cwd, { recursive: true, force: true });
	}
});
