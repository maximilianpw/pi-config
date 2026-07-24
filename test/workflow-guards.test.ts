import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { cloakText, loadState } from "../extensions/pi-cloak/index.ts";
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

test("cloak rules redact common secret formats", () => {
  const cwd = resolve(import.meta.dirname, "..");
  const state = loadState(resolve(cwd, "cloak.json"));
  const samples = [
    ["secret.env", "TOKEN=hunter2"],
    ["auth.json", "{\"apiKey\":\"hunter2\"}"],
    ["config.toml", "token = \"hunter2\""],
    ["secret.yaml", "password: hunter2"],
  ] as const;

  for (const [path, input] of samples) {
    const output = cloakText(input, path, cwd, state);
    assert.doesNotMatch(output, /hunter2/, `${path} leaked its secret`);
  }
});
