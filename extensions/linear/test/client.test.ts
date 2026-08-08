import assert from "node:assert/strict";
import test from "node:test";

import {
  LinearClient,
  type LinearIssue,
} from "../client.ts";

type RequestBody = {
  query: string;
  variables: Record<string, unknown>;
};

type MockHandler = (body: RequestBody, init: RequestInit | undefined) => unknown;

function mockFetch(handler: MockHandler): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as RequestBody;
    const payload = handler(body, init);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const team = { id: "team-1", key: "ENG", name: "Engineering" };
const defaultTeam = { id: "team-1", key: "ENG", name: "Engineering" };
const viewer = { id: "user-me", name: "Example User", email: "user@example.com" };
const inProgress = { id: "state-progress", name: "In Progress", type: "started" };
const project = {
  id: "project-1",
  name: "Launch",
  url: "https://linear.app/project/project-1",
};

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "issue-uuid",
    identifier: "ENG-123",
    title: "Ship the extension",
    description: "Details",
    url: "https://linear.app/issue/ENG-123",
    priority: 2,
    updatedAt: "2026-01-02T00:00:00.000Z",
    assignee: null,
    team,
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    project,
    labels: { nodes: [{ id: "label-team-bug", name: "Bug" }] },
    ...overrides,
  };
}

test("getIssue sends a personal API key and surfaces GraphQL errors", async () => {
  let authorization: string | null = null;
  const client = new LinearClient(
    "linear-secret",
    mockFetch((_body, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return { errors: [{ message: "Issue not found" }] };
    }),
  );

  await assert.rejects(client.getIssue("ENG-404"), /Linear API error: Issue not found/);
  assert.equal(authorization, "linear-secret");
});

test("createIssue uses the configured default team, viewer, and state", async () => {
  const seenOperations: string[] = [];
  let teamFilter: Record<string, unknown> | undefined;
  let mutationInput: Record<string, unknown> | undefined;
  const client = new LinearClient(
    "linear-secret",
    mockFetch((body) => {
      if (body.query.includes("LinearResolveTeam")) {
        seenOperations.push("team");
        teamFilter = body.variables.filter as Record<string, unknown>;
        return { data: { teams: { nodes: [defaultTeam] } } };
      }
      if (body.query.includes("LinearResolveProject")) {
        seenOperations.push("project");
        return {
          data: {
            projects: {
              nodes: [
                { ...project, teams: { nodes: [team] } },
                {
                  id: "project-other",
                  name: "Launch",
                  url: "https://linear.app/project/project-other",
                  teams: { nodes: [{ id: "team-2", key: "OPS", name: "Operations" }] },
                },
              ],
            },
          },
        };
      }
      if (body.query.includes("LinearResolveLabels")) {
        seenOperations.push("labels");
        return {
          data: {
            issueLabels: {
              nodes: [
                { id: "label-workspace-bug", name: "Bug", isGroup: false, team: null },
                { id: "label-team-bug", name: "Bug", isGroup: false, team: defaultTeam },
                { id: "label-ops", name: "Ops", isGroup: false, team: null },
              ],
            },
          },
        };
      }
      if (body.query.includes("LinearViewer")) {
        seenOperations.push("viewer");
        return { data: { viewer } };
      }
      if (body.query.includes("LinearResolveState")) {
        seenOperations.push("state");
        return { data: { team: { states: { nodes: [inProgress] } } } };
      }
      if (body.query.includes("LinearIssueCreate")) {
        seenOperations.push("create");
        mutationInput = body.variables.input as Record<string, unknown>;
        return { data: { issueCreate: { success: true, issue: issue() } } };
      }
      throw new Error(`Unexpected operation: ${body.query}`);
    }),
    "ENG",
  );

  const created = await client.createIssue({
    title: "Ship the extension",
    description: "Details",
    project: "Launch",
    labels: ["bug", "Bug", "Ops"],
    priority: 2,
  });

  assert.equal(created.identifier, "ENG-123");
  assert.deepEqual(teamFilter, {
    or: [
      { key: { eqIgnoreCase: "ENG" } },
      { name: { eqIgnoreCase: "ENG" } },
    ],
  });
  assert.deepEqual(seenOperations, ["team", "project", "labels", "viewer", "state", "create"]);
  assert.deepEqual(mutationInput, {
    title: "Ship the extension",
    teamId: "team-1",
    stateId: "state-progress",
    assigneeId: "user-me",
    description: "Details",
    priority: 2,
    projectId: "project-1",
    labelIds: ["label-team-bug", "label-ops"],
  });
});

test("createIssue requires a team when no default is configured", async () => {
  const client = new LinearClient("linear-secret");

  await assert.rejects(
    client.createIssue({ title: "Ship the extension" }),
    /Linear team is required\. Pass team or configure LINEAR_DEFAULT_TEAM\./,
  );
});

