import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { removeTempTextFiles } from "./temp.ts";
import { createWebFetchTool } from "./webfetch.ts";

export default function webToolsExtension(pi: ExtensionAPI) {
	pi.registerTool(createWebFetchTool());
	// Truncated results point the model at a full-output file; it stays readable for the whole session.
	pi.on("session_shutdown", () => removeTempTextFiles());
}
