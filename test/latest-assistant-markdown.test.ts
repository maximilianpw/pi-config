import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { latestAssistantMarkdown } from "../extensions/shared/latest-assistant-markdown.ts";

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

test("latest assistant Markdown is branch-aware and concatenates text blocks only", () => {
	const sessions = SessionManager.inMemory("/tmp");
	const active = sessions.appendMessage(assistantMessage([
		{ type: "thinking", thinking: "hidden" },
		{ type: "text", text: "# Active" },
		{ type: "image", data: "ignored", mimeType: "image/png" },
		{ type: "text", text: "Second paragraph" },
	]));
	sessions.appendMessage(assistantMessage([{ type: "text", text: "# Abandoned" }]));
	sessions.branch(active);

	assert.equal(latestAssistantMarkdown(sessions.getBranch()), "# Active\n\nSecond paragraph");
});
