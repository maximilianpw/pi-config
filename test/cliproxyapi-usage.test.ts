import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	formatCLIProxyAPIQuotaReport,
	getCLIProxyAPIQuotaReport,
} from "../cli/cliproxyapi-quota.ts";
import {
	createCLIProxyAPIClient,
	createRemoteCLIProxyAPIQuotaClient,
	parseClaudeQuota,
	parseCodexQuota,
	parseXAIQuota,
	quotaProviderForModel,
	resolveCLIProxyAPIConnection,
	type CLIProxyAPIClient,
	type CLIProxyAPIModelQuota,
} from "../extensions/cliproxyapi/client.ts";
import { formatCLIProxyAPIQuotaText } from "../extensions/cliproxyapi-usage.ts";
import { createCLIProxyAPIQuotaHandler } from "../cli/cliproxyapi-quota-server.ts";

test("requires explicit CLIProxyAPI routing instead of falling back to localhost", () => {
	assert.throws(
		() => resolveCLIProxyAPIConnection({}, { configFilePath: null }),
		/requires CLIPROXYAPI_ROOT_URL; refusing to fall back to a localhost proxy/,
	);
	assert.throws(
		() => resolveCLIProxyAPIConnection(
			{ CLIPROXYAPI_ROOT_URL: "https://proxy.example.test" },
			{ configFilePath: null },
		),
		/requires CLIPROXYAPI_API_KEY or CLIPROXYAPI_API_KEY_FILE/,
	);
});

test("resolves an explicit CLIProxyAPI endpoint and runtime token file", () => {
	assert.deepEqual(
		resolveCLIProxyAPIConnection({}, {
			configFilePath: "/home/test/.config/cliproxyapi/client.json",
			readTextFile: (path) => {
				if (path === "/home/test/.config/cliproxyapi/client.json") {
					return JSON.stringify({
						rootUrl: "https://proxy.example.test/",
						apiKeyFile: "/run/secrets/cliproxyapi-key",
					});
				}
				assert.equal(path, "/run/secrets/cliproxyapi-key");
				return "test-key\n";
			},
		}),
		{
			rootUrl: "https://proxy.example.test",
			baseUrl: "https://proxy.example.test/v1",
			apiKey: "test-key",
		},
	);
});

function codexQuota(usedPercent: number, allowed = true) {
	return {
		rate_limit: {
			allowed,
			limit_reached: !allowed,
			primary_window: {
				used_percent: usedPercent,
				limit_window_seconds: 604_800,
				reset_at: 1_788_454_137,
			},
			secondary_window: null,
		},
	};
}

test("maps CLIProxyAPI model families to their quota providers", () => {
	assert.equal(quotaProviderForModel("gpt-5.6-sol"), "codex");
	assert.equal(quotaProviderForModel("gpt-5.6-sol-fast"), "codex");
	assert.equal(quotaProviderForModel("o3"), "codex");
	assert.equal(quotaProviderForModel("grok-4.6"), "xai");
	assert.equal(quotaProviderForModel("claude-opus-5"), "claude");
	assert.equal(quotaProviderForModel("kimi-k3"), null);
});

test("parses Codex quota windows by their declared duration", () => {
	assert.deepEqual(
		parseCodexQuota({
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 42,
					limit_window_seconds: 604_800,
					reset_at: 1_788_454_137,
				},
				secondary_window: {
					used_percent: 17.5,
					limit_window_seconds: 18_000,
					reset_at: 1_787_878_502,
				},
			},
		}),
		{
			ready: true,
			windows: [
				{ label: "5h", usedPercent: 17.5, resetAtMs: 1_787_878_502_000 },
				{ label: "7d", usedPercent: 42, resetAtMs: 1_788_454_137_000 },
			],
		},
	);
});

test("marks exhausted Codex quota as unavailable", () => {
	assert.equal(parseCodexQuota(codexQuota(100, false)).ready, false);
});

test("parses Claude session and weekly usage", () => {
	assert.deepEqual(
		parseClaudeQuota({
			five_hour: {
				utilization: 49,
				resets_at: "2026-08-27T23:19:59.813Z",
			},
			seven_day: {
				utilization: 41,
				resets_at: "2026-08-30T16:59:59.813Z",
			},
		}),
		{
			ready: true,
			windows: [
				{
					label: "5h",
					usedPercent: 49,
					resetAtMs: Date.parse("2026-08-27T23:19:59.813Z"),
				},
				{
					label: "7d",
					usedPercent: 41,
					resetAtMs: Date.parse("2026-08-30T16:59:59.813Z"),
				},
			],
		},
	);
});

test("marks Claude unavailable when any active quota window is exhausted", () => {
	assert.equal(
		parseClaudeQuota({
			five_hour: { utilization: 100 },
			seven_day: { utilization: 41 },
		}).ready,
		false,
	);
});

test("parses xAI weekly billing usage", () => {
	assert.deepEqual(
		parseXAIQuota({
			config: {
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					start: "2026-08-24T12:11:40.078Z",
					end: "2026-08-31T12:11:40.078Z",
				},
				creditUsagePercent: 83.25,
			},
		}),
		{
			ready: true,
			windows: [
				{
					label: "7d",
					usedPercent: 83.25,
					resetAtMs: Date.parse("2026-08-31T12:11:40.078Z"),
				},
			],
		},
	);
});

