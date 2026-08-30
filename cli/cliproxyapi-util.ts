import {
	formatCLIProxyAPIQuotaReport,
	getCLIProxyAPIQuotaReport,
} from "./cliproxyapi-quota.ts";

function printUsage(): void {
	console.log(`Usage: cliproxyapi-util quota [--json]

Commands:
  quota    Report live Codex, Claude, and Grok quota availability

Options:
  --json   Emit stable machine-readable JSON`);
}

async function main(args: readonly string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printUsage();
		return 0;
	}
	const [command, ...options] = args;
	if (command !== "quota" || options.some((option) => option !== "--json")) {
		printUsage();
		return 2;
	}

	const report = await getCLIProxyAPIQuotaReport();
	console.log(
		options.includes("--json")
			? JSON.stringify(report, null, 2)
			: formatCLIProxyAPIQuotaReport(report),
	);
	return 0;
}

process.exitCode = await main(process.argv.slice(2));
