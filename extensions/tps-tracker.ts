import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let messageStart: number | null = null;
  let streamStart: number | null = null;
  let estimatedStreamedTokens = 0;
  let totalOutputTokens = 0;
  let totalStreamMs = 0;

  pi.on("agent_start", async (_event, ctx) => {
    totalOutputTokens = 0;
    totalStreamMs = 0;
    messageStart = null;
    streamStart = null;
    estimatedStreamedTokens = 0;
    ctx.ui.setStatus("tps", ctx.ui.theme.fg("dim", "⏱ generating..."));
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    messageStart = Date.now();
    streamStart = null;
    estimatedStreamedTokens = 0;
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    const isOutputDelta = streamEvent.type === "text_delta"
      || streamEvent.type === "thinking_delta"
      || streamEvent.type === "toolcall_delta";

    if (!isOutputDelta) return;

    const now = Date.now();
    streamStart ??= now;
    estimatedStreamedTokens += Math.max(0, streamEvent.delta.length / 4);

    const elapsed = (now - streamStart) / 1000;
    const officialTokens = event.message.usage.output;
    const currentTokens = officialTokens > 0 ? officialTokens : estimatedStreamedTokens;

    if (elapsed > 0 && currentTokens > 0) {
      const tps = Math.round(currentTokens / elapsed);
      const tokenLabel = officialTokens > 0 ? `${officialTokens} tok` : `~${Math.round(estimatedStreamedTokens)} tok`;
      const theme = ctx.ui.theme;
      ctx.ui.setStatus("tps", `${theme.fg("accent", `${tps} tok/s`)} ${theme.fg("dim", `(${tokenLabel} / ${elapsed.toFixed(1)}s)`)}`);
    }
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;

    const messageTokens = event.message.usage.output;
    const timingStart = streamStart ?? messageStart;
    if (timingStart && messageTokens > 0) {
      totalOutputTokens += messageTokens;
      totalStreamMs += Math.max(0, Date.now() - timingStart);
    }

    messageStart = null;
    streamStart = null;
    estimatedStreamedTokens = 0;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const elapsed = totalStreamMs / 1000;
    const tps = totalOutputTokens > 0 && elapsed > 0 ? Math.round(totalOutputTokens / elapsed) : 0;
    const theme = ctx.ui.theme;
    const label = tps > 0 ? theme.fg("accent", `${tps} tok/s`) : theme.fg("dim", "N/A");
    ctx.ui.notify(`${theme.fg("success", "✓")} ${label}  ${theme.fg("dim", `${totalOutputTokens} tokens in ${elapsed.toFixed(1)}s streaming`)}`, "info");
    ctx.ui.setStatus("tps", theme.fg("dim", `done — ${label}`));
  });
}
