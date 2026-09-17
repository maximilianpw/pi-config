import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { installModelFreeFooter } from "../extensions/model-free-footer.ts";

type FooterFactory = Exclude<Parameters<ExtensionContext["ui"]["setFooter"]>[0], undefined>;

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
} as unknown as Theme;

function context() {
  return {
    cwd: "/Users/max/pi-config",
    mode: "tui",
    model: { id: "gpt-5.6-luna", contextWindow: 272_000 },
    getContextUsage() {
      return { tokens: 8_300, contextWindow: 272_000, percent: 3.1 };
    },
    sessionManager: {
      getSessionName() {
        return undefined;
      },
      getEntries() {
        return [];
      },
    },
    ui: {},
  } as unknown as ExtensionContext;
}

const footerData = {
  getGitBranch() {
    return "main";
  },
  getExtensionStatuses() {
    return new Map([["quota", "quota 58% · 2/2 ready MCP 0/1"]]);
  },
  getAvailableProviderCount() {
    return 2;
  },
  onBranchChange() {
    return () => {};
  },
} satisfies ReadonlyFooterDataProvider;

test("lines up extension statuses on the left and usage on the right", () => {
  let factory: FooterFactory | undefined;
  installModelFreeFooter(context(), (next) => {
    factory = next;
  });

  assert.ok(factory);
  const component = factory(
    { requestRender() {} } as never,
    plainTheme,
    footerData,
  );
  const lines = component.render(100);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.length, 100);
  assert.match(lines[0] ?? "", /^quota 58% · 2\/2 ready MCP 0\/1 +3\.1%\/272k \(auto\)$/);
});
