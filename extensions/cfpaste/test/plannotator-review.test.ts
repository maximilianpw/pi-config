import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import test from "node:test";

import { createPlannotatorReviewer, type ProcessExecutor } from "../plannotator-review.ts";

test("file review uses a protected temporary copy and uploads result-file bytes only after approval", async () => {
	const original = new TextEncoder().encode("# Original\n");
	const revised = "# Reviewed\n";
	const executor: ProcessExecutor = {
		async execute(command, args) {
			assert.equal(command, "plannotator");
			assert.deepEqual(args.slice(0, 1), ["annotate"]);
			assert.deepEqual(args.slice(2), ["--gate", "--json", "--require-approval", "--result-file", args[6]]);
			assert.deepEqual([...await readFile(args[1] ?? "")], [...original]);
			assert.equal((await stat(args[1] ?? "")).mode & 0o777, 0o600);
			await writeFile(args[6] ?? "", revised, { flag: "wx", mode: 0o600 });
			return { stdout: JSON.stringify({ decision: "approved", feedback: "Optional note" }), code: 0 };
		},
	};
	const result = await createPlannotatorReviewer(executor).reviewFile(original);
	assert.deepEqual(result, { ok: true, value: { decision: "approved", markdown: revised, approvalNotes: "Optional note" } });
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
