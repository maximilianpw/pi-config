const LINEAR_API_URL = "https://api.linear.app/graphql";

type Fetch = typeof fetch;
type GraphQLError = {
  message?: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
};
type GraphQLResponse<T> = { data?: T; errors?: GraphQLError[] };

type Team = { id: string; key: string; name: string };
type Project = {
  id: string;
  name: string;
  url: string;
  teams: { nodes: Team[] };
};
type Label = {
  id: string;
  name: string;
  isGroup: boolean;
  team: Team | null;
};
type User = { id: string; name: string; email: string | null };
type WorkflowState = { id: string; name: string; type: string };

export const DEFAULT_ASSIGNEE = "me";
export const DEFAULT_STATE = "In Progress";

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  updatedAt: string;
  assignee: { id: string; name: string } | null;
  team: Team;
  state: { id: string; name: string; type: string };
  project: { id: string; name: string; url: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
};

export type CreateIssueInput = {
  title: string;
  team?: string;
  description?: string;
  labels?: string[];
  project?: string;
  priority?: number;
  assignee?: string;
  state?: string;
};

export type UpdateIssueInput = {
  id: string;
  title?: string;
  description?: string;
  labels?: string[];
  project?: string;
  clearProject?: boolean;
  assignee?: string;
  state?: string;
};

export type ListIssuesInput = {
  query?: string;
  team?: string;
  project?: string;
  label?: string;
  state?: string;
  assignee?: string;
  limit: number;
};

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  updatedAt
  assignee { id name }
  team { id key name }
  state { id name type }
  project { id name url }
  labels(first: 50) { nodes { id name } }
