import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, UIPromptKind } from "@earendil-works/pi-coding-agent";

// OSC 7501 Program Status Protocol: https://www.superlogical.com/rex/docs/build/program-status
type ProgramState = "idle" | "working" | "done" | "blocked" | "error" | "clear";
type BlockedKind = "permission" | "question";
type RunOutcome = "completed" | "aborted" | "error";

const APP = "pi";
const MAX_MESSAGE_CHARS = 200;

export interface ProgramStatusOptions {
  write?: (sequence: string) => void;
}

function encodeMessage(text: string) {
  const singleLine = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  const clipped =
    singleLine.length > MAX_MESSAGE_CHARS ? `${singleLine.slice(0, MAX_MESSAGE_CHARS - 1)}…` : singleLine;
  return Buffer.from(clipped, "utf8").toString("base64");
}

export function programStatusSequence(state: ProgramState, details: { kind?: BlockedKind; msg?: string } = {}) {
  const pairs = [`state=${state}`];
  if (state !== "clear") pairs.push(`app=${APP}`);
  if (state === "blocked" && details.kind) pairs.push(`kind=${details.kind}`);
  const msg = details.msg === undefined ? undefined : encodeMessage(details.msg);
  if (msg) pairs.push(`msg=${msg}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

function blockedKind(prompt: UIPromptKind): BlockedKind {
  return prompt === "confirm" || prompt === "select" ? "permission" : "question";
}

function runOutcome(messages: AgentMessage[]): { outcome: RunOutcome; errorMessage?: string } {
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  if (last?.stopReason === "aborted") return { outcome: "aborted" };
  if (last?.stopReason === "error") return { outcome: "error", errorMessage: last.errorMessage };
  return { outcome: "completed" };
}

export function createProgramStatus(options: ProgramStatusOptions = {}) {
  const write =
    options.write ??
    ((sequence: string) => {
      if (process.stdout.isTTY) process.stdout.write(sequence);
    });

  return function programStatus(pi: ExtensionAPI) {
    let enabled = false;
    let agentActive = false;
    let finished: ReturnType<typeof runOutcome> | undefined;
    let prompt: { kind: UIPromptKind; title?: string } | undefined;
    let questionCount = 0;
    let questionLabel: string | undefined;
    let lastSequence: string | undefined;

    function currentSequence() {
      if (questionCount > 0) return programStatusSequence("blocked", { kind: "question", msg: questionLabel });
      if (prompt) return programStatusSequence("blocked", { kind: blockedKind(prompt.kind), msg: prompt.title });
      if (agentActive) return programStatusSequence("working");
      if (finished?.outcome === "completed") return programStatusSequence("done");
      if (finished?.outcome === "error") return programStatusSequence("error", { msg: finished.errorMessage });
      return programStatusSequence("idle");
    }

    function publish() {
      if (!enabled) return;
      const sequence = currentSequence();
      if (sequence === lastSequence) return;
      lastSequence = sequence;
      write(sequence);
    }

    // ask_user emits this alongside its ui_prompt events; it is the only source of the question text.
    pi.events.on("herdr:blocked", (data) => {
      const event = data as { active?: boolean; label?: string } | undefined;
      if (event?.active) {
        questionCount += 1;
        questionLabel = event.label;
      } else {
        questionCount = Math.max(0, questionCount - 1);
        if (questionCount === 0) questionLabel = undefined;
      }
      publish();
    });

    pi.on("session_start", (_event, ctx) => {
      // RPC mode reports hasUI=true without owning a terminal, so only the TUI may write escapes.
      if (ctx.mode !== "tui") return;
      enabled = true;
      lastSequence = undefined;
      // A reload replaces this extension mid-run without another agent_start.
      agentActive = !ctx.isIdle();
      publish();
    });

    pi.on("agent_start", () => {
      agentActive = true;
      finished = undefined;
      publish();
    });

    pi.on("agent_end", (event) => {
      finished = runOutcome(event.messages);
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!ctx.isIdle()) return;
      agentActive = false;
      publish();
    });

    pi.on("ui_prompt_start", (event) => {
      prompt = { kind: event.kind, title: event.title };
      publish();
    });

    pi.on("ui_prompt_end", () => {
      prompt = undefined;
      publish();
    });

    pi.on("session_shutdown", (event) => {
      if (enabled && event.reason === "quit") write(programStatusSequence("clear"));
      enabled = false;
    });
  };
}

export default createProgramStatus();
