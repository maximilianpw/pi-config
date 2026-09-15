import assert from "node:assert/strict";
import test from "node:test";

import type { CloudflareAccessTokenProvider } from "../cloudflared-access-token.ts";
import { createMarkdownPasteClient } from "../markdown-paste-client.ts";
import { Redacted } from "../redacted.ts";
import { success } from "../result.ts";

test("Access rejection retries once with the same idempotency key and validates both origins", async () => {
	const requests: RequestInit[] = [];
	const documentId = "abcdefghijklmnopqrstuv";
	const revisionId = "bcdefghijklmnopqrstuvw";
	const publicationId = "cdefghijklmnopqrstuvwx";
	const fetchImplementation: typeof fetch = async (_input, init) => {
		requests.push(init ?? {});
		if (requests.length === 1) return new Response(null, { status: 403 });
		return Response.json({
			documentId,
			revisionId,
			publicationId,
			privateUrl: `https://private.example/documents/${documentId}`,
			rawUrl: `https://private.example/documents/${documentId}/raw`,
			downloadUrl: `https://private.example/documents/${documentId}/download`,
			publicUrl: `https://public.example/${publicationId}`,
		}, { status: 201 });
	};
	let refreshes = 0;
	const tokenProvider: CloudflareAccessTokenProvider = {
		resolveToken: async () => success(Redacted.make("cached")),
		refreshToken: async () => { refreshes += 1; return success(Redacted.make("fresh")); },
	};
	const client = createMarkdownPasteClient({ privateOrigin: new URL("https://private.example"), publicOrigin: new URL("https://public.example"), tokenProvider, fetchImplementation });
	const result = await client.createDocument({ markdown: "# Reviewed", title: "Pi agent response", sourceFilename: null, provenance: "plannotator-approved", publish: "30d", idempotencyKey: "one-command-key", interactive: true });
	assert.equal(result.ok, true);
	assert.equal(refreshes, 1);
	assert.equal(requests.length, 2);
	assert.equal(new Headers(requests[0]?.headers).get("idempotency-key"), "one-command-key");
	assert.equal(new Headers(requests[1]?.headers).get("idempotency-key"), "one-command-key");
	assert.equal(requests[0]?.redirect, "manual");
	assert.equal(requests[1]?.redirect, "manual");
});

test("Access rejection stops after one refresh retry", async () => {
	let requests = 0;
	let refreshes = 0;
	const tokenProvider: CloudflareAccessTokenProvider = {
		resolveToken: async () => success(Redacted.make("cached")),
		refreshToken: async () => {
			refreshes += 1;
			return success(Redacted.make("fresh"));
		},
	};
	const client = createMarkdownPasteClient({
		privateOrigin: new URL("https://private.example"),
		tokenProvider,
		fetchImplementation: async () => {
			requests += 1;
			return new Response(null, { status: 403 });
		},
	});
	const result = await client.createDocument({ markdown: "# Safe", title: "Safe", sourceFilename: null, provenance: "pi", publish: null, idempotencyKey: "key", interactive: true });
	assert.equal(result.ok, false);
	assert.equal(refreshes, 1);
	assert.equal(requests, 2);
});

test("client rejects a response URL on an unexpected origin", async () => {
	const id = "abcdefghijklmnopqrstuv";
	const tokenProvider: CloudflareAccessTokenProvider = { resolveToken: async () => success(Redacted.make("token")), refreshToken: async () => success(Redacted.make("token")) };
	const client = createMarkdownPasteClient({
		privateOrigin: new URL("https://private.example"),
		tokenProvider,
		fetchImplementation: async () => Response.json({ documentId: id, revisionId: id, publicationId: null, privateUrl: `https://evil.example/documents/${id}`, rawUrl: `https://evil.example/documents/${id}/raw`, downloadUrl: `https://evil.example/documents/${id}/download`, publicUrl: null }, { status: 201 }),
	});
	const result = await client.createDocument({ markdown: "# Safe", title: "Safe", sourceFilename: null, provenance: "pi", publish: null, idempotencyKey: "key", interactive: true });
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.reason, "invalid-response");
});
