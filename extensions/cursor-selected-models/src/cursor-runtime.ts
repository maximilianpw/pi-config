import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonlLocalAgentStore, type SDKAgent } from "@cursor/sdk";
import type { CursorRuntime } from "./cursor-stream.js";

const ABORT_CLEANUP_TIMEOUT_MS = 1_000;

function abortError(): DOMException {
	return new DOMException("Cursor run aborted", "AbortError");
}

function warn(message: string): void {
	process.emitWarning(message, { code: "PI_CURSOR_GROK" });
}

export function raceWithAbort<T>(
	operation: Promise<T>,
	signal: AbortSignal | undefined,
	onAbort: () => void | Promise<void>,
): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) {
		void Promise.resolve().then(onAbort).catch(() => warn("Cursor cancellation failed"));
		return Promise.reject(abortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", handleAbort);
			action();
		};
		const handleAbort = () => {
			void Promise.resolve().then(onAbort).catch(() => warn("Cursor cancellation failed"));
			finish(() => reject(abortError()));
		};
		signal.addEventListener("abort", handleAbort, { once: true });
		operation.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

async function disposeAgent(agent: SDKAgent | undefined, aborted: boolean): Promise<void> {
	if (!agent) return;
	const disposal = agent[Symbol.asyncDispose]();
	if (!aborted) {
		await disposal.catch(() => warn("Cursor agent cleanup failed"));
		return;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const outcome = await Promise.race([
		disposal.then(() => "done" as const, () => "failed" as const),
		new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), ABORT_CLEANUP_TIMEOUT_MS);
			timer.unref?.();
		}),
	]);
	if (timer) clearTimeout(timer);
	if (outcome === "failed") warn("Cursor agent cleanup failed after abort");
	if (outcome === "timeout") warn("Cursor agent cleanup timed out after abort");
}

async function removeStateDirectory(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true }).catch(() => {
		warn(`Cursor temporary state cleanup failed: ${path}`);
	});
}

export const cursorSdkRuntime: CursorRuntime = {
	async run(request) {
		const stateDir = await mkdtemp(join(tmpdir(), "pi-cursor-grok-"));
		let agent: SDKAgent | undefined;
		let aborted = request.signal?.aborted ?? false;

		try {
			request.signal?.throwIfAborted();
			agent = await Agent.create({
				apiKey: request.apiKey,
				model: request.model,
				name: "Pi Grok 4.6",
				local: {
					cwd: request.cwd,
					store: new JsonlLocalAgentStore(stateDir),
					autoReview: true,
				},
			});
			request.signal?.throwIfAborted();
			const run = await raceWithAbort(
				agent.send(request.prompt, {
					model: request.model,
					onDelta: ({ update }) => request.onDelta(update),
				}),
				request.signal,
				() => agent?.close(),
			);
			return await raceWithAbort(run.wait(), request.signal, () => run.cancel());
		} catch (error) {
			aborted = request.signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
			throw error;
		} finally {
			await disposeAgent(agent, aborted);
			await removeStateDirectory(stateDir);
		}
	},
};
