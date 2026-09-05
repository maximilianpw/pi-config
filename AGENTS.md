# Pi configuration guidance

## Purpose and ownership

This repository is the editable source for personal Pi coding-agent settings,
models, CLI utilities, themes, prompts, and extensions. Home Manager in the
separate `nix-config` checkout links these sources into `~/.pi/agent`.

- Edit this checkout, never installed links under `~/.pi/agent` or files in
  `/nix/store`.
- `settings.json` and model JSON files own Pi configuration. Each extension's
  entry point and nearest `package.json` own its runtime behavior and checks.
- Shared extension code belongs in `extensions/shared/`; keep package-specific
  code inside its extension. Preserve compatibility with the locked
  `@earendil-works/pi-*` APIs and update `bun.lock` with dependency changes.
- Agent skills and global agent policy are not owned here. See `README.md` for
  the cross-repository boundary.

## Local workflow and checks

Use the locked Bun package manager. `bun install --frozen-lockfile` prepares a
clean checkout. Local edits, tests, and typechecks are safe without asking.

- Configuration or documentation only: inspect the diff and run
  `git diff --check`.
- Root extension or CLI change: `bun run typecheck` and, when behavior changes,
  `bun run test`.
- Workspace extension change: run its discoverable package check, for example
  `bun run --filter pi-web-tools-extension check`.
- Broad changes: `bun run check`.

Do not substitute a full check for a focused one on a tiny change. Completion
means the relevant typecheck/tests pass after any fixes, the final diff is
inspected, and skipped checks are reported.

## Boundaries and traps

- Never commit `auth.json`, `.env`, sessions, caches, logs, credentials, tokens,
  or captured provider responses. Keep diagnostics redacted.
- Unit checks must not contact provider APIs or depend on live credentials. The
  subagents package's `test:live` is opt-in and is not part of normal validation.
- Do not rebuild/apply `nix-config`, invoke `/reload` in a user's session, or
  contact operational services unless explicitly requested. Those actions are
  deployment, not repository validation.
- Do not edit generated/install output. This repository has no build artifact
  that should be committed.
