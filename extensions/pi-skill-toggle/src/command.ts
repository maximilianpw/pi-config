import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SkillTogglePlanner } from "./apply/planner.ts";
import type { SkillChangeWriter } from "./apply/writer.ts";
import { classifyEditableSkillSet } from "./inventory/classifier.ts";
import type { SkillInventory } from "./inventory/loader.ts";
import type { ApplyResult, SkillDraft } from "./types.ts";

export interface ToggleSkillsCommandDeps {
  inventory: SkillInventory;
  planner: SkillTogglePlanner;
  writer: SkillChangeWriter;
}

/** Toggle every editable discovered skill between agent-invocable and manual-only, then reload resources. */
export async function runToggleSkillsCommand(
  ctx: ExtensionCommandContext,
  deps: ToggleSkillsCommandDeps,
): Promise<void> {
  let skills;
  try {
    skills = await deps.inventory.load(ctx.cwd);
  } catch (error) {
    ctx.ui.notify(
      `Pi Skill Toggle failed to scan skills: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  if (skills.length === 0) {
    ctx.ui.notify("Pi Skill Toggle: no skills found in global, user, or project skill directories", "info");
    return;
  }

  const currentMode = classifyEditableSkillSet(skills);
  if (currentMode === "none") {
    ctx.ui.notify("Pi Skill Toggle: no editable skills found", "info");
    return;
  }

  const desiredMode = currentMode === "manual-only" ? "agent-invocable" : "manual-only";
  const drafts: SkillDraft[] = skills.map((skill) => ({
    skill,
    desiredMode,
  }));
  let changes;
  try {
    changes = await deps.planner.plan(skills, drafts);
  } catch (error) {
    ctx.ui.notify(
      `Pi Skill Toggle failed to plan changes: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  if (changes.length === 0) {
    ctx.ui.notify(`Pi Skill Toggle: all editable skills are already ${desiredMode}`, "info");
    return;
  }

  const applied = await deps.writer.apply(changes);
  ctx.ui.notify(formatApplyResult(applied, desiredMode), applied.errors.length > 0 ? "warning" : "info");

  if (applied.applied.length > 0) {
    await ctx.reload();
  }
}

function formatApplyResult(result: ApplyResult, desiredMode: SkillDraft["desiredMode"]): string {
  const lines = [
    `Pi Skill Toggle made ${result.applied.length} skill${result.applied.length === 1 ? "" : "s"} ${desiredMode}.`,
  ];
  if (result.errors.length > 0) {
    lines.push(`Errors/skipped: ${result.errors.length}`);
    for (const error of result.errors.slice(0, 4)) {
      lines.push(`- ${error.message}`);
    }
  }
  if (result.applied.length > 0) {
    lines.push("Reloading skills, prompts, extensions, and themes.");
  }
  return lines.join("\n");
}
