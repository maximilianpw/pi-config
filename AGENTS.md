# pi-config Agent Notes

- This is repo-local guidance only. Shared global agent policy lives in
  `~/nix-config/users/maxpw/agents/shared/AGENTS.md`; do not move global rules
  into this repo.
- Edit source files here, or the Home Manager module that links them. Do not
  patch installed links under `~/.pi/agent` or immutable files under
  `/nix/store`.
- Keep extensions compatible with the existing `@earendil-works/pi-coding-agent`
  API and avoid new dependencies unless the repo already has the build path for
  them.
- For extension changes, run the narrowest available TypeScript or Pi reload
  check. For config-only changes, inspect the diff.
- Apply installed Pi config changes with `make -C ~/nix-config rebuild`; inside
  an active Pi session, `/reload` refreshes Pi resources after installation.
