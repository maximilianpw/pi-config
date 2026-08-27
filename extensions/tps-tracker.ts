import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const LIVE_UPDATE_INTERVAL_MS = 200;
const STATUS_KEY = "tps";

export interface TpsTrackerOptions {
  now?: () => number;
  liveUpdateIntervalMs?: number;
}

function estimateTokens(characters: number) {
  return Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
}

function visibleOutputTokens(output: number, reasoning: number | undefined) {
  const safeOutput = Number.isFinite(output) ? Math.max(0, output) : 0;
  const safeReasoning = Number.isFinite(reasoning) ? Math.max(0, reasoning ?? 0) : 0;
  return Math.max(0, safeOutput - safeReasoning);
}

function setStatus(ctx: ExtensionContext, text: string) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, text);
}

export function createTpsTracker(options: TpsTrackerOptions = {}) {
  const now = options.now ?? (() => performance.now());
  const liveUpdateIntervalMs =
    options.liveUpdateIntervalMs ?? LIVE_UPDATE_INTERVAL_MS;

  return function tpsTracker(pi: ExtensionAPI) {
    let stepStartedAt: number | null = null;
    let stepHasStreamUpdate = false;
    let stepVisibleCharacters = 0;
    let runVisibleTokens = 0;
    let runStreamMs = 0;
    let operationActive = false;
    let lastLiveUpdate = Number.NEGATIVE_INFINITY;

    function resetStepTracking() {
      stepStartedAt = null;
      stepHasStreamUpdate = false;
      stepVisibleCharacters = 0;
      lastLiveUpdate = Number.NEGATIVE_INFINITY;
    }

    function resetRunTracking() {
      runVisibleTokens = 0;
      runStreamMs = 0;
      resetStepTracking();
    }

    pi.on("agent_start", (_event, ctx) => {
      if (!operationActive) {
        resetRunTracking();
        operationActive = true;
      } else {
        resetStepTracking();
      }
      setStatus(ctx, ctx.ui.theme.fg("dim", "⏱ generating…"));
    });

    pi.on("message_start", (event) => {
      if (event.message.role !== "assistant") return;
      resetStepTracking();
      stepStartedAt = now();
    });

    pi.on("message_update", (event, ctx) => {
      if (event.message.role !== "assistant") return;

      const currentTime = now();
      if (!stepHasStreamUpdate) {
        stepStartedAt = currentTime;
        stepHasStreamUpdate = true;
      }

      const streamEvent = event.assistantMessageEvent;
      if (
        streamEvent.type !== "text_delta" &&
        streamEvent.type !== "toolcall_delta"
      ) {
        return;
      }
      if (!streamEvent.delta) return;

      stepVisibleCharacters += streamEvent.delta.length;
      const stepElapsedMs = currentTime - (stepStartedAt ?? currentTime);
      const estimatedStepTokens = estimateTokens(stepVisibleCharacters);
      const totalTokens = runVisibleTokens + estimatedStepTokens;
      const totalElapsedMs = runStreamMs + Math.max(0, stepElapsedMs);
      if (
        totalTokens <= 0 ||
        totalElapsedMs <= 0 ||
        currentTime - lastLiveUpdate < liveUpdateIntervalMs
      ) {
        return;
      }
      lastLiveUpdate = currentTime;

      const tps = totalTokens / (totalElapsedMs / 1_000);
      const theme = ctx.ui.theme;
      setStatus(
        ctx,
        `${theme.fg("accent", `~${tps.toFixed(1)} tok/s`)} ${theme.fg("dim", `(~${totalTokens} tok)`)}`,
      );
    });

    pi.on("message_end", (event) => {
      if (event.message.role === "user") {
        resetRunTracking();
        return;
      }
      if (event.message.role !== "assistant") return;

      const streamEnd = now();
      const streamStart = stepStartedAt ?? streamEnd;
      const streamMs = Math.max(0, streamEnd - streamStart);
      const tokens = visibleOutputTokens(
        event.message.usage.output,
        event.message.usage.reasoning,
      );

      if (tokens > 0) runVisibleTokens += tokens;
      if (streamMs > 0) runStreamMs += streamMs;

      resetStepTracking();
    });

    pi.on("agent_settled", (_event, ctx) => {
      const elapsedSeconds = runStreamMs / 1_000;
      const tps =
        runVisibleTokens > 0 && elapsedSeconds > 0
          ? runVisibleTokens / elapsedSeconds
          : null;
      const theme = ctx.ui.theme;
      setStatus(
        ctx,
        tps === null
          ? theme.fg("dim", "TPS unavailable")
          : `${theme.fg("accent", `${tps.toFixed(1)} tok/s`)} ${theme.fg("dim", `(${runVisibleTokens} tok / ${elapsedSeconds.toFixed(1)}s)`)}`,
      );
      operationActive = false;
      resetStepTracking();
    });

    pi.on("session_shutdown", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createTpsTracker();
