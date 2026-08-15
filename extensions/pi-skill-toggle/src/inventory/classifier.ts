import type { FrontmatterDocument, SkillInvocationMode, SkillRecord, SkillSource } from "../types.ts";
import { getDisableModelInvocation } from "../frontmatter/validation.ts";

export function classifyInvocationMode(doc: FrontmatterDocument): SkillInvocationMode {
  return getDisableModelInvocation(doc) ? "manual-only" : "agent-invocable";
}

export function classifyEditableSkillSet(skills: SkillRecord[]): SkillInvocationMode | "mixed" | "none" {
  const editableSkills = skills.filter((skill) => skill.editable);
  const [firstSkill] = editableSkills;
  if (!firstSkill) return "none";

  const firstMode = firstSkill.mode;
  return editableSkills.every((skill) => skill.mode === firstMode) ? firstMode : "mixed";
}

export function formatSourceKind(kind: SkillSource["kind"] | string): string {
  switch (kind) {
    case "global":
      return "Global";
    case "user":
      return "User";
    case "project":
      return "Project";
    case "project-legacy":
      return "Project (.agents)";
    default:
      return "Unknown";
  }
}

export function sourceCategory(source: SkillSource): "global" | "user" | "project" | "unknown" {
  if (source.kind === "project-legacy") return "project";
  if (source.kind === "global" || source.kind === "user" || source.kind === "project") return source.kind;
  return "unknown";
}

export function sourceBadge(source: SkillSource): string {
  return sourceCategory(source);
}
