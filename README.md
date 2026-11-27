# pi-config

Editable source for Max's Pi coding-agent config. Home Manager links this tree into `~/.pi/agent`.

Agent policy lives in `~/nix-config` at `users/maxpw/files/editable/agents/shared/AGENTS.md`, shared by Pi, Claude Code, and Codex. The `AGENTS.md` here is only for people and agents editing this repo.

## Layout

- `models.json` — custom model providers
- `cloudflare-deployment-allowlist.json` — human-owned deployment policy; empty maps deny all deployments
- `extensions/` — global Pi extensions; each package or `.ts` file is the source of truth for the commands and tools it registers
  - `cloudflare-deployment-guard/` holds agent deployments of Workers and Alchemy stacks to the allowlist above. It is ported from [dmmulroy/.dotfiles](https://github.com/dmmulroy/.dotfiles); its README lists the local adaptations to keep when syncing.
  - `terminal-browser.ts` registers the `browser` tool, which drives `terminal-browser` in a pane beside the conversation through agent-browser commands. Each session opens and keeps its own browser, gets screenshots back as images, and clears the agent-control indicator when the run settles. It refuses to upload `.env` or `auth.json`, and asks before WebMCP page tools that are not declared read-only. It needs `terminal-browser` on `PATH` and a terminal that can split panes, such as Rex.
  - `continue-after-compaction.ts` steers the agent, after each automatic compaction, to re-read the session file around the cut and continue. A manual `/compact` at rest waits for you.
  - `session-finder/` adds `/find` (this session) and `/find-all` (every session, SQLite full-text index under `~/.pi/agent/cache/`).
  - `rex-transfer.ts` adds `/transfer [host]`, the Pi half of the Rex action in nix-config (`users/maxpw/files/managed/.config/rex/transfer_pi_session/`) that moves a session and its working tree to another Rex host.
  - `safety-guard.ts` blocks writes to `.env`, `.git`, `.jj`, `node_modules`, `/nix/store`, and Pi's `auth.json`, blocks Git hook bypasses, and asks before dangerous shell operations. It parses bash with the same walker (`shared/shell-ast.ts`), so reads, quoted text, and `2>/dev/null` near protected paths are not blocked.
  - The CLIProxyAPI quota footer reads Fleet's `cliproxy-quota` HTTP service at `quotaUrl` from `~/.config/cliproxyapi/client.json`. The service and `cliproxyapi-util quota` live in the Fleet repository (`services/cliproxy-quota/`), not here.
- `prompts/` — prompt templates
- `themes/` — TUI themes

Notable local commands include `/toggle-skills`, `/worktrees`, `/save-md`, `/find`, `/find-all`, and `/transfer`. The worktree manager targets repositories using the canonical `.bare` plus linked-checkout layout. Its creation helper is bundled under `extensions/pi-worktrees/scripts/`.

Skills are not stored here. They live in `~/Local/agent-skills` and install with:

```bash
skills add ~/Local/agent-skills --global --agent pi --skill '*' --yes
```

Do not commit `auth.json`, sessions, `.env`, or package caches.

Pi's `settings.json` (defaults, enabled models, installed Pi packages) lives in `nix-config` at `users/maxpw/files/editable/agents/pi/settings.json`, linked into `~/.pi/agent` so Pi's own changes land there. Plannotator comes from `npm:@plannotator/pi-extension` in it. Start a plan-mode session with `pi --plan`.

MCP servers are declared in `nix-config` (`modules/agent-tools/home.nix`), which writes `~/.pi/agent/mcp.json` and registers the same servers for Claude Code and Codex. Computer use goes through the `computer` server: `fleet computer joyce`, which is `cua-driver mcp` on Joyce itself and the same server over SSH from any other host. It has a 60-second request timeout and uses deferred exposure: `tool_search` discovers tools and declares them when needed, rather than putting the entire computer API into every coding prompt. Pi's normal tool permission pipeline applies to MCP calls, including nested codemode calls.

The `executor` MCP server keeps the default codemode exposure. Server descriptions make both servers discoverable before they connect.

## Pi v1 defaults and development

- The default model is `pi-claude-cli/claude-opus-5-5` at `high` thinking. `enabledModels` limits startup selection and Ctrl+P cycling to GPT-6.1 Sol and GPT-6 Astra through CLIProxyAPI, and Claude Opus 5.5 and Fable 5.2 through [`pi-claude-cli`](https://github.com/dmmulroy/pi-claude-cli), which runs them on the Claude subscription via the `claude` CLI; `/model` still lists every available model.
- The four Pi SDK dependencies are pinned together to `1.6.0`, the newest release on npm; the installed host is `1.6.1`. Update them and `bun.lock` together when upgrading Pi.
- `defaultTools` adds `codemode` and `tool_search` without replacing the normal file and shell tools. Codemode remains available even when no MCP server connects; its default `on` mode keeps direct tools available too.
- `quietStartup: "header"` keeps version/key hints and hides the repetitive resource listing. Fullscreen comes from Pi v1's default; the custom Catppuccin theme remains selected.
- There is no in-process subagent extension. Parallel agents run as separate Pi sessions in Rex windows and split panes, driven by the `rex` CLI or the `rex` codemode tools from the `rex-sdk` package. Each one is a normal, visible session that loads every guard here.
- CLIProxyAPI discovery never blocks startup. Pi starts from the catalog last persisted in `models-store.json` and fetches the live catalog in its background refresh, persisting it for the next launch; new proxy models therefore appear from the following start. Before any catalog is stored, the built-in fallback includes GPT-6.1 Sol and GPT-6 Astra, so the scoped `enabledModels` list resolves. Only the existing GPT-5.6 Sol Fast alias rewrites requests to the priority tier; newer Sol models are not assumed to support it.

Normal checks do not call provider APIs or require live credentials.

## Apply

```bash
bun install --frozen-lockfile
bun run check
make -C ~/nix-config rebuild
```

Inside a running Pi session, `/reload` picks up installed resources.
