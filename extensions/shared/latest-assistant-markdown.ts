import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function textBlocks(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

/** Return only text blocks from the latest assistant message on the active branch. */
export function latestAssistantMarkdown(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			return textBlocks(entry.message);
		}
	}
	return undefined;
}
