import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import test from "node:test";

import { createPlannotatorReviewer, type ProcessExecutor } from "../plannotator-review.ts";

test("file review uploads the exact protected source bytes instead of result-file decision JSON", async () => {
	const original = new TextEncoder().encode("# Original\n");
	const executor: ProcessExecutor = {
		async execute(command, args) {
			assert.equal(command, "plannotator");
			assert.deepEqual(args.slice(0, 1), ["annotate"]);
			assert.deepEqual(args.slice(2), ["--gate", "--json", "--require-approval", "--result-file", args[6]]);
			assert.deepEqual([...await readFile(args[1] ?? "")], [...original]);
			assert.equal((await stat(args[1] ?? "")).mode & 0o777, 0o600);
			await writeFile(args[6] ?? "", JSON.stringify({ decision: "approved", feedback: "Optional note" }), { flag: "wx", mode: 0o600 });
			original.fill(0x58);
			return { stdout: JSON.stringify({ decision: "approved", feedback: "Optional note" }), code: 0 };
		},
	};
	const result = await createPlannotatorReviewer(executor).reviewFile(original);
	assert.deepEqual(result, { ok: true, value: { decision: "approved", markdown: "# Original\n", approvalNotes: "Optional note" } });
});

test("file review returns strict non-approval decisions without Markdown", async () => {
	const annotated = await createPlannotatorReviewer({
		async execute() { return { stdout: JSON.stringify({ decision: "annotated", feedback: "Revise it." }), code: 1 }; },
	}).reviewFile(new TextEncoder().encode("# Source\n"));
	assert.deepEqual(annotated, { ok: true, value: { decision: "annotated", feedback: "Revise it." } });

	const dismissed = await createPlannotatorReviewer({
		async execute() { return { stdout: JSON.stringify({ decision: "dismissed" }), code: 1 }; },
	}).reviewFile(new TextEncoder().encode("# Source\n"));
	assert.deepEqual(dismissed, { ok: true, value: { decision: "dismissed" } });
});

test("file review rejects decision and exit-status inconsistencies", async () => {
	for (const process of [
		{ stdout: JSON.stringify({ decision: "approved" }), code: 1 },
		{ stdout: JSON.stringify({ decision: "annotated", feedback: "Revise it." }), code: 0 },
		{ stdout: JSON.stringify({ decision: "dismissed" }), code: 0 },
		{ stdout: JSON.stringify({ decision: "dismissed" }), code: 143 },
	]) {
		const result = await createPlannotatorReviewer({ async execute() { return process; } }).reviewFile(new TextEncoder().encode("# Source\n"));
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.reason, "invalid-response");
	}
});

test("file review fails closed on startup failure, malformed output, and cancellation", async () => {
	const startupFailure = await createPlannotatorReviewer({
		async execute() { return { stdout: "", code: 2 }; },
	}).reviewFile(new TextEncoder().encode("# Source\n"));
	assert.equal(startupFailure.ok, false);
	if (!startupFailure.ok) assert.equal(startupFailure.error.reason, "rejected-response");

	const malformed = await createPlannotatorReviewer({
		async execute() { return { stdout: "not json", code: 0 }; },
	}).reviewFile(new TextEncoder().encode("# Source\n"));
	assert.equal(malformed.ok, false);
	if (!malformed.ok) assert.equal(malformed.error.reason, "invalid-response");

	const cancellation = await createPlannotatorReviewer({
		async execute() { throw new DOMException("The operation was aborted", "AbortError"); },
	}).reviewFile(new TextEncoder().encode("# Source\n"));
	assert.equal(cancellation.ok, false);
	if (!cancellation.ok) assert.equal(cancellation.error.reason, "rejected-response");

	const controller = new AbortController();
	const ignoredCancellation = await createPlannotatorReviewer({
		async execute(_command, args) {
			await writeFile(args[6] ?? "", JSON.stringify({ decision: "approved" }), { flag: "wx", mode: 0o600 });
			controller.abort();
			return { stdout: JSON.stringify({ decision: "approved" }), code: 0 };
		},
	}).reviewFile(new TextEncoder().encode("# Source\n"), controller.signal);
	assert.equal(ignoredCancellation.ok, false);
	if (!ignoredCancellation.ok) assert.equal(ignoredCancellation.error.reason, "rejected-response");
});

test("latest review sends exact bytes through annotate-last stdin and parses annotations structurally", async () => {
	const markdown = "Paragraph with trailing space  \n";
	const executor: ProcessExecutor = {
		async execute(command, args, options) {
			assert.equal(command, "plannotator");
			assert.deepEqual(args, ["annotate-last", "--stdin", "--gate", "--json"]);
			assert.equal(new TextDecoder().decode(options.input), markdown);
			return { stdout: JSON.stringify({ decision: "annotated", feedback: "Please clarify the second sentence." }), code: 1 };
		},
	};
	const result = await createPlannotatorReviewer(executor).reviewLatest(markdown);
	assert.deepEqual(result, { ok: true, value: { decision: "annotated", feedback: "Please clarify the second sentence." } });
});

test("latest review rejects an approved decision with a nonzero exit", async () => {
	const result = await createPlannotatorReviewer({
		async execute() { return { stdout: JSON.stringify({ decision: "approved" }), code: 1 }; },
	}).reviewLatest("# Source\n");
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.reason, "invalid-response");
});

test("latest review rejects approval after cancellation", async () => {
	const controller = new AbortController();
	const result = await createPlannotatorReviewer({
		async execute() {
			controller.abort();
			return { stdout: JSON.stringify({ decision: "approved" }), code: 0 };
		},
	}).reviewLatest("# Source\n", controller.signal);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.reason, "rejected-response");
});
