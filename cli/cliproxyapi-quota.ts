import {
	createCLIProxyAPIClient,
	type CLIProxyAPIClient,
	type CLIProxyAPIModelQuota,
} from "../extensions/cliproxyapi/client.ts";

export type CLIProxyAPIRouteFamily = "codex" | "claude" | "grok";
export type CLIProxyAPIAvailability = "available" | "unavailable" | "unknown";

export interface CLIProxyAPIQuotaReportEntry {
	family: CLIProxyAPIRouteFamily;
	status: CLIProxyAPIAvailability;
	usedPercent: number | null;
	readyAccounts: number;
	totalAccounts: number;
}

export interface CLIProxyAPIQuotaReport {
	version: 1;
	families: CLIProxyAPIQuotaReportEntry[];
}

const ROUTE_TARGETS: readonly {
	family: CLIProxyAPIRouteFamily;
	modelId: string;
}[] = [
	{ family: "codex", modelId: "gpt-5.6-sol" },
	{ family: "claude", modelId: "claude-opus-5" },
	{ family: "grok", modelId: "grok-4.6" },
];

function highestUsage(quota: CLIProxyAPIModelQuota): number {
	return Math.max(...quota.windows.map((window) => window.usedPercent));
}

function quotaEntry(
	family: CLIProxyAPIRouteFamily,
	quota: CLIProxyAPIModelQuota | null,
): CLIProxyAPIQuotaReportEntry {
	if (quota === null) {
		return {
			family,
			status: "unavailable",
			usedPercent: null,
			readyAccounts: 0,
			totalAccounts: 0,
		};
	}
	return {
		family,
		status: quota.readyAccounts > 0 ? "available" : "unavailable",
		usedPercent: highestUsage(quota),
		readyAccounts: quota.readyAccounts,
		totalAccounts: quota.totalAccounts,
	};
}

export async function getCLIProxyAPIQuotaReport(
	client: CLIProxyAPIClient = createCLIProxyAPIClient(),
): Promise<CLIProxyAPIQuotaReport> {
	const families = await Promise.all(
		ROUTE_TARGETS.map(async ({ family, modelId }): Promise<CLIProxyAPIQuotaReportEntry> => {
			try {
				return quotaEntry(family, await client.getModelQuota(modelId));
			} catch {
				return {
					family,
					status: "unknown",
					usedPercent: null,
					readyAccounts: 0,
					totalAccounts: 0,
				};
			}
		}),
	);
	return { version: 1, families };
}

function percentageText(value: number | null): string {
	if (value === null) return "-";
	return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function accountsText(entry: CLIProxyAPIQuotaReportEntry): string {
	return entry.totalAccounts === 0
		? "-"
		: `${entry.readyAccounts}/${entry.totalAccounts}`;
}

export function formatCLIProxyAPIQuotaReport(report: CLIProxyAPIQuotaReport): string {
	const rows = [
		["family", "status", "usage", "accounts"],
		...report.families.map((entry) => [
			entry.family,
			entry.status,
			percentageText(entry.usedPercent),
			accountsText(entry),
		]),
	];
	const widths = rows[0]?.map((_, column) =>
		Math.max(...rows.map((row) => row[column]?.length ?? 0)),
	) ?? [];
	return rows
		.map((row) =>
			row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd(),
		)
		.join("\n");
}
