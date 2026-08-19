import { readStoredCredential } from "@earendil-works/pi-coding-agent";

export const CURSOR_API_KEY_PLACEHOLDER = "pi-cursor-grok-api-key-placeholder";

const PLACEHOLDERS = new Set([
	CURSOR_API_KEY_PLACEHOLDER,
	"CURSOR_API_KEY",
	"$CURSOR_API_KEY",
	"${CURSOR_API_KEY}",
]);

function usableKey(value: string | undefined): string | undefined {
	const key = value?.trim();
	return key && !PLACEHOLDERS.has(key) ? key : undefined;
}

export function resolveCursorApiKey(providerKey: string | undefined): string | undefined {
	const direct = usableKey(providerKey);
	if (direct) return direct;
	try {
		const credential = readStoredCredential("cursor");
		if (credential?.type === "api_key") {
			const stored = usableKey(credential.key);
			if (stored) return stored;
		}
	} catch {
		// Fall through to the environment when Pi's credential store is unavailable.
	}
	return usableKey(process.env.CURSOR_API_KEY);
}
