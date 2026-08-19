import assert from "node:assert/strict";
import test from "node:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import { createCursorStream, type CursorRuntime } from "./cursor-stream.js";

const model: Model<"cursor-sdk"> = {
	id: "grok-4.6",
	name: "Cursor Grok 4.6",
	api: "cursor-sdk",
	provider: "cursor",
	baseUrl: "https://cursor.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 256000,
	maxTokens: 16384,
};

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
};

test("streams Cursor text, thinking, and usage as Pi events", async () => {
	const runtime: CursorRuntime = {
		async run(request) {
			request.onDelta({ type: "thinking-delta", text: "Considering" });
			request.onDelta({ type: "thinking-completed", thinkingDurationMs: 10 });
			request.onDelta({ type: "text-delta", text: "Hello" });
			request.onDelta({
				type: "turn-ended",
				usage: {
					inputTokens: 10,
					outputTokens: 4,
					cacheReadTokens: 2,
					cacheWriteTokens: 0,
					reasoningTokens: 1,
				},
			});
			return { id: "run-1", status: "finished", result: "Hello" };
		},
	};

	const events = [];
	for await (const event of createCursorStream(runtime, model, context, { apiKey: "key", reasoning: "high" })) {
		events.push(event);
	}

	assert.deepEqual(events.map(({ type }) => type), [
		"start",
		"thinking_start",
		"thinking_delta",
		"thinking_end",
		"text_start",
		"text_delta",
		"text_end",
		"done",
	]);
	const final = events.at(-1);
	assert.equal(final?.type, "done");
	if (final?.type !== "done") return;
	assert.equal(final.message.content.at(-1)?.type, "text");
	assert.equal(final.message.usage.input, 8);
	assert.equal(final.message.usage.totalTokens, 14);
	assert.equal(final.message.usage.reasoning, 1);
});

test("reports cancellation as an aborted Pi message", async () => {
	const controller = new AbortController();
	const runtime: CursorRuntime = {
		async run() {
			controller.abort();
			return { id: "run-1", status: "cancelled" };
		},
	};

	const events = [];
	for await (const event of createCursorStream(runtime, model, context, {
		apiKey: "key",
		signal: controller.signal,
	})) {
		events.push(event);
	}

	const final = events.at(-1);
	assert.equal(final?.type, "error");
	if (final?.type !== "error") return;
	assert.equal(final.reason, "aborted");
	assert.equal(final.error.stopReason, "aborted");
});
