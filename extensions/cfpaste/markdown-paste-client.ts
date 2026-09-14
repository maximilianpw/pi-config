import type { CloudflareAccessToken, CloudflareAccessTokenProvider } from "./cloudflared-access-token.ts";
import { CfPasteError } from "./errors.ts";
import { Redacted } from "./redacted.ts";
import { failure, type Result, success } from "./result.ts";

const HTTP_TIMEOUT_MS = 30_000;
const IDENTIFIER = /^[A-Za-z0-9_-]{22}$/u;

export type PublicationExpiry = "1d" | "7d" | "30d" | "90d" | "never";

export interface CreateMarkdownDocumentInput {
	readonly markdown: string;
	readonly title: string;
	readonly sourceFilename: string | null;
	readonly provenance: "pi" | "plannotator-approved";
	readonly publish: PublicationExpiry | null;
	readonly idempotencyKey: string;
	readonly interactive: boolean;
	readonly signal?: AbortSignal;
}

export interface CreatedMarkdownDocument {
	readonly documentId: string;
	readonly revisionId: string;
	readonly publicationId: string | null;
	readonly privateUrl: string;
	readonly rawUrl: string;
	readonly downloadUrl: string;
	readonly publicUrl: string | null;
}

export interface MarkdownPasteClient {
	createDocument(input: CreateMarkdownDocumentInput): Promise<Result<CreatedMarkdownDocument, CfPasteError>>;
}

function accessRejected(response: Response): boolean {
	if (response.status === 401 || response.status === 403) return true;
	if (response.status < 300 || response.status >= 400) return false;
	const location = response.headers.get("location");
	if (location === null) return false;
	try {
		return new URL(location, response.url).pathname.startsWith("/cdn-cgi/access/");
	} catch {
		return false;
	}
}

function validUrl(value: unknown, origin: URL, path: RegExp): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.origin === origin.origin && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && path.test(url.pathname);
	} catch {
		return false;
	}
}

function parseResponse(value: unknown, privateOrigin: URL, publicOrigin: URL | undefined): Result<CreatedMarkdownDocument, CfPasteError> {
	if (typeof value !== "object" || value === null) return failure(new CfPasteError("invalid-response", "CF Paste returned a malformed response"));
	const record = value as Record<string, unknown>;
	if (!IDENTIFIER.test(String(record.documentId)) || !IDENTIFIER.test(String(record.revisionId))) return failure(new CfPasteError("invalid-response", "CF Paste returned invalid identifiers"));
	const documentId = String(record.documentId);
	const revisionId = String(record.revisionId);
	const publicationId = record.publicationId === null ? null : String(record.publicationId);
	if (publicationId !== null && !IDENTIFIER.test(publicationId)) return failure(new CfPasteError("invalid-response", "CF Paste returned an invalid Publication identifier"));
	const privatePath = new RegExp(`^/documents/${documentId}$`, "u");
	if (!validUrl(record.privateUrl, privateOrigin, privatePath) || !validUrl(record.rawUrl, privateOrigin, new RegExp(`^/documents/${documentId}/raw$`, "u")) || !validUrl(record.downloadUrl, privateOrigin, new RegExp(`^/documents/${documentId}/download$`, "u"))) {
		return failure(new CfPasteError("invalid-response", "CF Paste returned an unexpected private URL origin or path"));
	}
	if (publicationId === null) {
		if (record.publicUrl !== null) return failure(new CfPasteError("invalid-response", "CF Paste returned inconsistent Publication fields"));
	} else if (publicOrigin === undefined || !validUrl(record.publicUrl, publicOrigin, new RegExp(`^/${publicationId}$`, "u"))) {
		return failure(new CfPasteError("invalid-response", "CF Paste returned an unexpected public URL origin or path"));
	}
	return success({ documentId, revisionId, publicationId, privateUrl: record.privateUrl, rawUrl: record.rawUrl, downloadUrl: record.downloadUrl, publicUrl: record.publicUrl as string | null });
}

async function send(
	fetchImplementation: typeof fetch,
	privateOrigin: URL,
	token: CloudflareAccessToken,
	input: CreateMarkdownDocumentInput,
): Promise<Result<Response, CfPasteError>> {
	const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
	const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
	try {
		return success(await fetchImplementation(new URL("/api/v1/documents", privateOrigin), {
			method: "POST",
			redirect: "manual",
			signal,
			headers: {
				"cf-access-token": Redacted.value(token),
				"content-type": "application/json",
				"idempotency-key": input.idempotencyKey,
			},
			body: JSON.stringify({
				markdown: input.markdown,
				title: input.title,
				sourceFilename: input.sourceFilename,
				provenance: input.provenance,
				...(input.publish === null ? {} : { publish: { expiry: input.publish } }),
			}),
		}));
	} catch (cause) {
		return failure(new CfPasteError("network", "CF Paste request failed before receiving a response", cause));
	}
}

export function createMarkdownPasteClient(options: {
	readonly privateOrigin: URL;
	readonly publicOrigin?: URL;
	readonly tokenProvider: CloudflareAccessTokenProvider;
	readonly fetchImplementation?: typeof fetch;
}): MarkdownPasteClient {
	const fetchImplementation = options.fetchImplementation ?? fetch;
	return {
		async createDocument(input) {
			const resolved = await options.tokenProvider.resolveToken(input.interactive, input.signal);
			if (!resolved.ok) return resolved;
			let response = await send(fetchImplementation, options.privateOrigin, resolved.value, input);
			if (!response.ok) return response;
			if (accessRejected(response.value)) {
				const refreshed = await options.tokenProvider.refreshToken(input.interactive, input.signal);
				if (!refreshed.ok) return refreshed;
				response = await send(fetchImplementation, options.privateOrigin, refreshed.value, input);
				if (!response.ok) return response;
				if (accessRejected(response.value)) return failure(new CfPasteError("authentication", "CF Paste rejected the refreshed Access token"));
			}
			if (response.value.status !== 201) return failure(new CfPasteError("rejected-response", `CF Paste rejected the request with HTTP status ${response.value.status}`));
			try {
				return parseResponse(await response.value.json(), options.privateOrigin, options.publicOrigin);
			} catch (cause) {
				return failure(new CfPasteError("invalid-response", "CF Paste returned invalid JSON", cause));
			}
		},
	};
}
