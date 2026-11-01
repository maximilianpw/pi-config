import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createProgramStatus } from "../extensions/program-status.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function decode(sequence: string) {
  const match = /^\x1b\]7501;(.*)\x1b\\$/.exec(sequence);
  assert.ok(match, `Not an OSC 7501 report: ${JSON.stringify(sequence)}`);
  const pairs = Object.fromEntries(match[1].split(":").map((pair) => pair.split("=", 2) as [string, string]));
  if (pairs.msg) pairs.msg = Buffer.from(pairs.msg, "base64").toString("utf8");
  return pairs;
}

function setup(mode = "tui") {
  const written: string[] = [];
  const handlers = new Map<string, EventHandler>();
  const bus = new EventEmitter();
  let idle = true;
  // SAFETY: the extension only uses ExtensionAPI.on and ExtensionAPI.events.on/emit; both are implemented here.
  const pi = {
    on(eventName: string, handler: EventHandler) {
      handlers.set(eventName, handler);
    },
    events: {
      on: (name: string, handler: (data: unknown) => void) => bus.on(name, handler),
      emit: (name: string, data: unknown) => bus.emit(name, data),
    },
  } as unknown as ExtensionAPI;
  // SAFETY: the extension only reads mode and isIdle from the event context.
  const ctx = { mode, isIdle: () => idle } as unknown as ExtensionContext;

  createProgramStatus({ write: (sequence) => written.push(sequence) })(pi);

  return {
    reports: () => written.map(decode),
    setIdle(value: boolean) {
      idle = value;
    },
    emit(eventName: string, event: Record<string, unknown> = {}) {
      const handler = handlers.get(eventName);
      assert.ok(handler, `Missing ${eventName} handler`);
      return handler({ type: eventName, ...event }, ctx);
    },
    emitBus(name: string, data: unknown) {
      bus.emit(name, data);
    },
  };
}

function assistant(stopReason: string, errorMessage?: string) {
  return { role: "assistant", content: [], stopReason, errorMessage, timestamp: 0 };
}

function runAgent(status: ReturnType<typeof setup>, last = assistant("stop")) {
  status.setIdle(false);
  status.emit("agent_start");
  status.emit("agent_end", { messages: [last] });
  status.setIdle(true);
  status.emit("agent_settled");
}

test("reports working while the agent runs and done once it settles", () => {
  const status = setup();
  status.emit("session_start", { reason: "startup" });
  runAgent(status);

  assert.deepEqual(status.reports(), [
    { state: "idle", app: "pi" },
    { state: "working", app: "pi" },
    { state: "done", app: "pi" },
  ]);
});

test("reports an ask_user question as blocked with its text, then resumes working", () => {
  const status = setup();
  status.emit("session_start", { reason: "startup" });
  status.setIdle(false);
  status.emit("agent_start");

  status.emitBus("herdr:blocked", { active: true, label: "Question: Ship it?\nyes/no" });
  status.emit("ui_prompt_start", { reason: "ui_prompt", kind: "custom" });
  status.emit("ui_prompt_end", { reason: "ui_prompt", kind: "custom" });
  status.emitBus("herdr:blocked", { active: false });

  assert.deepEqual(status.reports().slice(1), [
    { state: "working", app: "pi" },
    { state: "blocked", app: "pi", kind: "question", msg: "Question: Ship it? yes/no" },
    { state: "working", app: "pi" },
  ]);
});

test("reports a confirm dialog as a blocked permission request", () => {
  const status = setup();
  status.emit("session_start", { reason: "startup" });
  status.setIdle(false);
  status.emit("agent_start");
  status.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Dangerous bash command" });

  assert.deepEqual(status.reports().at(-1), {
    state: "blocked",
    app: "pi",
    kind: "permission",
    msg: "Dangerous bash command",
  });
});

test("reports idle after an interrupted run and error after a failed run", () => {
  const status = setup();
  status.emit("session_start", { reason: "startup" });
  runAgent(status, assistant("aborted"));
  runAgent(status, assistant("error", "429 rate limited"));

  assert.deepEqual(status.reports().slice(1), [
    { state: "working", app: "pi" },
    { state: "idle", app: "pi" },
    { state: "working", app: "pi" },
    { state: "error", app: "pi", msg: "429 rate limited" },
  ]);
});

test("clears its records when Pi quits", () => {
  const status = setup();
  status.emit("session_start", { reason: "startup" });
  runAgent(status);
  status.emit("session_shutdown", { reason: "quit" });

  assert.deepEqual(status.reports().at(-1), { state: "clear" });
});

test("writes nothing outside the TUI", () => {
  const status = setup("rpc");
  status.emit("session_start", { reason: "startup" });
  runAgent(status);
  status.emitBus("herdr:blocked", { active: true, label: "Question" });

  assert.deepEqual(status.reports(), []);
});
