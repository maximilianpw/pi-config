import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLIPROXYAPI_PROVIDER_ID = "cliproxyapi";

export interface CLIProxyAPIConnection {
	rootUrl: string;
	baseUrl: string;
	apiKey: string;
}

export interface CLIProxyAPIEnvironment {
	CLIPROXYAPI_ROOT_URL?: string;
	CLIPROXYAPI_API_KEY?: string;
	CLIPROXYAPI_API_KEY_FILE?: string;
	CLIPROXYAPI_QUOTA_URL?: string;
}

/** Fleet's quota endpoint base (ending in /quota/v1) and the token sent to it. */
export interface CLIProxyAPIQuotaConnection {
	quotaUrl: string;
	apiKey: string;
}

type ReadTextFile = (path: string) => string;

export interface ResolveCLIProxyAPIConnectionOptions {
	configFilePath?: string | null;
	readTextFile?: ReadTextFile;
}

function requiredNonEmpty(value: string | undefined, name: string): string {
	const normalized = value?.trim();
	if (!normalized) {
		throw new Error(
			`CLIProxyAPI configuration requires ${name}; refusing to fall back to a localhost proxy`,
		);
	}
	return normalized;
}

function readClientEnvironment(
	configFilePath: string | null,
	readTextFile: ReadTextFile,
): CLIProxyAPIEnvironment {
	if (configFilePath === null) return {};
	try {
		const payload: unknown = JSON.parse(readTextFile(configFilePath));
		if (!isRecord(payload)) {
			throw new Error("CLIProxyAPI client configuration must be an object");
		}
		return {
			CLIPROXYAPI_ROOT_URL:
				typeof payload.rootUrl === "string" ? payload.rootUrl : undefined,
			CLIPROXYAPI_API_KEY_FILE:
				typeof payload.apiKeyFile === "string" ? payload.apiKeyFile : undefined,
			CLIPROXYAPI_QUOTA_URL:
				typeof payload.quotaUrl === "string" ? payload.quotaUrl : undefined,
		};
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return {};
		throw error;
	}
}

function resolveClientSettings(
	environment: CLIProxyAPIEnvironment,
	options: ResolveCLIProxyAPIConnectionOptions,
): { connection: CLIProxyAPIConnection; quotaUrl: string | undefined } {
	const readTextFile = options.readTextFile ?? ((path) => readFileSync(path, "utf8"));
	const fileEnvironment = readClientEnvironment(
		options.configFilePath === undefined
			? join(homedir(), ".config", "cliproxyapi", "client.json")
			: options.configFilePath,
		readTextFile,
	);
	const rootUrl = requiredNonEmpty(
		environment.CLIPROXYAPI_ROOT_URL ?? fileEnvironment.CLIPROXYAPI_ROOT_URL,
		"CLIPROXYAPI_ROOT_URL",
	).replace(/\/$/, "");
	const directApiKey = environment.CLIPROXYAPI_API_KEY?.trim();
	const apiKey = directApiKey
		? directApiKey
		: readTextFile(
				requiredNonEmpty(
					environment.CLIPROXYAPI_API_KEY_FILE ??
						fileEnvironment.CLIPROXYAPI_API_KEY_FILE,
					"CLIPROXYAPI_API_KEY or CLIPROXYAPI_API_KEY_FILE",
				),
			).trim();
	if (!apiKey) {
		throw new Error("CLIProxyAPI API key is empty");
	}
	const quotaUrl = (
		environment.CLIPROXYAPI_QUOTA_URL ?? fileEnvironment.CLIPROXYAPI_QUOTA_URL
	)?.trim();
	return {
		connection: { rootUrl, baseUrl: `${rootUrl}/v1`, apiKey },
		quotaUrl: quotaUrl ? quotaUrl.replace(/\/$/, "") : undefined,
	};
}

export function resolveCLIProxyAPIConnection(
	environment: CLIProxyAPIEnvironment = process.env,
	options: ResolveCLIProxyAPIConnectionOptions = {},
): CLIProxyAPIConnection {
	return resolveClientSettings(environment, options).connection;
}

