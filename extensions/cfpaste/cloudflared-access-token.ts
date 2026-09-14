import { CfPasteError } from "./errors.ts";
import { Redacted, type Redacted as RedactedValue } from "./redacted.ts";
import { failure, type Result, success } from "./result.ts";

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

export type CloudflareAccessToken = RedactedValue<string>;

export interface CloudflaredExecutor {
	execute(args: readonly string[], options: { readonly timeout: number; readonly signal?: AbortSignal }): Promise<{ readonly stdout: string; readonly code: number }>;
}

export interface CloudflareAccessTokenProvider {
	resolveToken(interactive: boolean, signal?: AbortSignal): Promise<Result<CloudflareAccessToken, CfPasteError>>;
	refreshToken(interactive: boolean, signal?: AbortSignal): Promise<Result<CloudflareAccessToken, CfPasteError>>;
}

async function token(executor: CloudflaredExecutor, origin: string, signal?: AbortSignal): Promise<Result<CloudflareAccessToken, CfPasteError>> {
	try {
		const result = await executor.execute(["access", "token", `-app=${origin}`], { timeout: AUTH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
		if (result.code !== 0 || result.stdout.trim() === "") return failure(new CfPasteError("authentication", "Cloudflare Paste authentication requires Access login"));
		return success(Redacted.make(result.stdout.trim()));
	} catch (cause) {
		return failure(new CfPasteError("authentication", "Cloudflare Paste could not run cloudflared", cause));
	}
}

async function login(executor: CloudflaredExecutor, origin: string, interactive: boolean, signal?: AbortSignal): Promise<Result<void, CfPasteError>> {
	if (!interactive) return failure(new CfPasteError("configuration", `Interactive Access login is unavailable; run cloudflared access login -app=${origin} manually`));
	try {
		const result = await executor.execute(["access", "login", "--no-verbose", `-app=${origin}`], { timeout: AUTH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
		return result.code === 0 ? success(undefined) : failure(new CfPasteError("authentication", `Cloudflare Access login failed with exit status ${result.code}`));
	} catch (cause) {
		return failure(new CfPasteError("authentication", "Cloudflare Access login could not start", cause));
	}
}

export function createCloudflareAccessTokenProvider(executor: CloudflaredExecutor, origin: string): CloudflareAccessTokenProvider {
	const refreshToken = async (interactive: boolean, signal?: AbortSignal) => {
		const loggedIn = await login(executor, origin, interactive, signal);
		return loggedIn.ok ? token(executor, origin, signal) : loggedIn;
	};
	return {
		async resolveToken(interactive, signal) {
			const cached = await token(executor, origin, signal);
			return cached.ok ? cached : refreshToken(interactive, signal);
		},
		refreshToken,
	};
}
