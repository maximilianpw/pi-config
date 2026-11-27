import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
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

type HandoffGeneration =
  | { readonly _tag: "generated"; readonly prompt: string }
  | { readonly _tag: "cancelled" }
  | { readonly _tag: "failed"; readonly message: string };

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Generate a focused prompt and start a fresh session",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
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

      const model = ctx.model;
      const generation = await ctx.ui.custom<HandoffGeneration>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
        loader.onAbort = () => done({ _tag: "cancelled" });

        const doGenerate = async (): Promise<HandoffGeneration> => {
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

          const response = await ctx.modelRegistry.complete(
            model,
            { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
            {
              signal: loader.signal,
              cacheRetention: "none",
              sessionId: uuidv7(),
            },
          );

          if (response.stopReason === "aborted") return { _tag: "cancelled" };
          if (response.stopReason === "error") {
            return { _tag: "failed", message: response.errorMessage ?? "the model returned an error" };
          }
          const prompt = response.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
          return prompt
            ? { _tag: "generated", prompt }
            : { _tag: "failed", message: "the model returned no text" };
        };

        doGenerate()
          .then(done)
          .catch((error: unknown) =>
            done({ _tag: "failed", message: error instanceof Error ? error.message : String(error) }),
          );

        return loader;
      });

      if (generation._tag === "cancelled") {
        ctx.ui.notify("Handoff cancelled", "info");
        return;
      }
      if (generation._tag === "failed") {
        ctx.ui.notify(`Handoff generation failed: ${generation.message}`, "error");
        return;
      }
      const generatedPrompt = generation.prompt;

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
