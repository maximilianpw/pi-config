import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  createRefreshCoordinator,
  createVcsStatusWidget,
  formatStatusBar,
  getSummary,
  projectName,
  updateWidget,
  type RunVcsCommand,
} from "../extensions/vcs-status-widget.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function context(cwd: string, writes: Array<string[] | undefined> = []) {
  return {
    cwd,
    hasUI: true,
    model: {
      id: "gpt-5.6-luna",
      name: "GPT 5.6 Luna",
      reasoning: true,
      contextWindow: 272_000,
    },
    thinkingLevel: "high",
    getContextUsage() {
      return { tokens: 105_536, contextWindow: 272_000, percent: 38.8 };
    },
    sessionManager: {
      getEntries() {
        return [{
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 103_000,
              output: 18_000,
              cacheRead: 4_100_000,
              cacheWrite: 0,
              cost: { total: 0 },
            },
          },
        }];
      },
    },
    ui: {
      theme: {
        fg(_color: string, text: string) {
          return text;
        },
      },
      setWidget(_id: string, value: string[] | undefined) {
        writes.push(value);
      },
    },
  } as unknown as ExtensionContext;
}

async function nextMicrotask() {
  await Promise.resolve();
  await Promise.resolve();
}

test("coalesces overlapping refreshes into one trailing run with the latest context", async () => {
  const batches: Array<ReturnType<typeof deferred<void>>> = [];
  const calls: string[] = [];
  const rendered: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const coordinator = createRefreshCoordinator(async (ctx, isCurrent) => {
    calls.push(ctx.cwd);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    const batch = deferred<void>();
    batches.push(batch);
    await batch.promise;
    concurrent -= 1;
    if (isCurrent()) rendered.push(ctx.cwd);
  });

  const firstContext = context("/first");
  coordinator.activate(firstContext);
  const first = coordinator.request(firstContext);
  await nextMicrotask();

  const second = coordinator.request(context("/second"));
  const latest = coordinator.request(context("/latest"));
  assert.deepEqual(calls, ["/first"]);

  batches[0]!.resolve();
  await first;
  await nextMicrotask();
  assert.deepEqual(calls, ["/first", "/latest"]);
  assert.deepEqual(rendered, []);

  batches[1]!.resolve();
  await Promise.all([second, latest]);
  assert.deepEqual(rendered, ["/latest"]);
  assert.equal(maxConcurrent, 1);
});

test("a waiting handler completes with its coalesced trailing batch", async () => {
  const batches: Array<ReturnType<typeof deferred<void>>> = [];
  const coordinator = createRefreshCoordinator(async () => {
    const batch = deferred<void>();
    batches.push(batch);
    await batch.promise;
  });
  const ctx = context("/repo");
  coordinator.activate(ctx);
  const first = coordinator.request(ctx);
  await nextMicrotask();
  const handler = coordinator.request(ctx);
  batches[0]!.resolve();
  await first;
  await nextMicrotask();
  batches[1]!.resolve();
  await handler;
  assert.equal(batches.length, 2);
});

test("stop releases active and queued callers without allowing restart overlap", async () => {
  const batches: Array<ReturnType<typeof deferred<void>>> = [];
  const restartedBatchStarted = deferred<void>();
  let concurrent = 0;
  let maxConcurrent = 0;
  const coordinator = createRefreshCoordinator(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    const batch = deferred<void>();
    batches.push(batch);
    if (batches.length === 2) restartedBatchStarted.resolve();
    await batch.promise;
    concurrent -= 1;
  });
  const oldContext = context("/old");
  coordinator.activate(oldContext);
  const active = coordinator.request(oldContext);
  await nextMicrotask();
  const queued = coordinator.request(oldContext);

  coordinator.stop();
  await Promise.all([active, queued]);
  coordinator.activate(context("/new"));
  const restarted = coordinator.request(context("/new"));
  await nextMicrotask();
  assert.equal(batches.length, 1);

  batches[0]!.resolve();
  await restartedBatchStarted.promise;
  assert.equal(batches.length, 2);
  assert.equal(maxConcurrent, 1);
  batches[1]!.resolve();
  await restarted;
});

test("stop and restart invalidate old work and suppress post-shutdown writes", async () => {
  const writes: Array<string[] | undefined> = [];
  const oldSummary = deferred<string | undefined>();
  const newSummary = deferred<string | undefined>();
  const oldContext = context("/old", writes);
  const coordinator = createRefreshCoordinator((ctx, isCurrent) =>
    updateWidget(ctx, isCurrent, () =>
      ctx.cwd === "/old" ? oldSummary.promise : newSummary.promise,
    ),
  );
  coordinator.activate(oldContext);
  const oldRequest = coordinator.request(oldContext);
  await nextMicrotask();
  coordinator.stop();

  const newContext = context("/new", writes);
  coordinator.activate(newContext);
  const newRequest = coordinator.request(newContext);
  oldSummary.resolve("stale");
  await oldRequest;
  await nextMicrotask();
  assert.deepEqual(writes, []);

  newSummary.resolve("current");
  await newRequest;
  assert.deepEqual(writes, [["GPT 5.6 Luna › think:high ›  new › current"]]);
});

