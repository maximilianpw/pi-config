import { createServer } from "node:http";
import { createCLIProxyAPIClient, type CLIProxyAPIClient } from "../extensions/cliproxyapi/client.ts";

const PORT = 8318;
const QUOTA_PATH = /^\/quota\/v1\/(claude|codex|xai)$/;

/** Quota-only loopback surface; nginx authenticates the public API key before forwarding. */
export function createCLIProxyAPIQuotaHandler(client: CLIProxyAPIClient): (request: Request) => Promise<Response> {
	return async (request) => {
		const url = new URL(request.url);
		const match = QUOTA_PATH.exec(url.pathname);
		if (request.method !== "GET" || match === null) return new Response(null, { status: 404 });
		const modelId = match[1] === "claude" ? "claude-opus-5" : match[1] === "codex" ? "gpt-5.6-sol" : "grok-4.6";
		try {
			const quota = await client.getModelQuota(modelId, { signal: request.signal });
			if (quota === null) return new Response(null, { status: 404 });
			return Response.json(quota, { headers: { "cache-control": "no-store" } });
		} catch {
			return new Response(null, { status: 503 });
		}
	};
}

if (import.meta.main) {
	const handleQuota = createCLIProxyAPIQuotaHandler(createCLIProxyAPIClient());
	createServer(async (request, response) => {
		const result = await handleQuota(new Request(`http://127.0.0.1:${PORT}${request.url ?? "/"}`, {
			method: request.method,
		}));
		response.writeHead(result.status, Object.fromEntries(result.headers));
		response.end(await result.text());
	}).listen(PORT, "127.0.0.1");
}
