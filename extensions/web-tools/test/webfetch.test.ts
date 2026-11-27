import test from "node:test";
import assert from "node:assert/strict";
import {
	createWebFetchTool,
	describeRequestFailure,
	getFallbackUserAgent,
	OPENCODE_WEBFETCH_FALLBACK_USER_AGENT,
} from "../webfetch.ts";

test("webfetch execute rejects URL credentials with a safe message", async () => {
	const tool = createWebFetchTool();

	await assert.rejects(
		tool.execute("id", { url: "https://user:pass@example.com/secret" }),
		(error: unknown) => error instanceof Error && error.message === "URL credentials are not supported",
	);
});

test("getFallbackUserAgent prefers the configured setting and otherwise falls back to opencode", () => {
	assert.equal(getFallbackUserAgent("my-agent/1.0"), "my-agent/1.0");
	assert.equal(getFallbackUserAgent("  custom-agent  "), "custom-agent");
	assert.equal(getFallbackUserAgent(""), OPENCODE_WEBFETCH_FALLBACK_USER_AGENT);
	assert.equal(getFallbackUserAgent("   "), OPENCODE_WEBFETCH_FALLBACK_USER_AGENT);
	assert.equal(getFallbackUserAgent(undefined), OPENCODE_WEBFETCH_FALLBACK_USER_AGENT);
});

test("describeRequestFailure names the network error code and cause chain", () => {
	const refused = Object.assign(new Error("connect ECONNREFUSED 203.0.113.5:443"), { code: "ECONNREFUSED" });
	assert.equal(describeRequestFailure(refused), "Request failed: connect ECONNREFUSED 203.0.113.5:443");

	const tls = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
	assert.equal(
		describeRequestFailure(new Error("fetch failed", { cause: tls })),
		"Request failed: fetch failed <- CERT_HAS_EXPIRED: certificate has expired",
	);
	assert.equal(describeRequestFailure("opaque"), "Request failed");
});