function isLoopbackUrl(url: string): boolean {
	const hostname = new URL(url).hostname;
	return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * Quota is always read over HTTP from Fleet's cliproxy-quota service. The URL
 * is explicit (`quotaUrl` / CLIPROXYAPI_QUOTA_URL): loopback on Kim, the public
 * endpoint elsewhere. A public root URL implies `${rootUrl}/quota/v1`; a
 * loopback root URL is the proxy itself, so it never implies a quota URL.
 */
export function resolveCLIProxyAPIQuotaConnection(
	environment: CLIProxyAPIEnvironment = process.env,
	options: ResolveCLIProxyAPIConnectionOptions = {},
): CLIProxyAPIQuotaConnection {
	const { connection, quotaUrl } = resolveClientSettings(environment, options);
	if (quotaUrl !== undefined) return { quotaUrl, apiKey: connection.apiKey };
	if (isLoopbackUrl(connection.rootUrl)) {
		throw new Error(
			"CLIProxyAPI quota requires CLIPROXYAPI_QUOTA_URL when CLIPROXYAPI_ROOT_URL is loopback",
		);
	}
	return { quotaUrl: `${connection.rootUrl}/quota/v1`, apiKey: connection.apiKey };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

type Fetch = typeof globalThis.fetch;

export type CLIProxyAPIQuotaProvider = "claude" | "codex" | "xai";

export interface CLIProxyAPIQuotaWindow {
	label: string;
	usedPercent: number;
	resetAtMs: number | null;
}

export interface CLIProxyAPIModelQuota {
	provider: CLIProxyAPIQuotaProvider;
	windows: CLIProxyAPIQuotaWindow[];
	readyAccounts: number;
	totalAccounts: number;
	fetchedAtMs: number;
}

export interface GetCLIProxyAPIModelQuotaOptions {
	force?: boolean;
	signal?: AbortSignal;
}

export interface CLIProxyAPIClient {
	getModelQuota(
		modelId: string,
		options?: GetCLIProxyAPIModelQuotaOptions,
	): Promise<CLIProxyAPIModelQuota | null>;
}

export function createConfiguredCLIProxyAPIQuotaClient(): CLIProxyAPIClient {
	let client: CLIProxyAPIClient | undefined;
	return {
		async getModelQuota(modelId, options) {
			client ??= createRemoteCLIProxyAPIQuotaClient(resolveCLIProxyAPIQuotaConnection());
			return client.getModelQuota(modelId, options);
		},
	};
}

export function createRemoteCLIProxyAPIQuotaClient(
	connection: CLIProxyAPIQuotaConnection,
	fetchImplementation: Fetch = globalThis.fetch,
): CLIProxyAPIClient {
	return {
		async getModelQuota(modelId, options = {}) {
			const provider = quotaProviderForModel(modelId);
			if (provider === null) return null;
			const response = await fetchImplementation(
				`${connection.quotaUrl}/${provider}`,
				{
					headers: { authorization: `Bearer ${connection.apiKey}` },
					signal: requestSignal(options.signal, DEFAULT_REQUEST_TIMEOUT_MS),
				},
			);
			// The quota service has no credential for this provider.
			if (response.status === 404) return null;
			if (!response.ok) {
				throw new Error(`CLIProxyAPI remote ${provider} quota request failed with HTTP ${response.status}`);
			}
			return parseRemoteCLIProxyAPIQuota(await response.json(), provider);
		},
	};
}

function isCLIProxyAPIQuotaWindow(value: unknown): value is CLIProxyAPIQuotaWindow {
	return isRecord(value) && typeof value.label === "string" &&
		typeof value.usedPercent === "number" && value.usedPercent >= 0 && value.usedPercent <= 100 &&
		(value.resetAtMs === null || (typeof value.resetAtMs === "number" && Number.isFinite(value.resetAtMs)));
}

function parseRemoteCLIProxyAPIQuota(
	value: unknown,
	provider: CLIProxyAPIQuotaProvider,
): CLIProxyAPIModelQuota {
	const windows = isRecord(value) && Array.isArray(value.windows) ? value.windows : [];
	const readyAccounts = isRecord(value) ? value.readyAccounts : undefined;
	const totalAccounts = isRecord(value) ? value.totalAccounts : undefined;
	const fetchedAtMs = isRecord(value) ? value.fetchedAtMs : undefined;
	if (!isRecord(value) || value.provider !== provider || windows.length === 0 ||
		typeof readyAccounts !== "number" || !Number.isInteger(readyAccounts) || readyAccounts < 0 ||
		typeof totalAccounts !== "number" || !Number.isInteger(totalAccounts) || totalAccounts < readyAccounts ||
		typeof fetchedAtMs !== "number" || !Number.isFinite(fetchedAtMs) ||
		!windows.every(isCLIProxyAPIQuotaWindow)) {
		throw new Error(`CLIProxyAPI remote ${provider} quota response is invalid`);
	}
	return { provider, windows: windows.filter(isCLIProxyAPIQuotaWindow), readyAccounts, totalAccounts, fetchedAtMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function quotaProviderForModel(modelId: string): CLIProxyAPIQuotaProvider | null {
	const normalized = modelId.toLowerCase();
	if (normalized.startsWith("claude-")) return "claude";
	if (normalized.startsWith("grok-")) return "xai";
	if (normalized.startsWith("gpt-") || /^o\d/.test(normalized)) return "codex";
	return null;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal === undefined
		? timeoutSignal
		: AbortSignal.any([signal, timeoutSignal]);
}
