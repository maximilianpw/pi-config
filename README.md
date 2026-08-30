# pi-config

Editable source for Max's Pi coding-agent config. Home Manager links this tree into `~/.pi/agent`.

Agent policy lives in `~/nix-config`: shared rules in `users/maxpw/agents/shared/AGENTS.md`, Pi-only rules in `users/maxpw/agents/pi/AGENTS.md`. The `AGENTS.md` here is only for people and agents editing this repo.

## Layout

- `settings.json` — Pi defaults, enabled models, and installed Pi packages
- `cli/` — command-line entry points installed by Home Manager, including `cliproxyapi-util quota`
- `extensions/` — global Pi extensions; each package or `.ts` file is the source of truth for the commands and tools it registers
- `prompts/` — prompt templates
- `themes/` — TUI themes

Skills are not stored here. They live in `~/Local/agent-skills` and install with:

```bash
skills add ~/Local/agent-skills --global --agent pi --skill '*' --yes
```

Do not commit `auth.json`, sessions, `.env`, or package caches.

Plannotator comes from `npm:@plannotator/pi-extension` in `settings.json`. Start a plan-mode session with `pi --plan`.

## Apply

```bash
bun install
bun run check
make -C ~/nix-config rebuild
```

Inside a running Pi session, `/reload` picks up installed resources.
