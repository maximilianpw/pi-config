import assert from "node:assert/strict";
import test from "node:test";
import {
	createRemoteCLIProxyAPIQuotaClient,
	quotaProviderForModel,
	resolveCLIProxyAPIConnection,
	resolveCLIProxyAPIQuotaConnection,
	type CLIProxyAPIModelQuota,
} from "../extensions/cliproxyapi/client.ts";
import { formatCLIProxyAPIQuotaText } from "../extensions/cliproxyapi-usage.ts";

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

test("maps CLIProxyAPI model families to their quota providers", () => {
	assert.equal(quotaProviderForModel("gpt-5.6-sol"), "codex");
	assert.equal(quotaProviderForModel("gpt-5.6-sol-fast"), "codex");
	assert.equal(quotaProviderForModel("o3"), "codex");
	assert.equal(quotaProviderForModel("grok-4.6"), "xai");
	assert.equal(quotaProviderForModel("claude-opus-5"), "claude");
	assert.equal(quotaProviderForModel("kimi-k3"), null);
});

test("quota is read from the service with the proxy credential", async () => {
	const quota = {
		provider: "codex",
		windows: [{ label: "7d", usedPercent: 42, resetAtMs: null }],
		readyAccounts: 1,
		totalAccounts: 2,
		fetchedAtMs: 123,
	} satisfies CLIProxyAPIModelQuota;
	const client = createRemoteCLIProxyAPIQuotaClient(
		{ quotaUrl: "https://proxy.example.test/quota/v1", apiKey: "proxy-key" },
		async (input, init) => {
			assert.equal(input, "https://proxy.example.test/quota/v1/codex");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer proxy-key");
			return Response.json(quota);
		},
	);
	assert.deepEqual(await client.getModelQuota("gpt-5.6-sol"), quota);
});

test("quota rejects service errors and malformed replies", async () => {
	const connection = { quotaUrl: "https://proxy.example.test/quota/v1", apiKey: "proxy-key" };
	for (const response of [new Response(null, { status: 503 }), Response.json({ provider: "codex", windows: [] })]) {
		const client = createRemoteCLIProxyAPIQuotaClient(connection, async () => response);
		await assert.rejects(client.getModelQuota("gpt-5.6-sol"));
	}
});

test("a quota-service 404 means no credential for that provider", async () => {
	const client = createRemoteCLIProxyAPIQuotaClient(
		{ quotaUrl: "http://127.0.0.1:8318/quota/v1", apiKey: "local-key" },
		async (input) => {
			assert.equal(input, "http://127.0.0.1:8318/quota/v1/xai");
			return new Response(null, { status: 404 });
		},
	);
	assert.equal(await client.getModelQuota("grok-4.6"), null);
});

test("resolves an explicit quota URL, a public root fallback, and refuses a loopback root", () => {
	const files = (entries: Record<string, string>) => (path: string) => {
		const body = entries[path];
		if (body === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		return body;
	};
	assert.deepEqual(
		resolveCLIProxyAPIQuotaConnection({}, {
			configFilePath: "/c.json",
			readTextFile: files({
				"/c.json": JSON.stringify({
					rootUrl: "http://127.0.0.1:8317",
					quotaUrl: "http://127.0.0.1:8318/quota/v1/",
					apiKeyFile: "/run/secrets/local",
				}),
				"/run/secrets/local": "local-key\n",
			}),
		}),
		{ quotaUrl: "http://127.0.0.1:8318/quota/v1", apiKey: "local-key" },
	);
	assert.deepEqual(
		resolveCLIProxyAPIQuotaConnection(
			{ CLIPROXYAPI_ROOT_URL: "https://proxy.example.test/", CLIPROXYAPI_API_KEY: "public-key" },
			{ configFilePath: null },
		),
		{ quotaUrl: "https://proxy.example.test/quota/v1", apiKey: "public-key" },
	);
	assert.throws(
		() => resolveCLIProxyAPIQuotaConnection(
			{ CLIPROXYAPI_ROOT_URL: "http://127.0.0.1:8317", CLIPROXYAPI_API_KEY: "local-key" },
			{ configFilePath: null },
		),
		/requires CLIPROXYAPI_QUOTA_URL/,
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
