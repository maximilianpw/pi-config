export type ExecutorAction = "search" | "describe" | "integrations" | "call" | "resume";
export type ExecutorDecision = "accept" | "decline" | "cancel";

export interface ExecutorInput {
  action: ExecutorAction;
  query?: string;
  path?: string;
  args?: Record<string, unknown>;
  namespace?: string;
  limit?: number;
  executionId?: string;
  decision?: ExecutorDecision;
  content?: Record<string, unknown>;
}

function required(value: string | undefined, field: string, action: ExecutorAction): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Executor ${action} requires \`${field}\``);
  return normalized;
}

export function buildExecutorArgs(input: ExecutorInput): string[] {
  switch (input.action) {
    case "search": {
      const args = ["tools", "search", required(input.query, "query", input.action)];
      if (input.namespace?.trim()) args.push("--namespace", input.namespace.trim());
      args.push("--limit", String(input.limit ?? 10));
      return args;
    }
    case "describe":
      return ["tools", "describe", required(input.path, "path", input.action)];
    case "integrations": {
      const args = ["tools", "integrations"];
      if (input.query?.trim()) args.push("--query", input.query.trim());
      args.push("--limit", String(input.limit ?? 20));
      return args;
    }
    case "call": {
      const path = required(input.path, "path", input.action);
      const segments = path.split(".");
      if (segments.some((segment) => segment.length === 0)) {
        throw new Error("Executor call requires a dot-separated tool path without empty segments");
      }
      return ["call", ...segments, JSON.stringify(input.args ?? {})];
    }
    case "resume": {
      const executionId = required(input.executionId, "executionId", input.action);
      if (!input.decision) throw new Error("Executor resume requires `decision`");
      const args = [
        "--log-level",
        "debug",
        "resume",
        "--execution-id",
        executionId,
        "--action",
        input.decision,
      ];
      if (input.decision === "accept") {
        args.push("--content", JSON.stringify(input.content ?? {}));
      }
      return args;
    }
  }
}
