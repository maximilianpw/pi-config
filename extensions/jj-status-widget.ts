import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const WIDGET_ID = "jj-status-widget";
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

async function getSummary(cwd: string) {
  const [changeId, description, status] = await Promise.all([
    run("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id.shortest()"], cwd),
    run("jj", ["log", "-r", "@", "--no-graph", "-T", "description.first_line()"], cwd),
    run("jj", ["st"], cwd),
  ]);

  const changedFiles = status
    .split("\n")
    .filter((line) => /^[AMDRC?][ MDRC?]?\s+/.test(line.trim()))
    .length;

  const label = description.trim() || "no description";
  const fileLabel = changedFiles === 1 ? "file" : "files";
  return `󱗆 ${changeId.trim()} · ${label} · ${changedFiles} changed ${fileLabel}`;
}

async function updateWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;

  try {
    if (!(await isJjRepo(ctx.cwd))) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_ID, [await getSummary(ctx.cwd)]);
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
