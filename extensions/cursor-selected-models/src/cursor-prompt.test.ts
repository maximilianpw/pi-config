import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { buildCursorPrompt } from "./cursor-prompt.js";

test("serializes Pi instructions and conversation into a Cursor prompt", () => {
	const context: Context = {
		systemPrompt: "Follow the repository rules.",
		messages: [
			{ role: "user", content: "Inspect the project", timestamp: 1 },
			{
				role: "assistant",
				api: "cursor-sdk",
				provider: "cursor",
				model: "grok-4.6",
				content: [{ type: "text", text: "I found the entry point." }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "Fix it", timestamp: 3 },
		],
	};

	const prompt = buildCursorPrompt(context);
	assert.match(prompt.text, /System instructions:\nFollow the repository rules\./);
	assert.match(prompt.text, /<user>\nInspect the project/);
	assert.match(prompt.text, /<assistant>\nI found the entry point\./);
	assert.match(prompt.text, /<user>\nFix it/);
	assert.equal(prompt.images, undefined);
});

test("forwards Pi images to the Cursor SDK", () => {
	const prompt = buildCursorPrompt({
		messages: [{
			role: "user",
			content: [
				{ type: "text", text: "Describe this" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			timestamp: 1,
		}],
	});

	assert.deepEqual(prompt.images, [{ data: "aGVsbG8=", mimeType: "image/png" }]);
});