`;

function cleanReference(reference: string, kind: string): string {
  const value = reference.trim();
  if (!value) throw new Error(`${kind} must not be empty`);
  return value;
}

function exact(value: string, candidate: string): boolean {
  return value.localeCompare(candidate, undefined, { sensitivity: "accent" }) === 0;
}

function isUuid(reference: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference);
}

function referenceFilter(reference: string, names: string[]): Record<string, unknown> {
  return {
    or: [
      ...(isUuid(reference) ? [{ id: { eq: reference } }] : []),
      ...names.map((name) => ({ [name]: { eqIgnoreCase: reference } })),
    ],
  };
}

function describeTeams(teams: Team[]): string {
  return teams.map((team) => `${team.key} (${team.name}, ${team.id})`).join(", ");
}

function selectTeam(reference: string, teams: Team[]): Team {
  const matches = teams.filter(
    (team) => exact(team.id, reference) || exact(team.key, reference) || exact(team.name, reference),
  );
  if (matches.length === 0) throw new Error(`No Linear team matched "${reference}"`);
  if (matches.length > 1) {
    throw new Error(`Linear team "${reference}" is ambiguous: ${describeTeams(matches)}`);
  }
  return matches[0]!;
}

function selectProject(reference: string, team: Team, projects: Project[]): Project {
  const exactMatches = projects.filter(
    (project) => exact(project.id, reference) || exact(project.name, reference),
  );
  const compatible = exactMatches.filter((project) =>
    project.teams.nodes.some((candidate) => candidate.id === team.id),
  );
  if (compatible.length === 0) {
    if (exactMatches.length > 0) {
      throw new Error(`Linear project "${reference}" is not associated with team ${team.key}`);
    }
    throw new Error(`No Linear project matched "${reference}" for team ${team.key}`);
  }
  if (compatible.length > 1) {
    throw new Error(
      `Linear project "${reference}" is ambiguous: ${compatible.map((project) => `${project.name} (${project.id})`).join(", ")}`,
    );
  }
  return compatible[0]!;
}

function selectLabel(reference: string, team: Team, labels: Label[]): Label {
  const matches = labels.filter(
    (label) =>
      !label.isGroup &&
      (exact(label.id, reference) || exact(label.name, reference)) &&
      (label.team === null || label.team.id === team.id),
  );
  const teamMatches = matches.filter((label) => label.team?.id === team.id);
  const preferred = teamMatches.length > 0 ? teamMatches : matches;
  if (preferred.length === 0) {
    throw new Error(`No applicable Linear label matched "${reference}" for team ${team.key}`);
  }
  if (preferred.length > 1) {
    throw new Error(
      `Linear label "${reference}" is ambiguous: ${preferred.map((label) => `${label.name} (${label.id})`).join(", ")}`,
    );
  }
  return preferred[0]!;
}

function selectUser(reference: string, users: User[]): User {
  const matches = users.filter(
    (user) =>
      exact(user.id, reference) ||
      exact(user.name, reference) ||
      (user.email !== null && exact(user.email, reference)),
  );
  if (matches.length === 0) throw new Error(`No Linear user matched "${reference}"`);
  if (matches.length > 1) {
    throw new Error(
      `Linear user "${reference}" is ambiguous: ${matches.map((user) => `${user.name} (${user.email ?? "no email"}, ${user.id})`).join(", ")}`,
    );
  }
  return matches[0]!;
}

function selectWorkflowState(
  reference: string,
  team: Team,
  states: WorkflowState[],
): WorkflowState {
  const matches = states.filter(
    (state) => exact(state.id, reference) || exact(state.name, reference),
  );
  if (matches.length === 0) {
    throw new Error(`No Linear workflow state matched "${reference}" for team ${team.key}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Linear workflow state "${reference}" is ambiguous: ${matches.map((state) => `${state.name} (${state.id})`).join(", ")}`,
    );
  }
  return matches[0]!;
}

function isAny(reference: string): boolean {
  return exact(reference.trim(), "any");
}

function isUnassigned(reference: string): boolean {
  const value = reference.trim();
  return exact(value, "none") || exact(value, "unassigned");
}

export class LinearClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly defaultTeam?: string,
    private readonly endpoint: string = LINEAR_API_URL,
  ) {
    if (!apiKey.trim()) throw new Error("Linear API key is empty");
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal,
    });

    const text = await response.text();
    let payload: GraphQLResponse<T>;
    try {
      payload = JSON.parse(text) as GraphQLResponse<T>;
    } catch {
      throw new Error(
        `Linear API returned ${response.status} with a non-JSON response${text ? `: ${text.slice(0, 300)}` : ""}`,
      );
    }

    if (!response.ok) {
      const apiMessage = payload.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new Error(`Linear API request failed (${response.status})${apiMessage ? `: ${apiMessage}` : ""}`);
    }
    if (payload.errors?.length) {
      throw new Error(
        `Linear API error: ${payload.errors.map((error) => error.message ?? "Unknown GraphQL error").join("; ")}`,
      );
    }
    if (payload.data === undefined) throw new Error("Linear API response did not include data");
    return payload.data;
  }

  async getIssue(id: string, signal?: AbortSignal): Promise<LinearIssue> {
    const reference = cleanReference(id, "Issue identifier");
    const data = await this.request<{ issue: LinearIssue }>(
      `query LinearIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: reference },
      signal,
    );
    return data.issue;
  }

  async listIssues(input: ListIssuesInput, signal?: AbortSignal): Promise<LinearIssue[]> {
    const conditions: Record<string, unknown>[] = [];
    if (input.query?.trim()) {
      const query = input.query.trim();
      conditions.push({
        or: [
          { title: { containsIgnoreCase: query } },
          { description: { containsIgnoreCase: query } },
        ],
      });
    }

    const teamReference = input.team?.trim() || this.defaultTeam?.trim();
    if (teamReference && !isAny(teamReference)) {
      conditions.push({ team: referenceFilter(teamReference, ["key", "name"]) });
    }
    if (input.project?.trim()) {
      conditions.push({ project: referenceFilter(input.project.trim(), ["name"]) });
    }
    if (input.label?.trim()) {
      conditions.push({ labels: referenceFilter(input.label.trim(), ["name"]) });
    }
    if (input.state?.trim()) {
      conditions.push({ state: { name: { eqIgnoreCase: input.state.trim() } } });
    }

    const assigneeReference = input.assignee?.trim() || DEFAULT_ASSIGNEE;
    if (!isAny(assigneeReference)) {
      if (isUnassigned(assigneeReference)) {
        conditions.push({ assignee: { null: true } });
      } else {
        const assignee = await this.resolveUser(assigneeReference, signal);
        conditions.push({ assignee: { id: { eq: assignee.id } } });
      }
    }

    const filter =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : { and: conditions };
    const data = await this.request<{ issues: { nodes: LinearIssue[] } }>(
      `query LinearIssues($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }
      }`,
      { first: input.limit, filter },
      signal,
    );
    return data.issues.nodes;
  }

  async createIssue(input: CreateIssueInput, signal?: AbortSignal): Promise<LinearIssue> {
    const title = cleanReference(input.title, "Issue title");
    const teamReference = input.team?.trim() || this.defaultTeam?.trim();
    if (!teamReference) {
      throw new Error("Linear team is required. Pass team or configure LINEAR_DEFAULT_TEAM.");
    }
    const team = await this.resolveTeam(teamReference, signal);
    const assigneeReference = input.assignee ?? DEFAULT_ASSIGNEE;
    const stateReference = input.state ?? DEFAULT_STATE;
    const [project, labels, assignee, state] = await Promise.all([
      input.project ? this.resolveProject(input.project, team, signal) : undefined,
      this.resolveLabels(input.labels ?? [], team, signal),
      isUnassigned(assigneeReference)
        ? undefined
        : this.resolveUser(assigneeReference, signal),
      this.resolveState(stateReference, team, signal),
    ]);

    const mutationInput: Record<string, unknown> = {
      title,
      teamId: team.id,
      stateId: state.id,
    };
    if (assignee) mutationInput.assigneeId = assignee.id;
    if (input.description !== undefined) mutationInput.description = input.description;
    if (input.priority !== undefined) mutationInput.priority = input.priority;
    if (project) mutationInput.projectId = project.id;
    if (input.labels !== undefined) mutationInput.labelIds = labels.map((label) => label.id);

    const data = await this.request<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(
      `mutation LinearIssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
      }`,
      { input: mutationInput },
      signal,
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new Error("Linear reported that issue creation failed");
    }
    return data.issueCreate.issue;
  }

  async updateIssue(input: UpdateIssueInput, signal?: AbortSignal): Promise<LinearIssue> {
    if (input.project !== undefined && input.clearProject) {
      throw new Error("Pass either project or clearProject, not both");
    }
    const hasUpdate =
      input.title !== undefined ||
      input.description !== undefined ||
      input.labels !== undefined ||
      input.project !== undefined ||
      input.clearProject === true ||
      input.assignee !== undefined ||
      input.state !== undefined;
    if (!hasUpdate) throw new Error("No issue updates were provided");

    const needsTeam =
      input.project !== undefined || (input.labels?.length ?? 0) > 0 || input.state !== undefined;
    const current = needsTeam ? await this.getIssue(input.id, signal) : undefined;
    const [project, labels, assignee, state] = await Promise.all([
      input.project ? this.resolveProject(input.project, current!.team, signal) : undefined,
      input.labels === undefined
        ? undefined
        : input.labels.length === 0
          ? []
          : this.resolveLabels(input.labels, current!.team, signal),
      input.assignee === undefined
        ? undefined
        : isUnassigned(input.assignee)
          ? null
          : this.resolveUser(input.assignee, signal),
      input.state !== undefined
        ? this.resolveState(input.state, current!.team, signal)
        : undefined,
    ]);
    const mutationInput: Record<string, unknown> = {};
    if (input.title !== undefined) mutationInput.title = cleanReference(input.title, "Issue title");
    if (input.description !== undefined) mutationInput.description = input.description;
    if (input.labels !== undefined) mutationInput.labelIds = labels!.map((label) => label.id);
    if (project) mutationInput.projectId = project.id;
    if (input.clearProject) mutationInput.projectId = null;
    if (input.assignee !== undefined) mutationInput.assigneeId = assignee?.id ?? null;
    if (state) mutationInput.stateId = state.id;

    const data = await this.request<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(
      `mutation LinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
      }`,
      { id: current?.id ?? cleanReference(input.id, "Issue identifier"), input: mutationInput },
      signal,
    );
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new Error("Linear reported that issue update failed");
    }
    return data.issueUpdate.issue;
  }

  private async resolveUser(reference: string, signal?: AbortSignal): Promise<User> {
    const value = cleanReference(reference, "Assignee");
    if (exact(value, "me")) {
      const data = await this.request<{ viewer: User }>(
        `query LinearViewer { viewer { id name email } }`,
        {},
        signal,
      );
      return data.viewer;
    }

    const data = await this.request<{ users: { nodes: User[] } }>(
      `query LinearResolveUser($filter: UserFilter!) {
        users(first: 50, filter: $filter) { nodes { id name email } }
      }`,
      { filter: referenceFilter(value, ["name", "email"]) },
      signal,
    );
    return selectUser(value, data.users.nodes);
  }

  private async resolveState(
    reference: string,
    team: Team,
    signal?: AbortSignal,
  ): Promise<WorkflowState> {
    const value = cleanReference(reference, "Workflow state");
    const data = await this.request<{
      team: { states: { nodes: WorkflowState[] } } | null;
    }>(
      `query LinearResolveState($teamId: String!) {
        team(id: $teamId) { states(first: 50) { nodes { id name type } } }
      }`,
      { teamId: team.id },
      signal,
    );
    if (!data.team) throw new Error(`Linear team ${team.key} was not found while resolving state`);
    return selectWorkflowState(value, team, data.team.states.nodes);
  }

  private async resolveTeam(reference: string, signal?: AbortSignal): Promise<Team> {
    const value = cleanReference(reference, "Team");
    const data = await this.request<{ teams: { nodes: Team[] } }>(
      `query LinearResolveTeam($filter: TeamFilter!) {
        teams(first: 50, filter: $filter) { nodes { id key name } }
      }`,
      { filter: referenceFilter(value, ["key", "name"]) },
      signal,
    );
    return selectTeam(value, data.teams.nodes);
  }

  private async resolveProject(reference: string, team: Team, signal?: AbortSignal): Promise<Project> {
    const value = cleanReference(reference, "Project");
    const data = await this.request<{ projects: { nodes: Project[] } }>(
      `query LinearResolveProject($filter: ProjectFilter!) {
        projects(first: 50, filter: $filter) {
          nodes { id name url teams(first: 50) { nodes { id key name } } }
        }
      }`,
      { filter: referenceFilter(value, ["name"]) },
      signal,
    );
    return selectProject(value, team, data.projects.nodes);
  }

  private async resolveLabels(references: string[], team: Team, signal?: AbortSignal): Promise<Label[]> {
    const cleaned = references.map((reference) => cleanReference(reference, "Label"));
    const values = [...new Map(cleaned.map((value) => [value.toLowerCase(), value])).values()];
    if (values.length === 0) return [];
    const data = await this.request<{ issueLabels: { nodes: Label[] } }>(
      `query LinearResolveLabels($filter: IssueLabelFilter!) {
        issueLabels(first: 100, filter: $filter) {
          nodes { id name isGroup team { id key name } }
        }
      }`,
      {
        filter: {
          or: values.flatMap((value) => [
            ...(isUuid(value) ? [{ id: { eq: value } }] : []),
            { name: { eqIgnoreCase: value } },
          ]),
        },
      },
      signal,
    );
    const resolved = values.map((value) => selectLabel(value, team, data.issueLabels.nodes));
    return [...new Map(resolved.map((label) => [label.id, label])).values()];
  }
}
