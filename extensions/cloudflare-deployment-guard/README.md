# Cloudflare deployment guard

Pi extension that holds agent `bash` commands which deploy Cloudflare Workers or Alchemy stacks to the
allowlist in the repository-root `cloudflare-deployment-allowlist.json` (never edited by the agent), and
blocks agent writes to that file.

Ported from [dmmulroy/.dotfiles](https://github.com/dmmulroy/.dotfiles/tree/main/home/.pi/agent/extensions/cloudflare-deployment-guard)
at `b20510f`. To update, copy the upstream files over this directory, then reapply the local adaptations
below; `test/local-adaptations.test.ts` fails if one is lost.

## Local adaptations

- `policy.ts`: Alchemy `project` paths may start with `~/`, `$HOME/`, or `${HOME}/`, because the policy is
  committed to a public repository.
- `policy.ts`: on macOS and Windows the policy file name and path compare case-insensitively.
- `policy.ts`: `git checkout`, `restore`, `rm`, and `mv` naming the policy count as mutations, because the
  policy is tracked in git here.
- `shell-ast.ts` lives in `extensions/shared/`, because `safety-guard.ts` uses the same walker; its
  `sh-syntax` dependency is declared in the root `package.json`.
- `package-scripts.ts`: only pnpm and Vite+ read `pnpm-workspace.yaml`; npm, yarn, and bun use
  `package.json` workspaces even when both exist.

## How a command is decided

1. `../shared/shell-ast.ts` parses the command with mvdan/sh (`sh-syntax`, WASM) and walks every simple command that
   runs, in execution order, tracking the working directory (`cd`, `pushd`), exported variables, shell
   variables (`D=apps/api; cd $D`), `set -a`, and `source`. Heredoc bodies, quoted strings, and redirect
   targets are data; they are parsed as commands only when fed to a shell (`bash -c`, `sh <<EOF`, `eval`).
2. `evaluate.ts` classifies each command after stripping wrappers (`env`, `sudo`, `timeout`, `xargs`,
   `find -exec`, `doppler run --`):
   - Wrangler / cf / Alchemy, directly or through `npx`, `pnpm exec`, `vp exec`, … (`deploy-commands.ts`):
     `--help`/`--version` and dry runs pass; deploys resolve their Worker or Alchemy project and stage.
   - Package tasks (`package-scripts.ts`): `npm run`, `pnpm <script>`, `yarn [workspace]`, `bun run`,
     `vp run`/`vpr`. Runner built-ins (`vp test`, `pnpm install`, `pnpm deploy`) are not scripts. The
     script or Vite+ task command is evaluated recursively, with appended arguments.
   - Nested shells and shell script files are evaluated recursively; `node script.ts` is checked for
     code that spawns a deploy.
3. `policy.ts` authorizes the resolved target. An Alchemy project matches its entry from any git
   worktree of the same repository. Repositories holding an allowlisted Alchemy project are exempt,
   except for `alchemy destroy` and `wrangler delete`.

## Decisions

- **Definite denials** (unlisted Worker, project, or stage; destroy/delete, including
  `alchemy destroy --dry-run`; policy writes; a policy changed mid-session) always block.
- **Uncertain resolutions** (dynamic deploy arguments, `CLOUDFLARE_ENV`/`STAGE` from `source` or a
  secrets wrapper, a script piped into a shell, an unresolvable deploy-named task) ask the user with
  `ctx.ui.confirm` in interactive sessions and block in headless ones.
- Resolution failures for tasks whose name does not contain `deploy`/`destroy` are ignored.
- A stale Alchemy entry (project path gone) is skipped with a warning instead of invalidating the policy.
- The policy's content hash is recorded at `session_start`; a change during the session needs the user's
  confirmation before it is trusted.

## Checks

```bash
bun run check                          # typecheck + tests
bun run replay-sessions -- --show-blocks           # re-run every recorded block in ~/.pi/agent/sessions
bun run replay-sessions -- --strict --show-blocks  # same, without the repository exemption
```

`test/false-positive-regressions.test.ts` holds minimized reproductions of the false positives found by
auditing real sessions. Never commit replay output: session commands can contain private content.
