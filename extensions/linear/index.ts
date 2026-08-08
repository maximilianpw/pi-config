import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  DEFAULT_ASSIGNEE,
  DEFAULT_STATE,
  LinearClient,
  type LinearIssue,
} from "./client.ts";
import { loadLinearApiKey } from "./credentials.ts";

const LINEAR_DEFAULT_TEAM_ENV = "LINEAR_DEFAULT_TEAM";

function labelsSchema(description: string) {
  return Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description,
      maxItems: 50,
    }),
  );
}

const createSchema = Type.Object({
  title: Type.String({ description: "Issue title", minLength: 1 }),
  team: Type.Optional(
    Type.String({
      description: `Team key, name, or UUID. Defaults to ${LINEAR_DEFAULT_TEAM_ENV} when configured; otherwise required.`,
      minLength: 1,
    }),
  ),
  description: Type.Optional(Type.String({ description: "Markdown issue description" })),
  labels: labelsSchema("Linear label/tag names or UUIDs to apply to the new issue"),
  project: Type.Optional(Type.String({ description: "Project name or UUID", minLength: 1 })),
  priority: Type.Optional(
    Type.Integer({
      description: "Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low",
      minimum: 0,
      maximum: 4,
    }),
  ),
  assignee: Type.Optional(
    Type.String({
      description: `Assignee name, email, UUID, "me", or "none". Defaults to ${DEFAULT_ASSIGNEE}.`,
      minLength: 1,
    }),
  ),
  state: Type.Optional(
    Type.String({
      description: `Workflow state name or UUID. Defaults to ${DEFAULT_STATE}.`,
      minLength: 1,
    }),
  ),
});

const getSchema = Type.Object({
  id: Type.String({ description: "Issue identifier such as ENG-123, or issue UUID", minLength: 1 }),
});

const listSchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Case-insensitive text to find in issue titles or descriptions" })),
  team: Type.Optional(
    Type.String({ description: `Filter by team key, name, or UUID. Defaults to ${LINEAR_DEFAULT_TEAM_ENV} when configured; pass "any" for all teams.` }),
  ),
  project: Type.Optional(Type.String({ description: "Filter by project name or UUID" })),
  label: Type.Optional(Type.String({ description: "Filter by one label/tag name or UUID" })),
  state: Type.Optional(Type.String({ description: "Filter by workflow state name, such as Todo, In Progress, or Done" })),
  assignee: Type.Optional(
    Type.String({ description: `Filter by assignee name, email, UUID, "me", or "unassigned". Defaults to ${DEFAULT_ASSIGNEE}; pass "any" for all assignees.` }),
  ),
  limit: Type.Optional(
    Type.Integer({ description: "Maximum issues to return. Defaults to 20.", minimum: 1, maximum: 50 }),
  ),
});

const updateSchema = Type.Object({
  id: Type.String({ description: "Issue identifier such as ENG-123, or issue UUID", minLength: 1 }),
  title: Type.Optional(Type.String({ description: "Replacement issue title", minLength: 1 })),
  description: Type.Optional(Type.String({ description: "Replacement Markdown description; pass an empty string to clear" })),
  labels: labelsSchema("Replacement label/tag names or UUIDs; this replaces all current labels, and [] clears them"),
  project: Type.Optional(Type.String({ description: "Replacement project name or UUID", minLength: 1 })),
  clearProject: Type.Optional(Type.Boolean({ description: "Set true to remove the issue from its project" })),
  assignee: Type.Optional(
    Type.String({ description: "Replacement assignee name, email, UUID, or \"me\"; pass \"none\" to unassign", minLength: 1 }),
  ),
  state: Type.Optional(
    Type.String({ description: "Replacement workflow state name or UUID", minLength: 1 }),
  ),
});

type CreateToolInput = Static<typeof createSchema>;
type ListToolInput = Static<typeof listSchema>;
type UpdateToolInput = Static<typeof updateSchema>;

const PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

function priorityName(priority: number): string {
  return PRIORITIES[priority] ?? String(priority);
}

function issueHeader(issue: LinearIssue): string {
  return `${issue.identifier} — ${issue.title}`;
}

function formatIssue(issue: LinearIssue, includeDescription: boolean): string {
  const lines = [
    issueHeader(issue),
    `State: ${issue.state.name} (${issue.state.type})`,
    `Team: ${issue.team.key} (${issue.team.name})`,
    `Priority: ${priorityName(issue.priority)}`,
    `Project: ${issue.project?.name ?? "none"}`,
    `Labels: ${issue.labels.nodes.map((label) => label.name).join(", ") || "none"}`,
    `Assignee: ${issue.assignee?.name ?? "unassigned"}`,
    `Updated: ${issue.updatedAt}`,
    `URL: ${issue.url}`,
  ];
  if (includeDescription) lines.push("", "Description:", issue.description || "(none)");
  return lines.join("\n");
}

