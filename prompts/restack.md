---
description: Split mixed work into a coherent, verified commit stack
argument-hint: "[scope, base, constraints, or plan-only]"
---
Restack the current work into reviewable commits.

Scope: ${ARGUMENTS:-current uncommitted work and mutable local commits; infer the nearest sensible base}

Success means one logical concern per commit, dependencies before consumers, accurate messages, no lost changes, and a usable tree at every commit.

## Inspect

Use jj when `.jj/` exists; otherwise use Git. Do not mix mutating Git and jj commands in a colocated repo.

Read repository instructions and detect any operation already in progress; stop if one exists. Record a restore point, infer the base, and identify remote-reachable or immutable commits that must not be rewritten without explicit authorization.

Minimize output: begin with status, name/status, diffstat, and recent history. Inspect focused diffs by proposed concern instead of repeatedly printing the complete diff. Include staged, unstaged, and untracked work, but do not echo large raw diffs in the response.

## Plan

Group by intent, not file:
- keep tests with the behavior they verify;
- place foundations before implementations and consumers;
- separate pure renames from later edits;
- keep generated files and lockfiles with their cause;
- absorb unambiguous fixes into their target commit;
- use whole files first, hunks only for shared files, and keep inseparable changes together.

For dependency upgrades, inspect affected imports/exports and runtime-loaded files; a partial typecheck is not proof that the intermediate commit works.

Present only a compact table: commit title, purpose/files, dependencies, and focused check. Describe individual hunks only for shared or tangled files. If `plan-only` was requested, stop.

## Execute

Otherwise continue without asking unless the split is genuinely ambiguous or crosses a published-history boundary.

Use explicit staging/patch staging and inspect the staged diff before each Git commit. For jj, use `split`, `commit`, `squash`, `absorb`, `rebase`, or `parallelize` as appropriate; leave ambiguous absorb hunks untouched. Derive concise imperative messages from each selected diff.

Verify the committed tree after each commit—not a working tree that also contains later changes—using an isolated worktree, temporary stash, or jj `run --ignore-changes`. Run the cheapest relevant repository check and repair ordering when it fails.

## Finish

Confirm the final tree equals the recorded original work plus any explicitly retained commits. Use range-diff/interdiff only when comparing two real commit series; for one mixed snapshot split into many commits, prefer exact tree equality plus commit inspection. Run the focused final checks.

Report a compact final table of IDs, titles, and check results; then list excluded work, restore point, and any remaining failure. Do not narrate successful commands or paste routine output.

Never push, deploy, discard unrelated changes, rewrite published/immutable history, use `git reset --hard`, bypass hooks, or use jj `--ignore-immutable`. Clean up temporary verification worktrees and branches after success, retaining only the named restore point.
