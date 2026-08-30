import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	CLIPROXYAPI_API_KEY as API_KEY,
	CLIPROXYAPI_BASE_URL as BASE_URL,
	CLIPROXYAPI_PROVIDER_ID as PROVIDER_ID,
} from "./cliproxyapi/client.ts";

const MODELS_URL = `${BASE_URL}/models`;
const CODEX_MODELS_URL = `${MODELS_URL}?client_version=pi`;
const API = "openai-responses";
const SOL_MODEL_ID = "gpt-5.6-sol";
const SOL_FAST_MODEL_ID = `${SOL_MODEL_ID}-fast`;
const PRIORITY_SERVICE_TIER = "priority";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const THINKING_LEVELS: readonly Exclude<ModelThinkingLevel, "off">[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

interface CLIProxyAPICatalogModel {
	id: string;
	name: string;
	reasoningLevels: Exclude<ModelThinkingLevel, "off">[];
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isThinkingLevel(value: string): value is Exclude<ModelThinkingLevel, "off"> {
	return (
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function parseReasoningLevels(value: unknown): Exclude<ModelThinkingLevel, "off">[] {
	if (!Array.isArray(value)) return [];

	const levels = new Set<Exclude<ModelThinkingLevel, "off">>();
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.effort !== "string" || !isThinkingLevel(entry.effort)) continue;
		levels.add(entry.effort);
	}
	return THINKING_LEVELS.filter((level) => levels.has(level));
}

function parseInputModalities(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) return ["text"];
	const input: ("text" | "image")[] = [];
	if (value.includes("text")) input.push("text");
	if (value.includes("image")) input.push("image");
	return input.length > 0 ? input : ["text"];
}

export function parseCLIProxyAPIReasoningCatalog(
	payload: unknown,
): ReadonlyMap<string, Exclude<ModelThinkingLevel, "off">[]> {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("CLIProxyAPI reasoning catalog response must contain a data array");
	}

	const models = new Map<string, Exclude<ModelThinkingLevel, "off">[]>();
	for (const entry of payload.data) {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
			throw new Error("CLIProxyAPI returned a reasoning model without a valid id");
		}
		if (!Array.isArray(entry.reasoning_efforts)) {
			models.set(entry.id, []);
			continue;
		}

		const levels = entry.reasoning_efforts.map((effort) =>
			isRecord(effort) && typeof effort.value === "string" ? { effort: effort.value } : effort,
		);
		models.set(entry.id, parseReasoningLevels(levels));
	}
	return models;
}

export function parseCLIProxyAPICatalog(
	payload: unknown,
	reasoningCatalog: ReadonlyMap<string, Exclude<ModelThinkingLevel, "off">[]> = new Map(),
): CLIProxyAPICatalogModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw new Error("CLIProxyAPI catalog response must contain a models array");
	}

	const models = new Map<string, CLIProxyAPICatalogModel>();
	for (const entry of payload.models) {
		if (!isRecord(entry) || typeof entry.slug !== "string" || entry.slug.length === 0) {
			throw new Error("CLIProxyAPI returned a catalog model without a valid slug");
		}
		if (entry.visibility === "hide" || entry.supported_in_api === false) continue;

		const contextWindow = positiveInteger(entry.context_window, 128_000);
		const maxTokens = positiveInteger(entry.max_tokens, Math.min(contextWindow, 65_536));
		models.set(entry.slug, {
			id: entry.slug,
			name:
				typeof entry.display_name === "string" && entry.display_name.length > 0
					? entry.display_name
					: entry.slug,
			reasoningLevels: reasoningCatalog.get(entry.slug) ?? [],
			input: parseInputModalities(entry.input_modalities),
			contextWindow,
			maxTokens: Math.min(maxTokens, contextWindow),
		});
	}

	if (models.size === 0) {
		throw new Error("CLIProxyAPI returned no visible inference models");
	}
	return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function thinkingLevelMap(levels: readonly Exclude<ModelThinkingLevel, "off">[]): ThinkingLevelMap {
	const supported = new Set(levels);
	const result: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		result[level] = supported.has(level) ? level : null;
	}
	return result;
}

