---
description: Propose how to split current jj work into focused changes
argument-hint: "[goal]"
---
Inspect the current jj working-copy change and propose a split plan.

Goal or constraints: $ARGUMENTS

Use read-only jj commands such as `jj st`, `jj diff --stat`, and `jj diff`.

Return:
1. Proposed changesets with names and rationale.
2. Files/hunks that belong in each changeset.
3. Suggested jj commands if useful (`jj split`, `jj new`, `jj squash`, `jj absorb`) but do not execute them.
