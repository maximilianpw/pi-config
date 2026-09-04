import test from "node:test";
import assert from "node:assert/strict";
import { ok, type Result } from "../result.ts";
import {
	projectFetchPageResultToPiToolResult,
	type ToolOutputStore,
	type ToolOutputStoreError,
} from "../tool-output.ts";
import { parsePublicHttpUrl } from "../types.ts";

class RecordingToolOutputStore implements ToolOutputStore {
	readonly writes: Array<{ readonly prefix: string; readonly fileName: string; readonly content: string }> = [];

	constructor(private readonly outputPath: string) {}

	async writeTextFile(
		prefix: string,
		fileName: string,
		content: string,
	): Promise<Result<string, ToolOutputStoreError>> {
		this.writes.push({ prefix, fileName, content });
		return ok(this.outputPath);
	}
}

test("projectFetchPageResultToPiToolResult truncates and records full output path", async () => {
	const url = parsePublicHttpUrl("https://example.com/");
	assert.equal(url._tag, "ok");
	const store = new RecordingToolOutputStore("/tmp/full-output.txt");
	const text = Array.from({ length: 3_000 }, (_, index) => `Documentation line ${index + 1}`).join("\n");

	const result = await projectFetchPageResultToPiToolResult(
		{
			_tag: "Text",
			requestedUrl: url.value,
			finalUrl: url.value,
			format: "markdown",
			status: 200,
			mime: "text/markdown",
			contentType: "text/markdown; charset=utf-8",
			charset: "utf-8",
			decoder: "utf-8",
			bytes: Buffer.byteLength(text),
			text,
		},
		store,
	);

	assert.equal(result._tag, "ok");
	assert.equal(result.value.details.truncated, true);
	assert.equal(result.value.details.fullOutputPath, "/tmp/full-output.txt");
	assert.match(result.value.content[0]?.type === "text" ? result.value.content[0].text : "", /Output truncated/);
	assert.equal(store.writes.length, 1);
	assert.equal(store.writes[0]?.prefix, "pi-webfetch-");
});
