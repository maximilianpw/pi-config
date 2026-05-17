---
description: Draft a concise commit message for the current changes
argument-hint: "[style or scope]"
---
Inspect the current repository changes and draft a commit message.

Use `jj diff`/`jj st` in jj repos; use Git only if jj is unavailable.

Preferences: $ARGUMENTS

Return only:
- A one-line subject in imperative mood, <=72 chars.
- A short body when it adds useful context.
