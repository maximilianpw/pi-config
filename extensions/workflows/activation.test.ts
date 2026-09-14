import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflows, { parseWorkflowToolCommand, shouldActivateWorkflowTool } from "./index.ts";

test("workflow tool activation recognizes ultracode and explicit workflow requests", () => {
  assert.equal(shouldActivateWorkflowTool("ultracode review this branch"), true);
  assert.equal(shouldActivateWorkflowTool("Please run a multi-agent workflow for this audit"), true);
  assert.equal(shouldActivateWorkflowTool("Use the workflow tool to verify this"), true);
});

test("workflow tool stays inactive for ordinary workflow discussion", () => {
  assert.equal(shouldActivateWorkflowTool("How does the workflow engine work?"), false);
  assert.equal(shouldActivateWorkflowTool("Update the GitHub Actions workflow"), false);
  assert.equal(shouldActivateWorkflowTool("Do not run a workflow"), false);
});

test("workflow command parser exposes an explicit session-local override", () => {
  assert.equal(parseWorkflowToolCommand(" enable "), "enable");
  assert.equal(parseWorkflowToolCommand("DISABLE"), "disable");
  assert.equal(parseWorkflowToolCommand("wf_123"), undefined);
});

test("extension loading does not call runtime action methods", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let runtimeInitialized = false;
  let activeTools = ["read", "workflow"];
  const recordingApi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    registerTool() {},
    getActiveTools() {
      if (!runtimeInitialized) throw new Error("Extension runtime not initialized");
      return activeTools;
    },
    setActiveTools(names: string[]) {
      if (!runtimeInitialized) throw new Error("Extension runtime not initialized");
      activeTools = names;
    },
  };
  // SAFETY: this fake records only the registration and active-tool operations used during startup.
  const pi = recordingApi as unknown as ExtensionAPI;

  assert.doesNotThrow(() => workflows(pi));
  runtimeInitialized = true;
  await handlers.get("session_start")?.({}, { hasUI: false });

  assert.deepEqual(activeTools, ["read"]);
});
