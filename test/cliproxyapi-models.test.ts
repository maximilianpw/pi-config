import assert from "node:assert/strict";
import test from "node:test";
import {
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
