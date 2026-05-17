import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

type PlanModeState = {
  enabled: boolean;
  executing: boolean;
  todos: TodoItem[];
  previousActiveTools?: string[];
};

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let executionMode = false;
  let todoItems: TodoItem[] = [];
  let previousActiveTools: string[] | undefined;

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  function validToolNames(names: string[]): string[] {
    const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    return names.filter((name) => allToolNames.has(name));
  }

  function setReadOnlyTools(): void {
    pi.setActiveTools(validToolNames(READ_ONLY_TOOLS));
  }

  function restoreTools(): void {
    const names = previousActiveTools?.length ? previousActiveTools : pi.getAllTools().map((tool) => tool.name);
    pi.setActiveTools(validToolNames(names));
  }

  function persistState(): void {
    pi.appendEntry<PlanModeState>("plan-mode", {
      enabled: planModeEnabled,
      executing: executionMode,
      todos: todoItems,
      previousActiveTools,
    });
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (executionMode && todoItems.length > 0) {
      const completed = todoItems.filter((todo) => todo.completed).length;
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
      ctx.ui.setWidget(
        "plan-mode-todos",
        todoItems.map((todo) => {
          const checkbox = todo.completed ? ctx.ui.theme.fg("success", "☑") : ctx.ui.theme.fg("muted", "☐");
          const text = todo.completed ? ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(todo.text)) : todo.text;
          return `${checkbox} ${todo.step}. ${text}`;
        }),
      );
      return;
    }

    ctx.ui.setWidget("plan-mode-todos", undefined);
    ctx.ui.setStatus("plan-mode", planModeEnabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
  }

  function enablePlanMode(ctx: ExtensionContext): void {
    if (!planModeEnabled) previousActiveTools = pi.getActiveTools();
    planModeEnabled = true;
    executionMode = false;
    todoItems = [];
    setReadOnlyTools();
    updateStatus(ctx);
    persistState();
    ctx.ui.notify("Plan mode enabled. Only read-only tools are active.", "info");
  }

  function disablePlanMode(ctx: ExtensionContext): void {
    planModeEnabled = false;
    executionMode = false;
    todoItems = [];
    restoreTools();
    updateStatus(ctx);
    persistState();
    ctx.ui.notify("Plan mode disabled. Previous tools restored.", "info");
  }

  pi.registerCommand("plan", {
    description: "Toggle read-only plan mode",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on" || action === "start") return enablePlanMode(ctx);
      if (action === "off" || action === "stop" || action === "done") return disablePlanMode(ctx);
      if (planModeEnabled) return disablePlanMode(ctx);
      return enablePlanMode(ctx);
    },
  });

  pi.registerCommand("todos", {
    description: "Show current plan execution progress",
    handler: async (_args, ctx) => {
      if (todoItems.length === 0) {
        ctx.ui.notify("No active plan todos.", "info");
        return;
      }
      const list = todoItems.map((todo) => `${todo.step}. ${todo.completed ? "✓" : "○"} ${todo.text}`).join("\n");
      ctx.ui.notify(`Plan progress:\n${list}`, "info");
    },
  });

  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return undefined;

    const command = String((event.input as { command?: unknown }).command ?? "");
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `Plan mode blocked a non-read-only bash command. Use /plan off to leave plan mode.\nCommand: ${command}`,
      };
    }
    return undefined;
  });

  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[PLAN MODE ACTIVE]\nYou are in read-only planning mode.\n\nRestrictions:\n- You may inspect with read and read-only bash commands only.\n- You must not edit, write, install dependencies, mutate VCS state, or modify files.\n- Ask clarifying questions when needed.\n- Produce a concise numbered plan under a \"Plan:\" heading.\n- Do not implement until the user chooses to execute or turns plan mode off.`,
          display: false,
        },
      };
    }

    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems.filter((todo) => !todo.completed).map((todo) => `${todo.step}. ${todo.text}`).join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN]\nComplete the remaining steps in order. After completing a step, include [DONE:n] in your assistant response.\n\nRemaining steps:\n${remaining}`,
          display: false,
        },
      };
    }

    return undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (executionMode && todoItems.length > 0) {
      if (todoItems.every((todo) => todo.completed)) {
        executionMode = false;
        todoItems = [];
        restoreTools();
        updateStatus(ctx);
        persistState();
        pi.sendMessage({ customType: "plan-complete", content: "Plan complete. ✓", display: true }, { triggerTurn: false });
      }
      return;
    }

    if (!planModeEnabled || !ctx.hasUI) return;

    const lastAssistant = [...event.messages].reverse().find((message): message is AssistantMessage =>
      isAssistantMessage(message as AgentMessage),
    );
    if (lastAssistant) todoItems = extractTodoItems(getTextContent(lastAssistant));

    if (todoItems.length === 0) return;

    const choice = await ctx.ui.select("Plan mode", ["Execute the plan", "Stay in plan mode", "Refine the plan"]);
    if (choice === "Execute the plan") {
      planModeEnabled = false;
      executionMode = true;
      restoreTools();
      updateStatus(ctx);
      persistState();
      pi.sendMessage(
        { customType: "plan-execute", content: `Execute the plan. Start with step 1: ${todoItems[0].text}`, display: true },
        { triggerTurn: true },
      );
    } else if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("How should the plan be refined?", "");
      if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
    } else {
      updateStatus(ctx);
      persistState();
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || todoItems.length === 0 || !isAssistantMessage(event.message as AgentMessage)) return;
    if (markCompletedSteps(getTextContent(event.message as AssistantMessage), todoItems) > 0) {
      updateStatus(ctx);
      persistState();
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "plan-mode") {
        const state = entry.data as PlanModeState | undefined;
        if (state) {
          planModeEnabled = state.enabled;
          executionMode = state.executing;
          todoItems = state.todos ?? [];
          previousActiveTools = state.previousActiveTools;
        }
      }
    }

    if (pi.getFlag("plan") === true) planModeEnabled = true;
    if (planModeEnabled) setReadOnlyTools();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget("plan-mode-todos", undefined);
    ctx.ui.setStatus("plan-mode", undefined);
  });
}
