import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
type VcsKind = "jj" | "git";

const JJ_CHANGES_PROMPT = `Inspect the current Jujutsu repository, then respond with only:

1. A short 1-2 sentence summary of the current working-copy change.
2. A list of changed files with their +/- line counts when available.
3. A total +/- line count at the bottom when available.

Use jj commands, not git commands. Prefer:
- jj st
- jj diff --stat
- jj diff

Keep it concise.`;

const GIT_CHANGES_PROMPT = `Inspect the current Git repository, then respond with only:

1. A short 1-2 sentence summary of the current worktree changes.
2. A list of changed files with their +/- line counts when available.
3. A total +/- line count at the bottom when available.

Use git commands, not jj commands. Prefer:
- git status --short
- git diff --stat HEAD
- git diff HEAD

Keep it concise.`;

async function commandSucceeds(command: string, args: string[], cwd: string) {
  try {
    await execFileAsync(command, args, { cwd, timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function detectVcs(cwd: string): Promise<VcsKind | undefined> {
  // Prefer jj in colocated jj/git repositories, matching the VCS status widget.
  if (await commandSucceeds("jj", ["root"], cwd)) return "jj";
  if (await commandSucceeds("git", ["rev-parse", "--show-toplevel"], cwd)) {
    return "git";
  }
  return undefined;
}

function promptForVcs(vcs: VcsKind) {
  return vcs === "jj" ? JJ_CHANGES_PROMPT : GIT_CHANGES_PROMPT;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("changes", {
    description: "Summarize the current VCS changes",
    handler: async (_args, ctx) => {
      const vcs = await detectVcs(ctx.cwd);
      if (!vcs) {
        ctx.ui.notify("No jj or Git repository found for /changes.", "warning");
        return;
      }

      const prompt = promptForVcs(vcs);
      if (!ctx.isIdle()) {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /changes after the current turn finishes.", "info");
        return;
      }

      pi.sendUserMessage(prompt);
    },
  });
}
