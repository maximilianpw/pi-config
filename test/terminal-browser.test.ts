import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrowserSession,
  declaresReadOnly,
  secretFileArgument,
  type BrowserCall,
  type TerminalBrowserRun,
} from "../extensions/terminal-browser.ts";

type Responder = (args: readonly string[]) => Partial<TerminalBrowserRun>;

function fakeBrowser(respond: Responder = () => ({})) {
  const calls: string[][] = [];
  const session = new BrowserSession(async (args) => {
    calls.push([...args]);
    return { stdout: "", stderr: "", code: 0, ...respond(args) };
  });
  return { session, calls };
}

function call(command: readonly string[], overrides: Partial<BrowserCall> = {}): BrowserCall {
  return { command, cwd: "/work/app", confirm: async () => undefined, ...overrides };
}

const opensKey: Responder = (args) => (args[0] === "open" ? { stdout: "opened 77-1 (terminal-browser ls for details)" } : {});

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n");
}

test("the first open splits a pane and later commands target that browser", async () => {
  const { session, calls } = fakeBrowser(opensKey);
  await session.execute(call(["open", "localhost:3000"]));
  await session.execute(call(["snapshot", "-i"]));
  await session.execute(call(["open", "localhost:3000/settings"]));

  assert.deepEqual(calls, [
    ["open", "localhost:3000", "--split", "right", "--size", "0.5"],
    ["action", "--browser", "77-1", "--", "snapshot", "-i"],
    ["action", "--browser", "77-1", "--", "open", "localhost:3000/settings"],
  ]);
});

test("commands without a browser explain how to start or adopt one", async () => {
  const { session } = fakeBrowser((args) => (args[0] === "ls" ? { stdout: "2681-1 http://localhost:1337/" } : {}));
  await assert.rejects(session.execute(call(["snapshot"])), /no browser yet[\s\S]*2681-1 http:\/\/localhost:1337\//);
});

test("an adopted browser is used for the rest of the session", async () => {
  const { session, calls } = fakeBrowser();
  await session.execute(call(["get", "url"], { browser: "2681-1" }));
  await session.execute(call(["snapshot"]));
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ["action", "--browser", "2681-1"],
    ["action", "--browser", "2681-1"],
  ]);
});

test("a closed pane is forgotten, and open starts a new one", async () => {
  let closed = false;
  const { session, calls } = fakeBrowser((args) => {
    if (args[0] === "open") return { stdout: closed ? "opened 77-2" : "opened 77-1" };
    if (closed && args[2] === "77-1") return { code: 1, stderr: "terminal-browser: no browser 77-1" };
    return {};
  });
  await session.execute(call(["open", "example.com"]));
  closed = true;
  await assert.rejects(session.execute(call(["snapshot"])), /was closed/);
  await session.execute(call(["open", "example.com"]));
  assert.equal(session.browserKey, "77-2");
  assert.deepEqual(calls.at(-1), ["open", "example.com", "--split", "right", "--size", "0.5"]);
});

test("screenshots come back as images, and generated files are deleted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-shot-"));
  const generated = join(directory, "shot-1.png");
  writeFileSync(generated, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { session } = fakeBrowser((args) => {
    if (args[0] === "open") return { stdout: "opened 77-1" };
    return { stdout: `✓ Screenshot saved to ${generated}` };
  });
  await session.execute(call(["open", "example.com"]));
  const result = await session.execute(call(["screenshot", "--full"]));

  const image = result.content.find((block) => block.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  assert.equal(existsSync(generated), false);

  const kept = join(directory, "kept.png");
  writeFileSync(kept, "png");
  const { session: second } = fakeBrowser((args) =>
    args[0] === "open" ? { stdout: "opened 77-1" } : { stdout: `✓ Screenshot saved to ${kept}` },
  );
  await second.execute(call(["open", "example.com"]));
  await second.execute(call(["screenshot", kept]));
  assert.equal(existsSync(kept), true);
});

test("secret files are never uploaded or sent as parameters", async () => {
  assert.deepEqual(secretFileArgument(["upload", "@e4", ".env"], "/work/app"), { path: ".env", label: ".env files" });
  assert.equal(secretFileArgument(["webmcp", "invoke", "save", "--params", "@config/.env.local"], "/work/app")?.label, ".env files");
  assert.equal(secretFileArgument(["cookies", "set", "--curl", "~/.pi/agent/auth.json"], "/work/app")?.label, "Pi auth.json");
  assert.equal(secretFileArgument(["upload", "@e4", "report.pdf"], "/work/app"), undefined);
  assert.equal(secretFileArgument(["click", "@e12"], "/work/app"), undefined);
  assert.equal(secretFileArgument(["fill", "@e3", ".env"], "/work/app"), undefined);

  const { session, calls } = fakeBrowser(opensKey);
  await session.execute(call(["open", "example.com"]));
  await assert.rejects(session.execute(call(["upload", "@e4", ".env"])), /refusing to send \.env/);
  assert.equal(calls.length, 1);
});

test("WebMCP tools run without asking only when the page declares them read-only", async () => {
  const listing = (readOnly: boolean | undefined) =>
    JSON.stringify({ data: { tools: [{ name: "search", annotations: readOnly === undefined ? {} : { readOnlyHint: readOnly } }] } });
  assert.equal(declaresReadOnly(listing(true), "search"), true);
  assert.equal(declaresReadOnly(listing(false), "search"), false);
  assert.equal(declaresReadOnly(listing(undefined), "search"), false);
  assert.equal(declaresReadOnly("not json", "search"), false);

  const prompts: string[] = [];
  const { session, calls } = fakeBrowser((args) => {
    if (args[0] === "open") return { stdout: "opened 77-1" };
    if (args.includes("list")) return { stdout: listing(false) };
    return { stdout: "{}" };
  });
  await session.execute(call(["open", "shop.example"]));
  const invoke = ["webmcp", "invoke", "search", "--params", '{"query":"x"}'];

  await assert.rejects(session.execute(call(invoke)), /did not approve/);
  assert.equal(calls.filter((args) => args.includes("invoke")).length, 0);

  await session.execute(call(invoke, { confirm: async (_title, message) => (prompts.push(message), true) }));
  assert.equal(calls.filter((args) => args.includes("invoke")).length, 1);
  assert.match(prompts[0] ?? "", /"search" may change data/);
});

test("the agent-control indicator is cleared once after the agent acted", async () => {
  const { session, calls } = fakeBrowser(opensKey);
  await session.release("/work/app");
  await session.execute(call(["open", "example.com"]));
  await session.release("/work/app");
  assert.equal(calls.some((args) => args.at(-1) === "done"), false);

  await session.execute(call(["click", "@e1"]));
  await session.release("/work/app");
  await session.release("/work/app");
  assert.deepEqual(calls.filter((args) => args.at(-1) === "done"), [["action", "--browser", "77-1", "done"]]);
});

test("long output is truncated with a hint to narrow it", async () => {
  const huge = Array.from({ length: 5000 }, (_, index) => `- link "item ${index}" [ref=e${index}]`).join("\n");
  const { session } = fakeBrowser((args) => (args[0] === "open" ? { stdout: "opened 77-1" } : { stdout: huge }));
  await session.execute(call(["open", "example.com"]));
  const result = await session.execute(call(["snapshot"]));
  assert.equal(result.details.truncated, true);
  assert.match(text(result), /Narrow it with snapshot -i/);
});
