import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutorArgs } from "./command.ts";

test("builds a bounded Executor tool search", () => {
  assert.deepEqual(
    buildExecutorArgs({
      action: "search",
      query: "create issue",
      namespace: "github_rest",
      limit: 5,
    }),
    ["tools", "search", "create issue", "--namespace", "github_rest", "--limit", "5"],
  );
});

test("builds describe and integration discovery commands", () => {
  assert.deepEqual(
    buildExecutorArgs({ action: "describe", path: "github.issues.create" }),
    ["tools", "describe", "github.issues.create"],
  );
  assert.deepEqual(
    buildExecutorArgs({ action: "integrations", query: "github" }),
    ["tools", "integrations", "--query", "github", "--limit", "20"],
  );
});

test("turns a qualified tool path into an Executor call", () => {
  assert.deepEqual(
    buildExecutorArgs({
      action: "call",
      path: "github_rest.user.personalgithubrest.issues.get",
      args: { owner: "acme", repo: "app", issue_number: 42 },
    }),
    [
      "call",
      "github_rest",
      "user",
      "personalgithubrest",
      "issues",
      "get",
      '{"owner":"acme","repo":"app","issue_number":42}',
    ],
  );
});

test("builds approval responses only from explicit decisions", () => {
  assert.deepEqual(
    buildExecutorArgs({
      action: "resume",
      executionId: "exec_123",
      decision: "accept",
      content: { confirmed: true },
    }),
    [
      "--log-level",
      "debug",
      "resume",
      "--execution-id",
      "exec_123",
      "--action",
      "accept",
      "--content",
      '{"confirmed":true}',
    ],
  );
  assert.deepEqual(
    buildExecutorArgs({
      action: "resume",
      executionId: "exec_123",
      decision: "decline",
    }),
    [
      "--log-level",
      "debug",
      "resume",
      "--execution-id",
      "exec_123",
      "--action",
      "decline",
    ],
  );
});

test("rejects incomplete operations before invoking Executor", () => {
  assert.throws(
    () => buildExecutorArgs({ action: "call", path: "github..issues" }),
    /without empty segments/,
  );
  assert.throws(
    () => buildExecutorArgs({ action: "resume", executionId: "exec_123" }),
    /requires `decision`/,
  );
  assert.throws(
    () => buildExecutorArgs({ action: "search" }),
    /requires `query`/,
  );
});
