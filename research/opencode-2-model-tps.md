# OpenCode 2 model TPS

## Finding

OpenCode 2 reports **turn-level visible output tokens per provider-stream second**:

```text
TPS = sum(step.tokens.output) / (sum(max(0, step.time.streamed - step.time.created)) / 1000)
```

The calculation spans every assistant step after the most recent user or synthetic message through the terminal assistant message. It is a weighted aggregate, `sum(tokens) / sum(time)`, not an average of per-step rates. The implementation is in [`turnTokensPerSecond`](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/tui/src/routes/session/rows.ts#L356-L373). Its test uses two model steps with 20 and 30 output tokens over 2 and 3 stream seconds, producing `50 / 5 = 10 TPS`; the much longer completed times do not enter the calculation ([test](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/tui/test/cli/tui/session-rows.test.ts#L25-L44)).

## Which tokens count

Only `step.tokens.output` enters the numerator. Input tokens, cache reads/writes, and the separate `reasoning` field do not.

That `output` field is already normalized to `usage.visibleOutputTokens`, while `reasoning` is stored separately ([normalization](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/core/src/session/usage.ts#L8-L19)). `visibleOutputTokens` is `max(0, outputTokens - reasoningTokens)` ([usage contract](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/ai/src/schema/events.ts#L64-L82)). Therefore:

- Reported reasoning tokens are excluded from the token count.
- Reasoning time can still be included. The step clock starts before a reasoning block when reasoning is the first streamed content ([lifecycle](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/ai/src/protocols/utils/lifecycle.ts#L36-L57)). The metric can therefore be read as visible tokens over the whole provider response stream, not pure visible-token decoding speed.
- If a provider does not expose a reasoning-token breakdown, OpenCode subtracts zero. The source notes that older Anthropic responses may leave the thinking subset undefined, so hidden reasoning may remain in `output` for such responses ([provider semantics](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/ai/src/schema/events.ts#L47-L57)).

## Timing boundaries

Each step uses two durable event timestamps.

### Start: `time.created`

`time.created` is the timestamp of `session.step.started`. The event publisher stamps events with `Clock.currentTimeMillis` ([bus](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/core/src/bus.ts#L448-L468)), and the message projector copies that timestamp into a new assistant message ([projector](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/core/src/session/message-updater.ts#L200-L240)).

The assistant step starts when the normalized model stream emits `step-start` ([publisher](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/core/src/session/runner/publish-llm-event.ts#L110-L131)). Provider lifecycle helpers synthesize that event before the first text or reasoning block, and at finish if no earlier content started the step ([text/reasoning start](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/ai/src/protocols/utils/lifecycle.ts#L11-L45), [empty/final path](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/ai/src/protocols/utils/lifecycle.ts#L89-L108)). This excludes request setup and time-to-first-stream-event from TPS.

### End: `time.streamed`

After the provider stream exits, the runner publishes `session.step.streamed` before waiting for local tool fibers ([runner](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/core/src/session/runner/llm.ts#L483-L501)). The schema describes it as the provider response-body boundary, independent of tool settlement ([event definition](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/schema/src/session-event.ts#L319-L328)); the projector stores that event time as `time.streamed` ([projector](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/core/src/session/message-updater.ts#L242-L255)). A runner test proves `streamed` is present while a local tool is still running and `completed` is still absent ([test](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/core/test/session-runner.test.ts#L2929-L2954)).

Consequences:

- Local tool execution and inter-step gaps are excluded.
- Provider-stream time for tool-call steps is included, as are their visible output tokens.
- `time.completed` is used for the separate wall-clock duration label, not TPS.

## Live versus final behavior

TPS is **not a live rolling estimate**. The helper uses only persisted token totals and stream-boundary timestamps. Tokens are attached when a step ends, after `time.streamed` has been recorded ([projection order](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/core/src/session/message-updater.ts#L242-L269)). The transcript adds an assistant footer only for a terminal response, retry, or error; ordinary `tool-calls` and `unknown` steps do not get the terminal footer ([row reduction](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/tui/src/routes/session/rows.ts#L296-L328)). The displayed value therefore appears on the completed turn footer and aggregates the turn's preceding model steps.

## Display and configuration

The footer renders:

```text
 · 10.0 tok/s
```

It uses JavaScript `toFixed(1)`, so the value always has one decimal place, followed by the literal `tok/s` ([footer](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/tui/src/routes/session/index.tsx#L1929-L1937)). It is shown in subdued text. There is no TPS-specific terminal-width gate.

`session.tps` controls the display and defaults to `true` ([config schema and default](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/tui/src/config/index.tsx#L139-L141), [default resolution](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/tui/src/config/index.tsx#L269-L273)). The settings dialog exposes it as **Session > TPS**, with off/on choices ([dialog](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/tui/src/component/dialog-config.tsx#L96-L104)).

## Edge cases

The helper returns no value, and the footer omits TPS, when:

- there are no assistant steps;
- any included step lacks `time.streamed`;
- summed output is zero or negative;
- summed duration is zero or negative.

Missing `tokens` on one step contributes zero tokens but its stream duration still counts. A negative per-step duration is clamped to zero. If another step has positive duration, tokens from the zero-duration step still remain in the numerator. There is no minimum sample duration or finish-reason filter in the merged formula, so very short positive windows can produce large values, and an error/interruption can display TPS if it has positive output usage and complete stream timestamps. If the target message is unexpectedly absent from the list, the helper falls back to the list end; if no user or synthetic boundary exists, it uses all preceding assistant messages ([formula and guards](https://github.com/anomalyco/opencode/blob/91028a690be4ae763141878b6c3f57b43c585d80/packages/tui/src/routes/session/rows.ts#L356-L373)).

Because the real rate can be positive but below `0.05`, `toFixed(1)` can display `0.0 tok/s` even though the helper did not return zero.

## Introduction and earlier prototype

The OpenCode 2 implementation was merged into `v2` by [PR #45265, `feat(tui): show LLM token throughput`](https://github.com/anomalyco/opencode/pull/45265). Its merge commit is [`91028a690be4ae763141878b6c3f57b43c585d80`](https://github.com/anomalyco/opencode/commit/91028a690be4ae763141878b6c3f57b43c585d80).

An earlier, still-unmerged [PR #42112](https://github.com/anomalyco/opencode/pull/42112) used a different metric: `(output - 1) / (generated - started)`, only for `stop`/`length` responses, with a 250 ms minimum window ([prototype code](https://github.com/anomalyco/opencode/blob/5e27dd7b3e1d0a6dd9a0e8b1208b9882173fcfb0/packages/tui/src/routes/session/rows.ts#L357-L369)). That prototype is not the formula merged into OpenCode 2. The merged PR instead uses the turn-wide aggregate and durable provider-stream boundary described above.
