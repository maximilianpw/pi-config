import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const USAGE_PROMPT = String.raw`Create a Pi usage report for all of my Pi sessions over the last 1, 7, 30, and 90 days.

Goal:
- Produce a clean Markdown table for each window: 1 day, 7 days, 30 days, 90 days.
- For each model in each window, show source/app, model/provider, assistant messages or turns, input tokens, output tokens, cached input/read tokens, total tokens, and estimated USD price.
- Include a grand total row for each window.
- Use current model pricing from models.dev, not stale local assumptions.

Detailed steps:
1. Find Pi session JSONL files under ~/.pi/agent/sessions recursively.
2. Also find Codex CLI session JSONL files under ~/.codex/sessions recursively and ~/.codex/archived_sessions if present.
3. Parse JSONL safely. Ignore malformed lines, but mention skipped lines.
4. Count only Pi assistant message entries that have model usage data.
5. For Codex CLI, use token_count payload.info.last_token_usage per turn to avoid double-counting cumulative usage.
6. Group by source plus stable provider/model key.
7. Fetch/read pricing from models.dev without loading the whole api.json into the conversation. Use a temporary script or shell pipeline to fetch/process/filter outside context and print only matched pricing rows.
8. Compute price carefully by input, output, and cached input/read rates. If unavailable, use 0 for that component and add a note.
9. Present concise Markdown sections for Last 1 day, 7 days, 30 days, and 90 days.
10. Add pricing/parsing notes at the end.

Do not modify any session files.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Ask the agent to summarize Pi/Codex usage and cost for the last 1, 7, 30, and 90 days",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      pi.sendUserMessage(USAGE_PROMPT);
    },
  });
}
