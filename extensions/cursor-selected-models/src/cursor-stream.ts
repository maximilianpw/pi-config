import type { InteractionUpdate, ModelSelection, RunResult, SDKUserMessage, TokenUsage } from "@cursor/sdk";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { resolveCursorApiKey } from "./cursor-auth.js";
import { resolveCursorModelSelection } from "./cursor-model.js";
import { buildCursorPrompt } from "./cursor-prompt.js";

export interface CursorRuntimeRequest {
	apiKey: string;
	cwd: string;
	model: ModelSelection;
	prompt: SDKUserMessage;
	onDelta: (update: InteractionUpdate) => void;
	signal?: AbortSignal;
}

export interface CursorRuntime {
	run(request: CursorRuntimeRequest): Promise<RunResult>;
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createPartial(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function applyUsage(message: AssistantMessage, usage: TokenUsage): void {
	message.usage = {
		input: Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens),
		output: usage.outputTokens,
		cacheRead: usage.cacheReadTokens,
		cacheWrite: usage.cacheWriteTokens,
		reasoning: usage.reasoningTokens,
		totalTokens: usage.inputTokens + usage.outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

class CursorContentEmitter {
	private active: { type: "text" | "thinking"; index: number } | undefined;
	private emittedText = "";

	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly partial: AssistantMessage,
	) {}

	appendText(delta: string): void {
		if (!delta) return;
		if (this.active?.type !== "text") {
			this.close();
			const index = this.partial.content.length;
			this.partial.content.push({ type: "text", text: "" });
			this.active = { type: "text", index };
			this.stream.push({ type: "text_start", contentIndex: index, partial: this.partial });
		}
		const block = this.partial.content[this.active.index];
		if (block?.type !== "text") return;
		block.text += delta;
		this.emittedText += delta;
		this.stream.push({ type: "text_delta", contentIndex: this.active.index, delta, partial: this.partial });
	}

	appendThinking(delta: string): void {
		if (!delta) return;
		if (this.active?.type !== "thinking") {
			this.close();
			const index = this.partial.content.length;
			this.partial.content.push({ type: "thinking", thinking: "" });
			this.active = { type: "thinking", index };
			this.stream.push({ type: "thinking_start", contentIndex: index, partial: this.partial });
		}
		const block = this.partial.content[this.active.index];
		if (block?.type !== "thinking") return;
		block.thinking += delta;
		this.stream.push({ type: "thinking_delta", contentIndex: this.active.index, delta, partial: this.partial });
	}

	appendFinalFallback(result: string | undefined): void {
		if (!result?.trim()) return;
		if (this.emittedText.length === 0) {
			this.appendText(result);
			return;
		}
		if (result.startsWith(this.emittedText)) this.appendText(result.slice(this.emittedText.length));
	}

	closeThinking(): void {
		if (this.active?.type === "thinking") this.close();
	}

	close(): void {
		if (!this.active) return;
		const { index, type } = this.active;
		const block = this.partial.content[index];
		this.active = undefined;
		if (type === "text" && block?.type === "text") {
			this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.partial });
		}
		if (type === "thinking" && block?.type === "thinking") {
			this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.partial });
		}
	}
}

function errorText(error: unknown, apiKey: string | undefined): string {
	const message = error instanceof Error ? error.message : String(error);
	return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

export function createCursorStream(
	runtime: CursorRuntime,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial = createPartial(model);

	void (async () => {
		const emitter = new CursorContentEmitter(stream, partial);
		const apiKey = resolveCursorApiKey(options.apiKey);
		try {
			stream.push({ type: "start", partial });
			if (!apiKey) throw new Error("Cursor API key is required; use /login and select Cursor, or set CURSOR_API_KEY");
			const result = await runtime.run({
				apiKey,
				cwd: process.cwd(),
				model: resolveCursorModelSelection(model.id, options.reasoning),
				prompt: buildCursorPrompt(context),
				signal: options.signal,
				onDelta(update) {
					if (update.type === "text-delta") emitter.appendText(update.text);
					else if (update.type === "thinking-delta") emitter.appendThinking(update.text);
					else if (update.type === "thinking-completed") emitter.closeThinking();
					else if (update.type === "turn-ended" && update.usage) {
						applyUsage(partial, {
							...update.usage,
							totalTokens: update.usage.inputTokens + update.usage.outputTokens,
						});
					}
				},
			});
			if (result.usage) applyUsage(partial, result.usage);
			if (result.status === "cancelled" || options.signal?.aborted) {
				throw new DOMException("Cursor run aborted", "AbortError");
			}
			if (result.status === "error") throw new Error(result.error?.message ?? "Cursor run failed");
			emitter.appendFinalFallback(result.result);
			emitter.close();
			partial.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: partial });
		} catch (error) {
			emitter.close();
			const aborted = options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
			partial.stopReason = aborted ? "aborted" : "error";
			partial.errorMessage = errorText(error, apiKey);
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: partial });
		} finally {
			stream.end(partial);
		}
	})();

	return stream;
}
