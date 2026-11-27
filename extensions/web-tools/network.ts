import { lookup } from "node:dns/promises";
import { request as requestHttp, type IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { err, ok, type Result } from "./result.ts";
import { parsePublicHttpUrl, type ContentKind, type ParsePublicHttpUrlError, type ParsedContentType, type PublicHttpUrl } from "./types.ts";
import type { PublicWebClient, PublicWebError, PublicWebRequest, PublicWebResponse } from "./public-web-client.ts";

const HTML_MIME_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_MIME_TYPES = new Set([
	"application/json",
	"application/ld+json",
	"application/xml",
	"application/rss+xml",
	"application/atom+xml",
	"application/javascript",
	"application/x-javascript",
	"application/ecmascript",
	"image/svg+xml",
]);
const RASTER_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type ResolvedAddress = { readonly address: string; readonly family?: number };
type LookupHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const lookupHost: LookupHost = (hostname) => lookup(hostname, { all: true, verbatim: true });

export interface ReadBodyResult {
	buffer: Buffer;
	bytes: number;
}

export interface ComposedSignal {
	signal: AbortSignal;
	cleanup: () => void;
}

export class OperationTimeoutError extends Error {
	readonly _tag = "OperationTimeout" as const;

	constructor(readonly timeoutSeconds: number) {
		super(`Operation timed out after ${timeoutSeconds}s`);
		this.name = "OperationTimeoutError";
	}
}

export function createOperationSignal(timeoutMs: number, outerSignal?: AbortSignal): ComposedSignal {
	const controller = new AbortController();
	const timeoutSeconds = Math.ceil(timeoutMs / 1000);
	const timeoutId = setTimeout(() => {
		controller.abort(new OperationTimeoutError(timeoutSeconds));
	}, timeoutMs);
	const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
	return {
		signal,
		cleanup: () => clearTimeout(timeoutId),
	};
}

export function isOperationTimeoutError(value: unknown): value is OperationTimeoutError {
	return value instanceof OperationTimeoutError || (typeof value === "object" && value !== null && "_tag" in value && value._tag === "OperationTimeout");
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export async function readBodyWithLimit(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<ReadBodyResult> {
	if (!response.body) {
		return { buffer: Buffer.alloc(0), bytes: 0 };
	}

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let bytes = 0;

	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel(signal.reason).catch(() => undefined);
				throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
			}

			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error(`Response too large (exceeds ${Math.floor(maxBytes / (1024 * 1024))}MB limit)`);
			}

			chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
		}
	} finally {
		reader.releaseLock();
	}

	return {
		buffer: Buffer.concat(chunks),
		bytes,
	};
}

