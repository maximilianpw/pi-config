import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createTpsTracker } from "../extensions/tps-tracker.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function assistantMessage(
  usage: Partial<AssistantMessage["usage"]> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      ...usage,
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function setupTracker() {
  let currentTime = 0;
  const statuses: Array<string | undefined> = [];
  const handlers = new Map<string, EventHandler>();
  const recordingApi = {
    on(eventName: string, handler: EventHandler) {
      handlers.set(eventName, handler);
    },
  };
  // SAFETY: createTpsTracker only uses ExtensionAPI.on; recordingApi implements that operation and records every registered handler.
  const pi = recordingApi as unknown as ExtensionAPI;
  // SAFETY: the tracker only reads hasUI, ui.theme.fg, and ui.setStatus from the event context.
  const ctx = {
    hasUI: true,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      setStatus: (_key: string, text: string | undefined) => {
        statuses.push(text);
      },
    },
  } as unknown as ExtensionContext;

  createTpsTracker({ now: () => currentTime, liveUpdateIntervalMs: 0 })(pi);

  return {
    statuses,
    setTime(value: number) {
      currentTime = value;
    },
    emit(eventName: string, event: unknown) {
      const handler = handlers.get(eventName);
      assert.ok(handler, `Missing ${eventName} handler`);
      return handler(event, ctx);
    },
  };
}

test("aggregates visible output throughput across model steps and excludes tool time", () => {
  const tracker = setupTracker();

  tracker.emit("agent_start", { type: "agent_start" });
  tracker.setTime(50);
  tracker.emit("message_end", {
    type: "message_end",
    message: { role: "user", content: "Question", timestamp: 50 },
  });

  tracker.setTime(100);
  tracker.emit("message_start", {
    type: "message_start",
    message: assistantMessage(),
  });
  tracker.setTime(200);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "thinking_start",
      contentIndex: 0,
      partial: assistantMessage(),
    },
  });
  tracker.setTime(1_200);
  tracker.emit("message_end", {
    type: "message_end",
    message: assistantMessage({ output: 30, reasoning: 10 }),
  });

  tracker.setTime(5_000);
  tracker.emit("message_start", {
    type: "message_start",
    message: assistantMessage(),
  });
  tracker.setTime(5_100);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      partial: assistantMessage(),
    },
  });
  tracker.setTime(7_100);
  tracker.emit("message_end", {
    type: "message_end",
    message: assistantMessage({ output: 50, reasoning: 20 }),
  });

  tracker.setTime(20_000);
  tracker.emit("agent_settled", { type: "agent_settled" });

  assert.equal(tracker.statuses.at(-1), "16.7 tok/s (50 tok / 3.0s)");
});

test("keeps live TPS approximate and excludes thinking characters", () => {
  const tracker = setupTracker();

  tracker.emit("agent_start", { type: "agent_start" });
  tracker.setTime(100);
  tracker.emit("message_start", {
    type: "message_start",
    message: assistantMessage(),
  });
  tracker.setTime(200);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "thinking_start",
      contentIndex: 0,
      partial: assistantMessage(),
    },
  });
  tracker.setTime(1_000);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "x".repeat(400),
      partial: assistantMessage(),
    },
  });

  assert.equal(tracker.statuses.at(-1), "⏱ generating…");

  tracker.setTime(1_200);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "x".repeat(40),
      partial: assistantMessage(),
    },
  });

  assert.equal(tracker.statuses.at(-1), "~10.0 tok/s (~10 tok)");
});

test("includes reasoning-only stream time in the aggregate denominator", () => {
  const tracker = setupTracker();

  tracker.emit("agent_start", { type: "agent_start" });
  tracker.setTime(100);
  tracker.emit("message_start", {
    type: "message_start",
    message: assistantMessage(),
  });
  tracker.setTime(200);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "thinking_start",
      contentIndex: 0,
      partial: assistantMessage(),
    },
  });
  tracker.setTime(1_200);
  tracker.emit("message_end", {
    type: "message_end",
    message: assistantMessage({ output: 20, reasoning: 20 }),
  });

  tracker.setTime(2_000);
  tracker.emit("message_start", {
    type: "message_start",
    message: assistantMessage(),
  });
  tracker.setTime(2_100);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "text_start",
      contentIndex: 0,
      partial: assistantMessage(),
    },
  });
  tracker.setTime(3_100);
  tracker.emit("message_end", {
    type: "message_end",
    message: assistantMessage({ output: 20, reasoning: 0 }),
  });
  tracker.emit("agent_settled", { type: "agent_settled" });

  assert.equal(tracker.statuses.at(-1), "10.0 tok/s (20 tok / 2.0s)");
});

test("keeps continuation steps until settlement and resets the next operation", () => {
  const tracker = setupTracker();

  tracker.emit("agent_start", { type: "agent_start" });
  tracker.setTime(100);
  tracker.emit("message_start", {
    type: "message_start",
    message: assistantMessage(),
  });
  tracker.setTime(200);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "text_start",
      contentIndex: 0,
      partial: assistantMessage(),
    },
  });
  tracker.setTime(1_200);
  tracker.emit("message_end", {
    type: "message_end",
    message: assistantMessage({ output: 10 }),
  });

  tracker.emit("agent_start", { type: "agent_start" });
  tracker.setTime(2_000);
  tracker.emit("message_start", {
    type: "message_start",
    message: assistantMessage(),
  });
  tracker.setTime(2_100);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "text_start",
      contentIndex: 0,
      partial: assistantMessage(),
    },
  });
  tracker.setTime(3_100);
  tracker.emit("message_end", {
    type: "message_end",
    message: assistantMessage({ output: 30 }),
  });
  tracker.emit("agent_settled", { type: "agent_settled" });

  assert.equal(tracker.statuses.at(-1), "20.0 tok/s (40 tok / 2.0s)");

  tracker.emit("agent_start", { type: "agent_start" });
  tracker.setTime(4_000);
  tracker.emit("message_start", {
    type: "message_start",
    message: assistantMessage(),
  });
  tracker.setTime(4_100);
  tracker.emit("message_update", {
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: {
      type: "text_start",
      contentIndex: 0,
      partial: assistantMessage(),
    },
  });
  tracker.setTime(6_100);
  tracker.emit("message_end", {
    type: "message_end",
    message: assistantMessage({ output: 20 }),
  });
  tracker.emit("agent_settled", { type: "agent_settled" });

  assert.equal(tracker.statuses.at(-1), "10.0 tok/s (20 tok / 2.0s)");
});

test("reports unavailable when the provider reports no visible output or stream time", () => {
  const tracker = setupTracker();

  tracker.emit("agent_start", { type: "agent_start" });
  tracker.emit("agent_settled", { type: "agent_settled" });

  assert.equal(tracker.statuses.at(-1), "TPS unavailable");
});
