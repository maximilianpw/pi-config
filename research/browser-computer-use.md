# Projects to adapt for Pi browser / computer use

Researched 2026-09-10 against official repositories, LICENSE files, documentation, and selected source files. Sources below use mutable `main`/documentation URLs: pin a commit and matching package versions before copying. This is an architectural shortlist, **not a runtime evaluation, benchmark ranking, security audit, or production-readiness certification**. No packages were installed or provider APIs called.

## Recommendation

**Yes—copy an integration boundary, not a whole competing agent.** For browser use, compare **Stagehand's existing Pi extension** with a **thin wrapper around agent-browser**. For desktop use, adapt **UI-TARS's operator layer** or **Anthropic's isolated Linux desktop tools**, leaving Pi in charge of planning, approvals, and stopping.

1. **Closest literal “project I can copy”: Stagehand's Pi extension (MIT).** It already registers native browser tools, returns screenshot images, and manages browser lifetime. It is explicitly experimental and depends on an unpublished shared workspace package; copying its one entry point alone is insufficient. [S1–S6]
2. **Preferred separately packaged browser executor: agent-browser (Apache-2.0).** Wrap its CLI/JSON or MCP surface, use snapshots plus element references, and let Pi choose every action. Avoid its optional `chat` mode if you do not want another agent loop. [A1–A2]
3. **Browser alternative: Playwright MCP (Apache-2.0).** Particularly useful when cross-browser support and a documented MCP tool contract matter. Keep a persistent server connection; Pi needs an adapter rather than simply pasting another client's MCP config. [P1–P4, PI]
4. **Full desktop: UI-TARS operators for a TypeScript-oriented implementation; Anthropic demo for a disposable Linux desktop.** Neither should be copied wholesale onto a sensitive daily-use desktop. [U1–U4, C1–C2]

These recommendations concern fit and reusable mechanisms, not measured superiority.

## The distinction that matters

- **Tool executor:** Pi decides what to do; the backend performs a requested operation and returns state. This preserves one visible decision/approval loop. agent-browser's ordinary commands, Playwright MCP, Stagehand v4's native Pi facade, and UI-TARS's low-level operators fit this shape. [A1, P1, S2–S5, U3]
- **Model-backed primitive:** a bounded operation such as Stagehand `observe`, `act`, or `extract` may invoke an additional model without owning the whole task. It still introduces separate inference costs, credentials, and failure behavior. [S1, S5–S7]
- **Independent agent:** Browser Use `Agent.run`, UI-TARS `GUIAgent.run`, Anthropic's demo sampling loop, and Browser Use Pi `agent.run` choose multiple actions themselves. Wrapping these as one Pi tool delegates a task; it does not give the existing Pi session direct browser/desktop control. [B1, U3, C1, BP1]
- **Hosted browser ≠ hosted agent:** a remote browser can still be driven entirely by Pi. Browser Use's README explicitly separates cloud-browser hosting from its fully hosted agent API. [B1]

## Browser candidates

### vercel-labs/agent-browser

**Identity/license:** Vercel Labs' `vercel-labs/agent-browser`; Apache-2.0, verified in LICENSE (not MIT). [A1–A2]

**Architecture:** current README describes a native Rust CLI and daemon, with the principal browser path backed by CDP. It explicitly says the daemon needs neither Playwright nor Node.js. Commands reuse sessions; it also exposes an MCP stdio server. Do not describe current `main` using an older Node/Playwright-daemon architecture. [A1]

**Useful to reuse:** accessibility snapshots with `@eN` references, compact/interactive filtering, annotated screenshots, semantic selectors, waits, tabs, isolated sessions, auth-state persistence, console/network inspection, traces and diffs. JSON output and typed MCP tools provide integration surfaces without maintaining a fork of the browser engine. [A1]

