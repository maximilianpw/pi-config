import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MODELS, resolveCursorModelSelection } from "./cursor-model.js";

test("publishes only Grok 4.6 variants", () => {
	assert.deepEqual(CURSOR_MODELS.map(({ id }) => id), [
		"grok-4.6",
		"grok-4.6:fast",
		"grok-4.6:slow",
	]);
});

test("maps Pi variants and thinking levels to Cursor model parameters", () => {
	assert.deepEqual(resolveCursorModelSelection("grok-4.6", "high"), {
		id: "grok-4.6",
		params: [{ id: "effort", value: "high" }],
	});
	assert.deepEqual(resolveCursorModelSelection("grok-4.6:fast", "high"), {
		id: "grok-4.6",
		params: [
			{ id: "effort", value: "high" },
			{ id: "fast", value: "true" },
		],
	});
	assert.deepEqual(resolveCursorModelSelection("grok-4.6:slow", "xhigh"), {
		id: "grok-4.6",
		params: [
			{ id: "effort", value: "xhigh" },
			{ id: "fast", value: "false" },
		],
	});
});
