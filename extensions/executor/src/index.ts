import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { buildExecutorArgs } from "./command.ts";
import { formatExecutorFailure } from "./failure.ts";

const executorSchema = Type.Object({
  action: StringEnum(["search", "describe", "integrations", "call", "resume"] as const, {
    description: "Executor operation to perform",
  }),
  query: Type.Optional(
    Type.String({ description: "Natural-language tool search or integration filter" }),
  ),
  path: Type.Optional(
    Type.String({ description: "Fully qualified Executor tool path for describe or call" }),
  ),
  args: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arguments for a tool call",
    }),
  ),
  namespace: Type.Optional(
    Type.String({ description: "Optional namespace filter for tool search" }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Maximum search results. Defaults to 10.", minimum: 1, maximum: 50 }),
  ),
  executionId: Type.Optional(
    Type.String({ description: "Paused execution ID returned by Executor" }),
  ),
  decision: Type.Optional(
    StringEnum(["accept", "decline", "cancel"] as const, {
      description: "User-approved response for a paused execution",
    }),
  ),
  content: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Response object requested by a paused execution when accepting",
    }),
  ),
});

type ExecutorToolInput = Static<typeof executorSchema>;

const progressMessages: Record<ExecutorToolInput["action"], string> = {
  search: "Searching Executor tools...",
  describe: "Describing Executor tool...",
  integrations: "Listing Executor integrations...",
  call: "Calling Executor tool...",
  resume: "Resuming Executor execution...",
};

export default function executorExtension(pi: ExtensionAPI): void {
  const tempDirectories = new Set<string>();

  async function boundedOutput(output: string): Promise<string> {
    const normalized = output.trimEnd() || "(no output)";
    const truncation = truncateHead(normalized, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    if (!truncation.truncated) return truncation.content;

    const directory = await mkdtemp(join(tmpdir(), "pi-executor-"));
    const file = join(directory, "output.txt");
    tempDirectories.add(directory);
    await writeFile(file, normalized, { encoding: "utf8", mode: 0o600 });

    return `${truncation.content}\n\n[Executor output truncated to ${truncation.outputLines} lines / ${formatSize(truncation.outputBytes)}. Full output saved to: ${file}]`;
  }

  pi.registerTool({
    name: "executor",
    label: "Executor",
    description: "Discover and call tools from the configured Executor gateway through the installed Executor CLI. Supports searching, schema inspection, integration listing, calls, and resuming user-approved paused executions. Output is limited to 50KB or 2,000 lines.",
    promptSnippet: "Discover and call integrations managed by the configured Executor gateway",
    promptGuidelines: [
      "Use executor for integrations and remote APIs managed by Executor.",
      "Search Executor before calling an unfamiliar capability, then describe the selected path when its arguments are not already known.",
      "When Executor pauses a call for approval or input, ask the user before using executor resume; never accept a paused execution without the user's approval.",
    ],
    parameters: executorSchema,
    async execute(_toolCallId, params: ExecutorToolInput, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: progressMessages[params.action] }],
        details: { action: params.action },
      });

      const result = await pi.exec("executor", buildExecutorArgs(params), {
        cwd: ctx.cwd,
        signal,
        timeout: 60_000,
      });
      if (result.code !== 0) {
        throw new Error(formatExecutorFailure(result.stdout, result.stderr, result.code));
      }

      const output = result.stderr.trim()
        ? `${result.stdout.trimEnd()}\n\n[stderr]\n${result.stderr.trimEnd()}`
        : result.stdout;
      return {
        content: [{ type: "text", text: await boundedOutput(output) }],
        details: {
          action: params.action,
          ...(params.path ? { path: params.path } : {}),
          ...(params.executionId ? { executionId: params.executionId } : {}),
        },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    const directories = [...tempDirectories];
    tempDirectories.clear();
    await Promise.allSettled(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
}
