---
description: Review current code changes for bugs, risks, and missed verification
argument-hint: "[focus]"
---
Review the current repository changes. Prefer `jj` when this is a jj repo; otherwise use Git.

Focus: $ARGUMENTS

Return:
1. Critical correctness/security issues first.
2. Concrete file/line references when possible.
3. Missing tests or verification gaps.
4. A short verdict: safe to ship / needs changes / needs more investigation.
