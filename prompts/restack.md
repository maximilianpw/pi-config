---
description: Split mixed changes into a coherent, verified commit stack
argument-hint: "[scope, base, constraints, or plan-only]"
---
Restack the current work into coherent, reviewable commits.

User scope or constraints: ${ARGUMENTS:-Use the current uncommitted changes and mutable local stack; infer the nearest sensible base.}

A good result has one logical concern per commit, not one file per commit. Every original changed line has exactly one intentional home, each commit message matches its diff, dependencies appear before their consumers, and the project remains usable at every commit.

## 1. Inspect before mutating

Detect the repository type. If `.jj/` is present, use jj for all mutations, including in a colocated Git repository. Otherwise use Git.

Inspect the status, complete diffs, diff stats, renames, recent history, likely base, and repository instructions. Include staged, unstaged, and untracked work. Read enough surrounding code and tests to understand why each change exists.

Record a restore point before any mutation:
- Git: current branch, `HEAD`, base, status, and remote containment of commits in scope.
- jj: current change, base, status, and latest operation ID.

If a merge, rebase, conflict resolution, or other history operation is already in progress, stop and explain. Do not rewrite commits reachable from a remote ref or jj immutable commits unless the user explicitly authorized that rewrite.

## 2. Design the stack

Partition by intent and behavior. Prefer:
- one independently explainable change per commit, even when it spans many files;
- tests with the behavior they verify, except reusable test infrastructure which may come first;
- foundations before implementations, and implementations before callers or documentation;
- pure moves or renames before edits to moved code;
- generated files and lockfiles with the change that caused them, or in a dedicated regeneration commit when independently meaningful;
- existing review fixes absorbed into the unambiguous commit they correct, not a trailing “fixes” commit;
- independent changes as siblings in jj when that is materially clearer, otherwise a simple linear stack.

Start with whole-file/fileset boundaries. Use hunk selection only when a file contains multiple concerns. If a hunk is tangled, try a smaller hunk or careful patch edit; never invent a broken intermediate state merely to make commits smaller. Keep inseparable changes together.

Before executing, present a concise plan containing:
1. ordered commit titles and rationales;
2. dependency edges;
3. files and relevant hunks assigned to each commit;
4. treatment of renames, binaries, generated files, and tangled hunks;
5. the focused verification command for each commit.

If the arguments say `plan-only`, stop after this plan. Otherwise continue without asking unless a genuinely ambiguous split or a published-history boundary requires user input.

## 3. Execute safely

Use the native workflow for the detected VCS:

- Git working tree: compose each commit through explicit path staging or patch staging, inspect `git diff --cached` before committing, then commit with a message derived from that staged diff.
- Git existing series: use fixup/autosquash, interactive rebase, or edit/reset/recommit as appropriate. Keep a recoverable old tip and use the merge rebase backend when renames are involved.
- jj working copy or series: use `jj split`, `jj commit`, `jj squash`, `jj absorb`, `jj rebase`, or `jj parallelize` as appropriate. Let ambiguous absorb hunks remain instead of guessing.

After creating or rewriting each commit/change:
1. inspect its actual diff;
2. confirm it represents one concern and its message is accurate;
3. run the cheapest relevant repository check;
4. stop if the check fails, fix the split if the failure is caused by ordering, or combine commits that cannot remain valid independently.

Write concise imperative commit titles. Add a body only when the problem, impact, or non-obvious reasoning needs explanation. Do not invent signoffs or issue references.

## 4. Verify the result

Run a per-commit check across the final range when practical (`git rebase --exec` or `jj run --ignore-changes`). Compare the old and new series with `git range-diff`, `jj interdiff`, or jj operation diff/log evidence. Confirm no original changes were lost, duplicated, or silently added.

Report:
- the final ordered commits/change IDs and titles;
- verification run for each commit and for the full stack;
- any intentionally excluded or remaining work;
- the recorded restore point and recovery command if useful.

Hard safety gates:
- Never push, publish, or deploy.
- Never use `git reset --hard`, bare `git push --force`, `--no-verify`, or jj `--ignore-immutable`.
- Do not mix Git and jj mutations in a colocated repository.
- Do not discard unrelated user changes, secrets, or failing evidence.
