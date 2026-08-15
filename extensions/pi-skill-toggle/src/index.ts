import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AtomicSkillChangeWriter } from "./apply/writer.ts";
import { DefaultSkillTogglePlanner } from "./apply/planner.ts";
import { DefaultSkillLocator } from "./discovery/skill-locator.ts";
import { MinimalFrontmatterPatcher } from "./frontmatter/patcher.ts";
import { SimpleFrontmatterCodec } from "./frontmatter/parser.ts";
import { classifyEditableSkillSet } from "./inventory/classifier.ts";
import { DefaultSkillInventory } from "./inventory/loader.ts";
import { NodeFileSystem } from "./ports/fs.ts";
import { runToggleSkillsCommand } from "./command.ts";

export default function piSkillToggle(pi: ExtensionAPI) {
  const fs = new NodeFileSystem();
  const codec = new SimpleFrontmatterCodec();
  const patcher = new MinimalFrontmatterPatcher();
  const locator = new DefaultSkillLocator(fs);
  const inventory = new DefaultSkillInventory(locator, fs, codec);
  const planner = new DefaultSkillTogglePlanner(fs, codec, patcher);
  const writer = new AtomicSkillChangeWriter(fs);

  pi.on("session_start", async (_event, ctx) => {
    try {
      const mode = classifyEditableSkillSet(await inventory.load(ctx.cwd));
      const status = mode === "manual-only"
        ? ctx.ui.theme.fg("warning", "manual-only")
        : undefined;
      ctx.ui.setStatus("toggle-skills", status);
    } catch {
      ctx.ui.setStatus("toggle-skills", undefined);
    }
  });

  pi.registerCommand("toggle-skills", {
    description: "Toggle all editable skills between agent-invocable and manual-only, then reload Pi resources",
    handler: async (_args, ctx) => {
      await runToggleSkillsCommand(ctx, { inventory, planner, writer });
    },
  });
}
