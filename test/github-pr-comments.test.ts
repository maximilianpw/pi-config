import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGitHubRepo,
  parseOwnerNameRepo,
  selectCommentsForOutput,
  type NormalizedComment,
} from "../extensions/github-pr-comments.ts";

function comment(id: number, body = `comment ${id}`): NormalizedComment {
  return {
    kind: "issue",
    id,
    author: "reviewer",
    createdAt: `2026-01-${String(id).padStart(2, "0")}T00:00:00Z`,
    body,
  };
}

test("parseGitHubRepo accepts common GitHub remote URL forms", () => {
  assert.equal(parseGitHubRepo("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(parseGitHubRepo("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(parseGitHubRepo("ssh://git@github.com/owner/repo.git"), "owner/repo");
  assert.equal(parseGitHubRepo("https://example.com/owner/repo.git"), undefined);
});

test("parseOwnerNameRepo accepts only a GitHub owner/name slug", () => {
  assert.equal(parseOwnerNameRepo(" owner/repo "), "owner/repo");
  assert.equal(parseOwnerNameRepo("owner"), undefined);
  assert.equal(parseOwnerNameRepo("owner/repo/extra"), undefined);
  assert.equal(parseOwnerNameRepo("https://github.com/owner/repo"), undefined);
});

test("comment limits keep the newest comments in chronological order", () => {
  const selection = selectCommentsForOutput(
    [comment(1), comment(2), comment(3), comment(4)],
    2,
  );

  assert.deepEqual(
    selection.comments.map(({ id }) => id),
    [3, 4],
  );
  assert.equal(selection.omittedByCount, 2);
  assert.equal(selection.omittedBySize, 0);
});

test("comment output truncates large bodies and stays within its output budget", () => {
  const selection = selectCommentsForOutput(
    [comment(1, "a".repeat(200)), comment(2, "b".repeat(200))],
    2,
    { maxBodyChars: 40, maxOutputChars: 300 },
  );

  assert.ok(selection.text.length <= 300);
  assert.match(selection.text, /truncated/);
  assert.ok(selection.truncatedBodies > 0);
});

test("output-budget truncation drops older comments before newer comments", () => {
  const selection = selectCommentsForOutput(
    [comment(1, "old".repeat(20)), comment(2, "new".repeat(20))],
    2,
    { maxBodyChars: 200, maxOutputChars: 150 },
  );

  assert.deepEqual(selection.comments.map(({ id }) => id), [2]);
  assert.equal(selection.omittedBySize, 1);
});

test("a newest comment that cannot fit is reported as omitted rather than absent", () => {
  const selection = selectCommentsForOutput(
    [comment(1, "x".repeat(100))],
    1,
    { maxBodyChars: 100, maxOutputChars: 10 },
  );

  assert.deepEqual(selection.comments, []);
  assert.equal(selection.omittedBySize, 1);
});
