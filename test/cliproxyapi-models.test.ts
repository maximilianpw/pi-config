import assert from "node:assert/strict";
import test from "node:test";
import {
	createAssistantMessageEventStream,
	getModels,
	registerApiProvider,
	resetApiProviders,
	streamSimple as streamSimpleByApi,
} from "@earendil-works/pi-ai/compat";
import {
	generateSummaryWithUsage,
	type ExtensionAPI,
	type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import cliProxyAPIModels, {
	addSolFastVariant,
	parseCLIProxyAPICatalog,
	parseCLIProxyAPIReasoningCatalog,
	rewriteCLIProxyAPIFastRequest,
	toProviderModel,
} from "../extensions/cliproxyapi-models.ts";

const grokCatalogEntry = {
	slug: "grok-4.6",
	display_name: "Grok 4.6",
	context_window: 500_000,
	max_tokens: 65_536,
	input_modalities: ["text", "image"],
	visibility: "list",
	supported_in_api: true,
};

const reasoningCatalog = parseCLIProxyAPIReasoningCatalog({
	data: [
		{
			id: "grok-4.6",
			reasoning_efforts: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
		},
		{ id: "gpt-5.6-sol", reasoning_efforts: [{ value: "high" }, { value: "max" }, { value: "ultra" }] },
	],
});

test("parses, deduplicates, and sorts visible CLIProxyAPI inference models", () => {
	assert.deepEqual(
		parseCLIProxyAPICatalog({
			models: [
				grokCatalogEntry,
				{
					slug: "gpt-5.6-sol",
					display_name: "GPT 5.6 Sol",
					context_window: 272_000,
					max_tokens: 128_000,
					input_modalities: ["text", "image"],
					visibility: "list",
					supported_in_api: true,
				},
				grokCatalogEntry,
				{ slug: "gpt-image-2", visibility: "hide", supported_in_api: true },
				{ slug: "disabled-model", visibility: "list", supported_in_api: false },
			],
		}, reasoningCatalog),
		[
			{
				id: "gpt-5.6-sol",
				name: "GPT 5.6 Sol",
				reasoningLevels: ["high", "max"],
				input: ["text", "image"],
				contextWindow: 272_000,
				maxTokens: 128_000,
			},
			{
				id: "grok-4.6",
				name: "Grok 4.6",
				reasoningLevels: ["low", "medium", "high", "xhigh"],
				input: ["text", "image"],
				contextWindow: 500_000,
				maxTokens: 65_536,
			},
		],
	);
});

test("adds a Fast Mode variant for Sol only", () => {
	const models = addSolFastVariant(
		parseCLIProxyAPICatalog(
			{
				models: [
					{
						slug: "gpt-5.6-sol",
						display_name: "GPT 5.6 Sol",
						visibility: "list",
					},
					{
						slug: "gpt-5.6-terra",
						display_name: "GPT 5.6 Terra",
						visibility: "list",
					},
				],
			},
			reasoningCatalog,
		).map(toProviderModel),
	);
	assert.deepEqual(
		models.map((model) => model.id),
		["gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-terra"],
	);
	assert.equal(models[1]?.name, "GPT 5.6 Sol via CLIProxyAPI (Fast)");
});

const TEST_ENVIRONMENT = {
	CLIPROXYAPI_ROOT_URL: "https://cliproxy.example.test",
	CLIPROXYAPI_API_KEY: "test-key",
};

function registerForTest(): ProviderConfig {
	let providerConfig: ProviderConfig | undefined;
	const recordingApi = {
		registerProvider(_providerName: string, config: ProviderConfig) {
			providerConfig = config;
		},
	};
	// SAFETY: The extension uses only registerProvider; this recording API supplies that operation.
	cliProxyAPIModels(recordingApi as unknown as ExtensionAPI, TEST_ENVIRONMENT);
	assert.ok(providerConfig);
	return providerConfig;
}

type RefreshContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];

function refreshContext(overrides: Partial<RefreshContext>): RefreshContext {
	// SAFETY: refreshModels reads only allowNetwork, stored, signal, and publish.
	return {
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async () => true,
		...overrides,
	} as RefreshContext;
}

function stubCatalogFetch(): () => number {
	let calls = 0;
	globalThis.fetch = async (input) => {
		calls++;
		return Response.json(
			String(input).includes("client_version=pi")
				? { models: [grokCatalogEntry] }
				: { data: [{ id: "grok-4.6", reasoning_efforts: [{ value: "high" }] }] },
		);
	};
	return () => calls;
}

