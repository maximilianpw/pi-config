import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

type LookupHost = (hostname: string) => Promise<readonly { readonly address: string }[]>;

const lookupHost: LookupHost = (hostname) => lookup(hostname, { all: true, verbatim: true });

export interface FetchWithRedirectsOptions {
	headers: Record<string, string>;
	signal?: AbortSignal;
	maxRedirects: number;
	blockPrivateHosts: boolean;
}

export interface FetchWithRedirectsResult {
	response: Response;
	finalUrl: URL;
}

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

export function normalizeAndValidateUrl(rawUrl: string): URL {
	const parsed = parsePublicHttpUrl(rawUrl);
	if (parsed._tag === "err") {
		throw new Error(renderSafeUrlParseError(parsed.error));
	}
	return new URL(parsed.value);
}

export async function fetchWithRedirects(
	initialUrl: URL,
	options: FetchWithRedirectsOptions,
): Promise<FetchWithRedirectsResult> {
	let currentUrl = initialUrl;
	let redirects = 0;

	while (true) {
		assertUrlHasNoCredentials(currentUrl);
		if (options.blockPrivateHosts) {
			await assertPublicUrl(currentUrl);
		}

		const response = await fetch(currentUrl, {
			method: "GET",
			headers: options.headers,
			signal: options.signal,
			redirect: "manual",
		});

		if (isRedirectStatus(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			const location = response.headers.get("location");
			if (!location) {
				throw new Error("Redirect response was missing a Location header");
			}
			if (redirects >= options.maxRedirects) {
				throw new Error("Too many redirects while fetching URL");
			}
			let nextUrl: URL;
			try {
				nextUrl = new URL(location, currentUrl);
			} catch {
				throw new Error("Redirect response had an invalid Location header");
			}
			if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
				throw new Error("Redirected to unsupported protocol");
			}
			assertUrlHasNoCredentials(nextUrl);
			currentUrl = nextUrl;
			redirects += 1;
			continue;
		}

		return { response, finalUrl: currentUrl };
	}
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

async function assertPublicUrl(url: URL): Promise<void> {
	const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
	if (isBlockedHostname(hostname)) {
		throw new Error("Blocked private or local host");
	}
	if (isPrivateOrLocalIp(hostname)) {
		throw new Error("Blocked private or local IP address");
	}

	let records: readonly { readonly address: string }[];
	try {
		records = await lookupHost(hostname);
	} catch {
		throw new Error("Could not safely resolve host");
	}
	if (records.length === 0) {
		throw new Error("Could not safely resolve host");
	}
	for (const record of records) {
		if (isPrivateOrLocalIp(record.address)) {
			throw new Error("Blocked private, local, or reserved IP address");
		}
	}
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

function assertUrlHasNoCredentials(url: URL): void {
	if (url.username || url.password) {
		throw new Error("URL credentials are not supported");
	}
}

function renderSafeUrlParseError(error: ParsePublicHttpUrlError): string {
	switch (error._tag) {
		case "EmptyUrl":
			return "URL cannot be empty";
		case "UnsupportedUrlProtocol":
			return "URL must start with http:// or https://";
		case "InvalidUrl":
			return "Invalid URL";
		case "UrlCredentialsUnsupported":
			return "URL credentials are not supported";
	}
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

		if (request.blockPrivateHosts) {
			const publicCheck = await checkPublicUrl(currentUrl, currentPublicUrl.value, resolveHostname);
			if (publicCheck._tag === "err") {
				return publicCheck;
			}
		}

		let response: Response;
		try {
			response = await fetch(currentUrl, {
				method: "GET",
				headers: createPublicWebHeaders(request.accept, userAgent),
				signal,
				redirect: "manual",
			});
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
	};
}

async function checkPublicUrl(
	url: URL,
	publicUrl: PublicHttpUrl,
	resolveHostname: LookupHost,
): Promise<Result<void, PublicWebError>> {
	const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
	if (isBlockedHostname(hostname)) {
		return err({ _tag: "PrivateHostBlocked", url: publicUrl });
	}
	if (isPrivateOrLocalIp(hostname)) {
		return err({ _tag: "PrivateIpBlocked", url: publicUrl });
	}

	let records: readonly { readonly address: string }[];
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

	return ok(undefined);
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
