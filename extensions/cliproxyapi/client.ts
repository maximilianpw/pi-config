import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLIPROXYAPI_PROVIDER_ID = "cliproxyapi";
export const CLIPROXYAPI_ROOT_URL = "http://127.0.0.1:8317";
export const CLIPROXYAPI_BASE_URL = `${CLIPROXYAPI_ROOT_URL}/v1`;
export const CLIPROXYAPI_API_KEY = "cliproxyapi-local-claudex";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const XAI_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const DEFAULT_CACHE_TTL_MS = 15_000;
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

export interface CLIProxyAPIAccountQuota {
	windows: CLIProxyAPIQuotaWindow[];
	ready: boolean;
}

interface StoredAuthRecord {
	provider: CLIProxyAPIQuotaProvider;
	accessToken: string;
	accountId: string | null;
}

export interface CLIProxyAPIClientOptions {
	authDirectory?: string;
	cacheTtlMs?: number;
	requestTimeoutMs?: number;
	fetch?: Fetch;
	now?: () => number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function percentage(value: unknown): number | null {
	const parsed = finiteNumber(value);
	return parsed === null ? null : Math.max(0, Math.min(100, parsed));
}

function timestampMs(value: unknown): number | null {
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	const parsed = finiteNumber(value);
	if (parsed === null || parsed <= 0) return null;
	return parsed < 100_000_000_000 ? parsed * 1_000 : parsed;
}

function durationLabel(seconds: number | null): string {
	if (seconds === null || seconds <= 0) return "usage";
	if (seconds === 18_000) return "5h";
	if (seconds === 604_800) return "7d";
	if (seconds >= 2_419_200 && seconds <= 2_678_400) return "30d";
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	return "usage";
}

function windowDurationSeconds(value: Record<string, unknown>): number | null {
	return finiteNumber(value.limit_window_seconds ?? value.limitWindowSeconds);
}

function parseCodexWindow(value: unknown): CLIProxyAPIQuotaWindow | null {
	if (!isRecord(value)) return null;
	const usedPercent = percentage(value.used_percent ?? value.usedPercent);
	if (usedPercent === null) return null;
	return {
		label: durationLabel(windowDurationSeconds(value)),
		usedPercent,
		resetAtMs: timestampMs(value.reset_at ?? value.resetAt),
	};
}

export function parseCodexQuota(payload: unknown): CLIProxyAPIAccountQuota {
	if (!isRecord(payload)) {
		throw new Error("CLIProxyAPI Codex quota response must be an object");
	}
	const rateLimit = payload.rate_limit ?? payload.rateLimit;
	if (!isRecord(rateLimit)) {
		throw new Error("CLIProxyAPI Codex quota response must contain rate_limit");
	}

	const windows = [
		parseCodexWindow(rateLimit.primary_window ?? rateLimit.primaryWindow),
		parseCodexWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow),
	].filter((window): window is CLIProxyAPIQuotaWindow => window !== null);
	if (windows.length === 0) {
		throw new Error("CLIProxyAPI Codex quota response contains no usage windows");
	}

	const allowed = rateLimit.allowed;
	const limitReached = rateLimit.limit_reached ?? rateLimit.limitReached;
	return {
		windows: windows.sort((left, right) => {
			const order = new Map([
				["5h", 0],
				["7d", 1],
				["30d", 2],
			]);
			return (order.get(left.label) ?? 3) - (order.get(right.label) ?? 3);
		}),
		ready:
			allowed !== false &&
			limitReached !== true &&
			windows.every((window) => window.usedPercent < 100),
	};
}

function parseClaudeWindow(
	value: unknown,
	label: string,
): CLIProxyAPIQuotaWindow | null {
	if (!isRecord(value)) return null;
	const usedPercent = percentage(value.utilization);
	if (usedPercent === null) return null;
	return {
		label,
		usedPercent,
		resetAtMs: timestampMs(value.resets_at ?? value.resetsAt),
	};
}

export function parseClaudeQuota(payload: unknown): CLIProxyAPIAccountQuota {
	if (!isRecord(payload)) {
		throw new Error("CLIProxyAPI Claude quota response must be an object");
	}
	const windows = [
		parseClaudeWindow(payload.five_hour ?? payload.fiveHour, "5h"),
		parseClaudeWindow(payload.seven_day ?? payload.sevenDay, "7d"),
	].filter((window): window is CLIProxyAPIQuotaWindow => window !== null);
	if (windows.length === 0) {
		throw new Error("CLIProxyAPI Claude quota response contains no usage windows");
	}
	return {
		windows,
		ready: windows.every((window) => window.usedPercent < 100),
	};
}

export function parseXAIQuota(payload: unknown): CLIProxyAPIAccountQuota {
	if (!isRecord(payload)) {
		throw new Error("CLIProxyAPI xAI quota response must be an object");
	}
	const config = isRecord(payload.config) ? payload.config : payload;
	const usedPercent = percentage(config.creditUsagePercent ?? config.credit_usage_percent);
	if (usedPercent === null) {
		throw new Error("CLIProxyAPI xAI quota response must contain creditUsagePercent");
	}

	const period = isRecord(config.currentPeriod)
		? config.currentPeriod
		: isRecord(config.current_period)
			? config.current_period
			: null;
	const startMs = timestampMs(period?.start);
	const endMs = timestampMs(period?.end);
	const durationSeconds =
		startMs !== null && endMs !== null && endMs > startMs
			? Math.round((endMs - startMs) / 1_000)
			: null;
	const periodType =
		typeof period?.type === "string" ? period.type.toLowerCase() : "";
	const label = periodType.includes("weekly") ? "7d" : durationLabel(durationSeconds);

	return {
		windows: [{ label, usedPercent, resetAtMs: endMs }],
		ready: usedPercent < 100,
	};
}

