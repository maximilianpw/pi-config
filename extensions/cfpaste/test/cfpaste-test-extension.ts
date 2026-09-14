import { createCfPasteExtension } from "../index.ts";
import type { MarkdownPasteClient } from "../markdown-paste-client.ts";
import type { PlannotatorReviewer } from "../plannotator-review.ts";

declare global {
	var cfpasteTestClient: MarkdownPasteClient | undefined;
	var cfpasteTestReviewer: PlannotatorReviewer | undefined;
}

export default createCfPasteExtension({
	client: { createDocument: (input) => {
		if (globalThis.cfpasteTestClient === undefined) throw new Error("Missing test client");
		return globalThis.cfpasteTestClient.createDocument(input);
	} },
	reviewer: {
		reviewFile: (bytes, signal) => {
			if (globalThis.cfpasteTestReviewer === undefined) throw new Error("Missing test reviewer");
			return globalThis.cfpasteTestReviewer.reviewFile(bytes, signal);
		},
		reviewLatest: (markdown, signal) => {
			if (globalThis.cfpasteTestReviewer === undefined) throw new Error("Missing test reviewer");
			return globalThis.cfpasteTestReviewer.reviewLatest(markdown, signal);
		},
	},
});
