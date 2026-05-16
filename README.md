# pi-config

Personal Pi coding-agent configuration for Max.

This repo is the editable source of truth for Pi-specific resources. Home
Manager links selected files into `~/.pi/agent` from `~/pi-config`.

Shared global agent instructions are managed in
`~/nix-config/users/maxpw/agents/shared/AGENTS.md`. The root `AGENTS.md` in this
repo is only local guidance for agents editing `pi-config`.

## Managed here

- `AGENTS.md` — repo-local agent instructions for working on this config repo
- `settings.json` — Pi defaults
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
- `vcs-status-widget` — show current jj or Git change summary in the UI
- `tps-tracker` — show tokens/sec while streaming
- `zsh-user-bash` — run interactive `!`/`!!` commands through zsh without sourcing prompt integrations

## Applying changes

Edit this repo, then rebuild Home Manager via the nix-config workflow:

```bash
make -C ~/nix-config rebuild
```

For quick Pi resource reloads inside an active Pi session, run:

```text
/reload
```
