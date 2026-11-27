import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import rexTransfer, {
  TRANSFER_NOTE_ENV,
  piRexSidecarPath,
  removePiRexSidecar,
  writePiRexSidecar,
  type PiRexSidecar,
} from "../extensions/rex-transfer.ts";

const BLOCK = "block:01a21c84-0dda-774b-8e36-5b9471320ff9";

function sidecar(pid: number): PiRexSidecar {
  return {
    agent: "pi",
    session_id: "s1",
    session_file: "/sessions/s1.jsonl",
    cwd: "/work/app",
    pid,
    rex_block: BLOCK,
    updated_at: "2026-11-27T00:00:00.000Z",
  };
}

test("sidecars live under XDG_STATE_HOME, named by the block uuid, as pi_sidecar.lua expects", () => {
  const env = { XDG_STATE_HOME: "/state" };
  assert.equal(piRexSidecarPath(BLOCK, env), "/state/pi-rex/blocks/01a21c84-0dda-774b-8e36-5b9471320ff9.json");
});

test("a sidecar is removed only by the pi process that wrote it", () => {
  const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "rex-transfer-")) };
  const path = writePiRexSidecar(sidecar(100), env);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).session_file, "/sessions/s1.jsonl");

  removePiRexSidecar(BLOCK, 200, env);
  assert.equal(existsSync(path), true);
  removePiRexSidecar(BLOCK, 100, env);
  assert.equal(existsSync(path), false);
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(env: Record<string, string | undefined>) {
  const saved = { REX_BLOCK: process.env.REX_BLOCK, [TRANSFER_NOTE_ENV]: process.env[TRANSFER_NOTE_ENV] };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const execs: Array<{ command: string; args: string[] }> = [];
  const messages: unknown[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, options),
    exec: async (command: string, args: string[]) => (execs.push({ command, args }), { code: 0, stdout: "", stderr: "" }),
    sendMessage: (message: unknown) => messages.push(message),
  };
  try {
    rexTransfer(pi as never);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { handlers, commands, execs, messages };
}

test("outside Rex the extension registers nothing", () => {
  const { handlers, commands } = load({ REX_BLOCK: undefined });
  assert.equal(handlers.size, 0);
  assert.equal(commands.size, 0);
});

test("/transfer runs the Rex action for this pane, with the host when given", async () => {
  const state = mkdtempSync(join(tmpdir(), "rex-transfer-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  try {
    const { commands, execs } = load({ REX_BLOCK: BLOCK });
    const ctx = {
      waitForIdle: async () => undefined,
      cwd: "/work/app",
      sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/sessions/s1.jsonl" },
      ui: { notify: () => undefined },
    };
    await commands.get("transfer")?.handler(" kim ", ctx);
    await commands.get("transfer")?.handler("", ctx);
    assert.deepEqual(execs.map((exec) => exec.args), [
      ["do", "transfer_pi_session", `block_id=${BLOCK}`, "host=kim"],
      ["do", "transfer_pi_session", `block_id=${BLOCK}`],
    ]);
    assert.equal(existsSync(piRexSidecarPath(BLOCK)), true);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});
