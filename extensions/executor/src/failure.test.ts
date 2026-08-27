import assert from "node:assert/strict";
import test from "node:test";

import { formatExecutorFailure } from "./failure.ts";

test("explains approvals that Executor cannot resume", () => {
  assert.equal(
    formatExecutorFailure(
      "",
      'Error: {"_tag":"ApprovalExpiredError","executionId":"exec_123"}',
      1,
    ),
    "Executor could not resume execution exec_123. The approval expired or the gateway could not reconstruct the paused execution. Trigger the original action again.",
  );
});

test("explains unreadable CLI errors", () => {
  assert.equal(
    formatExecutorFailure("[object Object]\n", "", 1),
    "Executor failed but its CLI returned an unreadable error. Run the command with `--log-level debug` for the real failure details.",
  );
});

test("keeps ordinary Executor errors", () => {
  assert.equal(
    formatExecutorFailure("", "Authentication failed", 1),
    "Authentication failed",
  );
});
