import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareAccessTokenProvider, type CloudflaredExecutor } from "../cloudflared-access-token.ts";
import { Redacted } from "../redacted.ts";

test("cloudflared runs without shell arguments, logs in, then resolves a fresh token", async () => {
	const calls: string[][] = [];
	const executor: CloudflaredExecutor = {
		async execute(args) {
			calls.push([...args]);
			if (calls.length === 1) return { stdout: "", code: 1 };
			if (calls.length === 2) return { stdout: "ignored", code: 0 };
			return { stdout: "secret-token\n", code: 0 };
		},
	};
	const result = await createCloudflareAccessTokenProvider(executor, "https://private.example").resolveToken(true);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(String(result.value), "<redacted>");
	assert.equal(JSON.stringify(result.value), '"<redacted>"');
	assert.equal(Redacted.value(result.value), "secret-token");
	assert.deepEqual(calls, [
		["access", "token", "-app=https://private.example"],
		["access", "login", "--no-verbose", "-app=https://private.example"],
		["access", "token", "-app=https://private.example"],
	]);
});

test("headless authentication fails before browser login", async () => {
	const calls: string[][] = [];
	const executor: CloudflaredExecutor = { async execute(args) { calls.push([...args]); return { stdout: "", code: 1 }; } };
	const result = await createCloudflareAccessTokenProvider(executor, "https://private.example").resolveToken(false);
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.error.reason, "configuration");
	assert.match(result.error.message, /cloudflared access login/u);
	assert.equal(calls.length, 1);
});
