import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const JJ_CHANGES_PROMPT = `Inspect the current repository using jj, then respond with only:

1. A short 1-2 sentence summary of the current working-copy change.
2. A list of changed files with their +/- line counts when available.
3. A total +/- line count at the bottom when available.

Use jj commands, not git commands. Prefer:
- jj st
- jj diff --stat
- jj diff

Keep it concise.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("changes", {
    description: "Summarize the current jj working-copy change",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        pi.sendUserMessage(JJ_CHANGES_PROMPT, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /changes after the current turn finishes.", "info");
        return;
      }

      pi.sendUserMessage(JJ_CHANGES_PROMPT);
    },
  });
}
