import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runToggleSkillsCommand } from "./command.ts";
import type { ToggleSkillsCommandDeps } from "./command.ts";
import type { SkillChange, SkillDraft, SkillRecord } from "./types.ts";

function skill(name: string, mode: SkillRecord["mode"]): SkillRecord {
  return {
    id: `/skills/${name}/SKILL.md`,
    name,
    description: `${name} skill`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    source: { kind: "user", root: "/skills" },
    editable: true,
    mode,
    diagnostics: [],
  };
}

function change(record: SkillRecord, to: SkillRecord["mode"] = "manual-only"): SkillChange {
  return {
    skill: record,
    filePath: record.filePath,
    from: record.mode,
    to,
    patch: { oldText: "before", newText: "after" },
  };
}

function commandContext(notifications: Array<{ message: string; type: string | undefined }>, reload: () => void): ExtensionCommandContext {
  // SAFETY: The command uses only cwd, ui.notify, and reload; this narrow fake supplies their production behavior.
  return {
    cwd: "/project",
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
    async reload() {
      reload();
    },
  } as unknown as ExtensionCommandContext;
}

test("toggle-skills makes every editable skill manual-only when any are agent-invocable", async () => {
  const records = [skill("agent", "agent-invocable"), skill("manual", "manual-only")];
  let plannedDrafts: SkillDraft[] | undefined;
  let reloads = 0;
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const deps: ToggleSkillsCommandDeps = {
    inventory: { async load() { return records; } },
    planner: {
      async plan(_records, drafts) {
        plannedDrafts = drafts;
        return [change(records[0]!)];
      },
    },
    writer: {
      async apply(changes) {
        return { applied: changes, skipped: [], errors: [] };
      },
    },
  };

  await runToggleSkillsCommand(commandContext(notifications, () => { reloads += 1; }), deps);

  assert.deepEqual(plannedDrafts, [
    { skill: records[0], desiredMode: "manual-only" },
    { skill: records[1], desiredMode: "manual-only" },
  ]);
  assert.equal(reloads, 1);
  assert.match(notifications[0]?.message ?? "", /made 1 skill manual-only/);
});

test("toggle-skills makes every editable skill agent-invocable when all are manual-only", async () => {
  const records = [skill("manual", "manual-only")];
  let plannedDrafts: SkillDraft[] | undefined;
  let reloads = 0;
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const deps: ToggleSkillsCommandDeps = {
    inventory: { async load() { return records; } },
    planner: {
      async plan(_records, drafts) {
        plannedDrafts = drafts;
        return [change(records[0]!, "agent-invocable")];
      },
    },
    writer: {
      async apply(changes) {
        return { applied: changes, skipped: [], errors: [] };
      },
    },
  };

  await runToggleSkillsCommand(commandContext(notifications, () => { reloads += 1; }), deps);

  assert.deepEqual(plannedDrafts, [
    { skill: records[0], desiredMode: "agent-invocable" },
  ]);
  assert.equal(reloads, 1);
  assert.match(notifications[0]?.message ?? "", /made 1 skill agent-invocable/);
});

test("toggle-skills does not plan or reload when no discovered skills are editable", async () => {
  const readonly = { ...skill("readonly", "manual-only"), editable: false };
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  let reloads = 0;
  const deps: ToggleSkillsCommandDeps = {
    inventory: { async load() { return [readonly]; } },
    planner: {
      async plan() {
        throw new Error("planner must not run when there are no editable skills");
      },
    },
    writer: {
      async apply() {
        throw new Error("writer must not run when there are no editable skills");
      },
    },
  };

  await runToggleSkillsCommand(commandContext(notifications, () => { reloads += 1; }), deps);

  assert.equal(reloads, 0);
  assert.equal(notifications[0]?.message, "Pi Skill Toggle: no editable skills found");
});
