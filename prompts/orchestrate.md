---
description: Execute a multi-file plan set with coordinated Herdr workers
argument-hint: "[plan index, directory, or constraints]"
---
Orchestrate this plan set to completion with Herdr.

Scope: ${ARGUMENTS:-infer the plan index or plan directory from the conversation and repository}

Success means every applicable plan is integrated and verified, and every temporary resource created for this run is removed.

## 1. Prepare

Load and follow the `herdr` skill. Require `HERDR_ENV=1`; otherwise stop and explain that this command must run inside Herdr. Keep this pane as coordinator and user focus here.

Read repository instructions and record the VCS, revision, working-tree state, caller pane/tab/workspace, and relevant checks. Maintain a ledger of only the panes, tabs, workspaces, worktrees, branches, and agents created by this run. If existing changes make safe isolation or integration ambiguous, ask one focused question.

This command authorizes local Herdr coordination and temporary commits. It does not authorize pushing, deploying, changing live/shared systems, discarding unrelated work, bypassing safeguards, or stopping the Herdr server/session.

## 2. Map the plans

Read the index/README first, then every referenced plan. Extract each plan's deliverables, completion criteria, dependencies, likely file overlap, and checks. Reconcile contradictions against repository evidence while preserving intent.

Build dependency-ready waves. Briefly state the wave, worker scope, and topology, then execute; do not stop after planning.

## 3. Choose topology

Use the smallest safe topology:

- **Worktree workspace:** independent implementation that can run in parallel. Base it on the revision containing all completed dependencies.
- **Pane or tab in the current checkout:** read-only research, review, tests, or serialized edits.
- **Coordinator:** small or heavily overlapping work.

One checkout has at most one editor. Put overlapping plans in one worker or separate waves. Keep concurrency small and useful. Create resources without stealing focus, parse returned IDs, and add each resource to the ledger. Prefer the current agent kind; otherwise use `pi` unless the user requested another.

## 4. Dispatch bounded workers

Each worker prompt must name its plan file, exact scope, index and prerequisites to read, repository instructions, owned files/interfaces, required checks, and report format.

Implementation workers inspect first, complete their scope, run focused checks, review the diff, and commit only their work. Their report includes status, commit IDs, changed files, checks, assumptions, and blockers. They do not push, deploy, broaden scope silently, touch another checkout, or clean up Herdr resources.

Wait through Herdr's agent lifecycle. Inspect a timed-out or blocked worker before acting; never duplicate a possibly delivered prompt or answer an approval on the user's behalf. Send precise corrections to the same worker while its environment exists.

## 5. Integrate each wave

For every worker result:

1. Inspect the report, commit, and diff against its plan.
2. Reproduce the focused check where practical.
3. Integrate commits in dependency order and resolve conflicts from plan intent.
4. Run interface/integration checks before starting dependent workers from the new revision.

Treat reports as evidence, not completion. Follow the plan set's tracking convention; update live checklists when appropriate, but retain plan files unless explicitly told otherwise.

## 6. Verify and tear down

Audit every completion criterion against the final tree. Run proportionate final and cross-plan checks; inspect the final diff and status. Repair failures and re-run affected checks before declaring success.

Then reconcile the resource ledger:

1. Preserve or record any useful unintegrated commit.
2. Confirm each created worktree is clean and remove it through Herdr.
3. Close each created pane, tab, or non-worktree workspace still present.
4. Delete temporary branches only after integration.
5. Re-list VCS and Herdr state and confirm no created resource remains.

Never close the caller or a pre-existing resource. Never force-remove a dirty worktree; retain it and report its ID, path, and recovery command. Do not create or stop a named Herdr session.

## Report

Return a compact table of plans, outcomes, integrated commits, and checks, followed by cleanup confirmation and any blocker, retained resource, assumption, or deferred item. Do not paste worker transcripts or routine command output.
