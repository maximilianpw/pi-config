import type { SDKImage, SDKUserMessage } from "@cursor/sdk";
import type { AssistantMessage, Context, Message, ToolResultMessage } from "@earendil-works/pi-ai";

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => {
			if (block.type === "text") return [block.text];
			if (block.type === "toolCall") {
				return [`<tool_call name=${safeJson(block.name)}>\n${safeJson(block.arguments)}\n</tool_call>`];
			}
			return [];
		})
		.join("\n");
}

function toolResultText(message: ToolResultMessage): string {
	const content = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return `<tool_result name=${safeJson(message.toolName)} error=${message.isError}>\n${content}\n</tool_result>`;
}

function messageText(message: Message): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	if (message.role === "assistant") return assistantText(message);
	return toolResultText(message);
}

function collectImages(context: Context): SDKImage[] {
	const images: SDKImage[] = [];
	for (const message of context.messages) {
		if (message.role === "assistant") continue;
		const content = message.content;
		if (typeof content === "string") continue;
		for (const block of content) {
			if (block.type === "image") images.push({ data: block.data, mimeType: block.mimeType });
		}
	}
	return images;
}

export function buildCursorPrompt(context: Context): SDKUserMessage {
	const sections: string[] = [
		"Continue this Pi coding-agent conversation. Follow the system instructions and treat the transcript as prior context.",
	];
	if (context.systemPrompt?.trim()) sections.push(`System instructions:\n${context.systemPrompt.trim()}`);
	if (context.messages.length > 0) {
		const transcript = context.messages
			.map((message) => `<${message.role}>\n${messageText(message)}\n</${message.role}>`)
			.join("\n\n");
		sections.push(`Conversation transcript:\n${transcript}`);
	}
	const images = collectImages(context);
	return {
		text: sections.join("\n\n"),
		...(images.length > 0 ? { images } : {}),
	};
}
