import type { ModelSelection } from "@cursor/sdk";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const BASE_MODEL_ID = "grok-4.6";
const CONTEXT_WINDOW = 256_000;
const MAX_TOKENS = 16_384;
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const THINKING_LEVELS = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
} as const;

function model(id: string, name: string): ProviderModelConfig {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: THINKING_LEVELS,
		input: ["text", "image"],
		cost: COST,
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_TOKENS,
	};
}

export const CURSOR_MODELS: ProviderModelConfig[] = [
	model(BASE_MODEL_ID, "Cursor Grok 4.6"),
	model(`${BASE_MODEL_ID}:fast`, "Cursor Grok 4.6 (fast)"),
	model(`${BASE_MODEL_ID}:slow`, "Cursor Grok 4.6 (slow)"),
];

export function resolveCursorModelSelection(
	piModelId: string,
	reasoning: ThinkingLevel | undefined,
): ModelSelection {
	const params: NonNullable<ModelSelection["params"]> = [];
	if (reasoning === "low" || reasoning === "medium" || reasoning === "high" || reasoning === "xhigh") {
		params.push({ id: "effort", value: reasoning });
	}
	if (piModelId.endsWith(":fast")) params.push({ id: "fast", value: "true" });
	if (piModelId.endsWith(":slow")) params.push({ id: "fast", value: "false" });
	return { id: BASE_MODEL_ID, params };
}
