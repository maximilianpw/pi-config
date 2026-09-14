# Restack strategies for mixed diffs and messy commit series

Researched 2026-03-25 against official Git documentation, Jujutsu docs, Linux kernel patch-submission guidance, and first-party stacked-change tooling. This is a **workflow note for an AI coding agent**, not a VCS comparison ranking. Commands and URLs are from current docs; pin versions before encoding them in a prompt.

Local context: `prompts/jj-split.md` already exists as a **plan-only** split prompt. A `/restack` prompt should cover both Git and jj, mixed working trees *and* messy series, verification, and safety.

## What “restack” means here

Two related jobs:

1. **Split a mixed working-tree (or mixed commit) into coherent changesets.** Git’s own interactive-staging chapter exists specifically so you can “partition” extensive edits into “several focused commits rather than one big messy commit” so they “can be reviewed easily.” ([Git Book 7.2](https://git-scm.com/book/en/v2/Git-Tools-Interactive-Staging))
2. **Rewrite a messy series into a reviewable stack**, including reorder, squash, split, drop, and rebase onto a new base. Git’s rewriting-history chapter lists changing order, messages, files, squashing, splitting, and removing commits — “all before you share your work with others.” ([Git Book 7.6](https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History))

In stacked-change tools, “restack” often has a narrower meaning: **reattach abandoned descendants after a rewrite**. `git restack` rebases children of rewritten commits back onto the new versions. ([git-branchless restack](https://github.com/arxanas/git-branchless/wiki/Command:-git-restack)) Jujutsu does this automatically: rewriting a change rebases descendants, including through first-class conflicts. ([jj tutorial](https://docs.jj-vcs.dev/latest/tutorial/)) A Pi `/restack` prompt should cover **split + order + verify**, not only descendant repair.

## The reviewability bar

Primary sources agree on a single test: **one logical change per commit, independently justifiable, and the series still builds after each step.**

Linux kernel guidance is the clearest first-party statement of that bar:

- “Separate each **logical change** into a separate patch.”
- Bug fix and performance work in the same driver → two patches. API update and a consumer of that API → two patches.
- One change across many files → **one** patch. The unit is the concern, not the file.
- “Each patch should make an easily understood change that can be verified by reviewers. Each patch should be justifiable on its own merits.”
- Dependencies are allowed; note “this patch depends on patch X.”
- “The kernel builds and runs properly after each patch,” because `git bisect` can stop at any commit. ([Submitting patches](https://www.kernel.org/doc/html/latest/process/submitting-patches.html#separate-your-changes))

Git’s commit-message convention is complementary: a short (≤50 character) title, blank line, then a thorough body. The title is the object Git tools treat as the commit’s identity (`git format-patch` uses it as the email Subject). ([git-commit DISCUSSION](https://git-scm.com/docs/git-commit#_discussion)) Kernel style adds: imperative mood (“make xyzzy do frotz”), describe the problem and user-visible impact before the technical change, and do not duplicate a move and a modification in the same patch. ([Submitting patches](https://www.kernel.org/doc/html/latest/process/submitting-patches.html#describe-your-changes), [style-check](https://www.kernel.org/doc/html/latest/process/submitting-patches.html#style-check-your-changes))

Git’s rebase docs make the same buildability point for rewritten history: “Reordering and editing commits usually creates untested intermediate steps.” Use `exec` (or `git rebase -i --exec`) so a failing command stops the rebase. ([git-rebase interactive mode](https://git-scm.com/docs/git-rebase#_interactive_mode)) When splitting, “If you are not absolutely sure that the intermediate revisions are consistent (they compile, pass the testsuite, etc.) you should use `git stash` to stash away the not-yet-committed changes after each commit, test, and amend.” ([git-rebase SPLITTING COMMITS](https://git-scm.com/docs/git-rebase#_splitting_commits))

## Heuristics an agent can follow

These are the decision rules a `/restack` prompt should encode. They are inferred from the sources above plus the command behavior documented in later sections; they are not a second-hand blog recipe.

### 1. Identify independent concerns before touching history

Inspect first. Do not start splitting until every change has a proposed home.

Cluster by **intent**, then check **file overlap** and **symbol/line overlap**:

| Cluster | Put in one commit when | Split when |
| --- | --- | --- |
| One concern, many files | The files implement one change (new API + all in-tree callers of that API if they cannot compile independently; or a rename that must land atomically). | Callers can be a follow-up *and* the first commit still builds. Kernel: API update and new driver that uses it are two patches. |
| Many concerns, one file | Never, if the hunks are separable. | Use patch/hunk selection (`git add -p`, `jj split -i`). |
| Bugfix mixed with feature | Never. | Bugfix first if the feature depends on it; otherwise either order as long as each commit builds. |
| Formatting / generated output mixed with logic | Never if the formatter/generated file can be isolated. | Formatter/lockfile/codegen as its own commit, or absorbed into the commit that forced regeneration. |
| Test + production change | Same commit if the test only makes sense with that change (reviewers verify the change). | Fixture/harness work that later tests reuse → earlier commit. |
| Move/rename + edit | Never in the same commit. Kernel: “you should not modify the moved code at all in the same patch which moves it.” | Rename/move commit, then edit commit. |

A practical agent procedure:

1. Inventory paths (`git status` / `git diff --stat` / `jj st` / `jj diff --stat`).
2. Group paths by package, layer, and generated-vs-source.
3. For files that appear in more than one group, drop to hunks.
4. Name each proposed changeset with a one-line intent (this becomes the commit title).
5. Order by dependency (next section).
6. Only then emit commands.

If a description “starts to get long, that’s a sign that you probably need to split.” ([Submitting patches](https://www.kernel.org/doc/html/latest/process/submitting-patches.html#describe-your-changes))

### 2. Dependency ordering

A commit B depends on A when B’s tree would not compile, typecheck, or make sense without A’s tree. Sources:

- Git rebase `--onto` is explicitly for “when `topicB` does not depend on `topicA`”: transplant B onto the earlier base and leave A behind. ([git-rebase --onto](https://git-scm.com/docs/git-rebase#_transplanting_a_topic_branch_with_onto))
- Git rebase `--rebase-merges` can split one linear branch into two topic branches joined by a merge when one commit “addresses a different concern.” ([git-rebase REBASING MERGES](https://git-scm.com/docs/git-rebase#_rebasing_merges))
- `jj parallelize` is the first-class “these revisions are actually independent” operation: it turns a chain into siblings while keeping outside ancestors/descendants. `jj parallelize '1 | 3'` is a no-op if 2 sits between them. ([jj parallelize](https://docs.jj-vcs.dev/latest/cli-reference/#jj-parallelize))
- `jj rebase -s L -o K -o M` creates a merge when L actually depends on both K and M. ([jj rebase](https://docs.jj-vcs.dev/latest/cli-reference/#jj-rebase))

Agent ordering rules:

1. **Foundation first:** types, interfaces, schema, config flags, test harnesses.
2. **Implementation next:** the behavior that uses the foundation.
3. **Call sites / UI / docs last**, unless they are the entire change.
4. **Fixes to earlier commits in the same stack** belong *in* those commits (`git commit --fixup` / `jj squash --into` / `jj absorb`), not as a trailing “fixes” commit. Git-absorb’s pitch is exactly this: do not shove review fixes into an opaque `fixes` commit. ([git-absorb](https://github.com/tummychow/git-absorb))
5. **Independent stacks become siblings** (`jj parallelize`, Git `--onto` / `--rebase-merges`), not an arbitrary linear order.
6. If two hunks commute (applying A then B equals B then A), they are candidates for sibling commits or for absorb into different ancestors. Absorb implementations use commutation as the placement test. ([git-absorb “How it works”](https://github.com/tummychow/git-absorb#how-it-works-roughly); [jj absorb](https://docs.jj-vcs.dev/latest/cli-reference/#jj-absorb); [Sapling absorb](https://sapling-scm.com/docs/commands/absorb/))

### 3. File vs hunk vs line

Granularity ladder, coarsest first:

1. **Pathspec commits.** Git: `git add path` then `git commit`; or `git commit path` (that form records the named paths and **holds back** already-staged changes to other paths). ([git-commit](https://git-scm.com/docs/git-commit)) jj: `jj split fileset` / `jj commit fileset` / `jj squash fileset`.
2. **Hunk selection.** `git add -p` (also `git reset -p`, `git stash push -p`, `git commit -p`). Interactive options include `s` (split hunk into smaller hunks) and `e` (edit the hunk). ([git-add Interactive mode](https://git-scm.com/docs/git-add#_interactive_mode); [Git Book 7.2](https://git-scm.com/book/en/v2/Git-Tools-Interactive-Staging))
3. **Manual patch edit.** `git add -e` or `e` in the hunk selector. Documented safe edits: delete `+` lines to drop additions; convert `-` to ` ` to keep the old line; for a modification, convert `-` to ` ` *and* delete the matching `+`. Documented unsafe edits (make the patch unapplicable): adding context/removal lines, deleting context/removal lines, modifying context or removal line contents. ([git-add EDITING PATCHES](https://git-scm.com/docs/git-add#_editing_patches))
4. **Context fusion.** `--inter-hunk-context=<n>` fuses nearby hunks; `--unified=<n>` changes hunk size. Useful when two concerns are interleaved but you want them as one hunk, or the reverse. ([git-add](https://git-scm.com/docs/git-add#_options))

jj’s split/squash interactive path is a diff editor, not Git’s y/n prompt: edit the right side until it has the content for the selected commit. Selected changes stay in the original by default; remainder becomes a child. `--parallel` makes siblings. `-o`/`-A`/`-B` extract the selection to another location. ([jj split](https://docs.jj-vcs.dev/latest/cli-reference/#jj-split); [jj tutorial](https://docs.jj-vcs.dev/latest/tutorial/#moving-content-changes-between-commits))

**Verify the index/selection before committing.** Git’s official split-apart recipe is: `git reset -N HEAD^` (the `-N` keeps new files visible to `add -p`), `git add -p`, **`git diff --cached`**, then `git commit -c HEAD@{1}` to reuse the original message. Repeat. ([git-reset EXAMPLES](https://git-scm.com/docs/git-reset#_examples)) The rebase-split recipe is the same idea inside `edit`: `git reset HEAD^`, add, commit, continue. ([git-rebase SPLITTING COMMITS](https://git-scm.com/docs/git-rebase#_splitting_commits))

### 4. Tangled hunks

A hunk is tangled when one diff hunk contains two concerns, or two hunks of different concerns share overlapping context so Git will not split them with `s`.

Documented tools:

- **`s` first.** If the hunk has an unchanged context line in the middle, Git can split it. ([git-add Interactive mode](https://git-scm.com/docs/git-add#_interactive_mode))
- **`e` next.** Manually drop the lines that belong later. Because the patch applies to the **index**, not the worktree, leftover lines remain unstaged. ([git-add EDITING PATCHES](https://git-scm.com/docs/git-add#_editing_patches))
- **Do not half-edit a `-/+` pair.** “Beware that modifying only half of the pair is likely to introduce confusing changes to the index.”
- **If the concerns cannot be separated without a broken intermediate tree, do not fake a split.** Keep them in one commit, or split at a coarser boundary (whole file, whole function) that still builds. Kernel: each patch must build.
- **Absorb instead of split** when the tangled work is review feedback on an existing stack: commute each hunk to the last ancestor that touched those lines; leave unambiguous leftovers in the source. ([jj absorb](https://docs.jj-vcs.dev/latest/cli-reference/#jj-absorb); [git-absorb](https://github.com/tummychow/git-absorb); [Sapling absorb](https://sapling-scm.com/docs/commands/absorb/))
- **jj squash -i into a parent** can move part of a child into the parent *without changing the child’s content state*, even when the hunks touch the same word. That is the opposite of `jj diffedit`, which changes the commit’s resulting tree and can conflict descendants. ([jj tutorial](https://docs.jj-vcs.dev/latest/tutorial/#moving-content-changes-between-commits))

Agent rule: if an edited hunk would not apply, or `git diff --cached` shows a mix of two intents, abort that hunk and keep the file together.

### 5. Renames, copies, binaries, generated files

- Detect renames with `git diff -M` / `--find-renames[=<n>]` (default similarity 50%; `-M100%` for exact renames). Copies: `-C`. Break rewrites into delete+create with `-B`. Limit exhaustive rename detection with `-l`. Filter with `--diff-filter=R` / `A` / `D` / `M`. ([git-diff](https://git-scm.com/docs/git-diff))
- Git rebase’s **merge backend** has directory-rename detection; the apply backend does not, and can leave new files in the old directory with no warning. Prefer the merge backend (the default) when restacking renames. ([git-rebase behavioral differences](https://git-scm.com/docs/git-rebase#_directory_rename_detection))
- Kernel: a pure move is its own patch; do not edit in the same patch.
- Generated artifacts (lockfiles, `*.pb.go`, formatted codegen, minified bundles): either commit them with the change that forced regeneration, or as a dedicated “chore: regenerate X” commit. Do not interleave hand-edits with generated hunks in one commit — reviewers cannot see the intent, and hunk splitting generated files is usually wasted work.
- Binaries: `git add -p` cannot usefully split them; `git diff --numstat` prints `-` `-` for binary files. Treat each binary as atomic. ([git-diff --numstat](https://git-scm.com/docs/git-diff)) Git FAQ recommends not storing build products in the repo at all. ([gitfaq recommended storage](https://git-scm.com/docs/gitfaq#_cross_platform_issues))
- `git-absorb` currently lists copy/rename commutation as incomplete (“more commutation cases (esp copy/rename detection)” in its TODO). Do not trust absorb across renames; place those hunks by hand. ([git-absorb](https://github.com/tummychow/git-absorb))

### 6. Preserve buildability; verify per commit

This is the non-negotiable check. Sources:

- Kernel: series must build and run after **each** patch because bisect can stop anywhere. ([Submitting patches](https://www.kernel.org/doc/html/latest/process/submitting-patches.html#separate-your-changes))
- Git rebase `exec` / `--exec`: run a command after every rewritten commit; non-zero exit stops the rebase. Combined with `--autosquash`, exec lines attach to the *end* of each squash/fixup group, not the intermediate fixups. `--empty=keep` is implied by `--exec` unless `-i` is also set. ([git-rebase --exec](https://git-scm.com/docs/git-rebase#Documentation/git-rebase.txt---execcmd))
- Git stash `--keep-index`: official “Testing partial commits” recipe — stage the first part, stash the rest while leaving the index intact, build/test, commit, pop, repeat. `--patch` implies `--keep-index`. ([git-stash](https://git-scm.com/docs/git-stash#_examples))
- Git rebase splitting: stash leftover uncommitted changes, test, amend, continue. ([git-rebase SPLITTING COMMITS](https://git-scm.com/docs/git-rebase#_splitting_commits))
- jj: `jj run --ignore-changes` checks out each revision in an isolated working copy, runs the command, **discards** working-copy changes. That is the read-only per-commit check. Without `--ignore-changes`, `jj run` **amends** each revision with the command’s result (useful for formatters, dangerous as a “test”). `--ignore-errors` continues after failures but still exits 0, so do not use it as a gate. ([jj run](https://docs.jj-vcs.dev/latest/cli-reference/#jj-run))
- `jj bisect run` is the complementary search: exit 0 = good, other non-zero = bad, 125 = skip. ([jj bisect run](https://docs.jj-vcs.dev/latest/cli-reference/#jj-bisect-run))

Agent verification ladder (cheapest first):

1. After composing each commit: `git diff --cached` / `jj diff -r <change>` looks like one concern.
2. Per commit: project’s cheap check (`tsc`, `go test ./...`, `bun test` of affected package). Match the repo’s existing verification, not a full suite by default.
3. After the whole stack: `git rebase --exec '<check>' <base>` or `jj run --ignore-changes -r <revset> -- <check>`.
4. Compare old vs new series with `git range-diff` / `jj interdiff` so the restack did not drop or invent patches. ([git-range-diff](https://git-scm.com/docs/git-range-diff); [jj interdiff](https://docs.jj-vcs.dev/latest/cli-reference/#jj-interdiff))

If a desired split cannot pass step 2, merge those two proposed commits back together.

### 7. Commit-message generation

Generate the message from the **staged/selected diff**, not from the original mixed message, except as a starting point.

Git:

- Title ≤50 chars; blank line; body. ([git-commit DISCUSSION](https://git-scm.com/docs/git-commit#_discussion))
- `git commit -c HEAD@{1}` / `-C` reuses an old message when splitting one commit into several that still share that intent; edit when the content no longer matches. Git Book: if you amend content substantially, update the message; if the amendment is trivial, `--amend --no-edit`. ([Git Book 7.6](https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History); [git-reset split example](https://git-scm.com/docs/git-reset#_examples))
- `git commit --fixup=<commit>` / `--squash=<commit>` / `--fixup=amend:` / `--fixup=reword:` create autosquash markers; `git rebase --autosquash` folds them. Fixup discards the fixup’s log message; squash concatenates. Neither changes authorship of the target. ([git-commit --fixup](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt---fixupamendrewordcommit); [git-rebase --autosquash](https://git-scm.com/docs/git-rebase#Documentation/git-rebase.txt---autosquash))
- `git commit -v` puts the staged diff into the editor buffer as a reminder; it is not stored. ([git-commit --verbose](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt---verbose))

jj:

- `jj describe -m` / `--stdin` for a known message.
- `jj split -m` sets the description for the **selected** half; the remainder keeps the original.
- `jj squash` with both sides described asks for a combined description; `--use-destination-message` keeps the destination’s. ([jj split](https://docs.jj-vcs.dev/latest/cli-reference/#jj-split); [jj squash](https://docs.jj-vcs.dev/latest/cli-reference/#jj-squash))

Kernel message rules worth copying into a prompt: imperative mood; problem + impact + what changed; `Fixes: <12+ sha> ("subject")` when fixing a known commit; do not wrap `Fixes:` tags. ([Submitting patches](https://www.kernel.org/doc/html/latest/process/submitting-patches.html#describe-your-changes))

Do not invent `Signed-off-by` unless the project requires it. Git will not add a config default for `--signoff` because that would dilute DCO meaning. ([gitfaq](https://git-scm.com/docs/gitfaq#_configuration); [git-commit --signoff](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt---signoff))

## Git workflow

### Mixed working tree → N commits

Official recipes, in order of safety:

1. **Pathspec commit, leave the rest staged/unstaged.** `git commit Makefile` records only that path; other staged files stay staged. ([git-commit EXAMPLES](https://git-scm.com/docs/git-commit#_examples))
2. **Interactive hunk staging.** `git add -p` then `git commit`; repeat. Inspect with `git diff` (unstaged) and `git diff --cached` (staged). ([Git Book 7.2](https://git-scm.com/book/en/v2/Git-Tools-Interactive-Staging); [git-add](https://git-scm.com/docs/git-add))
3. **Test each partial commit.** `git add -p`; `git stash push --keep-index`; test; `git commit`; `git stash pop`; repeat. ([git-stash](https://git-scm.com/docs/git-stash#_examples))
4. **Park unrelated staged work.** `git stash push --staged` stashes only the index. ([git-stash](https://git-scm.com/docs/git-stash#_examples))
5. **Isolate in another worktree** when the working tree is too messy to stash. `git worktree add` shares the repo, separate `HEAD`/index. ([git-worktree](https://git-scm.com/docs/git-worktree))

To split the **last commit** (not just uncommitted work): `git reset -N HEAD^` then recipe 2. `reset --soft HEAD^` is the “undo commit, keep index” variant; `--mixed` (default) unstages; `--hard` discards the worktree and is the wrong tool for splitting. ([git-reset](https://git-scm.com/docs/git-reset))

### Messy series → reviewable series

1. `git rebase -i <parent-of-range>`. Oldest at top. Actions: `pick`, `reword`, `edit`, `squash`, `fixup` / `fixup -c` / `fixup -C`, `drop`, `exec`, `break`, plus `label`/`reset`/`merge` with `--rebase-merges`. ([Git Book 7.6](https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History); [git-rebase](https://git-scm.com/docs/git-rebase))
2. Split a middle commit: mark `edit`, then `git reset HEAD^`, commit pieces, `git rebase --continue`. ([git-rebase SPLITTING COMMITS](https://git-scm.com/docs/git-rebase#_splitting_commits))
3. Fold review fixes: `git commit --fixup=<target>` then `git rebase -i --autosquash`.
4. Transplant an independent suffix: `git rebase --onto <newbase> <oldbase> <branch>`.
5. After rewrite, `git range-diff <old>...<new>` or `git range-diff @{u} @{1} @` immediately after a rebase. Output is porcelain and **not** version-stable. ([git-range-diff](https://git-scm.com/docs/git-range-diff))
6. Verify: `git rebase -i --exec '<check>'`.
7. Recover: `git rebase --abort` during; `git reflog` after. `ORIG_HEAD` is set at start but is not guaranteed if `git reset` ran during the rebase; use `branch@{1}`. ([git-rebase](https://git-scm.com/docs/git-rebase#_description))

Do not use `git filter-branch` for this job; Git itself points at `git-filter-repo` for large history rewrites, which is out of scope for restacking a topic. ([Git Book 7.6](https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History))

### Git: read-only vs mutating

**Read-only (safe for the inspect/plan phase):**

- `git status`, `git diff`, `git diff --cached`, `git diff --stat`, `git diff --name-status -M`
- `git log`, `git show`, `git rev-parse`, `git merge-base`
- `git range-diff` (read-only comparison of two ranges)
- `git stash list` / `git stash show`
- `git worktree list`
- `git rebase --show-current-patch` (during an in-progress rebase)
- `git commit --dry-run` (does not create a commit)

**Mutating:**

- `git add` / `git add -p` / `git add -e` (index)
- `git reset` / `git restore` (index and/or worktree; `--hard` destroys worktree)
- `git commit`, `git commit --amend`, `git commit --fixup`
- `git rebase`, `git cherry-pick`, `git stash push`/`pop`
- `git switch` / `git checkout` (worktree + HEAD)
- `git push` and any `--force*`

`git add -n`/`--dry-run` is read-only for the index. `git stash` is mutating. A dirty worktree rebase needs `--autostash`; Git warns the final stash application can conflict. ([git-rebase --autostash](https://git-scm.com/docs/git-rebase#Documentation/git-rebase.txt---autostash))

## Jujutsu workflow

jj’s model changes the restack loop: **the working copy is already a commit** (`@`). Almost every command snapshots the worktree into that commit. There is no staging area. Change IDs survive rewrites; commit IDs do not. ([jj tutorial](https://docs.jj-vcs.dev/latest/tutorial/); [working copy](https://docs.jj-vcs.dev/latest/working-copy/))

### Mixed working-copy change → N changes

1. Inspect: `jj st`, `jj diff --stat`, `jj diff`. True read-only inspect of a *stale* snapshot: `jj --ignore-working-copy st` / `jj --at-op=<id>`. Snapshotting *is* a mutation of `@`. ([jj global options](https://docs.jj-vcs.dev/latest/cli-reference/#jj); [operation log](https://docs.jj-vcs.dev/latest/operation-log/))
2. Describe intent first: `jj describe -m '…'` so you do not forget. ([jj tutorial](https://docs.jj-vcs.dev/latest/tutorial/#creating-our-first-change))
3. Split:
   - By fileset: `jj split pathspec`
   - Interactively: `jj split -i` (default if no fileset)
   - To siblings: `jj split -p`
   - Extract selection elsewhere: `jj split -o/-A/-B`
   - Sequential “commit the selection, leave the rest in `@`”: `jj commit pathspec` / `jj commit -i` (does **not** move bookmarks, unlike `jj split`). ([jj split](https://docs.jj-vcs.dev/latest/cli-reference/#jj-split); [jj commit](https://docs.jj-vcs.dev/latest/cli-reference/#jj-commit))
4. Repeat split on the remainder until each change is one concern.
5. `jj new` when done amending `@`; later `jj squash` to fold a follow-up into the parent (like `git commit --amend`). ([jj tutorial](https://docs.jj-vcs.dev/latest/tutorial/))

### Messy series → reviewable series

| Job | jj command |
| --- | --- |
| Move hunks into parent / another change | `jj squash`, `jj squash -i`, `jj squash --from/--into` |
| Absorb review-fix hunks into the stack | `jj absorb` (into `mutable()` ancestors; ambiguous hunks stay) |
| Reorder | `jj rebase -r <rev> -A/-B <neighbor>` |
| Move a change without descendants | `jj rebase -r` |
| Move a change **and** descendants | `jj rebase -s` |
| Independent changes → siblings | `jj parallelize` |
| Edit a buried change in `@` | `jj edit <rev>` (harder to inspect resolutions) or `jj new <rev>` then `jj squash` |
| Touch up a buried diff without checkout | `jj diffedit -r` |
| Drop a change, rebase descendants | `jj abandon` |
| Run a check on each rev | `jj run --ignore-changes -r <revset> -- <cmd>` |
| Undo | `jj undo` / `jj redo` / `jj op restore` |
| See how a change evolved | `jj evolog` |
| Review the last rewrite | `jj op show -p` (documented for absorb/converge) |

Conflicts do not stop a rebase. Resolve later: `jj new <conflicted>`, edit or `jj resolve`, `jj squash` the resolution back. Descendants rebase onto the resolved change automatically. ([jj tutorial conflicts](https://docs.jj-vcs.dev/latest/tutorial/#conflicts); [working copy conflicts](https://docs.jj-vcs.dev/latest/working-copy/#conflicts))

Immutable commits are protected; `--ignore-immutable` disables the check but does not change `immutable_heads()`. Do not pass it in an agent restack unless the user asked to rewrite public history. ([jj --ignore-immutable](https://docs.jj-vcs.dev/latest/cli-reference/#jj))

### jj: read-only vs mutating

**Mostly inspect, but snapshot `@`:** `jj st`, `jj diff`, `jj log`, `jj show`, `jj file list`. These snapshot the working copy unless `--ignore-working-copy` is set.

**Read-only given `--ignore-working-copy` or `--at-op`:** the same inspect commands, plus `jj op log`, `jj evolog` on already-recorded changes.

**Mutating:** `jj split`, `squash`, `absorb`, `rebase`, `describe`, `new`, `commit`, `edit`, `abandon`, `restore`, `diffedit`, `parallelize`, `arrange`, `run` (without `--ignore-changes`), `bookmark *`, `git push`.

**Safety net:** every mutating command is an operation. `jj undo` restores the previous operation; repeated undo walks further back. `jj op restore <id>` jumps. Concurrent commands can diverge; `jj st`/`jj log` will say so. ([operation log](https://docs.jj-vcs.dev/latest/operation-log/); [jj undo](https://docs.jj-vcs.dev/latest/cli-reference/#jj-undo))

## Git vs jj for this job

| Concern | Git | jj |
| --- | --- | --- |
| Mixed worktree | Index is the composition buffer (`add -p`). | `@` is the composition buffer; `split`/`commit` carve it. |
| Split a buried commit | `rebase -i` → `edit` → `reset HEAD^` → recommit. Stops the rest of the series until you continue. | `jj split -r <rev>`; descendants rebase automatically, possibly with first-class conflicts. |
| Fold review hunks | `commit --fixup` + `rebase --autosquash`, or `git absorb`. | `jj absorb` / `jj squash --into`. |
| Independent concerns | Linearize or `--onto` / `--rebase-merges`. | `jj parallelize` or multiple parents. |
| Descendant repair after amend | Manual, or `git restack` (branchless). Git rebase of a published tip creates a “ripple effect” for downstream. ([git-rebase recovering](https://git-scm.com/docs/git-rebase#_recovering_from_upstream_rebase)) | Automatic; change ID stable. |
| Per-commit test | `rebase --exec`; stash `--keep-index` during a split. | `jj run --ignore-changes`. |
| Compare old vs new series | `git range-diff`. | `jj interdiff`; `jj op show -p`. |
| Undo | `rebase --abort`; reflog. | Operation log; `jj undo`. |
| Published history | Cardinal rule: do not rewrite after push unless you have a reason. ([Git Book 7.6](https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History)) | Same social rule, plus `immutable()` protection. |
| Colocated git+jj | N/A | Interleaving `git` and `jj` mutations can create divergent change IDs and `branch@git` disagreements. Prefer one tool to mutate. ([Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/#colocated-jujutsugit-workspaces)) |

**Default for an agent in a jj repo:** restack with jj. Git commands will not see jj’s conflict representation correctly (`git switch` on a conflicted commit can snapshot `.jjconflict-*` directories). ([Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/#format-mapping-details))

**Default in a Git repo:** Git recipes above. Optional helpers: `git absorb` for review hunks, `git restack` (branchless) if amending mid-stack abandoned children.

## Stacked-change tools (first-party, useful but not required)

Use these as **vocabulary and extra commands**, not as a dependency of `/restack`.

- **Graphite CLI.** First-party purpose: “break up large engineering tasks into a series of small, incremental code changes” and author stacked PRs. ([Graphite CLI overview](https://graphite.dev/docs/cli-overview)) Restack-the-PR-stack after a base rewrite is Graphite’s product job; locally the Git/jj techniques still apply.
- **git-branchless `git restack`.** Repairs abandoned descendants after `commit --amend` / rewrite. In-memory rebase by default; can restack a subset by passing the hidden rewritten commits. Warns when an operation abandons children. ([git restack](https://github.com/arxanas/git-branchless/wiki/Command:-git-restack); [README](https://github.com/arxanas/git-branchless)) Also: `git move` for subtrees, `git sync` to rebase all local stacks without checkout.
- **git-absorb.** Port of Facebook `hg absorb`. Considers only the **index**. Walks up to `--base` (default last 10 commits). For each hunk, walks from HEAD until a commit that does **not** commute; that commit is the fixup target. Hunks that commute with the whole range stay unstaged. Then `git rebase -i --autosquash`. Recovery: `git reset --soft PRE_ABSORB_HEAD`. ([git-absorb](https://github.com/tummychow/git-absorb))
- **Sapling `sl split` / `sl absorb`.** Split: prompt for hunks until exhausted; first selection is the parent-most commit. `--no-rebase` skips descendant rebase. Absorb: does **not** write the working copy; unambiguous pending changes amend the proper stack commit; remainder stays pending; empty commits deleted; default is dry-run/prompt, `-a` applies. Immutable revset: `. % (public() | merge() | immutable)`. ([split](https://sapling-scm.com/docs/commands/split/); [absorb](https://sapling-scm.com/docs/commands/absorb/))

Absorb’s shared heuristic across Sapling/jj/git-absorb: **if the destination is ambiguous, leave the hunk alone.** A `/restack` prompt should do the same instead of guessing.

## Safety constraints

Encode these as hard gates, not advice.

1. **Inspect before mutate.** Produce the plan (changesets, hunks, order, commands) before running mutating commands. Matches existing `prompts/jj-split.md`.
2. **Do not rewrite published / immutable history** unless the user explicitly asked. Git Book: treat pushed work as final. Git rebase: rewriting a branch others based work on is “a bad idea.” jj: do not pass `--ignore-immutable` by default. ([Git Book 7.6](https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History); [git-rebase recovering](https://git-scm.com/docs/git-rebase#_recovering_from_upstream_rebase))
3. **Do not push.** Restack is local. If a later step needs to update a remote topic branch, require explicit authorization and use `git push --force-with-lease` (never bare `--force`). `--force` disables lease checks and can delete others’ work. Lease without an expected value is defeated by background `git fetch`. ([git-push --force-with-lease](https://git-scm.com/docs/git-push#Documentation/git-push.txt---force-with-lease), [--force](https://git-scm.com/docs/git-push#Documentation/git-push.txt---force))
4. **Do not use `reset --hard` to split.** It overwrites the worktree. ([git-reset --hard](https://git-scm.com/docs/git-reset#Documentation/git-reset.txt---hard))
5. **Do not skip hooks by default.** `git commit --no-verify` bypasses `pre-commit`/`commit-msg`; `git rebase --no-verify` bypasses `pre-rebase`. Git FAQ: client hooks are not a policy boundary (`--no-verify` is always available), but they are still the local safety net. ([git-commit --no-verify](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt---no-verify); [gitfaq hooks](https://git-scm.com/docs/gitfaq#_hooks))
6. **Stop on a failed per-commit check.** Do not `--ignore-errors` / continue a rebase past a red `exec`.
7. **Keep a restore point.** Git: note `HEAD` / `ORIG_HEAD` / a tag before rewriting. jj: the operation log is the restore point; quote the pre-restack `jj op log -n 1` id in the report.
8. **Range-diff the result** against the pre-restack tip so dropped/invented patches are visible.
9. **Secrets, credentials, generated junk.** Splitting does not make an accidental secret safer; drop that file from the series instead of restacking it. History-wide scrubbing is `git-filter-repo`, out of scope. ([Git Book 7.6](https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History))
10. **One mutator.** In colocated repos, do not mix `git rebase -i` with `jj split` in the same restack.
11. **Worktree isolation.** Prefer `git worktree add` / `jj workspace add` if the current tree is mid-conflict, mid-rebase, or has unrelated dirty files the user did not ask to restack. Git rebase of a checked-out branch in another worktree will not `--update-refs` that worktree. ([git-rebase --update-refs](https://git-scm.com/docs/git-rebase#Documentation/git-rebase.txt---update-refs); [git-worktree](https://git-scm.com/docs/git-worktree); [jj workspace](https://docs.jj-vcs.dev/latest/working-copy/#workspaces))

## Requirements for a Pi `/restack` prompt

Translate the findings into prompt requirements. Do not implement the prompt in this note.

### Invocation

- Name: `/restack` (not `/split`). Split is one tactic; restack is split + order + absorb + verify.
- Argument: optional goal/constraints (`$ARGUMENTS`), e.g. “keep the migration separate”, “do not touch commits already on origin/main”.
- Detect VCS: `.jj/` present → jj path; else Git path. If both (colocated), **jj path** and do not shell out to mutating Git.

### Phase 1 — inspect (read-only)

- Git: `status`, `diff --stat`, `diff`, `diff --cached`, `log --oneline <base>..HEAD`, `merge-base`.
- jj: `st`, `diff --stat`, `diff`, `log`. Prefer not using `--ignore-working-copy` so the snapshot includes current files; state that snapshotting `@` is a side effect.
- Record a restore point (Git `HEAD` sha; jj operation id).
- Identify published/immutable boundary (`origin/main`, `trunk()`, `immutable()`). Refuse to rewrite it without explicit user text.

### Phase 2 — plan (no mutate beyond the inspect snapshot)

Return, before executing:

1. Proposed changesets: title, rationale, dependency edges.
2. Files **and hunks** in each (path + hunk header or fileset). Call out tangled hunks and the chosen resolution (edit / keep together / absorb).
3. Generated files, renames (`-M`), binaries — and whether they ride with a logic commit or stand alone.
4. Ordered stack (linear or sibling/parallel).
5. Exact commands, labeled mutating vs not.
6. Per-commit verification command, defaulting to the repo’s cheap check.

Stop here if the user only asked for a plan, or if `$ARGUMENTS` includes `plan-only`. Match `prompts/jj-split.md` for that mode.

### Phase 3 — execute (mutating, only after the plan)

- Follow the VCS recipes above. Prefer fileset splits first, hunk splits second, patch-edits last.
- After each created commit: show `git diff --cached` / `jj diff -r` equivalent (already committed: `git show` / `jj diff -r`) and run the cheap check if the prompt is in execute mode.
- Absorb leftover review-shaped hunks rather than making a trailing “fixes” commit, but only when the destination is unambiguous.
- Do not `--force` push. Do not `--ignore-immutable`. Do not `reset --hard`. Do not `--no-verify`.

### Phase 4 — verify and report

- `git rebase --exec` or `jj run --ignore-changes` over the new range.
- `git range-diff` / `jj interdiff` vs the restore point.
- Report: new change/commit ids, titles, what was dropped, remaining conflicts, commands the user would need to push (unexecuted).
- If verification fails: undo to the restore point (Git: reset/reflog or rebase --abort; jj: `jj op restore`) unless a later commit in the new series is already good *and* the user asked to keep it — default is restore.

### Prompt writing constraints (for whoever authors `/restack`)

- Front-load the trigger: mixed diff, messy series, “split this into reviewable commits”, “restack”.
- Positive instructions (“plan, then split by concern, then verify each commit”) rather than a long list of don’ts; keep the safety list as a short hard-gate block.
- Disclose Git vs jj as branches; do not load both command encyclopedias on every run.
- Completion criterion: every original changed line has exactly one home in the new series, each commit’s title matches its diff, the per-commit check passed or the failure is reported, and no push happened.
- Do not duplicate this research note into the prompt; point at it as disclosed reference.

## Sources

- [Git Book 7.2 Interactive Staging](https://git-scm.com/book/en/v2/Git-Tools-Interactive-Staging)
- [Git Book 7.6 Rewriting History](https://git-scm.com/book/en/v2/Git-Tools-Rewriting-History)
- [git-add](https://git-scm.com/docs/git-add) (interactive mode, patch editing)
- [git-reset](https://git-scm.com/docs/git-reset) (split-apart example, modes)
- [git-commit](https://git-scm.com/docs/git-commit) (message shape, `--fixup`/`--squash`, `-c`/`-C`, `--dry-run`)
- [git-rebase](https://git-scm.com/docs/git-rebase) (interactive, `--exec`, `--autosquash`, `--onto`, splitting commits, recovering from upstream rebase, merge backend)
- [git-stash](https://git-scm.com/docs/git-stash) (`--keep-index`, `--staged`, `--patch`)
- [git-range-diff](https://git-scm.com/docs/git-range-diff)
- [git-diff](https://git-scm.com/docs/git-diff) (`-M`/`-C`/`-B`, `--diff-filter`, binaries)
- [git-push](https://git-scm.com/docs/git-push) (`--force-with-lease`, `--force`)
- [git-worktree](https://git-scm.com/docs/git-worktree)
- [gitfaq](https://git-scm.com/docs/gitfaq) (hooks, storage, signoff)
- [Linux kernel submitting-patches](https://www.kernel.org/doc/html/latest/process/submitting-patches.html)
- [jj tutorial](https://docs.jj-vcs.dev/latest/tutorial/)
- [jj working copy](https://docs.jj-vcs.dev/latest/working-copy/)
- [jj CLI reference](https://docs.jj-vcs.dev/latest/cli-reference/) (`split`, `squash`, `absorb`, `rebase`, `parallelize`, `run`, `undo`, `restore`)
- [jj operation log](https://docs.jj-vcs.dev/latest/operation-log/)
- [jj Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/)
- [git-absorb](https://github.com/tummychow/git-absorb)
- [Sapling split](https://sapling-scm.com/docs/commands/split/), [Sapling absorb](https://sapling-scm.com/docs/commands/absorb/)
- [git-branchless](https://github.com/arxanas/git-branchless), [git restack](https://github.com/arxanas/git-branchless/wiki/Command:-git-restack)
- [Graphite CLI overview](https://graphite.dev/docs/cli-overview)