export function parseContentType(contentTypeHeader: string | null | undefined): ParsedContentType {
	const contentType = contentTypeHeader?.trim() ?? "";
	const [mimePart = ""] = contentType.split(";");
	const mime = mimePart.trim().toLowerCase();
	const charsetMatch = contentType.match(/charset\s*=\s*['\"]?([^;'\"]+)/i);
	const charset = charsetMatch?.[1]?.trim().toLowerCase();
	return {
		contentType,
		mime,
		charset,
		kind: classifyMimeType(mime),
	};
}

export function classifyMimeType(mime: string): ContentKind {
	const normalized = mime.trim().toLowerCase();
	if (!normalized) return "binary";
	if (HTML_MIME_TYPES.has(normalized)) return "html";
	if (RASTER_IMAGE_MIME_TYPES.has(normalized)) return "raster-image";
	if (normalized === "image/svg+xml") return "svg";
	if (normalized.startsWith("text/")) return normalized === "text/html" ? "html" : "text";
	if (TEXT_MIME_TYPES.has(normalized) || normalized.endsWith("+xml") || normalized.endsWith("+json")) return "text";
	return "binary";
}

export function decodeTextBuffer(buffer: Buffer, charset?: string): { text: string; decoder: string } {
	const normalizedCharset = normalizeCharset(charset);
	if (normalizedCharset) {
		try {
			return {
				text: new TextDecoder(normalizedCharset).decode(buffer),
				decoder: normalizedCharset,
			};
		} catch {
			// Fall back to utf-8 below.
		}
	}
	return {
		text: new TextDecoder("utf-8").decode(buffer),
		decoder: "utf-8",
	};
}

export function normalizeCharset(charset: string | undefined): string | undefined {
	if (!charset) return undefined;
	const normalized = charset.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "utf8") return "utf-8";
	return normalized;
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isBlockedHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname.endsWith(".localhost");
}

function stripIpv6Brackets(hostname: string): string {
	return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

export function isPrivateOrLocalIp(input: string): boolean {
	const ip = normalizeIpLiteral(input);
	if (!ip) return false;

	const mappedIpv4 = parseIpv4MappedIpv6Address(ip);
	if (mappedIpv4) {
		return isPrivateOrLocalIp(mappedIpv4);
	}

	const compatibleIpv4 = parseIpv4CompatibleIpv6Address(ip);
	if (compatibleIpv4) {
		return isPrivateOrLocalIp(compatibleIpv4);
	}

	const version = isIP(ip);
	if (version === 4) {
		const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
		const [a, b, c] = octets;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
		if (a === 192 && b === 88 && c === 99) return true;
		if (a === 192 && b === 168) return true;
		if (a === 198 && (b === 18 || b === 19)) return true;
		if (a === 198 && b === 51 && c === 100) return true;
		if (a === 203 && b === 0 && c === 113) return true;
		if (a >= 224) return true;
		return false;
	}
	if (version === 6) {
		const groups = parseIpv6Groups(ip);
		if (!groups) return true;
		return IPV6_BLOCKED_PREFIXES.some(({ network, prefix }) => ipv6MatchesPrefix(groups, network, prefix));
	}
	return false;
}

const IPV6_BLOCKED_PREFIXES = [
	{ network: [0x0000, 0, 0, 0, 0, 0, 0, 0], prefix: 128 }, // Unspecified
	{ network: [0x0000, 0, 0, 0, 0, 0, 0, 1], prefix: 128 }, // Loopback
	{ network: [0x0064, 0xff9b, 0, 0, 0, 0, 0, 0], prefix: 96 }, // IPv4/IPv6 translation
	{ network: [0x0064, 0xff9b, 1, 0, 0, 0, 0, 0], prefix: 48 }, // Local-use translation
	{ network: [0x0100, 0, 0, 0, 0, 0, 0, 0], prefix: 64 }, // Discard-only
	{ network: [0x2001, 0, 0, 0, 0, 0, 0, 0], prefix: 23 }, // IETF protocol assignments
	{ network: [0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], prefix: 32 }, // Documentation
	{ network: [0x2002, 0, 0, 0, 0, 0, 0, 0], prefix: 16 }, // 6to4
	{ network: [0x3fff, 0, 0, 0, 0, 0, 0, 0], prefix: 20 }, // Documentation
	{ network: [0xfc00, 0, 0, 0, 0, 0, 0, 0], prefix: 7 }, // Unique local
	{ network: [0xfe80, 0, 0, 0, 0, 0, 0, 0], prefix: 10 }, // Link-local
	{ network: [0xfec0, 0, 0, 0, 0, 0, 0, 0], prefix: 10 }, // Deprecated site-local
	{ network: [0xff00, 0, 0, 0, 0, 0, 0, 0], prefix: 8 }, // Multicast
] as const;

function ipv6MatchesPrefix(groups: readonly number[], network: readonly number[], prefix: number): boolean {
	const fullGroups = Math.floor(prefix / 16);
	for (let index = 0; index < fullGroups; index += 1) {
		if (groups[index] !== network[index]) return false;
	}

	const remainingBits = prefix % 16;
	if (remainingBits === 0) return true;
	const mask = (0xffff << (16 - remainingBits)) & 0xffff;
	return ((groups[fullGroups] ?? 0) & mask) === ((network[fullGroups] ?? 0) & mask);
}

function parseIpv6Groups(address: string): number[] | undefined {
	const pieces = address.split("::");
	if (pieces.length > 2) return undefined;

	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((pieces.length === 1 && missing !== 0) || missing < 0) return undefined;

	const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) => {
		if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
		return Number.parseInt(part, 16);
	});
	return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : undefined;
}

