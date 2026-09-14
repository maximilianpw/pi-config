export type CfPasteFailureReason =
	| "authentication"
	| "configuration"
	| "validation"
	| "network"
	| "rejected-response"
	| "invalid-response";

export class CfPasteError extends Error {
	readonly _tag = "CfPasteError" as const;

	constructor(readonly reason: CfPasteFailureReason, message: string, override readonly cause?: unknown) {
		super(message);
		this.name = "CfPasteError";
	}
}