export function quotaProviderForModel(modelId: string): CLIProxyAPIQuotaProvider | null {
	const normalized = modelId.toLowerCase();
	if (normalized.startsWith("claude-")) return "claude";
	if (normalized.startsWith("grok-")) return "xai";
	if (normalized.startsWith("gpt-") || /^o\d/.test(normalized)) return "codex";
	return null;
}

function authProvider(value: unknown): CLIProxyAPIQuotaProvider | null {
	return value === "claude" || value === "codex" || value === "xai"
		? value
		: null;
}

async function readStoredAuthRecords(authDirectory: string): Promise<StoredAuthRecord[]> {
	let names: string[];
	try {
		names = await readdir(authDirectory);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	}

	const records = await Promise.all(
		names
			.filter((name) => name.endsWith(".json"))
			.map(async (name): Promise<StoredAuthRecord | null> => {
				try {
					const payload: unknown = JSON.parse(
						await readFile(join(authDirectory, name), "utf8"),
					);
					if (!isRecord(payload) || payload.disabled === true) return null;
					const provider = authProvider(payload.type);
					if (provider === null || typeof payload.access_token !== "string") return null;
					if (payload.access_token.length === 0) return null;
					return {
						provider,
						accessToken: payload.access_token,
						accountId:
							typeof payload.account_id === "string" && payload.account_id.length > 0
								? payload.account_id
								: null,
					};
				} catch {
					return null;
				}
			}),
	);
	return records.filter((record): record is StoredAuthRecord => record !== null);
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal === undefined
		? timeoutSignal
		: AbortSignal.any([signal, timeoutSignal]);
}

async function fetchQuota(
	fetchImplementation: Fetch,
	record: StoredAuthRecord,
	signal: AbortSignal,
): Promise<CLIProxyAPIAccountQuota> {
	const headers: Record<string, string> = {
		authorization: `Bearer ${record.accessToken}`,
	};
	let url: string;
	if (record.provider === "claude") {
		url = CLAUDE_USAGE_URL;
		headers["anthropic-beta"] = "oauth-2025-04-20";
		headers["content-type"] = "application/json";
	} else if (record.provider === "codex") {
		url = CODEX_USAGE_URL;
		headers["content-type"] = "application/json";
		headers["user-agent"] = "codex-tui/0.149.1";
		if (record.accountId !== null) headers["chatgpt-account-id"] = record.accountId;
	} else {
		url = XAI_USAGE_URL;
		headers.accept = "*/*";
		headers["user-agent"] = "grok-pager/0.2.91 grok-shell/0.2.91";
		headers["x-grok-client-version"] = "0.2.91";
		headers["x-xai-token-auth"] = "xai-grok-cli";
	}

	const response = await fetchImplementation(url, { headers, signal });
	if (!response.ok) {
		throw new Error(`CLIProxyAPI ${record.provider} quota request failed with HTTP ${response.status}`);
	}
	const payload: unknown = await response.json();
	if (record.provider === "claude") return parseClaudeQuota(payload);
	return record.provider === "codex" ? parseCodexQuota(payload) : parseXAIQuota(payload);
}

function quotaScore(quota: CLIProxyAPIAccountQuota): number {
	return Math.max(...quota.windows.map((window) => window.usedPercent));
}

function selectAccountQuota(
	quotas: readonly CLIProxyAPIAccountQuota[],
): CLIProxyAPIAccountQuota {
	const ready = quotas.filter((quota) => quota.ready);
	const candidates = ready.length > 0 ? ready : quotas;
	const selected = [...candidates].sort(
		(left, right) => quotaScore(left) - quotaScore(right),
	)[0];
	if (selected === undefined) {
		throw new Error("CLIProxyAPI quota selection requires at least one account");
	}
	return selected;
}

export function createCLIProxyAPIClient(
	options: CLIProxyAPIClientOptions = {},
): CLIProxyAPIClient {
	const authDirectory = options.authDirectory ?? join(homedir(), ".cli-proxy-api");
	const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	const cache = new Map<CLIProxyAPIQuotaProvider, CLIProxyAPIModelQuota>();

	return {
		async getModelQuota(modelId, requestOptions = {}) {
			const provider = quotaProviderForModel(modelId);
			if (provider === null) return null;

			const cached = cache.get(provider);
			if (
				requestOptions.force !== true &&
				cached !== undefined &&
				now() - cached.fetchedAtMs < cacheTtlMs
			) {
				return cached;
			}

			const authRecords = (await readStoredAuthRecords(authDirectory)).filter(
				(record) => record.provider === provider,
			);
			if (authRecords.length === 0) return null;

			const signal = requestSignal(requestOptions.signal, requestTimeoutMs);
			const results = await Promise.allSettled(
				authRecords.map((record) => fetchQuota(fetchImplementation, record, signal)),
			);
			const quotas = results.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : [],
			);
			if (quotas.length === 0) {
				throw new Error(`CLIProxyAPI ${provider} quota request failed for every account`);
			}

			const selected = selectAccountQuota(quotas);
			const quota: CLIProxyAPIModelQuota = {
				provider,
				windows: selected.windows,
				readyAccounts: quotas.filter((account) => account.ready).length,
				totalAccounts: authRecords.length,
				fetchedAtMs: now(),
			};
			cache.set(provider, quota);
			return quota;
		},
	};
}
