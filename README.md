# pi-config

Personal Pi coding-agent configuration for Max.

This repo is the editable source of truth for Pi-specific resources. Home
Manager links selected files into `~/.pi/agent` from `~/pi-config`.

Shared global agent instructions are managed in
`~/nix-config/users/maxpw/agents/shared/AGENTS.md`. Pi-specific agent guidance is
managed in `~/nix-config/users/maxpw/agents/pi/AGENTS.md` and composed with the
shared policy by Home Manager. The root `AGENTS.md` in this repo is only local
guidance for agents editing `pi-config`.

## Managed here

- `AGENTS.md` — repo-local agent instructions for working on this config repo
- `settings.json` — Pi defaults
- `APPEND_SYSTEM.md` — small Pi-only system-prompt nudge; larger Pi policy lives in `~/nix-config/users/maxpw/agents/pi/AGENTS.md`
- `extensions/` — global Pi extensions
- `prompts/` — global prompt templates
- `themes/` — custom themes

## Not managed here

Never commit local runtime state or secrets:

- `~/.pi/agent/auth.json`
- `~/.pi/agent/sessions/`
- `~/.pi/agent/.env`
- package caches (`git/`, `npm/`, `node_modules/`)

## Extensions

- `/copy-all` — copy current user/assistant branch to clipboard
- `/changes` — ask the agent to summarize the current jj or Git changes
- `/usage` — ask the agent to compute Pi/Codex usage and costs
- `/loop plan|run|tasks|log|status|stop` — plan and run bounded saved-task loops with compact per-iteration logs
- `/handoff <goal>` — generate a focused prompt and start a fresh session
- `/plannotator` or `Ctrl+Alt+P` — toggle browser-reviewed plan mode
- `/plannotator-review` — review the current Git/JJ changes in Plannotator
- `/plannotator-annotate <file>` and `/plannotator-last` — annotate Markdown or the latest response
- `/save-md <name>` — save the latest assistant response as Markdown without overwriting
- `/cloak-status` — inspect secret-cloaking rules loaded from `cloak.json`
- `webfetch` and `websearch` — LLM-callable public web tools
- `continue-after-compaction` — automatically continue work after context compaction
- `herdr-agent-state` — report Pi activity to Herdr's agent-state UI
- `safety-guard` — confirm dangerous bash commands, protect sensitive paths,
  prevent `--no-verify`, and suppress interactive Git editors
- `obsidian-tools` — LLM-callable tools for vault search/read/create/append
- `github-issue-autocomplete` — complete `#123` issue references in GitHub repos
- `vcs-status-widget` — show current jj or Git change summary in the UI
- `tps-tracker` — show tokens/sec while streaming

Start directly in Plannotator plan mode with:

```bash
pi --plan
```

The browser gate must approve the checklist before Pi leaves planning mode and
starts implementation.

## Prompt templates

- `/review` — review current changes
- `/commit-message` — draft a commit message for current changes
- `/jj-split` — propose a focused jj split plan
- `/wiki-article` — draft a durable Obsidian wiki article
- `/diagnose-brief` — run a compact diagnosis loop

## Applying changes

Edit this repo, then rebuild Home Manager via the nix-config workflow:

```bash
make -C ~/nix-config rebuild
```

For quick Pi resource reloads inside an active Pi session, run:

```text
/reload
```

Install and verify extension dependencies with Bun:

```bash
bun install
bun run check
```

## Upstream inspiration

The compaction continuation, secret cloaking, Markdown export, and public web
tools are adapted from
[`dmmulroy/.dotfiles`](https://github.com/dmmulroy/.dotfiles/tree/3669c396c6426a613aceade2112315404dc8e39f/home/.pi)
at commit `3669c396c6426a613aceade2112315404dc8e39f`. Local safety,
package-management, theme, and platform integration changes are maintained
here.
