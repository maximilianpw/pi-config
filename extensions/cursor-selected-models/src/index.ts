import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_API_KEY_PLACEHOLDER } from "./cursor-auth.js";
import { CURSOR_MODELS } from "./cursor-model.js";
import { cursorSdkRuntime } from "./cursor-runtime.js";
import { createCursorStream } from "./cursor-stream.js";

export default function cursorSelectedModels(pi: ExtensionAPI): void {
	pi.registerProvider("cursor", {
		name: "Cursor (Grok only)",
		baseUrl: "https://cursor.com",
		apiKey: CURSOR_API_KEY_PLACEHOLDER,
		api: "cursor-sdk",
		models: CURSOR_MODELS,
		streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
			return createCursorStream(cursorSdkRuntime, model, context, options);
		},
	});
}