function normalizeIpLiteral(input: string): string {
	const ip = stripIpv6Brackets(input).toLowerCase();
	if (isIP(ip) !== 6) {
		return ip;
	}

	try {
		return stripIpv6Brackets(new URL(`http://[${ip}]/`).hostname).toLowerCase();
	} catch {
		return ip;
	}
}

function parseIpv4MappedIpv6Address(ip: string): string | undefined {
	const prefix = "::ffff:";
	if (!ip.startsWith(prefix)) {
		return undefined;
	}

	const suffix = ip.slice(prefix.length);
	if (isIP(suffix) === 4) {
		return suffix;
	}

	const segments = suffix.split(":");
	if (segments.length !== 2) {
		return undefined;
	}

	const high = parseIpv6Hex16(segments[0]);
	const low = parseIpv6Hex16(segments[1]);
	if (high === undefined || low === undefined) {
		return undefined;
	}

	return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function parseIpv4CompatibleIpv6Address(ip: string): string | undefined {
	const prefix = "::";
	if (!ip.startsWith(prefix)) {
		return undefined;
	}

	const suffix = ip.slice(prefix.length);
	const segments = suffix.split(":");
	if (segments.length !== 2) {
		return undefined;
	}

	const high = parseIpv6Hex16(segments[0]);
	const low = parseIpv6Hex16(segments[1]);
	if (high === undefined || low === undefined) {
		return undefined;
	}

	return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function parseIpv6Hex16(segment: string | undefined): number | undefined {
	if (!segment || !/^[0-9a-f]{1,4}$/i.test(segment)) {
		return undefined;
	}

	const value = Number.parseInt(segment, 16);
	return Number.isFinite(value) && value >= 0 && value <= 0xffff ? value : undefined;
}

export class FetchPublicWebClient implements PublicWebClient {
	constructor(private readonly resolveHostname: LookupHost = lookupHost) {}

	/** Fetch a bounded public web response, following safe redirects. */
	async get(
		request: PublicWebRequest,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<Result<PublicWebResponse, PublicWebError>> {
		const firstFetch = await fetchWithUserAgent(request, request.userAgent, this.resolveHostname, options.signal);
		if (firstFetch._tag === "err") {
			return firstFetch;
		}

		let response = firstFetch.value.response;
		let finalUrl = firstFetch.value.finalUrl;
		if (isCloudflareChallenge(response)) {
			await response.body?.cancel().catch(() => undefined);
			const retryFetch = await fetchWithUserAgent(request, request.fallbackUserAgent, this.resolveHostname, options.signal);
			if (retryFetch._tag === "err") {
				return retryFetch;
			}
			response = retryFetch.value.response;
			finalUrl = retryFetch.value.finalUrl;
		}

		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return err({ _tag: "HttpStatusRejected", status: response.status, statusText: response.statusText });
		}

		const contentLength = response.headers.get("content-length");
		if (contentLength) {
			const declaredBytes = Number.parseInt(contentLength, 10);
			if (Number.isFinite(declaredBytes) && declaredBytes > request.maxResponseBytes) {
				await response.body?.cancel().catch(() => undefined);
				return err({ _tag: "ResponseTooLarge", maxBytes: request.maxResponseBytes });
			}
		}

		try {
			const body = await readBodyWithLimit(response, request.maxResponseBytes, options.signal);
			return ok({
				requestedUrl: request.url,
				finalUrl,
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
				body: body.buffer,
				bytes: body.bytes,
			});
		} catch (cause: unknown) {
			if (options.signal?.aborted) {
				return err(classifySignalAbort(options.signal, cause));
			}
			if (isResponseTooLargeCause(cause)) {
				return err({ _tag: "ResponseTooLarge", maxBytes: request.maxResponseBytes });
			}
			return err({ _tag: "PublicWebRequestFailed", cause });
		}
	}
}

async function fetchWithUserAgent(
	request: PublicWebRequest,
	userAgent: string,
	resolveHostname: LookupHost,
	signal?: AbortSignal,
): Promise<Result<{ readonly response: Response; readonly finalUrl: PublicHttpUrl }, PublicWebError>> {
	let currentUrl = new URL(request.url);
	let redirects = 0;

	while (true) {
		if (signal?.aborted) {
			return err(classifySignalAbort(signal));
		}

		const currentPublicUrl = publicHttpUrlFromUrl(currentUrl);
		if (currentPublicUrl._tag === "err") {
			return currentPublicUrl;
		}

		let pinnedAddresses: readonly ResolvedAddress[] | undefined;
		if (request.blockPrivateHosts) {
			const publicCheck = await checkPublicUrl(currentUrl, currentPublicUrl.value, resolveHostname);
			if (publicCheck._tag === "err") {
				return publicCheck;
			}
			pinnedAddresses = publicCheck.value;
		}

		let response: Response;
		try {
			response = await requestOnce(currentUrl, createPublicWebHeaders(request.accept, userAgent), signal, pinnedAddresses);
		} catch (cause: unknown) {
			if (signal?.aborted || isAbortError(cause)) {
				return err(signal ? classifySignalAbort(signal, cause) : { _tag: "PublicWebCancelled", cause });
			}
			return err({ _tag: "PublicWebRequestFailed", cause });
		}

		if (!isRedirectStatus(response.status)) {
			return ok({ response, finalUrl: currentPublicUrl.value });
		}

		await response.body?.cancel().catch(() => undefined);
		const location = response.headers.get("location");
		if (!location) {
			return err({ _tag: "RedirectLocationMissing", url: currentPublicUrl.value });
		}
		if (redirects >= request.maxRedirects) {
			return err({ _tag: "RedirectLimitExceeded", url: request.url, maxRedirects: request.maxRedirects });
		}

		let nextUrl: URL;
		try {
			nextUrl = new URL(location, currentUrl);
		} catch {
			return err({ _tag: "RedirectLocationInvalid" });
		}
		if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
			return err({ _tag: "RedirectProtocolUnsupported", protocol: nextUrl.protocol });
		}

		currentUrl = nextUrl;
		redirects += 1;
	}
}

function createPublicWebHeaders(accept: string, userAgent: string): Record<string, string> {
	return {
		"User-Agent": userAgent,
		Accept: accept,
		"Accept-Language": "en-US,en;q=0.9",
		"Accept-Encoding": "gzip, deflate, br",
	};
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Sends one GET without following redirects. When `pinnedAddresses` is given, the socket may only connect
 * to those already-validated addresses: `fetch` would resolve the host again, and a DNS answer that
 * changed between the check and the connection (DNS rebinding) could reach a private network. A fresh
 * agent per request keeps a pooled socket from bypassing the lookup.
 */
export function requestOnce(
	url: URL,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	pinnedAddresses: readonly ResolvedAddress[] | undefined,
): Promise<Response> {
	const send = url.protocol === "https:" ? requestHttps : requestHttp;
	return new Promise((resolve, reject) => {
		const outgoing = send(
			url,
			{
				method: "GET",
				headers,
				signal,
				agent: false,
				...(pinnedAddresses ? { lookup: pinnedLookup(pinnedAddresses) } : {}),
			},
			(incoming) => {
				try {
					resolve(toWebResponse(incoming));
				} catch (cause: unknown) {
					incoming.destroy();
					reject(cause);
				}
			},
		);
		outgoing.on("error", reject);
		outgoing.end();
	});
}

function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
	const entries = addresses.map(({ address, family }) => ({ address, family: family ?? isIP(address) }));
	return (_hostname, options, callback) => {
		const wanted = typeof options === "object" && options.family ? options.family : 0;
		const matching = wanted === 0 ? entries : entries.filter((entry) => entry.family === wanted);
		const first = matching[0];
		if (!first) {
			callback(Object.assign(new Error("No validated address for the requested family"), { code: "ENOTFOUND" }), "", 0);
			return;
		}
		if (typeof options === "object" && options.all) {
			(callback as unknown as (error: null, addresses: typeof matching) => void)(null, matching);
			return;
		}
		callback(null, first.address, first.family);
	};
}

function toWebResponse(incoming: IncomingMessage): Response {
	const headers = new Headers();
	for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
		headers.append(incoming.rawHeaders[index] ?? "", incoming.rawHeaders[index + 1] ?? "");
	}
	const status = incoming.statusCode ?? 0;
	const init = { status, statusText: incoming.statusMessage ?? "", headers };
	if (NULL_BODY_STATUSES.has(status)) {
		incoming.resume();
		return new Response(null, init);
	}
	const decoded = decodeContentEncoding(incoming, headers);
	return new Response(Readable.toWeb(decoded) as ReadableStream<Uint8Array>, init);
}

