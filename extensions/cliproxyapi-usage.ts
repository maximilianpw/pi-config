import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CLIPROXYAPI_PROVIDER_ID,
	createCLIProxyAPIClient,
	type CLIProxyAPIModelQuota,
} from "./cliproxyapi/client.ts";

const STATUS_KEY = "cliproxyapi-usage";

function formatUsedPercent(usedPercent: number): string {
	return Number.isInteger(usedPercent)
		? String(usedPercent)
		: usedPercent.toFixed(1);
}

function highestQuotaUsage(quota: CLIProxyAPIModelQuota): number {
	return Math.max(...quota.windows.map((window) => window.usedPercent));
}

export function formatCLIProxyAPIQuotaText(quota: CLIProxyAPIModelQuota): string {
	const usedPercent = formatUsedPercent(highestQuotaUsage(quota));
	const accountStatus =
		quota.totalAccounts > 1
			? ` · ${quota.readyAccounts}/${quota.totalAccounts} ready`
			: "";
	return `quota ${usedPercent}%${accountStatus}`;
}

function quotaColor(quota: CLIProxyAPIModelQuota): "error" | "warning" | "success" {
	const highestUsage = highestQuotaUsage(quota);
	if (quota.readyAccounts === 0 || highestUsage >= 100) return "error";
	if (highestUsage >= 80) return "warning";
	return "success";
}

function clearStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

export default function cliProxyAPIUsage(pi: ExtensionAPI): void {
	const client = createCLIProxyAPIClient();
	let refreshGeneration = 0;

	function refresh(
		ctx: ExtensionContext,
		provider: string | undefined,
		modelId: string | undefined,
		force = false,
	): void {
		const generation = ++refreshGeneration;
		if (!ctx.hasUI || provider !== CLIPROXYAPI_PROVIDER_ID || modelId === undefined) {
			clearStatus(ctx);
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "quota …"));
		void client
			.getModelQuota(modelId, { force })
			.then((quota) => {
				if (generation !== refreshGeneration) return;
				if (quota === null) {
					clearStatus(ctx);
					return;
				}
				ctx.ui.setStatus(
					STATUS_KEY,
					ctx.ui.theme.fg(quotaColor(quota), formatCLIProxyAPIQuotaText(quota)),
				);
			})
			.catch(() => {
				if (generation !== refreshGeneration) return;
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "quota unavailable"));
			});
	}

	pi.on("session_start", (_event, ctx) => {
		refresh(ctx, ctx.model?.provider, ctx.model?.id);
	});

	pi.on("model_select", (event, ctx) => {
		refresh(ctx, event.model.provider, event.model.id, true);
	});

	pi.on("agent_settled", (_event, ctx) => {
		refresh(ctx, ctx.model?.provider, ctx.model?.id, true);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		refreshGeneration += 1;
		clearStatus(ctx);
	});
}
