# Guidance used to compact `/orchestrate`

## Primary sources

- [Agent Skills: best practices](https://agentskills.io/skill-creation/best-practices.md)
- [Agent Skills specification](https://agentskills.io/specification)
- [Anthropic: Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

## Applied principles

- Include only information the agent is likely to get wrong without the prompt; omit general coding and tool-use advice.
- Prefer concise, sequential workflows with explicit validation gates over exhaustive edge-case prose.
- Match control to fragility: leave topology selection flexible, but make isolation, integration order, authorization boundaries, and cleanup strict.
- Give a clear default instead of a menu: worktrees for parallel editors, panes/tabs for non-concurrent work, coordinator execution for tightly coupled work.
- Use checklists for dependency-heavy workflows and a validate/fix/revalidate loop before completion.
- Rely on progressive disclosure: the prompt loads the existing `herdr` skill instead of duplicating CLI syntax and lifecycle details.

The first draft was 107 lines and repeated substantial Herdr guidance already owned by the `herdr` skill. The compact version retains the orchestration invariants while delegating command-level mechanics to that source of truth.
