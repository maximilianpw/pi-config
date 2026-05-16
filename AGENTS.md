# Global Agents Config

## Obsidian Vault

The Obsidian CLI (`obsidian`) is available on the system. Use it when interacting with notes.

The vault is located at `~/Documents/obsidian vault/`.

### Feature Planning

When discussing or planning a new feature, create a note in the vault using the Feature template (`999-TEMPLATES/Feature.md`). Fill in the template sections (Why, MVP, Not doing, Approach) to align on scope before writing code.

### Bug Reports

When investigating or reporting a bug, create a note in the vault using the Problem template (`999-TEMPLATES/Problem.md`). Fill in the sections (What's happening, What I expected, What I've tried, What I think is going on) and update the Solution section after resolving it.

### Wiki Integration

The vault contains a persistent LLM-maintained wiki at `200-WIKI/`. See `200-WIKI/CLAUDE.md` for full schema.

**When working on project code:**

- Before diving into domain-specific work, read the relevant topic index at `200-WIKI/topics/<topic>/index.md` for context. Key mappings:
  - VEV / vev-server / vev-ocpi → `ev-charging/` (also linked from `333-VEV/`)
  - LibreStock / Effect migration → `effect-ts/`
  - Architecture decisions → `software-architecture/`
  - Dev tooling (jj, etc.) → `dev-tools/`
- When a conversation produces a useful synthesis, exploration, or resolved question that would benefit future work, offer to file it back as a wiki article.

**When to update the wiki:**

- After resolving a non-trivial technical question related to an existing topic
- After an audit or investigation that surfaces new domain knowledge
- After ingesting a new source (spec, article, book) — compile it into wiki articles
- Do not update the wiki for ephemeral or project-specific details (use project notes in `100-PROJECTS/` or `333-VEV/` instead)

**Project ↔ Wiki boundary:**

- `333-VEV/`, `100-PROJECTS/` = actionable work (audits, features, bugs, specs)
- `200-WIKI/` = compiled domain knowledge (protocols, patterns, concepts)
- Project index files link to relevant wiki topics via "Wiki Context" sections
- Don't duplicate — project notes reference wiki articles for domain context, wiki articles reference VEV for real-world examples

## Version Control: prefer jj over git

When a repo has a `.jj/` directory (run `jj root` to check), use `jj` instead of `git` for VCS operations. Most of my repos are jj-colocated with git — assume jj unless `jj root` fails.

Background and deeper workflows: `200-WIKI/topics/dev-tools/` has my jj notes.

**Command mapping** (use the jj form):

- `git status` → `jj st`
- `git diff` → `jj diff` (working copy) / `jj diff -r <rev>` (specific revision)
- `git log` → `jj log` (default shows the relevant slice, not full history)
- `git add` → _no equivalent needed_ — jj auto-tracks all changes in the working copy
- `git commit -m "msg"` → `jj commit -m "msg"` (finalize) or `jj describe -m "msg"` (set message on current change without starting a new one)
- `git checkout -b foo` → `jj new -m "foo"` then `jj bookmark create foo -r @-` if a named branch is needed
- `git push` → `jj git push` (pushes bookmarks)
- `git pull` → `jj git fetch` then `jj rebase` as needed
- `git stash` → not needed; just `jj new` to start fresh, the WIP becomes its own change

**Gotchas for a git-trained agent:**

- No staging area. Don't try to `jj add` files. The working copy _is_ a commit (`@`).
- Don't `git commit --amend` — use `jj squash` or just edit `@` and re-`jj describe`.
- Branches in jj are called **bookmarks** and don't auto-follow new commits — push them explicitly with `jj git push`.
- `jj undo` reverses the last operation; safer than git resets.
- When a conflict appears, jj records it in the commit rather than blocking — resolve in the working copy, then continue.

**When git is still the right tool:**

- Repo has no `.jj/` directory.
- Operating on remote-only refs the user explicitly named in git terms.
- Reading `git log`/`git blame` for forensics where jj's view would obscure history (rare).

## Planning First

Never jump straight into implementation. For any non-trivial task:

1. **Understand the problem** — read the relevant code, ask clarifying questions, make sure you know what's actually going on before proposing changes.
2. **Draft a plan** — outline the approach, the files involved, and the key decisions. For complex work, use plan mode.
3. **Grill the plan** — before implementing, automatically invoke `/grill-me` to stress-test the plan with the user. Resolve ambiguities, surface missed edge cases, and reach shared understanding before writing code.
4. **Then implement** — only after alignment.

For larger features, also create a Feature note in the Obsidian vault (see below) to capture Why, MVP, Not doing, and Approach.

A "trivial" change is a one-liner, a typo fix, or something the user explicitly tells you to just do. Everything else gets a plan.

## Shell: prefer Nushell over POSIX text tools

Nushell is the primary interactive shell. When generating commands, scripts, or one-liners for the user to run, prefer Nushell's structured-data pipelines over POSIX text-munging tools.

**Substitutions:**

- `grep` → `where`, `find`, or `str contains`
- `awk` / `cut` → `get`, `select`, `columns`
- `sed` → `str replace`
- `wc -l` → `length`
- `sort | uniq -c` → `group-by | transpose`
- `xargs` → `each { |it| ... }`
- `jq` → native `from json` + `get` / `where`
- `head` / `tail` → `first N` / `last N`
- `find . -name` → `ls **/*pattern*` or `glob`

**When the POSIX tool is still right:**

- Target is a Bash/POSIX script, CI step, Makefile, or README example that runs under `/bin/sh`.
- Tool shells out via `system()` or similar and won't pick up Nushell.
- Piping to a tool that expects raw text on stdin in a way Nushell would mangle.
