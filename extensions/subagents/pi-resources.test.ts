import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type ProviderConfig,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiChildResources } from "./src/backends/pi-resources.ts";

async function withChildSession(
  script: string,
  check: (session: AgentSession, cwd: string) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-child-resources-"));
  const agentDir = join(cwd, ".agent");
  let session: AgentSession | undefined;
  try {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      defaultTools: ["+codemode", "+tool_search"],
      enableInstallTelemetry: false,
      cacheWarming: "off",
    }));
    // If MCP were loaded, this invalid local server would attempt to connect.
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({
      mcpServers: {
        computer: { command: "pi-test-mcp-must-not-start", exposure: "direct" },
        executor: { command: "pi-test-mcp-must-not-start" },
      },
    }));
    await copyFile(
      new URL("../safety-guard.ts", import.meta.url),
      join(agentDir, "extensions", "safety-guard.ts"),
    );
    const { loader, settingsManager, excludeTools } = await createPiChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(!loader.getExtensions().extensions.some((extension) => extension.commands.has("mcp")));

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    let requestCount = 0;
    const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = (model) => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: requestCount++ === 0 ? "toolUse" : "stop",
        message: {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: requestCount === 1
            ? [{ type: "toolCall", id: "codemode-test", name: "codemode", arguments: { code: script } }]
            : [{ type: "text", text: "done" }],
          stopReason: requestCount === 1 ? "toolUse" : "stop",
          timestamp: Date.now(),
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
      return stream;
    };
    modelRuntime.registerProvider("test-pi-child", {
      api: "openai-responses",
      baseUrl: "https://pi-child-provider.invalid",
      apiKey: "test-key",
      streamSimple,
      models: [{
        id: "test-model", name: "Test model", reasoning: false,
        input: ["text"], contextWindow: 128_000, maxTokens: 1_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
    const model = modelRuntime.getModel("test-pi-child", "test-model");
    assert.ok(model);
    const forbiddenTools: ToolDefinition[] = excludeTools.map((name, index) => ({
      name,
      label: name,
      description: "Must not be callable by children",
      // Cover both indirectly callable exposures and normal direct tools.
      exposure: index % 3 === 0 ? "codemode" : index % 3 === 1 ? "deferred" : "direct",
      parameters: Type.Object({}),
      execute: async () => { throw new Error(`Excluded tool executed: ${name}`); },
    }));
    ({ session } = await createAgentSession({
      cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      excludeTools,
      customTools: forbiddenTools,
    }));
    await session.bindExtensions({ mode: "print" });
    await check(session, cwd);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

function codemodeOutput(session: AgentSession): string {
  const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, false);
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

test("Pi children load codemode and tool search without inheriting MCP servers", async () => {
  await withChildSession('return await tools.read({path: "sample.txt"});', async (session, cwd) => {
    await writeFile(join(cwd, "sample.txt"), "child codemode works");
    assert.ok(session.getActiveToolNames().includes("codemode"));
    assert.ok(session.getActiveToolNames().includes("tool_search"));
    assert.ok(!session.getAllTools().some((tool) => tool.name.startsWith("mcp__")));
    await session.prompt("Read the sample through codemode");
    assert.match(codemodeOutput(session), /child codemode works/);
  });
});

test("Pi child exclusions apply to direct, deferred, and codemode tools", async () => {
  const excluded = ["subagent_spawn", "subagent_wait", "subagent_cancel", "subagent_check", "subagent_list", "ask_user"];
  await withChildSession(`return ${JSON.stringify(excluded)}.map(name => ({name, available: name in tools}));`, async (session) => {
    for (const name of excluded) {
      assert.ok(!session.getAllTools().some((tool) => tool.name === name), name);
      assert.ok(!session.getCallableToolNames().includes(name), name);
    }
    await session.prompt("Check excluded tool availability");
    const output = codemodeOutput(session);
    for (const name of excluded) assert.ok(output.includes(`"name":"${name}","available":false`), output);
  });
});

test("Pi child codemode cannot call an excluded tool", async () => {
  await withChildSession('try { await tools.ask_user({}); return "unexpected execution"; } catch (error) { return error.message; }', async (session) => {
    await session.prompt("Try an excluded tool");
    const output = codemodeOutput(session);
    assert.match(output, /ask_user/);
    assert.doesNotMatch(output, /unexpected execution|Excluded tool executed/);
  });
});

test("Pi child codemode nested calls still pass through safety guards", async () => {
  await withChildSession('try { await tools.write({path: ".env", content: "not-a-secret"}); return "unexpected write"; } catch (error) { return error.message; }', async (session) => {
    await session.prompt("Try writing a protected path through codemode");
    assert.match(codemodeOutput(session), /Blocked write to protected path/);
    assert.doesNotMatch(codemodeOutput(session), /unexpected write/);
  });
});
