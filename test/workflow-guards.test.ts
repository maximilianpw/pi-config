import assert from "node:assert/strict";
import test from "node:test";

import { guardGitCommand } from "../extensions/safety-guard.ts";

test("Git commands cannot bypass hooks and never open an interactive editor", () => {
  const blocked = guardGitCommand("git commit --no-verify");
  assert.match(blocked.blockReason ?? "", /--no-verify/);

  const guarded = guardGitCommand("git rebase --continue");
  assert.equal(guarded.blockReason, undefined);
  assert.match(guarded.command, /^export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n/);

  const unrelated = guardGitCommand("rg git README.md");
  assert.deepEqual(unrelated, { command: "rg git README.md" });
});
