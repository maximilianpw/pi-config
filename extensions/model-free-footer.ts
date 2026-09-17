import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function formatTokens(count: number) {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function sanitizeStatusText(text: string) {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function sessionUsage(ctx: ExtensionContext) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let latestCacheHitRate: number | undefined;

  for (const entry of ctx.sessionManager.getEntries()) {
    let usage;
    if (entry.type === "message" && entry.message.role === "assistant") {
      usage = (entry.message as AssistantMessage).usage;
      const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      usage = entry.message.usage;
    } else if (entry.type === "branch_summary" || entry.type === "compaction") {
      usage = entry.usage;
    }

    if (!usage) continue;
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
    cost += usage.cost.total;
  }

  return { input, output, cacheRead, cacheWrite, cost, latestCacheHitRate };
}

function statsContent(ctx: ExtensionContext, theme: Theme, width: number) {
  const usage = sessionUsage(ctx);
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if ((usage.cacheRead || usage.cacheWrite) && usage.latestCacheHitRate !== undefined) {
    parts.push(`CH${usage.latestCacheHitRate.toFixed(1)}%`);
  }
  if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);

  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextDisplay = contextUsage?.percent === null
    ? `?/${formatTokens(contextWindow)} (auto)`
    : `${contextPercentValue.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
  if (contextPercentValue > 90) parts.push(theme.fg("error", contextDisplay));
  else if (contextPercentValue > 70) parts.push(theme.fg("warning", contextDisplay));
  else parts.push(contextDisplay);

  return theme.fg("dim", truncateToWidth(parts.join(" "), width, "..."));
}

export function installModelFreeFooter(
  ctx: ExtensionContext,
  setFooter: ExtensionContext["ui"]["setFooter"] = ctx.ui.setFooter.bind(ctx.ui),
) {
  if (ctx.mode !== "tui") return;

  setFooter((_tui, theme, footerData) => ({
    invalidate() {},
    render(width: number) {
      const stats = statsContent(ctx, theme, width);
      const statsWidth = visibleWidth(stats);
      const statusText = [...footerData.getExtensionStatuses().entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, text]) => sanitizeStatusText(text))
        .join(" ");

      if (statusText === "") {
        return [" ".repeat(Math.max(0, width - statsWidth)) + stats];
      }

      const availableForStatus = Math.max(0, width - statsWidth - 1);
      if (availableForStatus === 0) return [stats];
      const status = truncateToWidth(statusText, availableForStatus, theme.fg("dim", "..."));
      const padding = " ".repeat(Math.max(1, width - visibleWidth(status) - statsWidth));
      return [status + padding + stats];
    },
  }));
}

export default function modelFreeFooter(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    installModelFreeFooter(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
