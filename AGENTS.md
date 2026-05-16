# pi-config Agent Instructions

## Scope

This file is repo-local guidance for working on `~/pi-config`.

Do not treat this file as Pi's installed global agent policy. The shared global
agent instructions live in `~/nix-config/users/maxpw/agents/shared/AGENTS.md`
and are linked into each agent by Home Manager.

## Repository Purpose

This repo stores Max's Pi coding-agent configuration:

- `settings.json` configures Pi defaults.
- `extensions/` contains Pi extension modules.
- `prompts/` and `themes/`, when present, contain Pi resources.
- Runtime state and secrets stay outside the repo.

Home Manager links selected files from this repo into `~/.pi/agent`. The mapping
is defined in `~/nix-config/users/maxpw/modules/agent-tools.nix`.

## Editing Rules

- Keep changes focused on Pi configuration and extension behavior.
- Do not edit files under `/nix/store`; change this repo or the Home Manager
  module source instead.
- Do not commit local runtime state or secrets such as `auth.json`, `sessions/`,
  `.env`, package caches, or `node_modules/`.
- Preserve the extension API shape from `@earendil-works/pi-coding-agent`.
- Prefer small, dependency-light extensions unless the repo already carries the
  dependency and build path.

## Version Control

This repo is currently a Git repo, not a jj repo. Use Git commands here unless
`jj root` starts succeeding in the future.

## Verification

For config-only changes, inspect the diff and confirm the linked Home Manager
source still points where intended. For extension changes, run the narrowest
available TypeScript or Pi reload check; if there is no local build script, say
so explicitly.

Apply installed Pi config changes through the nix-config workflow:

```bash
make -C ~/nix-config rebuild
```

Inside an active Pi session, `/reload` can refresh Pi resources after the
installed files have changed.