test("updateIssue can clear all labels and remove the project", async () => {
  let mutationVariables: Record<string, unknown> | undefined;
  const client = new LinearClient(
    "linear-secret",
    mockFetch((body) => {
      if (body.query.includes("LinearIssueUpdate")) {
        mutationVariables = body.variables;
        return {
          data: {
            issueUpdate: {
              success: true,
              issue: issue({ project: null, labels: { nodes: [] } }),
            },
          },
        };
      }
      throw new Error(`Unexpected operation: ${body.query}`);
    }),
  );

  const updated = await client.updateIssue({
    id: "ENG-123",
    labels: [],
    clearProject: true,
  });

  assert.equal(updated.project, null);
  assert.deepEqual(mutationVariables, {
    id: "ENG-123",
    input: { labelIds: [], projectId: null },
  });
});

test("updateIssue can assign the viewer and change workflow state", async () => {
  let mutationVariables: Record<string, unknown> | undefined;
  const client = new LinearClient(
    "linear-secret",
    mockFetch((body) => {
      if (body.query.includes("query LinearIssue(")) {
        return { data: { issue: issue() } };
      }
      if (body.query.includes("LinearViewer")) {
        return { data: { viewer } };
      }
      if (body.query.includes("LinearResolveState")) {
        return { data: { team: { states: { nodes: [inProgress] } } } };
      }
      if (body.query.includes("LinearIssueUpdate")) {
        mutationVariables = body.variables;
        return {
          data: {
            issueUpdate: {
              success: true,
              issue: issue({ assignee: viewer, state: inProgress }),
            },
          },
        };
      }
      throw new Error(`Unexpected operation: ${body.query}`);
    }),
  );

  await client.updateIssue({ id: "ENG-123", assignee: "me", state: "In Progress" });

  assert.deepEqual(mutationVariables, {
    id: "issue-uuid",
    input: { assigneeId: "user-me", stateId: "state-progress" },
  });
});

test("updateIssue rejects an unsuccessful mutation", async () => {
  const client = new LinearClient(
    "linear-secret",
    mockFetch(() => ({
      data: { issueUpdate: { success: false, issue: null } },
    })),
  );

  await assert.rejects(
    client.updateIssue({ id: "ENG-123", title: "New title" }),
    /Linear reported that issue update failed/,
  );
});

test("a non-JSON HTTP failure is reported clearly", async () => {
  const fetchImpl = (async (): Promise<Response> =>
    new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
  const client = new LinearClient("linear-secret", fetchImpl);

  await assert.rejects(
    client.getIssue("ENG-123"),
    /Linear API returned 502 with a non-JSON response/,
  );
});

test("listIssues defaults to the configured team and current viewer", async () => {
  const seenOperations: string[] = [];
  let variables: Record<string, unknown> | undefined;
  const client = new LinearClient(
    "linear-secret",
    mockFetch((body) => {
      if (body.query.includes("LinearViewer")) {
        seenOperations.push("viewer");
        return { data: { viewer } };
      }
      if (body.query.includes("LinearIssues")) {
        seenOperations.push("issues");
        variables = body.variables;
        return { data: { issues: { nodes: [issue()] } } };
      }
      throw new Error(`Unexpected operation: ${body.query}`);
    }),
    "ENG",
  );

  const issues = await client.listIssues({ limit: 20 });

  assert.equal(issues.length, 1);
  assert.deepEqual(seenOperations, ["viewer", "issues"]);
  assert.deepEqual(variables?.filter, {
    and: [
      {
        team: {
          or: [
            { key: { eqIgnoreCase: "ENG" } },
            { name: { eqIgnoreCase: "ENG" } },
          ],
        },
      },
      { assignee: { id: { eq: "user-me" } } },
    ],
  });
});

test("listIssues builds combined relationship and text filters", async () => {
  let variables: Record<string, unknown> | undefined;
  const client = new LinearClient(
    "linear-secret",
    mockFetch((body) => {
      variables = body.variables;
      return { data: { issues: { nodes: [issue()] } } };
    }),
  );

  const issues = await client.listIssues({
    query: "extension",
    team: "ENG",
    project: "Launch",
    label: "Bug",
    state: "Todo",
    assignee: "any",
    limit: 10,
  });

  assert.equal(issues.length, 1);
  assert.equal(variables?.first, 10);
  assert.deepEqual(variables?.filter, {
    and: [
      {
        or: [
          { title: { containsIgnoreCase: "extension" } },
          { description: { containsIgnoreCase: "extension" } },
        ],
      },
      {
        team: {
          or: [
            { key: { eqIgnoreCase: "ENG" } },
            { name: { eqIgnoreCase: "ENG" } },
          ],
        },
      },
      {
        project: {
          or: [
            { name: { eqIgnoreCase: "Launch" } },
          ],
        },
      },
      {
        labels: {
          or: [
            { name: { eqIgnoreCase: "Bug" } },
          ],
        },
      },
      { state: { name: { eqIgnoreCase: "Todo" } } },
    ],
  });
});
