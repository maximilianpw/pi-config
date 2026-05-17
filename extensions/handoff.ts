import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation: decisions, approaches, constraints, and key findings.
2. Lists relevant files discussed or modified.
3. Clearly states the next task based on the user's goal.
4. Is self-contained so the new thread can proceed without the old conversation.

Format your response as the prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include preamble like "Here's the prompt".

Use this shape:
## Context
...

## Files
- path/to/file

## Task
...`;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      compactionIndex = i;
      break;
    }
  }

  if (compactionIndex < 0) {
    return branch.map(entryToMessage).filter((message): message is AgentMessage => message !== undefined);
  }

  const compaction = branch[compactionIndex];
  const firstKeptIndex =
    compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
  const compactedBranch = [
    compaction,
    ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
    ...branch.slice(compactionIndex + 1),
  ];
  return compactedBranch.map(entryToMessage).filter((message): message is AgentMessage => message !== undefined);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Generate a focused prompt and start a fresh session",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/handoff requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /handoff <goal for the new session>", "error");
        return;
      }

      await ctx.waitForIdle();

      const messages = getHandoffMessages(ctx.sessionManager.getBranch());
      if (messages.length === 0) {
        ctx.ui.notify("No conversation to hand off", "error");
        return;
      }

      const conversationText = serializeConversation(convertToLlm(messages));
      const currentSessionFile = ctx.sessionManager.getSessionFile();

      const generatedPrompt = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
        loader.onAbort = () => done(null);

        const doGenerate = async () => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);

          const userMessage: Message = {
            role: "user",
            content: [
              {
                type: "text",
                text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
              },
            ],
            timestamp: Date.now(),
          };

          const response = await complete(
            ctx.model!,
            { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
            { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
          );

          if (response.stopReason === "aborted") return null;
          return response.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
        };

        doGenerate()
          .then(done)
          .catch((error) => {
            console.error("Handoff generation failed:", error);
            done(null);
          });

        return loader;
      });

      if (!generatedPrompt) {
        ctx.ui.notify("Handoff cancelled", "info");
        return;
      }

      const editedPrompt = await ctx.ui.editor("Edit handoff prompt", generatedPrompt);
      if (editedPrompt === undefined) {
        ctx.ui.notify("Handoff cancelled", "info");
        return;
      }

      const result = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (replacementCtx) => {
          replacementCtx.ui.setEditorText(editedPrompt);
          replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
        },
      });

      if (result.cancelled) ctx.ui.notify("New session cancelled", "info");
    },
  });
}
