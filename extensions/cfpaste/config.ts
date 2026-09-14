import { CfPasteError } from "./errors.ts";
import { failure, type Result, success } from "./result.ts";

export function parseServiceOrigin(raw: string | undefined, label = "CFPASTE_PRIVATE_ORIGIN"): Result<URL, CfPasteError> {
	if (raw === undefined || raw.trim() === "") {
		return failure(new CfPasteError("configuration", `${label} must be configured for the CF Paste extension`));
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch (cause) {
		return failure(new CfPasteError("configuration", `${label} is not a valid URL`, cause));
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
		return failure(new CfPasteError("configuration", `${label} must be an HTTPS origin without credentials, path, query, or fragment`));
	}
	return success(url);
}
