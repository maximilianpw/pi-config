# pi-config

Editable source for Max's Pi coding-agent config. Home Manager links this tree into `~/.pi/agent`.

Agent policy lives in `~/nix-config`: shared rules in `users/maxpw/agents/shared/AGENTS.md`, Pi-only rules in `users/maxpw/agents/pi/AGENTS.md`. The `AGENTS.md` here is only for people and agents editing this repo.

## Layout

- `settings.json` — Pi defaults, enabled models, and installed Pi packages
- `mcp.json` — Pi MCP adapter settings and the local Cua Driver computer-use server
- `cloudflare-deployment-allowlist.json` — human-owned deployment policy; empty maps deny all deployments
- `cli/` — command-line entry points installed by Home Manager, including `cliproxyapi-util quota`
- `extensions/` — global Pi extensions; each package or `.ts` file is the source of truth for the commands and tools it registers
- `prompts/` — prompt templates
- `themes/` — TUI themes

Notable local commands include `/toggle-skills`, `/worktrees`, and `/save-md`. The worktree manager targets repositories using the canonical `.bare` plus linked-checkout layout. Its creation helper is bundled under `extensions/pi-worktrees/scripts/`.

Skills are not stored here. They live in `~/Local/agent-skills` and install with:

```bash
skills add ~/Local/agent-skills --global --agent pi --skill '*' --yes
```

Do not commit `auth.json`, sessions, `.env`, or package caches.

Plannotator comes from `npm:@plannotator/pi-extension` in `settings.json`. Start a plan-mode session with `pi --plan`.

Computer use is provided by the pinned `pi-mcp-adapter` package and the `computer` server in `mcp.json`. The server starts lazily with `cua-driver mcp`, does not inherit the full Pi environment, and requires approval for every MCP tool call.

## Apply

```bash
bun install
bun run check
make -C ~/nix-config rebuild
```

Inside a running Pi session, `/reload` picks up installed resources.