/** Undoes the content encodings this client advertises; anything else is passed through as bytes. */
function decodeContentEncoding(incoming: IncomingMessage, headers: Headers): Readable {
	const encoding = headers.get("content-encoding")?.trim().toLowerCase();
	const decoder =
		encoding === "gzip" || encoding === "x-gzip"
			? createGunzip()
			: encoding === "deflate"
				? createInflate()
				: encoding === "br"
					? createBrotliDecompress()
					: undefined;
	if (!decoder) return incoming;
	headers.delete("content-encoding");
	headers.delete("content-length");
	incoming.on("error", (cause) => decoder.destroy(cause));
	return incoming.pipe(decoder);
}

async function checkPublicUrl(
	url: URL,
	publicUrl: PublicHttpUrl,
	resolveHostname: LookupHost,
): Promise<Result<readonly ResolvedAddress[] | undefined, PublicWebError>> {
	const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
	if (isBlockedHostname(hostname)) {
		return err({ _tag: "PrivateHostBlocked", url: publicUrl });
	}
	if (isPrivateOrLocalIp(hostname)) {
		return err({ _tag: "PrivateIpBlocked", url: publicUrl });
	}
	// The socket connects to an IP literal without a lookup, so there is nothing to pin.
	if (isIP(hostname) !== 0) {
		return ok(undefined);
	}

	let records: readonly ResolvedAddress[];
	try {
		records = await resolveHostname(hostname);
	} catch {
		return err({ _tag: "HostResolutionFailed", url: publicUrl });
	}
	if (records.length === 0) {
		return err({ _tag: "HostResolutionFailed", url: publicUrl });
	}
	for (const record of records) {
		if (isPrivateOrLocalIp(record.address)) {
			return err({ _tag: "PrivateIpBlocked", url: publicUrl });
		}
	}

	return ok(records);
}

