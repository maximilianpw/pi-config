import { execFile } from "node:child_process";
import { basename, parse, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const WIDGET_ID = "vcs-status-widget";

export type RunVcsCommand = (command: string, args: string[], cwd: string) => Promise<string>;

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

function changedFileLabel(count: number) {
  const fileLabel = count === 1 ? "file" : "files";
  return `${count} changed ${fileLabel}`;
}

export function projectName(cwd: string, home = process.env.HOME ?? process.env.USERPROFILE) {
  const resolvedCwd = resolve(cwd);
  if (home && resolvedCwd === resolve(home)) return "~";
  return basename(resolvedCwd) || parse(resolvedCwd).root;
}

function separator(theme: Theme) {
  return ` ${theme.fg("dim", "›")} `;
}

function colorVcsSummary(summary: string, theme: Theme) {
  const parts = summary.split(" · ");
  const head = parts.shift() ?? summary;
  let coloredHead = theme.fg("muted", head);
  if (head.startsWith(" ")) {
    coloredHead = `${theme.fg("warning", "")} ${theme.fg("success", head.replace(/^\s+/u, ""))}`;
  } else if (head.startsWith("󱗆 ")) {
    coloredHead = `${theme.fg("warning", "󱗆")} ${theme.fg("success", head.replace(/^󱗆\s+/u, ""))}`;
  }

  return [coloredHead, ...parts.map((part, index) =>
    theme.fg(index === parts.length - 1 ? "dim" : "muted", part),
  )].join(` ${theme.fg("dim", "·")} `);
}

type ThinkingLevel = Exclude<ExtensionContext["thinkingLevel"], undefined>;

const RAINBOW_COLORS = [
  "error",
  "warning",
  "success",
  "mdLinkUrl",
  "accent",
  "mdHeading",
  "customMessageLabel",
] satisfies readonly ThemeColor[];

function rainbowText(text: string, theme: Theme) {
  return [...text]
    .map((character, index) => theme.fg(RAINBOW_COLORS[index % RAINBOW_COLORS.length]!, character))
    .join("");
}

export function formatStatusBar(
  ctx: ExtensionContext,
  vcsSummary: string | undefined,
  theme: Theme = ctx.ui.theme,
) {
  const modelName = ctx.model?.name ?? ctx.model?.id ?? "no-model";
  const model = theme.fg("customMessageLabel", modelName);
  const thinkingLevel: ThinkingLevel = ctx.thinkingLevel ?? "off";
  const thinking = ctx.model?.reasoning
    ? separator(theme) + rainbowText(`think:${thinkingLevel}`, theme)
    : "";
  const project = separator(theme) + `${theme.fg("mdLink", "")} ${theme.fg("success", projectName(ctx.cwd))}`;
  const vcs = vcsSummary ? separator(theme) + colorVcsSummary(vcsSummary, theme) : "";
  return model + thinking + project + vcs;
}

const JJ_SUMMARY_TEMPLATE =
  'change_id.shortest() ++ "\\n" ++ description.first_line() ++ "\\n" ++ self.diff().files().len()';

/** One jj process takes one working-copy snapshot instead of racing several. */
async function getJjSummary(cwd: string, runCommand: RunVcsCommand) {
  const output = await runCommand("jj", ["log", "-r", "@", "--no-graph", "-T", JJ_SUMMARY_TEMPLATE], cwd);
  const [changeId = "", description = "", changed = "0"] = output.split("\n");
  const label = description.trim() || "no description";
  return `󱗆 ${changeId.trim()} · ${label} · ${changedFileLabel(Number.parseInt(changed, 10) || 0)}`;
}

/** `--no-optional-locks` keeps the widget from taking index.lock while the agent runs git. */
async function getGitSummary(cwd: string, runCommand: RunVcsCommand) {
  const status = await runCommand(
    "git",
    ["--no-optional-locks", "status", "--porcelain=v2", "--branch"],
    cwd,
  );
  let branch = "";
  let oid = "";
  let changed = 0;
  for (const line of status.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.oid ")) oid = line.slice("# branch.oid ".length);
    else if (line.length > 0 && !line.startsWith("#")) changed += 1;
  }
  const label = branch && branch !== "(detached)" ? branch : `detached ${oid.slice(0, 7)}`;
  return ` ${label} · ${changedFileLabel(changed)}`;
}

type VcsKind = "jj" | "git";

async function detectVcs(cwd: string, runCommand: RunVcsCommand): Promise<VcsKind | undefined> {
  try {
    await runCommand("jj", ["root", "--ignore-working-copy"], cwd);
    return "jj";
  } catch {}
  try {
    await runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
    return "git";
  } catch {
    return undefined;
  }
}

/**
 * Summarizes the working copy. Detected repositories are remembered per cwd so later
 * refreshes spawn a single process; directories without a VCS are probed again.
 */
export function createSummarizer(runCommand: RunVcsCommand = run) {
  const detected = new Map<string, VcsKind>();
  return async (cwd: string) => {
    const kind = detected.get(cwd) ?? (await detectVcs(cwd, runCommand));
    if (!kind) return undefined;
    detected.set(cwd, kind);
    return kind === "jj" ? getJjSummary(cwd, runCommand) : getGitSummary(cwd, runCommand);
  };
}

export function getSummary(cwd: string, runCommand: RunVcsCommand = run) {
  return createSummarizer(runCommand)(cwd);
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
    ctx.ui.setWidget(WIDGET_ID, [formatStatusBar(ctx, summary, ctx.ui.theme)]);
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
}

export function createVcsStatusWidget(options: VcsStatusWidgetOptions = {}) {
  return function vcsStatusWidget(pi: ExtensionAPI) {
    const baseSummarize = options.summarize ?? createSummarizer();
    let lastSummary: { cwd: string; summary: string | undefined } | undefined;
    const summarize = async (cwd: string) => {
      const summary = await baseSummarize(cwd);
      lastSummary = { cwd, summary };
      return summary;
    };
    const refresh = createRefreshCoordinator((ctx, isCurrent) => updateWidget(ctx, isCurrent, summarize));

    // Model and thinking changes only alter the label, so re-render from the last VCS summary.
    const rerender = (ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      if (lastSummary?.cwd !== ctx.cwd) {
        void refresh.request(ctx);
        return;
      }
      ctx.ui.setWidget(WIDGET_ID, [formatStatusBar(ctx, lastSummary.summary, ctx.ui.theme)]);
    };

    pi.on("session_start", async (_event, ctx) => {
      refresh.activate(ctx);
      await refresh.request(ctx);
    });

    pi.on("input", (_event, ctx) => {
      void refresh.request(ctx);
      return { action: "continue" };
    });

    pi.on("agent_settled", (_event, ctx) => {
      void refresh.request(ctx);
    });

    pi.on("model_select", (_event, ctx) => rerender(ctx));
    pi.on("thinking_level_select", (_event, ctx) => rerender(ctx));

    pi.on("session_shutdown", async (_event, ctx) => {
      refresh.stop();
      lastSummary = undefined;
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
    });
  };
}

export default createVcsStatusWidget();
