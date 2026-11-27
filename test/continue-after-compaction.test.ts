import assert from "node:assert/strict";
import test from "node:test";

import continueAfterCompaction, { buildContinuationPrompt } from "../extensions/continue-after-compaction.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const sent: Array<{ text: string; options: unknown }> = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    sendUserMessage: (text: string, options: unknown) => sent.push({ text, options }),
  };
  continueAfterCompaction(pi as never);
  const compact = (reason: string, idle: boolean) =>
    handlers.get("session_compact")?.(
      { reason, compactionEntry: { id: "c1" } },
      { isIdle: () => idle, sessionManager: { getSessionFile: () => "/sessions/a.jsonl" } },
    );
  return { handlers, sent, compact };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("automatic compaction steers the agent to recover context from the session file", async () => {
  const { sent, compact } = harness();
  compact("threshold", false);
  await tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.options, { deliverAs: "steer" });
  assert.match(sent[0]?.text ?? "", /"\/sessions\/a\.jsonl"/);
  assert.match(sent[0]?.text ?? "", /"c1"/);
});

test("a manual /compact at rest waits for the user; one during a run still steers", async () => {
  const { sent, compact } = harness();
  compact("manual", true);
  await tick();
  assert.equal(sent.length, 0);
  compact("manual", false);
  await tick();
  assert.equal(sent.length, 1);
});

test("shutdown cancels a continuation that has not been sent yet", async () => {
  const { handlers, sent, compact } = harness();
  compact("overflow", false);
  handlers.get("session_shutdown")?.({}, {});
  await tick();
  assert.equal(sent.length, 0);
});

test("ephemeral sessions are told there is no session file", () => {
  assert.match(buildContinuationPrompt(undefined, "c1"), /ephemeral/);
});