test("uses the least-used ready credential from a CLIProxyAPI account pool", async () => {
	const authDirectory = await mkdtemp(join(tmpdir(), "cliproxyapi-usage-"));
	try {
		await Promise.all([
			writeFile(
				join(authDirectory, "ready.json"),
				JSON.stringify({
					type: "codex",
					access_token: "ready-token",
					account_id: "ready-account",
				}),
			),
			writeFile(
				join(authDirectory, "exhausted.json"),
				JSON.stringify({
					type: "codex",
					access_token: "exhausted-token",
					account_id: "exhausted-account",
				}),
			),
		]);

		let requests = 0;
		const fakeFetch: typeof fetch = async (_input, init) => {
			requests += 1;
			const headers = new Headers(init?.headers);
			const accountId = headers.get("chatgpt-account-id");
			return Response.json(
				accountId === "ready-account" ? codexQuota(5) : codexQuota(100, false),
			);
		};
		const client = createCLIProxyAPIClient({
			authDirectory,
			fetch: fakeFetch,
			now: () => 123_456,
		});

		const quota = await client.getModelQuota("gpt-5.6-sol");
		assert.deepEqual(quota, {
			provider: "codex",
			windows: [{ label: "7d", usedPercent: 5, resetAtMs: 1_788_454_137_000 }],
			readyAccounts: 1,
			totalAccounts: 2,
			fetchedAtMs: 123_456,
		});
		assert.equal(requests, 2);

		await client.getModelQuota("gpt-5.6-luna");
		assert.equal(requests, 2, "same-provider quota should use the short-lived cache");
	} finally {
		await rm(authDirectory, { recursive: true, force: true });
	}
});

test("remote quota uses the proxy credential, not stale local OAuth files", async () => {
	const quota = {
		provider: "codex",
		windows: [{ label: "7d", usedPercent: 42, resetAtMs: null }],
		readyAccounts: 1,
		totalAccounts: 2,
		fetchedAtMs: 123,
	} satisfies CLIProxyAPIModelQuota;
	const handler = createCLIProxyAPIQuotaHandler({
		async getModelQuota(modelId) {
			assert.equal(modelId, "gpt-5.6-sol");
			return quota;
		},
	});
	const client = createRemoteCLIProxyAPIQuotaClient(
		{ rootUrl: "https://proxy.example.test", baseUrl: "https://proxy.example.test/v1", apiKey: "proxy-key" },
		async (input, init) => {
			assert.equal(input, "https://proxy.example.test/quota/v1/codex");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer proxy-key");
			return handler(new Request(String(input)));
		},
	);
	assert.deepEqual(await client.getModelQuota("gpt-5.6-sol"), quota);
	assert.equal((await handler(new Request("http://localhost/quota/v1/codex", { method: "POST" }))).status, 404);
});

test("remote quota rejects errors and malformed replies instead of falling back to local credentials", async () => {
	const connection = { rootUrl: "https://proxy.example.test", baseUrl: "https://proxy.example.test/v1", apiKey: "proxy-key" };
	for (const response of [new Response(null, { status: 503 }), Response.json({ provider: "codex", windows: [] })]) {
		const client = createRemoteCLIProxyAPIQuotaClient(connection, async () => response);
		await assert.rejects(client.getModelQuota("gpt-5.6-sol"));
	}
});

test("builds a deterministic routing quota report", async () => {
	const client: CLIProxyAPIClient = {
		async getModelQuota(modelId) {
			if (modelId.startsWith("grok-")) {
				return {
					provider: "xai",
					windows: [{ label: "7d", usedPercent: 100, resetAtMs: null }],
					readyAccounts: 0,
					totalAccounts: 1,
					fetchedAtMs: 0,
				};
			}
			if (modelId.startsWith("claude-")) {
				return {
					provider: "claude",
					windows: [
						{ label: "5h", usedPercent: 49, resetAtMs: null },
						{ label: "7d", usedPercent: 41, resetAtMs: null },
					],
					readyAccounts: 1,
					totalAccounts: 1,
					fetchedAtMs: 0,
				};
			}
			return {
				provider: "codex",
				windows: [{ label: "7d", usedPercent: 5, resetAtMs: null }],
				readyAccounts: 1,
				totalAccounts: 2,
				fetchedAtMs: 0,
			};
		},
	};

	const report = await getCLIProxyAPIQuotaReport(client);
	assert.deepEqual(report, {
		version: 1,
		families: [
			{
				family: "codex",
				status: "available",
				usedPercent: 5,
				readyAccounts: 1,
				totalAccounts: 2,
			},
			{
				family: "claude",
				status: "available",
				usedPercent: 49,
				readyAccounts: 1,
				totalAccounts: 1,
			},
			{
				family: "grok",
				status: "unavailable",
				usedPercent: 100,
				readyAccounts: 0,
				totalAccounts: 1,
			},
		],
	});
	assert.equal(
		formatCLIProxyAPIQuotaReport(report),
		[
			"family  status       usage  accounts",
			"codex   available    5%     1/2",
			"claude  available    49%    1/1",
			"grok    unavailable  100%   0/1",
		].join("\n"),
	);
});

test("formats a compact footer status", () => {
	assert.equal(
		formatCLIProxyAPIQuotaText({
			provider: "codex",
			windows: [
				{ label: "5h", usedPercent: 12, resetAtMs: null },
				{ label: "7d", usedPercent: 44.5, resetAtMs: null },
			],
			readyAccounts: 1,
			totalAccounts: 2,
			fetchedAtMs: 0,
		}),
		"quota 44.5% · 1/2 ready",
	);
});