**Limits/caveats:**
- Primarily browser automation, not general OS control; auxiliary Safari/iOS backends have capability gaps (e.g. annotated screenshots). Refresh references after page changes. [A1]
- Security controls are opt-in. Domain restrictions have significant incompatibilities with existing CDP sessions, profiles, restored state, and several backends. Auth-state files can contain plaintext session tokens. Browser attachment is a privileged operation. [A1]
- The current CLI includes a separate natural-language `chat` mode. Ordinary `open`/`snapshot`/`click` execution does not require that mode. [A1]

**Judgment:** strongest candidate here for a small Pi-owned tool adapter around an independently distributed executor. Copy the workflow/tool design; depend on a pinned CLI before considering a Rust fork.

### microsoft/playwright-mcp

**Identity/license:** Microsoft's `microsoft/playwright-mcp`, npm `@playwright/mcp`; Apache-2.0. [P1–P3]

**Architecture:** MCP server exposing Playwright browser operations and structured accessibility snapshots, plus optional vision/coordinate capabilities. Supports Chrome, Firefox, WebKit and Edge configuration, persistent or isolated profiles, CDP attachment, and an extension for existing browser tabs. No model-planning loop is needed inside this server. [P1]

**Useful to reuse:** explicit tool schemas, reference/selector targeting, form/dialog/upload handling, browser/network diagnostics, screenshot output and profile options. Current `index.js` delegates `createConnection` to `playwright-core/lib/coreBundle`; much of the implementation is therefore in the Playwright dependency, not a self-contained engine in this repository. [P1, P4]

**Limits/caveats:**
- README explicitly says it is **not a security boundary**. Origin filters do not cover redirects; filesystem restrictions are convenience guardrails. `browser_run_code_unsafe` is documented as host-process RCE-equivalent. Do not expose it by default without suitable isolation. [P1]
- Persistent profiles cannot be shared by concurrent browser instances; use isolated contexts or separate directories. Docker support is documented as headless Chromium only. [P1]
- README suggests Microsoft's separate CLI+skills project for coding agents. Its token-efficiency rationale is first-party advice, not a measured comparison performed here. MCP schema/snapshot overhead should be measured in Pi. [P1]
- Inspected package metadata pins alpha Playwright dependencies; source `main` should not be assumed equivalent to a selected stable release. [P3]

**Judgment:** use the server as a dependency/sidecar rather than copying the small wrapper and assuming you acquired its engine. Strong alternative for richer browser tooling and cross-browser needs.

### browser-use/browser-use

**Identity/license:** Browser Use's `browser-use/browser-use`; Python library under MIT. Paid inference/cloud services are distinct from the source license. [B1–B2]

**Architecture:** `Agent(task, llm, browser).run()` owns a task-level loop. Selected source shows an event-driven `BrowserSession`, CDP client, DOM state, screenshot support, and watchdogs for lifecycle/security/downloads and other browser concerns. Its README now also points existing agents toward a CLI in the separate `browser-use/browser-harness` repository. [B1, B3]

**Useful to reuse:** browser-state extraction, session lifecycle/reconnection patterns, custom actions, structured outputs, and task history; or deliberately delegate browser jobs to its Python agent. Local browsers and alternative model providers are documented, so Browser Use Cloud is not mandatory for the Python library. [B1, B3]

**Limits/caveats:** copying `Agent.run` into a Pi tool creates a second model loop and Python runtime dependency. Lower-level browser code can be adapted, but it is intertwined with event/session/watchdog abstractions. Cloud CAPTCHA/stealth features are not guarantees or automatically included by copying MIT source. No README benchmark scores are adopted here. [B1, B3]

**Judgment:** useful reference or explicit delegated worker; not my first choice for a small direct-control Pi extension. Do not mistakenly characterize its separately linked CLI as necessarily running the Python agent loop.

### browserbase/stagehand

**Identity/license:** Browserbase's `browserbase/stagehand`; MIT. Its trademark is separate from permission to copy source. [S1, S8]