function boundedText(text: string): string {
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return truncation.content;
  return `${truncation.content}\n\n[Linear output truncated to ${truncation.outputLines} lines / ${formatSize(truncation.outputBytes)}. Use a narrower list query or fetch an issue directly.]`;
}

async function client(): Promise<LinearClient> {
  return new LinearClient(
    await loadLinearApiKey(),
    fetch,
    process.env[LINEAR_DEFAULT_TEAM_ENV],
  );
}

function issueDetails(issue: LinearIssue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    team: issue.team,
    project: issue.project,
    labels: issue.labels.nodes,
  };
}

export default function linearExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "linear_create_issue",
    label: "Linear Create Issue",
    description: `Create a Linear issue. Team defaults to ${LINEAR_DEFAULT_TEAM_ENV} when configured; assignee defaults to ${DEFAULT_ASSIGNEE}, and state defaults to ${DEFAULT_STATE}. Optionally assigns labels/tags and a project. Requires a configured Linear API key.`,
    promptSnippet: `Create a Linear issue (configured team, ${DEFAULT_ASSIGNEE}, ${DEFAULT_STATE})`,
    promptGuidelines: [
      `Use linear_create_issue when the user asks to create a Linear issue; omit team only when ${LINEAR_DEFAULT_TEAM_ENV} is configured, and omit assignee and state to use the defaults (${DEFAULT_ASSIGNEE} and ${DEFAULT_STATE}).`,
      "Linear calls labels what users may call tags; pass those values in linear_create_issue labels.",
    ],
    parameters: createSchema,
    async execute(_toolCallId, params: CreateToolInput, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Creating Linear issue in ${params.team ?? "the configured default team"}...` }], details: {} });
      const linear = await client();
      const issue = await linear.createIssue(params, signal);
      return {
        content: [{ type: "text", text: boundedText(`Created ${formatIssue(issue, false)}`) }],
        details: issueDetails(issue),
      };
    },
  });

  pi.registerTool({
    name: "linear_get_issue",
    label: "Linear Get Issue",
    description: "Get the current details of one Linear issue by identifier or UUID. Requires a configured Linear API key.",
    promptSnippet: "Read a Linear issue by identifier or UUID",
    promptGuidelines: [
      "Use linear_get_issue when the user asks to check or inspect a specific Linear issue.",
    ],
    parameters: getSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Loading Linear issue ${params.id}...` }], details: {} });
      const linear = await client();
      const issue = await linear.getIssue(params.id, signal);
      return {
        content: [{ type: "text", text: boundedText(formatIssue(issue, true)) }],
        details: issueDetails(issue),
      };
    },
  });

  pi.registerTool({
    name: "linear_list_issues",
    label: "Linear List Issues",
    description: `List recent Linear issues, defaulting to ${LINEAR_DEFAULT_TEAM_ENV} when configured and assignee ${DEFAULT_ASSIGNEE}. Without a configured team, lists span all teams. Supports text, team, assignee, project, label/tag, and workflow-state filters; pass "any" for team or assignee to opt out of a default. Returns at most 50 issues and requires a configured Linear API key.`,
    promptSnippet: "List or search the current user's Linear issues with optional filters",
    promptGuidelines: [
      `Use linear_list_issues when the user asks to check, find, or summarize multiple Linear issues; omit team to use ${LINEAR_DEFAULT_TEAM_ENV} when configured, omit assignee to default to ${DEFAULT_ASSIGNEE}, or pass "any" to disable either default.`,
    ],
    parameters: listSchema,
    async execute(_toolCallId, params: ListToolInput, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "Loading Linear issues..." }], details: {} });
      const linear = await client();
      const issues = await linear.listIssues({ ...params, limit: params.limit ?? 20 }, signal);
      const text =
        issues.length === 0
          ? "No Linear issues matched."
          : `${issues.length} Linear issue${issues.length === 1 ? "" : "s"}:\n\n${issues.map((issue) => formatIssue(issue, false)).join("\n\n")}`;
      return {
        content: [{ type: "text", text: boundedText(text) }],
        details: { count: issues.length, issues: issues.map(issueDetails) },
      };
    },
  });

  pi.registerTool({
    name: "linear_update_issue",
    label: "Linear Update Issue",
    description: "Update a Linear issue's title, description, labels/tags, project, assignee, or workflow state. The labels array replaces all labels; [] clears them. Requires a configured Linear API key.",
    promptSnippet: "Update a Linear issue, including its labels, project, assignee, or workflow state",
    promptGuidelines: [
      "Use linear_update_issue to change an existing Linear issue's fields, assignee, or workflow state; warn that labels replaces the complete current label set.",
    ],
    parameters: updateSchema,
    async execute(_toolCallId, params: UpdateToolInput, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Updating Linear issue ${params.id}...` }], details: {} });
      const linear = await client();
      const issue = await linear.updateIssue(params, signal);
      return {
        content: [{ type: "text", text: boundedText(`Updated ${formatIssue(issue, false)}`) }],
        details: issueDetails(issue),
      };
    },
  });
}
