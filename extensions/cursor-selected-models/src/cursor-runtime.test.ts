import assert from "node:assert/strict";
import test from "node:test";
import { raceWithAbort } from "./cursor-runtime.js";

test("abort rejects promptly and invokes Cursor cancellation", async () => {
	const controller = new AbortController();
	let cancelCount = 0;
	const operation = new Promise<string>(() => {});
	const result = raceWithAbort(operation, controller.signal, () => {
		cancelCount += 1;
	});

	controller.abort();
	await assert.rejects(result, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
	await Promise.resolve();
	assert.equal(cancelCount, 1);
});