export function toProviderModel(model: CLIProxyAPICatalogModel): ProviderModelConfig {
	const reasoning = model.reasoningLevels.length > 0;
	return {
		id: model.id,
		name: `${model.name} via CLIProxyAPI`,
		reasoning,
		...(reasoning ? { thinkingLevelMap: thinkingLevelMap(model.reasoningLevels) } : {}),
		input: model.input,
		cost: ZERO_COST,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export function addSolFastVariant(
	models: readonly ProviderModelConfig[],
): ProviderModelConfig[] {
	const modelIds = new Set(models.map((model) => model.id));
	return models.flatMap((model) => {
		if (model.id !== SOL_MODEL_ID || modelIds.has(SOL_FAST_MODEL_ID)) return [model];
		return [model, { ...model, id: SOL_FAST_MODEL_ID, name: `${model.name} (Fast)` }];
	});
}

export function rewriteCLIProxyAPIFastRequest(payload: unknown, modelId: string): unknown {
	if (modelId !== SOL_FAST_MODEL_ID) return payload;
	if (!isRecord(payload)) {
		throw new Error("CLIProxyAPI Fast Mode request payload must be an object");
	}
	return {
		...payload,
		model: SOL_MODEL_ID,
		service_tier: PRIORITY_SERVICE_TIER,
	};
}

function fallbackModel(
	id: string,
	name: string,
	contextWindow: number,
	maxTokens: number,
	reasoningLevels: Exclude<ModelThinkingLevel, "off">[],
): ProviderModelConfig {
	return toProviderModel({
		id,
		name,
		reasoningLevels,
		input: ["text", "image"],
		contextWindow,
		maxTokens,
	});
}

const FALLBACK_MODELS = addSolFastVariant([
	fallbackModel(SOL_MODEL_ID, "GPT 5.6 Sol", 272_000, 128_000, ["low", "medium", "high", "xhigh", "max"]),
	fallbackModel("gpt-5.6-luna", "GPT 5.6 Luna", 272_000, 128_000, ["low", "medium", "high", "xhigh", "max"]),
	fallbackModel("gpt-5.6-terra", "GPT 5.6 Terra", 272_000, 128_000, ["low", "medium", "high", "xhigh", "max"]),
	fallbackModel("grok-4.6", "Grok 4.6", 500_000, 65_536, ["low", "medium", "high", "xhigh"]),
]);

async function fetchCatalog(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		throw new Error(`CLIProxyAPI model request failed with HTTP ${response.status}`);
	}
	return response.json();
}

async function fetchModels(signal: AbortSignal): Promise<ProviderModelConfig[]> {
	const headers = {
		accept: "application/json",
		authorization: `Bearer ${API_KEY}`,
	};
	const [catalogPayload, reasoningPayload] = await Promise.all([
		fetchCatalog(CODEX_MODELS_URL, headers, signal),
		fetchCatalog(MODELS_URL, { ...headers, "user-agent": "grok-shell/pi" }, signal),
	]);
	const reasoningCatalog = parseCLIProxyAPIReasoningCatalog(reasoningPayload);
	return addSolFastVariant(
		parseCLIProxyAPICatalog(catalogPayload, reasoningCatalog).map(toProviderModel),
	);
}

export default async function cliProxyAPIModels(pi: ExtensionAPI): Promise<void> {
	let models = FALLBACK_MODELS;
	try {
		models = await fetchModels(AbortSignal.timeout(5_000));
	} catch (error) {
		console.warn(
			`CLIProxyAPI model discovery failed during startup; using the default catalog: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	pi.registerProvider(PROVIDER_ID, {
		name: "CLIProxyAPI",
		baseUrl: BASE_URL,
		apiKey: API_KEY,
		api: API,
		models,
	});

	pi.on("before_provider_request", (event, context) => {
		if (context.model?.provider !== PROVIDER_ID) return;
		return rewriteCLIProxyAPIFastRequest(event.payload, context.model.id);
	});
}
