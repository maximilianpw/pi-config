import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

async function writeTempPrompt(text: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-minimal-subagent-"));
	const file = path.join(dir, "system-prompt.md");
	await fs.promises.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
	return { dir, file };
}

function finalTextFromMessage(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmuxHasSession(sessionName: string): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const proc = spawn("tmux", ["-L", "pi-subagents", "has-session", "-t", sessionName], { stdio: "ignore" });
		proc.on("close", (code) => resolve(code === 0));
		proc.on("error", () => resolve(false));
	});
}

async function runSubagent(params: {
	task: string;
	systemPrompt?: string;
	model?: string;
	tools?: string[];
	cwd: string;
	signal?: AbortSignal;
}): Promise<{ output: string; stderr: string; exitCode: number; sessionName?: string }> {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (params.model) args.push("--model", params.model);
	if (params.tools && params.tools.length > 0) args.push("--tools", params.tools.join(","));

	let tmp: { dir: string; file: string } | undefined;
	let sessionName: string | undefined;
	try {
		const systemPrompt = [
			"You are a delegated Pi subagent running in an isolated context.",
			"Complete the task independently. Return only the final result that the parent agent needs.",
			params.systemPrompt?.trim() ? `\nAdditional instructions:\n${params.systemPrompt.trim()}` : "",
		]
			.filter(Boolean)
			.join("\n");
		tmp = await writeTempPrompt(systemPrompt);
		args.push("--append-system-prompt", tmp.file, params.task);

		const invocation = getPiInvocation(args);
		const stdoutFile = path.join(tmp.dir, "stdout.jsonl");
		const stderrFile = path.join(tmp.dir, "stderr.log");
		const exitFile = path.join(tmp.dir, "exit-code");
		const runnerFile = path.join(tmp.dir, "run-subagent.sh");
		sessionName = `pi-subagent-${process.pid}-${Date.now().toString(36)}`;

		const command = [invocation.command, ...invocation.args].map(shellQuote).join(" ");
		await fs.promises.writeFile(
			runnerFile,
			[
				"#!/usr/bin/env bash",
				"set +e",
				`cd ${shellQuote(params.cwd)}`,
				`echo "Pi subagent running in tmux session: ${sessionName}" >&2`,
				`echo "Attach with: tmux -L pi-subagents attach -t ${sessionName}" >&2`,
				`${command} > >(tee ${shellQuote(stdoutFile)}) 2> >(tee ${shellQuote(stderrFile)} >&2)`,
				"code=$?",
				`printf '%s\\n' "$code" > ${shellQuote(exitFile)}`,
				"exit $code",
				"",
			].join("\n"),
			{ encoding: "utf8", mode: 0o700 },
		);

		let aborted = false;
		const kill = () => {
			aborted = true;
			if (sessionName) {
				spawn("tmux", ["-L", "pi-subagents", "kill-session", "-t", sessionName], { stdio: "ignore" });
			}
		};

		if (params.signal?.aborted) kill();
		else params.signal?.addEventListener("abort", kill, { once: true });

		const tmux = spawn("tmux", ["-L", "pi-subagents", "new-session", "-d", "-s", sessionName, runnerFile], {
			cwd: params.cwd,
			shell: false,
			stdio: ["ignore", "ignore", "pipe"],
		});

		let tmuxError = "";
		tmux.stderr.on("data", (data) => {
			tmuxError += data.toString();
		});

		const tmuxExitCode = await new Promise<number>((resolve) => {
			tmux.on("close", (code) => resolve(code ?? 0));
			tmux.on("error", () => resolve(1));
		});
		if (tmuxExitCode !== 0) return { output: "", stderr: tmuxError || "Failed to start tmux subagent session.", exitCode: tmuxExitCode, sessionName };

		while (!fs.existsSync(exitFile)) {
			if (aborted) throw new Error("Subagent was aborted");
			if (!(await tmuxHasSession(sessionName))) {
				const stderr = await fs.promises.readFile(stderrFile, "utf8").catch(() => "");
				return { output: "", stderr: stderr || "tmux subagent session ended before writing an exit code.", exitCode: 1, sessionName };
			}
			await sleep(250);
		}

		if (aborted) throw new Error("Subagent was aborted");

		const [stdout, stderr, exitText] = await Promise.all([
			fs.promises.readFile(stdoutFile, "utf8").catch(() => ""),
			fs.promises.readFile(stderrFile, "utf8").catch(() => ""),
			fs.promises.readFile(exitFile, "utf8").catch(() => "1"),
		]);

		let output = "";
		for (const line of stdout.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end") {
					const text = finalTextFromMessage(event.message);
					if (text) output = text;
				}
			} catch {
				// Ignore non-JSON noise.
			}
		}

		const parsedExitCode = Number.parseInt(exitText.trim(), 10);
		return { output, stderr, exitCode: Number.isNaN(parsedExitCode) ? 1 : parsedExitCode, sessionName };
	} finally {
		if (sessionName) {
			spawn("tmux", ["-L", "pi-subagents", "kill-session", "-t", sessionName], { stdio: "ignore" });
		}
		if (tmp) {
			await fs.promises.rm(tmp.dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a self-contained task to an isolated Pi subagent launched in a detached tmux session. The parent receives only the final answer, not intermediate context. Defaults to read-only tools; pass tools explicitly for edit/bash/write access.",
		promptSnippet: "Delegate self-contained research or implementation subtasks to an isolated Pi subagent",
		promptGuidelines: [
			"Use subagent for self-contained tasks where only the final result is needed and intermediate context would be noisy.",
			"Subagents run in detached tmux sessions on the pi-subagents socket while active.",
			"The subagent tool defaults to read-only access; pass tools explicitly when the delegated task needs bash, edit, or write.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete task for the isolated subagent." }),
			systemPrompt: Type.Optional(Type.String({ description: "Optional extra instructions for the subagent." })),
			model: Type.Optional(Type.String({ description: "Optional Pi model id for the subagent." })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Tools to enable for the subagent. Defaults to ["read"]. Use e.g. ["read", "bash"] or ["read", "edit", "write", "bash"].',
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent. Defaults to the current Pi cwd." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runSubagent({
				task: params.task,
				systemPrompt: params.systemPrompt,
				model: params.model,
				tools: params.tools ?? ["read"],
				cwd: params.cwd ?? ctx.cwd,
				signal,
			});

			if (result.exitCode !== 0) {
				return {
					isError: true,
					content: [{ type: "text", text: result.stderr || `Subagent exited with code ${result.exitCode}.` }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: result.output || "(subagent produced no final text)" }],
				details: result,
			};
		},
	});
}
