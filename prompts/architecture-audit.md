---
description: Audit architecture and identify high-leverage refactoring opportunities
argument-hint: "[area or concern]"
---
Audit the architecture for this codebase area:

$ARGUMENTS

Look for:
- Domain concepts that are implicit or scattered.
- Tight coupling and hidden dependencies.
- Testability seams and missing boundaries.
- Places where a small refactor would unlock future work.

Return a prioritized list with evidence, tradeoffs, and a suggested first tracer-bullet change.