test("updateWidget skips work without UI and suppresses stale success and failure", async () => {
  let calls = 0;
  const noUi = { ...context("/headless"), hasUI: false } as ExtensionContext;
  await updateWidget(noUi, () => true, async () => {
    calls += 1;
    return "unused";
  });
  assert.equal(calls, 0);

  const writes: Array<string[] | undefined> = [];
  await updateWidget(context("/stale", writes), () => false, async () => "summary");
  await updateWidget(context("/stale", writes), () => false, async () => {
    throw new Error("failed");
  });
  assert.deepEqual(writes, []);
});

test("formats model, reasoning, project, and VCS into the prompt status bar", () => {
  assert.equal(
    formatStatusBar(context("/Users/max/pi-config"), " main · 7 changed files"),
    "GPT 5.6 Luna › think:high ›  pi-config ›  main · 7 changed files",
  );
  assert.equal(projectName("/Users/max", "/Users/max"), "~");
});

test("colors the prompt status bar by semantic segment", () => {
  const taggedTheme = {
    fg(color: string, text: string) {
      return `<${color}>${text}</${color}>`;
    },
  } as unknown as Theme;
  const line = formatStatusBar(
    context("/Users/max/pi-config"),
    " main · 7 changed files",
    taggedTheme,
  );
  assert.match(line, /<customMessageLabel>GPT 5\.6 Luna<\/customMessageLabel>/);
  assert.match(
    line,
    /<error>t<\/error><warning>h<\/warning><success>i<\/success><mdLinkUrl>n<\/mdLinkUrl><accent>k<\/accent>/,
  );
  assert.match(line, /<mdLink><\/mdLink> <success>pi-config<\/success>/);
  assert.match(line, /<warning><\/warning> <success>main<\/success>/);
  assert.match(line, /<dim>7 changed files<\/dim>/);
});

test("getSummary preserves jj and git display behavior", async () => {
  const jjRun: RunVcsCommand = async (command, args) => {
    assert.equal(command, "jj");
    if (args[0] === "root") return "/repo";
    if (args[0] === "st") return "M file.ts\n? new.ts";
    return args.at(-1) === "change_id.shortest()" ? "abc123" : "description";
  };
  assert.equal(await getSummary("/repo", jjRun), "󱗆 abc123 · description · 2 changed files");

  const gitRun: RunVcsCommand = async (command, args) => {
    if (command === "jj") throw new Error("not jj");
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo";
    if (args[0] === "branch") return "main";
    if (args[0] === "status") return " M file.ts";
    return "deadbee";
  };
  assert.equal(await getSummary("/repo", gitRun), " main · 1 changed file");
});

test("getSummary waits for sibling probes to settle after one fails", async () => {
  const siblings = [deferred<string>(), deferred<string>()];
  let sibling = 0;
  const run: RunVcsCommand = async (_command, args) => {
    if (args[0] === "root") return "/repo";
    if (args[0] === "st") throw new Error("status failed");
    return siblings[sibling++]!.promise;
  };
  let settled = false;
  const summary = getSummary("/repo", run).finally(() => {
    settled = true;
  });
  await nextMicrotask();
  assert.equal(settled, false);
  siblings[0]!.resolve("abc123");
  await nextMicrotask();
  assert.equal(settled, false);
  siblings[1]!.resolve("description");
  await assert.rejects(summary, /status failed/);
});

test("shutdown during startup prevents late writes", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const summary = deferred<string | undefined>();
  createVcsStatusWidget({ summarize: () => summary.promise })(pi);

  const writes: Array<string[] | undefined> = [];
  const ctx = context("/repo", writes);
  const startup = handlers.get("session_start")!({}, ctx);
  await nextMicrotask();
  await handlers.get("session_shutdown")!({}, ctx);
  summary.resolve("late");
  await startup;

  assert.deepEqual(writes, [undefined]);
});

test("input preserves continue semantics", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  createVcsStatusWidget({ summarize: async () => "clean" })(pi);
  const ctx = context("/repo");
  await handlers.get("session_start")!({}, ctx);
  assert.deepEqual(await handlers.get("input")!({}, ctx), { action: "continue" });
  await handlers.get("session_shutdown")!({}, ctx);
});
