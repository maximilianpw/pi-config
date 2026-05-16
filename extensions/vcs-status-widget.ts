import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const WIDGET_ID = "vcs-status-widget";
const UPDATE_INTERVAL_MS = 2_000;

async function run(command: string, args: string[], cwd: string) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function isJjRepo(cwd: string) {
  try {
    await run("jj", ["root"], cwd);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(cwd: string) {
  try {
    await run("git", ["rev-parse", "--show-toplevel"], cwd);
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

async function getJjSummary(cwd: string) {
  const [changeId, description, status] = await Promise.all([
    run("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id.shortest()"], cwd),
    run("jj", ["log", "-r", "@", "--no-graph", "-T", "description.first_line()"], cwd),
    run("jj", ["st"], cwd),
  ]);

  const label = description.trim() || "no description";
  return `󱗆 ${changeId.trim()} · ${label} · ${changedFileLabel(countJjChangedFiles(status))}`;
}

async function getGitSummary(cwd: string) {
  const [branch, detachedHead, status] = await Promise.all([
    run("git", ["branch", "--show-current"], cwd),
    run("git", ["rev-parse", "--short", "HEAD"], cwd),
    run("git", ["status", "--porcelain=v1"], cwd),
  ]);

  const label = branch.trim() || `detached ${detachedHead.trim()}`;
  return ` ${label} · ${changedFileLabel(countGitChangedFiles(status))}`;
}

async function getSummary(cwd: string) {
  if (await isJjRepo(cwd)) return getJjSummary(cwd);
  if (await isGitRepo(cwd)) return getGitSummary(cwd);
  return undefined;
}

async function updateWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  try {
    const summary = await getSummary(ctx.cwd);
    ctx.ui.setWidget(WIDGET_ID, summary ? [summary] : undefined);
  } catch {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
}

export default function (pi: ExtensionAPI) {
  let interval: NodeJS.Timeout | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (interval) clearInterval(interval);
    await updateWidget(ctx);
    interval = setInterval(() => void updateWidget(ctx), UPDATE_INTERVAL_MS);
  });

  pi.on("input", async (_event, ctx) => {
    await updateWidget(ctx);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    await updateWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (interval) clearInterval(interval);
    interval = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
  });
}
