import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { latestAssistantMarkdown } from "../shared/latest-assistant-markdown.ts";

export default function saveMarkdownExtension(pi: ExtensionAPI) {
	pi.registerCommand("save-md", {
		description: "Save the latest assistant response as Markdown (usage: /save-md name)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const markdown = latestAssistantMarkdown(ctx.sessionManager.getBranch());
			if (markdown === undefined) {
				ctx.ui.notify("No assistant response to save", "warning");
				return;
			}

			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /save-md name", "warning");
				return;
			}

			if (!markdown.trim()) {
				ctx.ui.notify(
					"The latest assistant response has no Markdown text",
					"warning",
				);
				return;
			}

			const fileName = name.endsWith(".md") ? name : `${name}.md`;
			const path = resolve(ctx.cwd, fileName);

			try {
				await writeFile(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`, {
					encoding: "utf8",
					flag: "wx",
				});
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "EEXIST"
				) {
					ctx.ui.notify(`File already exists: ${path}`, "error");
					return;
				}
				throw error;
			}

			const message = `Saved Markdown to ${path}`;
			pi.sendMessage(
				{
					customType: "save-md",
					content: message,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify(message, "info");
		},
	});
}
