import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const WIDGET_ID = "vcs-status-widget";
const UPDATE_INTERVAL_MS = 2_000;

export type RunVcsCommand = (command: string, args: string[], cwd: string) => Promise<string>;

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function isJjRepo(cwd: string, runCommand: RunVcsCommand) {
  try {
    await runCommand("jj", ["root"], cwd);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(cwd: string, runCommand: RunVcsCommand) {
  try {
    await runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
    return true;
  } catch {
    return false;
  }
}

function changedFileLabel(count: number) {
  const fileLabel = count === 1 ? "file" : "files";
  return `${count} changed ${fileLabel}`;
}

function countJjChangedFiles(status: string) {
  return status
    .split("\n")
    .filter((line) => /^[AMDRC?][ MDRC?]?\s+/.test(line.trim()))
    .length;
}

function countGitChangedFiles(status: string) {
  return status.split("\n").filter((line) => line.trim().length > 0).length;
}

async function settleCommands(commands: Promise<string>[]): Promise<string[]> {
  const results = await Promise.allSettled(commands);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<string>).value);
}

async function getJjSummary(cwd: string, runCommand: RunVcsCommand) {
  const [changeId, description, status] = await settleCommands([
    runCommand("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id.shortest()"], cwd),
    runCommand("jj", ["log", "-r", "@", "--no-graph", "-T", "description.first_line()"], cwd),
    runCommand("jj", ["st"], cwd),
  ]);

  const label = description.trim() || "no description";
  return `󱗆 ${changeId.trim()} · ${label} · ${changedFileLabel(countJjChangedFiles(status))}`;
}

async function getGitSummary(cwd: string, runCommand: RunVcsCommand) {
  const [branch, detachedHead, status] = await settleCommands([
    runCommand("git", ["branch", "--show-current"], cwd),
    runCommand("git", ["rev-parse", "--short", "HEAD"], cwd),
    runCommand("git", ["status", "--porcelain=v1"], cwd),
  ]);

  const label = branch.trim() || `detached ${detachedHead.trim()}`;
  return ` ${label} · ${changedFileLabel(countGitChangedFiles(status))}`;
}

export async function getSummary(cwd: string, runCommand: RunVcsCommand = run) {
  if (await isJjRepo(cwd, runCommand)) return getJjSummary(cwd, runCommand);
  if (await isGitRepo(cwd, runCommand)) return getGitSummary(cwd, runCommand);
  return undefined;
}

export async function updateWidget(
  ctx: ExtensionContext,
  isCurrent: () => boolean = () => true,
  summarize: (cwd: string) => Promise<string | undefined> = getSummary,
) {
  if (!ctx.hasUI) return;

  try {
    const summary = await summarize(ctx.cwd);
    if (!isCurrent()) return;
    ctx.ui.setWidget(WIDGET_ID, summary ? [summary] : undefined);
  } catch {
    if (!isCurrent()) return;
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
}

type Refresh = (ctx: ExtensionContext, isCurrent: () => boolean) => Promise<void>;

export function createRefreshCoordinator(refresh: Refresh) {
  let active = false;
  let epoch = 0;
  let latestContext: ExtensionContext | undefined;
  let inFlight: Promise<void> | undefined;
  let pending = false;
  let activeWaiters: Array<() => void> = [];
  let pendingWaiters: Array<() => void> = [];

  const resolveWaiters = (waiters: Array<() => void>) => {
    for (const resolve of waiters) resolve();
  };

  const resolvePendingWaiters = () => {
    resolveWaiters(pendingWaiters);
    pendingWaiters = [];
  };

  const resolveActiveWaiters = () => {
    resolveWaiters(activeWaiters);
    activeWaiters = [];
  };

  const startNext = () => {
    if (!active || inFlight || !pending || !latestContext) return;

    pending = false;
    const ctx = latestContext;
    const batchEpoch = epoch;
    activeWaiters = pendingWaiters;
    pendingWaiters = [];
    inFlight = Promise.resolve()
      .then(() =>
        refresh(
          ctx,
          () => active && epoch === batchEpoch && latestContext?.cwd === ctx.cwd,
        ),
      )
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        resolveActiveWaiters();
        inFlight = undefined;
        startNext();
      });
  };

  const enqueue = (ctx: ExtensionContext | undefined, waitForBatch: boolean) => {
    if (!active) return Promise.resolve();
    if (ctx) latestContext = ctx;
    pending = true;
    const completed = waitForBatch
      ? new Promise<void>((resolve) => pendingWaiters.push(resolve))
      : Promise.resolve();
    startNext();
    return completed;
  };

  return {
    activate(ctx: ExtensionContext) {
      active = true;
      epoch += 1;
      latestContext = ctx;
      pending = false;
      resolvePendingWaiters();
      return epoch;
    },
    request(ctx: ExtensionContext) {
      return enqueue(ctx, true);
    },
    tick() {
      void enqueue(undefined, false);
    },
    isActive(sessionEpoch: number) {
      return active && epoch === sessionEpoch;
    },
    stop() {
      active = false;
      epoch += 1;
      latestContext = undefined;
      pending = false;
      resolveActiveWaiters();
      resolvePendingWaiters();
    },
  };
}

export interface VcsStatusWidgetOptions {
  summarize?: (cwd: string) => Promise<string | undefined>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export function createVcsStatusWidget(options: VcsStatusWidgetOptions = {}) {
  const summarize = options.summarize ?? getSummary;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;

  return function vcsStatusWidget(pi: ExtensionAPI) {
    let interval: NodeJS.Timeout | undefined;
    const refresh = createRefreshCoordinator((ctx, isCurrent) => updateWidget(ctx, isCurrent, summarize));

    pi.on("session_start", async (_event, ctx) => {
      if (interval) clearIntervalFn(interval);
      interval = undefined;
      const sessionEpoch = refresh.activate(ctx);
      await refresh.request(ctx);
      if (refresh.isActive(sessionEpoch)) {
        interval = setIntervalFn(() => refresh.tick(), UPDATE_INTERVAL_MS);
      }
    });

    pi.on("input", async (_event, ctx) => {
      await refresh.request(ctx);
      return { action: "continue" };
    });

    pi.on("tool_execution_end", async (_event, ctx) => {
      await refresh.request(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      refresh.stop();
      if (interval) clearIntervalFn(interval);
      interval = undefined;
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
    });
  };
}

export default createVcsStatusWidget();
