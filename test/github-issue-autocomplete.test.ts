import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubRepo } from "../extensions/github-issue-autocomplete.ts";

test("parses every GitHub remote form and ignores other hosts", () => {
  for (const remote of [
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "https://github.com/owner/repo",
    "https://github.com/owner/repo.git/",
    "https://token@github.com/owner/repo.git",
  ]) {
    assert.equal(parseGitHubRepo(remote), "owner/repo", remote);
  }
  assert.equal(parseGitHubRepo("https://gitlab.com/owner/repo"), undefined);
});
