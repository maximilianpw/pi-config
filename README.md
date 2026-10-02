# pi-config

Editable source for Max's Pi coding-agent config. Home Manager links this tree into `~/.pi/agent`.

Agent policy lives in `~/nix-config`: shared rules in `users/maxpw/agents/shared/AGENTS.md`, Pi-only rules in `users/maxpw/agents/pi/AGENTS.md`. The `AGENTS.md` here is only for people and agents editing this repo.

## Layout

- `settings.json` — Pi defaults, enabled models, and installed Pi packages
- `mcp.json` — Pi's built-in MCP configuration for the local Cua Driver computer-use server
- `cloudflare-deployment-allowlist.json` — human-owned deployment policy; empty maps deny all deployments
- `extensions/` — global Pi extensions; each package or `.ts` file is the source of truth for the commands and tools it registers
  - The CLIProxyAPI quota footer reads Fleet's `cliproxy-quota` HTTP service at `quotaUrl` from `~/.config/cliproxyapi/client.json`. The service and `cliproxyapi-util quota` live in the Fleet repository (`services/cliproxy-quota/`), not here.
- `prompts/` — prompt templates
- `themes/` — TUI themes

Notable local commands include `/toggle-skills`, `/worktrees`, and `/save-md`. The worktree manager targets repositories using the canonical `.bare` plus linked-checkout layout. Its creation helper is bundled under `extensions/pi-worktrees/scripts/`.

Skills are not stored here. They live in `~/Local/agent-skills` and install with:

```bash
skills add ~/Local/agent-skills --global --agent pi --skill '*' --yes
```

Do not commit `auth.json`, sessions, `.env`, or package caches.

Plannotator comes from `npm:@plannotator/pi-extension` in `settings.json`. Start a plan-mode session with `pi --plan`.

Computer use uses Pi's built-in MCP support and the `computer` server in `mcp.json`. It runs `cua-driver mcp` with a 60-second request timeout and uses deferred exposure: `tool_search` discovers tools and declares them when needed, rather than putting the entire computer API into every coding prompt. Pi's normal tool permission pipeline applies to MCP calls, including nested codemode calls.

The `executor` MCP server keeps the default codemode exposure. Server descriptions make both servers discoverable before they connect.

## Pi v1 defaults and development

- The four Pi SDK dependencies are pinned together to `1.0.0`, matching the installed host used to validate these extensions. Update them and `bun.lock` together when upgrading Pi.
- `defaultTools` adds `codemode` and `tool_search` without replacing the normal file and shell tools. Codemode remains available even when no MCP server connects; its default `on` mode keeps direct tools available too.
- `quietStartup: "header"` keeps version/key hints and hides the repetitive resource listing. Fullscreen comes from Pi v1's default; the custom Catppuccin theme remains selected.
- Pi subagents explicitly load the built-in codemode and tool-search extensions, with normal settings and project-trust handling. They deliberately do not load MCP, so they do not inherit the computer or executor servers. Recursive subagent tools and `ask_user` remain excluded, including through codemode.
- CLIProxyAPI live discovery remains authoritative. Its offline fallback includes GPT-6.1 Sol. Only the existing GPT-5.6 Sol Fast alias rewrites requests to the priority tier; newer Sol models are not assumed to support it.

Subagent resource tests use temporary agent directories and a fake model provider. Normal checks do not call provider APIs or require live credentials.

## Apply

```bash
bun install --frozen-lockfile
bun run check
make -C ~/nix-config rebuild
```

Inside a running Pi session, `/reload` picks up installed resources.
