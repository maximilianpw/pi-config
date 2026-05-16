import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object" || !("type" in block)) return "";
      if (block.type === "text" && "text" in block && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function copyWith(command: string, args: string[], text: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (chunk) => stderr += String(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with code ${code}`)));
    child.stdin.end(text);
  });
}

async function copyToClipboard(text: string) {
  const attempts: Array<[string, string[]]> = process.platform === "darwin"
    ? [["pbcopy", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];

  let lastError: unknown;
  for (const [command, args] of attempts) {
    try {
      await copyWith(command, args, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("No clipboard command found");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-all", {
    description: "Copy all previous user and assistant messages in this thread to the clipboard",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const messages = ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message)
        .filter((message) => message.role === "user" || message.role === "assistant");

      const text = messages
        .map((message) => `${message.role.toUpperCase()}:\n${textFromContent(message.content).trim()}`)
        .filter((section) => !section.endsWith(":\n"))
        .join("\n\n---\n\n");

      if (!text) {
        ctx.ui.notify("No user or assistant messages to copy", "info");
        return;
      }

      await copyToClipboard(text);
      ctx.ui.notify(`Copied ${messages.length} messages to clipboard`, "info");
    },
  });
}