**Architecture:** current docs are **v4**: TypeScript/Python/Go SDKs, a CDP browser driver, and runtime inside a browser extension. Provides deterministic Playwright-shaped operations and model-backed `act`/`observe`/`extract`. Local Chrome, CDP attachment and Browserbase are documented options. **v4 removed `agent()`**; old v2/v3 descriptions of its autonomous agent/CUA mode must not be applied to v4. [S1, S5–S7]

**The especially relevant code:** `packages/integrations/pi/extensions/stagehand.ts` registers `run`, `snapshot`, and `screenshot`, imports shared validators/descriptions, serializes tool execution, launches lazily, and closes resources on session shutdown. Screenshot results are image content, not just file paths. `run` accepts JavaScript or snapshot-ID actions; IDs belong to the latest active-page snapshot. [S2–S4]

**Limits/caveats:**
- Pi integration **and shared integration package** are experimental, repository-only and unpublished. Package dependencies use `workspace:*`; this is not a drop-in single-file extension. Source package has typecheck/unit-test scripts, but they were not run here. [S2–S4, S9]
- Current Pi facade tools are documented as deterministic without a separate Stagehand model call. General SDK AI primitives do use inference. The agent's Pi credentials and optional Stagehand model credentials are separate. [S2, S4–S5]
- `run` executes model-authored JavaScript in the browser extension service worker, not the Pi host process. It can nevertheless control/access the privileged browser session. Local CDP attachment defaults to loading the extension from the SDK host filesystem; do not assume arbitrary remote CDP URLs work identically. [S4, S7]
- Browserbase-only server caching and Model Gateway are not local OSS features. Current docs also flag unsupported authenticated local proxies. [S7]

**Judgment:** best literal starting point to copy/adapt for native Pi tools. Start with its integration and shared contract, not old `agent()` examples. Compare against agent-browser before accepting the larger source-build/extension-runtime dependency.

## Desktop candidates

### anthropics/anthropic-quickstarts — computer-use-demo

**Identity/license:** the official demo is a subdirectory of `anthropics/anthropic-quickstarts`, not a standalone repository called “anthropic computer use.” Root LICENSE is MIT. [C1–C2]

**Architecture:** Python reference tools and Claude API/Bedrock/Vertex sampling loop, Streamlit UI, and a Docker Linux desktop with X11/VNC. README describes screenshot/coordinate scaling and dated model-specific computer-tool schemas. [C1]

**Reuse:** disposable desktop environment, screenshot/input tool boundary, coordinate mapping, and tool-result handling. Replace or bypass the demo agent loop if Pi should control individual actions. [C1]

**Limits:** explicitly a minimal reference and beta-feature demo. README says components are weakly separated, loop and controlled desktop share a container, only one session can use it at a time, and resets may be needed. It is not native macOS/Windows desktop control. It warns about prompt injection and recommends minimal privileges, network restrictions, avoiding sensitive data and human confirmation of consequential actions. Proprietary Claude model access is not granted by the MIT license. [C1–C2]

**Judgment:** clearest bounded starting point for a disposable Linux desktop; not a production isolation architecture to copy unchanged.

### bytedance/UI-TARS-desktop

**Identity/license:** ByteDance's `bytedance/UI-TARS-desktop`, Apache-2.0. Root README covers **two projects**: Agent TARS (general multimodal CLI/Web UI agent stack) and UI-TARS Desktop (GUI application/operators). The separately linked `bytedance/UI-TARS` model repository is not the desktop application. [U1–U2]

**Architecture:** experimental TypeScript SDK separates `GUIAgent`/model inference from `Operator.screenshot()` and `Operator.execute()`. NutJS operator implements mouse, keyboard, scrolling and screenshots; browser/custom operators are also described. `GUIAgent.run` is an independent screenshot → prediction → execution loop with abort and loop-limit controls. [U3]