function publicHttpUrlFromUrl(url: URL): Result<PublicHttpUrl, PublicWebError> {
	const parsed = parsePublicHttpUrl(url.toString());
	if (parsed._tag === "err") {
		return err(mapPublicHttpUrlParseError(parsed.error));
	}
	return parsed;
}

function mapPublicHttpUrlParseError(error: ParsePublicHttpUrlError): PublicWebError {
	switch (error._tag) {
		case "UrlCredentialsUnsupported":
			return { _tag: "UrlCredentialsUnsupported", url: error.url };
		case "UnsupportedUrlProtocol":
			return { _tag: "RedirectProtocolUnsupported", protocol: error.protocol ?? "unknown" };
		case "EmptyUrl":
		case "InvalidUrl":
			return { _tag: "PublicWebRequestFailed", cause: error };
	}
}

function classifySignalAbort(signal: AbortSignal, cause?: unknown): PublicWebError {
	if (isOperationTimeoutError(signal.reason)) {
		return { _tag: "PublicWebTimedOut", timeoutSeconds: signal.reason.timeoutSeconds };
	}
	return { _tag: "PublicWebCancelled", cause };
}

function isCloudflareChallenge(response: Pick<Response, "status" | "headers">): boolean {
	return response.status === 403 && response.headers.get("cf-mitigated") === "challenge";
}

function isResponseTooLargeCause(cause: unknown): boolean {
	return cause instanceof Error && cause.message.startsWith("Response too large");
}
