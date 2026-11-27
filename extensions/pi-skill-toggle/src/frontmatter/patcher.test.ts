import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SimpleFrontmatterCodec } from "./parser.ts";
import { MinimalFrontmatterPatcher } from "./patcher.ts";
import { getDuplicateFrontmatterKeys } from "./validation.ts";

const codec = new SimpleFrontmatterCodec();
const patcher = new MinimalFrontmatterPatcher();

describe("MinimalFrontmatterPatcher", () => {
  it("does not add a second disable-model-invocation key when a skill is already manual-only", () => {
    const raw = [
      "---",
      "name: handoff",
      "description: Compact the conversation.",
      "disable-model-invocation: true",
      "argument-hint: What next?",
      "---",
      "",
      "# Handoff",
      "",
    ].join("\n");

    const patch = patcher.patchInvocationMode(codec.parse(raw), "manual-only");

    assert.equal(patch.newText, raw);
    assert.equal(countDisableKeys(patch.newText), 1);
  });

  it("collapses duplicated disable-model-invocation keys when setting manual-only", () => {
    const raw = [
      "---",
      "name: handoff",
      "description: Compact the conversation.",
      "disable-model-invocation: true",
      "argument-hint: What next?",
      "disable-model-invocation: true",
      "---",
      "",
      "# Handoff",
      "",
    ].join("\n");

    const patch = patcher.patchInvocationMode(codec.parse(raw), "manual-only");

    assert.equal(countDisableKeys(patch.newText), 1);
    assert.deepEqual(getDuplicateFrontmatterKeys(codec.parse(patch.newText)), []);
    assert.ok(patch.newText.includes("disable-model-invocation: true\nargument-hint: What next?\n---"));
  });

  it("removes all disable-model-invocation keys when setting agent-invocable", () => {
    const raw = [
      "---",
      "name: handoff",
      "description: Compact the conversation.",
      "disable-model-invocation: true",
      "argument-hint: What next?",
      "disable-model-invocation: true",
      "---",
      "",
      "# Handoff",
      "",
    ].join("\n");

    const patch = patcher.patchInvocationMode(codec.parse(raw), "agent-invocable");

    assert.equal(countDisableKeys(patch.newText), 0);
    assert.deepEqual(getDuplicateFrontmatterKeys(codec.parse(patch.newText)), []);
    assert.ok(patch.newText.includes("argument-hint: What next?\n---"));
  });

  it("leaves a nested key with the same name untouched", () => {
    const raw = [
      "---",
      "name: handoff",
      "metadata:",
      "  disable-model-invocation: legacy",
      "---",
      "",
    ].join("\n");

    const manual = patcher.patchInvocationMode(codec.parse(raw), "manual-only");
    assert.ok(manual.newText.includes("metadata:\n  disable-model-invocation: legacy\n"));
    assert.equal(countDisableKeys(manual.newText), 1);

    const invocable = patcher.patchInvocationMode(codec.parse(raw), "agent-invocable");
    assert.equal(invocable.newText, raw);
  });
});

function countDisableKeys(raw: string): number {
  return (raw.match(/^disable-model-invocation\s*:/gm) ?? []).length;
}