test("registers without network access so startup never waits on CLIProxyAPI", () => {
	const originalFetch = globalThis.fetch;
	const fetchCalls = stubCatalogFetch();
	try {
		registerForTest();
		assert.equal(fetchCalls(), 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("startup refresh serves the stored catalog, or the fallback, without fetching", async () => {
	const { refreshModels } = registerForTest();
	assert.ok(refreshModels);
	const originalFetch = globalThis.fetch;
	const fetchCalls = stubCatalogFetch();
	try {
		const storedModel = {
			...getModels("openai")[0]!,
			provider: "cliproxyapi",
			id: "stored-model",
			baseUrl: "https://old-endpoint.example.test/v1",
		};
		const otherProvider = { ...storedModel, provider: "openai", id: "foreign" };
		const fromStore = await refreshModels(refreshContext({ stored: { models: [storedModel, otherProvider] } }));
		assert.deepEqual(fromStore.map((model) => model.id), ["stored-model"]);
		// A stored model must follow the current connection, not the endpoint it was fetched from.
		assert.equal(fromStore[0]?.baseUrl, "https://cliproxy.example.test/v1");

		const fromFallback = await refreshModels(refreshContext({}));
		assert.ok(fromFallback.some((model) => model.id === "gpt-6.1-sol"));
		assert.equal(fetchCalls(), 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("network refresh fetches the live catalog and persists it for the next launch", async () => {
	const { refreshModels } = registerForTest();
	assert.ok(refreshModels);
	const originalFetch = globalThis.fetch;
	const fetchCalls = stubCatalogFetch();
	const published: unknown[] = [];
	try {
		const models = await refreshModels(refreshContext({
			allowNetwork: true,
			publish: async (publication) => {
				published.push(publication);
				return true;
			},
		}));
		assert.deepEqual(models.map((model) => model.id), ["grok-4.6"]);
		assert.equal(fetchCalls(), 2);
		assert.equal(published.length, 1);
		const { persist } = published[0] as { persist: { models: Array<Record<string, unknown>> } };
		assert.equal(persist.models[0]?.id, "grok-4.6");
		assert.equal(persist.models[0]?.provider, "cliproxyapi");
		assert.equal(persist.models[0]?.baseUrl, "https://cliproxy.example.test/v1");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("registers the configured GPT-6.1, GPT-6, and Grok models from the fallback catalog", () => {
	const providerConfig = registerForTest();
	const registeredModels = providerConfig.models ?? [];
	for (const [id, name, contextWindow, maxTokens] of [
		["gpt-6-astra", "GPT 6.0 Astra via CLIProxyAPI", 272_000, 128_000],
		["gpt-6-luna", "GPT 6.0 Luna via CLIProxyAPI", 272_000, 128_000],
		["gpt-6-sol", "GPT 6.0 Sol via CLIProxyAPI", 272_000, 128_000],
		["gpt-6.1-sol", "GPT 6.1 Sol via CLIProxyAPI", 500_000, 128_000],
		["grok-4.7", "Grok 4.7 via CLIProxyAPI", 500_000, 65_536],
	] as const) {
		const fallback = registeredModels.find((candidate) => candidate.id === id);
		assert.ok(fallback);
		assert.ok(fallback.type === undefined || fallback.type === "chat");
		assert.equal(fallback.name, name);
		assert.equal(fallback.contextWindow, contextWindow);
		assert.equal(fallback.maxTokens, maxTokens);
		assert.deepEqual(fallback.thinkingLevelMap, {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: id.startsWith("grok-") ? null : "max",
		});
	}
});

test("does not infer Fast Mode support for newer Sol models", () => {
	const models = ["gpt-6-sol", "gpt-6.1-sol"].map((slug) => {
		const [catalogModel] = parseCLIProxyAPICatalog({ models: [{ slug }] });
		assert.ok(catalogModel);
		return toProviderModel(catalogModel);
	});
	assert.deepEqual(addSolFastVariant(models), models);
	const payload = { model: "gpt-6.1-sol", input: "hello" };
	assert.equal(rewriteCLIProxyAPIFastRequest(payload, "gpt-6.1-sol"), payload);
});

test("rewrites Sol Fast requests to the priority service tier", () => {
	const payload = { model: "gpt-5.6-sol-fast", input: "hello" };
	assert.deepEqual(rewriteCLIProxyAPIFastRequest(payload, "gpt-5.6-sol-fast"), {
		model: "gpt-5.6-sol",
		input: "hello",
		service_tier: "priority",
	});
	assert.equal(rewriteCLIProxyAPIFastRequest(payload, "gpt-5.6-sol"), payload);
	assert.throws(
		() => rewriteCLIProxyAPIFastRequest("invalid", "gpt-5.6-sol-fast"),
		/payload must be an object/,
	);
});

test("compaction rewrites Sol Fast to the upstream model and priority tier", async () => {
	const providerConfig = registerForTest();
	const baseModel = getModels("openai")[0];
	assert.ok(baseModel);
	const fastModel = {
		...baseModel,
		provider: "cliproxyapi",
		id: "gpt-5.6-sol-fast",
		name: "GPT 5.6 Sol via CLIProxyAPI (Fast)",
	};
	const streamFn = providerConfig.streamSimple ?? streamSimpleByApi;
	let observedPayload: Readonly<Record<string, unknown>> | undefined;
	const fakeOpenAIStream = (model: typeof fastModel, _context: unknown, options: {
		readonly onPayload?: (payload: unknown, model: typeof fastModel) => unknown;
	} = {}) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const initialPayload = { model: model.id };
			const transformed = await options.onPayload?.(initialPayload, model) ?? initialPayload;
			assert.equal(typeof transformed, "object");
			assert.ok(transformed);
			observedPayload = transformed as Readonly<Record<string, unknown>>;
			const usage = {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			if (observedPayload.model === fastModel.id) {
				stream.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage,
						stopReason: "error",
						errorMessage: "unknown provider for model gpt-5.6-sol-fast",
						timestamp: 2,
					},
				});
			} else {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "summary" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage,
						stopReason: "stop",
						timestamp: 2,
					},
				});
			}
			stream.end();
		})();
		return stream;
	};
	// SAFETY: The fake implements the provider stream contract used by the compaction helper.
	const streamOpenAI = fakeOpenAIStream as Parameters<typeof registerApiProvider>[0]["streamSimple"];
	registerApiProvider({
		api: "openai-responses",
		stream: streamOpenAI,
		streamSimple: streamOpenAI,
	}, "cliproxyapi-fast-compaction-test");
	try {
		const result = await generateSummaryWithUsage(
			[{ role: "user", content: "Summarize this", timestamp: 1 }],
			fastModel,
			1_000,
			"test-key",
			undefined,
			new AbortController().signal,
			undefined,
			undefined,
			"off",
			streamFn,
		);

		assert.equal(result.text, "summary");
		assert.equal(observedPayload?.model, "gpt-5.6-sol");
		assert.equal(observedPayload?.service_tier, "priority");
	} finally {
		resetApiProviders();
	}
});

test("rejects malformed or empty CLIProxyAPI catalog responses", () => {
	assert.throws(() => parseCLIProxyAPIReasoningCatalog({ models: [] }), /data array/);
	assert.throws(() => parseCLIProxyAPICatalog({ models: [{ display_name: "missing slug" }] }), /valid slug/);
	assert.throws(() => parseCLIProxyAPICatalog({ data: [] }), /models array/);
	assert.throws(
		() => parseCLIProxyAPICatalog({ models: [{ slug: "hidden", visibility: "hide" }] }),
		/no visible inference models/,
	);
});

test("maps Grok using CLIProxyAPI's declared capabilities", () => {
	const [catalogModel] = parseCLIProxyAPICatalog({ models: [grokCatalogEntry] }, reasoningCatalog);
	assert.ok(catalogModel);
	const model = toProviderModel(catalogModel);

	assert.equal(model.id, "grok-4.6");
	assert.equal(model.name, "Grok 4.6 via CLIProxyAPI");
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.thinkingLevelMap, {
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	});
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.contextWindow, 500_000);
	assert.equal(model.maxTokens, 65_536);
});

test("uses conservative defaults when optional catalog metadata is absent", () => {
	const [catalogModel] = parseCLIProxyAPICatalog({ models: [{ slug: "plain-model", visibility: "list" }] });
	assert.ok(catalogModel);
	const model = toProviderModel(catalogModel);

	assert.equal(model.reasoning, false);
	assert.deepEqual(model.input, ["text"]);
	assert.equal(model.contextWindow, 128_000);
	assert.equal(model.maxTokens, 65_536);
});

test("clamps output tokens to the declared context window", () => {
	const [catalogModel] = parseCLIProxyAPICatalog({
		models: [{ slug: "small-model", context_window: 1_000, max_tokens: 2_000, visibility: "list" }],
	});
	assert.ok(catalogModel);
	assert.equal(catalogModel.maxTokens, 1_000);
});
