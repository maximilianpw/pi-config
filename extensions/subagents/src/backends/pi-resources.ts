import {
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Tools that headless children must not receive, including through codemode. */
const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "ask_user",
];

/**
 * Load normal global/package and trust-gated project resources for a Pi child.
 * SDK sessions opt into built-ins explicitly. MCP is intentionally not loaded:
 * children must not inherit the parent's computer or remote-executor access.
 */
export async function createPiChildResources(options: {
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
}) {
  const { cwd, projectTrusted } = options;
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      {
        name: "codemode",
        builtin: true,
        replaceable: true,
        factory: createCodemodeExtension(),
      },
      {
        name: "tool-search",
        builtin: true,
        replaceable: true,
        factory: createToolSearchExtension(),
      },
    ],
  });
  await loader.reload();
  return {
    loader,
    settingsManager,
    excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES],
  };
}
