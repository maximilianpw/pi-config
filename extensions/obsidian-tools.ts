import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_VAULT_PATH = path.join(process.env.HOME ?? "", "Documents", "obsidian vault");
const MAX_OUTPUT_CHARS = 20_000;

type ObsidianResult = {
  command: string;
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
};

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated to ${MAX_OUTPUT_CHARS} characters]`;
}

function kv(key: string, value: string | number | boolean | undefined): string | undefined {
  return value === undefined ? undefined : `${key}=${String(value)}`;
}

async function runObsidian(pi: ExtensionAPI, args: Array<string | undefined>, cwd = DEFAULT_VAULT_PATH): Promise<ObsidianResult> {
  const cleanArgs = args.filter((arg): arg is string => typeof arg === "string" && arg.length > 0);
  const result = await pi.exec("obsidian", cleanArgs, { cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return {
    command: "obsidian",
    args: cleanArgs,
    code: result.code,
    stdout: truncate(result.stdout.trimEnd()),
    stderr: truncate(result.stderr.trimEnd()),
  };
}

function response(result: ObsidianResult) {
  const text = result.stdout || result.stderr || `(obsidian exited with code ${result.code})`;
  return {
    content: [{ type: "text" as const, text }],
    details: result,
  };
}

function errorResponse(result: ObsidianResult) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: result.stderr || result.stdout || `obsidian exited with code ${result.code}` }],
    details: result,
  };
}

function dateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}

function frontmatter(entries: Record<string, string | string[]>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "obsidian_search",
    label: "Obsidian Search",
    description: "Search the Obsidian vault using the obsidian CLI. Output is truncated to 20KB.",
    promptSnippet: "Search the Obsidian vault for notes, wiki articles, and project context",
    promptGuidelines: [
      "Use obsidian_search before answering questions that likely have relevant context in the user's Obsidian vault.",
      "Prefer reading specific matching notes with obsidian_read before relying on search snippets.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      folder: Type.Optional(Type.String({ description: "Optional folder to limit the search, e.g. 200-WIKI or 100-PROJECTS." })),
      limit: Type.Optional(Type.Integer({ description: "Maximum matching files to return." })),
    }),
    async execute(_id, params) {
      const result = await runObsidian(pi, ["search:context", kv("query", params.query), kv("path", params.folder), kv("limit", params.limit ?? 20)]);
      return result.code === 0 ? response(result) : errorResponse(result);
    },
  });

  pi.registerTool({
    name: "obsidian_read",
    label: "Obsidian Read",
    description: "Read an Obsidian note by exact path using the obsidian CLI. Output is truncated to 20KB.",
    promptSnippet: "Read an Obsidian note by exact vault path",
    parameters: Type.Object({
      path: Type.String({ description: "Exact vault-relative path, e.g. 200-WIKI/topics/dev-tools/index.md." }),
    }),
    async execute(_id, params) {
      const result = await runObsidian(pi, ["read", kv("path", params.path)]);
      return result.code === 0 ? response(result) : errorResponse(result);
    },
  });

  pi.registerTool({
    name: "obsidian_create",
    label: "Obsidian Create",
    description: "Create an Obsidian note at an exact path using the obsidian CLI.",
    promptSnippet: "Create a note in the Obsidian vault",
    promptGuidelines: [
      "Use obsidian_create only when the user asks to save notes or when project instructions explicitly require a feature/problem note.",
      "For wiki articles, follow 200-WIKI/CLAUDE.md and update the topic index and log separately.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Exact vault-relative path to create." }),
      content: Type.String({ description: "Initial Markdown content." }),
      template: Type.Optional(Type.String({ description: "Optional Obsidian template name, e.g. Feature or Problem." })),
      overwrite: Type.Optional(Type.Boolean({ description: "Whether to overwrite an existing note." })),
    }),
    async execute(_id, params) {
      const result = await runObsidian(pi, [
        "create",
        kv("path", params.path),
        kv("template", params.template),
        kv("content", params.content),
        params.overwrite ? "overwrite" : undefined,
      ]);
      return result.code === 0 ? response(result) : errorResponse(result);
    },
  });

  pi.registerTool({
    name: "obsidian_append",
    label: "Obsidian Append",
    description: "Append Markdown to an Obsidian note using the obsidian CLI.",
    promptSnippet: "Append content to an existing Obsidian note",
    parameters: Type.Object({
      path: Type.String({ description: "Exact vault-relative path." }),
      content: Type.String({ description: "Markdown content to append." }),
      inline: Type.Optional(Type.Boolean({ description: "Append without adding a newline." })),
    }),
    async execute(_id, params) {
      const result = await runObsidian(pi, ["append", kv("path", params.path), kv("content", params.content), params.inline ? "inline" : undefined]);
      return result.code === 0 ? response(result) : errorResponse(result);
    },
  });

  pi.registerTool({
    name: "obsidian_create_structured_note",
    label: "Obsidian Structured Note",
    description: "Create a standard feature, problem, or wiki note with starter frontmatter and sections.",
    promptSnippet: "Create standard project or wiki notes in Obsidian",
    promptGuidelines: [
      "Use obsidian_create_structured_note for larger features, substantial bugs, or user-approved wiki saves.",
      "Project notes belong in 100-PROJECTS or a project folder; compiled durable knowledge belongs in 200-WIKI.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["feature", "problem", "wiki-synthesis"] as const),
      title: Type.String({ description: "Human-readable title." }),
      folder: Type.Optional(Type.String({ description: "Destination folder. Defaults by kind." })),
      topic: Type.Optional(Type.String({ description: "Wiki topic for wiki-synthesis notes." })),
      summary: Type.Optional(Type.String({ description: "Optional initial summary/body." })),
    }),
    async execute(_id, params) {
      const fileSlug = slug(params.title);
      const folder = params.folder ?? (params.kind === "wiki-synthesis" ? `200-WIKI/topics/${params.topic ?? "dev-tools"}` : "100-PROJECTS");
      const notePath = `${folder.replace(/\/$/, "")}/${fileSlug}.md`;

      let content: string;
      if (params.kind === "feature") {
        content = `${frontmatter({ tags: ["feature"], date: dateString(), project: "" })}\n# ${params.title}\n\n## Why\n${params.summary ?? ""}\n\n## MVP\n- [ ] \n\n## Not doing (yet)\n- \n\n## Approach\n\n## Problems\n\n## Retro\n`;
      } else if (params.kind === "problem") {
        content = `${frontmatter({ tags: ["problem"], date: dateString(), project: "" })}\n# ${params.title}\n\n## What's happening\n${params.summary ?? ""}\n\n## What I expected\n\n## What I've tried\n1. \n\n## What I think is going on\n\n## Solution\n`;
      } else {
        const topic = params.topic ?? "dev-tools";
        content = `${frontmatter({ type: "synthesis", status: "draft", topic, source: "original", tags: ["wiki", topic], date: dateString() })}\n# ${params.title}\n\n${params.summary ?? ""}\n\n## Key points\n- \n\n## Connections\n- [[${topic}]]\n`;
      }

      const result = await runObsidian(pi, ["create", kv("path", notePath), kv("content", content)]);
      return result.code === 0 ? response(result) : errorResponse(result);
    },
  });
}
