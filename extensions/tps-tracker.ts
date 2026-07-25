import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const LIVE_UPDATE_INTERVAL_MS = 200;
const STATUS_KEY = "tps";

function estimateTokens(characters: number) {
  return Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
}

function setStatus(ctx: ExtensionContext, text: string) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, text);
}

export default function tpsTracker(pi: ExtensionAPI) {
  let contentStreamStart: number | null = null;
  let lastContentDeltaAt: number | null = null;
  let contentCharacters = 0;
  let firstContentDeltaCharacters = 0;
  let contentDeltaCount = 0;
  let sawToolCall = false;
  let runContentTokens = 0;
  let runContentStreamMs = 0;
  let lastLiveUpdate = 0;

  function resetMessageTracking() {
    contentStreamStart = null;
    lastContentDeltaAt = null;
    contentCharacters = 0;
    firstContentDeltaCharacters = 0;
    contentDeltaCount = 0;
    sawToolCall = false;
    lastLiveUpdate = 0;
  }

  pi.on("agent_start", (_event, ctx) => {
    runContentTokens = 0;
    runContentStreamMs = 0;
    resetMessageTracking();
    setStatus(ctx, ctx.ui.theme.fg("dim", "⏱ generating…"));
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") resetMessageTracking();
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type === "toolcall_delta") {
      sawToolCall = true;
      return;
    }
    if (
      streamEvent.type !== "text_delta" &&
      streamEvent.type !== "thinking_delta"
    ) {
      return;
    }
    if (!streamEvent.delta) return;

    const now = Date.now();
    if (contentStreamStart === null) {
      contentStreamStart = now;
      firstContentDeltaCharacters = streamEvent.delta.length;
    }
    lastContentDeltaAt = now;
    contentCharacters += streamEvent.delta.length;
    contentDeltaCount += 1;

    const elapsedMs = now - contentStreamStart;
    const streamedCharacters = contentCharacters - firstContentDeltaCharacters;
    if (
      contentDeltaCount < 2 ||
      elapsedMs <= 0 ||
      streamedCharacters <= 0 ||
      now - lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS
    ) {
      return;
    }
    lastLiveUpdate = now;

    const tps = estimateTokens(streamedCharacters) / (elapsedMs / 1_000);
    const theme = ctx.ui.theme;
    setStatus(
      ctx,
      `${theme.fg("accent", `${Math.round(tps)} tok/s`)} ${theme.fg("dim", `(~${estimateTokens(streamedCharacters)} streamed)`)}`,
    );
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;

    sawToolCall ||= event.message.content.some(
      (block) => block.type === "toolCall",
    );

    if (contentStreamStart !== null && contentCharacters > 0) {
      const streamEnd = lastContentDeltaAt ?? contentStreamStart;
      const streamMs = streamEnd - contentStreamStart;
      const firstDeltaTokens = estimateTokens(firstContentDeltaCharacters);
      const streamedTokens =
        !sawToolCall && event.message.usage.output > 0
          ? Math.max(0, event.message.usage.output - firstDeltaTokens)
          : Math.max(0, estimateTokens(contentCharacters) - firstDeltaTokens);

      if (contentDeltaCount >= 2 && streamMs >= 50 && streamedTokens > 0) {
        runContentTokens += streamedTokens;
        runContentStreamMs += streamMs;
      }
    }

    resetMessageTracking();
  });

  pi.on("agent_settled", (_event, ctx) => {
    const elapsedSeconds = runContentStreamMs / 1_000;
    const tps =
      runContentTokens > 0 && elapsedSeconds > 0
        ? runContentTokens / elapsedSeconds
        : null;
    const theme = ctx.ui.theme;
    setStatus(
      ctx,
      tps === null
        ? theme.fg("dim", "TPS unavailable")
        : `${theme.fg("accent", `${Math.round(tps)} tok/s`)} ${theme.fg("dim", `(${runContentTokens} tok / ${elapsedSeconds.toFixed(1)}s)`)}`,
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