**Reuse:** operator interface, input execution, screenshot/DPR coordinate conversion, stop controls, and progress events—not the whole GUI application or Agent TARS orchestrator. [U3]

**Limits:**
- Quickstart documents single-monitor support and macOS Accessibility + Screen Recording permissions. A generic SDK extensibility claim is not evidence that every OS/display configuration works. [U4]
- README's “fully local processing” must not be interpreted as guaranteed local inference: quickstart configures hosted Hugging Face/Volcengine model endpoints. Screenshots/model requests may leave the machine according to deployment. [U1, U4]
- Root README advertises free remote operators, but quickstart states that service would be discontinued **2025-08-20**. Do not recommend relying on it. [U1, U4]
- Root code license does not settle model-weight, native dependency, or hosted-service terms. Confirm these for the exact operator/model artifacts you redistribute. [U2–U4]

**Judgment:** strongest desktop operator design reference here for a TypeScript Pi extension, but experimental and a larger OS-permission/native-dependency undertaking than browser use.

### openclaw/Peekaboo — native macOS alternative

Peekaboo provides a macOS CLI/menu-bar app for screenshots, accessibility inspection, and native UI actions, with structured element IDs and JSON output. Its current README requires macOS 15+, Screen Recording for capture and Accessibility for inspection/control. It documents explicit window targeting and foreground-consent distinctions. Ordinary `see`, `click`, `type`, and window/menu commands can be used without its separate `agent` loop. For a Mac-only Pi plugin, wrapping these commands is a more directly targeted starting point than adopting a cross-platform GUI agent. This is a fit judgment, not a runtime reliability claim. Root license is MIT, copyright Peter Steinberger; preserve its notices. Sources: [official README](https://github.com/openclaw/Peekaboo/blob/main/README.md), [LICENSE](https://github.com/openclaw/Peekaboo/blob/main/LICENSE).

## Additional directly relevant discovery: browser-use/browser-use-pi

Official Browser Use README links this separate **MIT** project. Its README describes Pi Mono → persistent V8 REPL → raw CDP → Chrome, with accessibility trees/screenshots, sessions, streaming and typed results. `BrowserUse.create()` / `agent.run()` builds a browser agent **on Pi** rather than merely adding tools to the user's existing Pi session. [B1, BP1–BP2]

Worth a follow-up implementation review for browser primitives and persistence, but not interchangeable with Stagehand's native extension. README explicitly says its killable worker has filesystem/network access and recommends an isolated machine; anonymous counters are enabled unless disabled. Model/API compatibility with this checkout's locked Pi version was not checked. [BP1]

## What makes the eventual plugin “good” — proposed acceptance gates

These are recommendations, not claims the projects already satisfy:

- Keep Pi's planning loop by default; make any delegated browser agent explicit, cancellable and budget-limited.
- Use DOM/accessibility references for web controls and screenshots/coordinates where structure is insufficient; re-observe after navigation or stale targets.
- Preserve one browser per Pi session, serialize state-changing actions, and handle restart, cancellation and shutdown without orphan processes.
- Return useful errors, real image content, bounded snapshots and redacted traces. Never equate a successful click with completed user intent.
- Do not automatically retry a possibly committed submission/payment. Stagehand's migration guide specifically warns that failed `act()` calls may already have caused side effects. [S5]
- Default to isolated profiles/desktops; treat imported logins, downloads, clipboard and debugging endpoints as privileged. Approval policy must live outside untrusted page content. Native Pi has neither built-in MCP nor default permission popups. [PI]
- Test realistic fixtures: SPA rerenders, iframes/shadow DOM, canvas, popups, file transfers, session restoration, cancellation, denied actions, prompt-injection attempts, and desktop DPI/focus changes. Record task outcome, erroneous actions, latency, model cost and interventions on the same tasks/models before picking a winner.

## Copying/license checklist

All six principal codebases have permissive root licenses verified directly. MIT requires retaining copyright and permission notices in copies/substantial portions. Apache-2.0 requires license/attribution preservation, change notices in modified files and applicable NOTICE propagation, and includes a conditional patent grant; it does not grant trademarks. Inspect per-file/package notices and dependencies at the pinned revision. None of these licenses makes commercial infrastructure, proprietary model access or separately licensed model weights free. [A2, P2, B2, S8, C2, U2]

## Primary sources

- **[A1]** [agent-browser README](https://github.com/vercel-labs/agent-browser/blob/main/README.md)
- **[A2]** [agent-browser LICENSE](https://github.com/vercel-labs/agent-browser/blob/main/LICENSE)
- **[P1]** [Playwright MCP README](https://github.com/microsoft/playwright-mcp/blob/main/README.md)
- **[P2]** [Playwright MCP LICENSE](https://github.com/microsoft/playwright-mcp/blob/main/LICENSE)
- **[P3]** [Playwright MCP package.json](https://github.com/microsoft/playwright-mcp/blob/main/package.json)
- **[P4]** [Playwright MCP index.js](https://github.com/microsoft/playwright-mcp/blob/main/index.js)
- **[B1]** [Browser Use README](https://github.com/browser-use/browser-use/blob/main/README.md)
- **[B2]** [Browser Use LICENSE](https://github.com/browser-use/browser-use/blob/main/LICENSE)
- **[B3]** [BrowserSession source](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/session.py) (selected opening source sections inspected)
- **[S1]** [Stagehand README](https://github.com/browserbase/stagehand/blob/main/README.md)
- **[S2]** [Stagehand Pi integration documentation](https://docs.stagehand.dev/v4/integrations/pi)
- **[S3]** [Stagehand Pi extension source](https://github.com/browserbase/stagehand/blob/main/packages/integrations/pi/extensions/stagehand.ts)
- **[S4]** [Stagehand integration contract and security boundary](https://docs.stagehand.dev/v4/integrations/overview)
- **[S5]** [Stagehand v3 → v4 migration](https://docs.stagehand.dev/v4/migrations/v3)
- **[S6]** [Stagehand Pi package.json](https://github.com/browserbase/stagehand/blob/main/packages/integrations/pi/package.json)
- **[S7]** [Stagehand browser configuration](https://docs.stagehand.dev/v4/configuration/browser)
- **[S8]** [Stagehand LICENSE](https://github.com/browserbase/stagehand/blob/main/LICENSE)
- **[S9]** [Stagehand documentation index](https://docs.stagehand.dev/llms.txt)
- **[C1]** [Anthropic computer-use-demo README](https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/README.md)
- **[C2]** [Anthropic quickstarts LICENSE](https://github.com/anthropics/anthropic-quickstarts/blob/main/LICENSE)
- **[U1]** [UI-TARS-desktop README](https://github.com/bytedance/UI-TARS-desktop/blob/main/README.md)
- **[U2]** [UI-TARS-desktop LICENSE](https://github.com/bytedance/UI-TARS-desktop/blob/main/LICENSE)
- **[U3]** [UI-TARS experimental SDK guide](https://github.com/bytedance/UI-TARS-desktop/blob/main/docs/sdk.md)
- **[U4]** [UI-TARS desktop quickstart](https://github.com/bytedance/UI-TARS-desktop/blob/main/docs/quick-start.md)
- **[BP1]** [Browser Use Pi README](https://github.com/browser-use/browser-use-pi/blob/main/README.md)
- **[BP2]** [Browser Use Pi LICENSE](https://github.com/browser-use/browser-use-pi/blob/main/LICENSE)
- **[PI]** Installed Pi 0.85.1 official README, read from `/nix/store/1wv2fgwjgw1b0fyjqfny9mdrxjaawb6b-pi-0.85.1/libexec/pi/README.md`, especially Extensions, Pi Packages and Philosophy. [Upstream counterpart](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md).
