# Pi Linear extension

Small, dependency-free Linear GraphQL tools for Pi.

## Setup

Create a personal API key in Linear under **Settings → Security & access**. The preferred setup stores it as the `linear-api-key` sops-nix secret; on managed machines the extension discovers either:

- `~/.config/sops-nix/secrets/linear-api-key` (Home Manager, including Darwin and WSL)
- `/run/secrets/linear-api-key` (NixOS)

For unmanaged machines, set `LINEAR_API_KEY_FILE` to a readable secret file. `LINEAR_API_KEY` remains available as a temporary override and takes precedence over files.

The extension authenticates directly against `https://api.linear.app/graphql` and never includes the key in tool output.

## Defaults

Set `LINEAR_DEFAULT_TEAM` to a team key, name, or UUID to configure the default team without storing organization-specific details in this repository. For example:

```bash
export LINEAR_DEFAULT_TEAM=ENG
```

The tools otherwise use these defaults:

- Assignee: the authenticated Linear user (`me`)
- New-issue state: `In Progress`
- Issue lists: issues assigned to `me`

Creating an issue requires an explicit `team` when `LINEAR_DEFAULT_TEAM` is not set. Lists span all teams when no default team is configured. Pass `team: "any"` and/or `assignee: "any"` to disable those filters. Pass `assignee: "none"` to create an unassigned issue.

## Tools

- `linear_create_issue` — create an issue with personal defaults plus optional labels/tags and project assignment
- `linear_get_issue` — read one issue by `ENG-123`-style identifier or UUID
- `linear_list_issues` — list/search the current user's issues with optional text, team, assignee, project, label, or state overrides
- `linear_update_issue` — update title/description, labels, project, assignee, or workflow state

Team references accept a key, name, or UUID. Assignee references accept `me`, a name, email, or UUID. Label references accept a name or UUID. Project and workflow-state references accept a name or UUID. Names are resolved case-insensitively and ambiguous matches fail instead of guessing.

`linear_update_issue.labels` replaces the issue's complete label set; pass an empty array to clear labels. Set `clearProject: true` to remove a project, or set `assignee: "none"` to unassign the issue. Direct get/update operations never silently apply create/list defaults.
