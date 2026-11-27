/**
 * Guards agent tool calls against accidental damage: writes to protected paths (`.env`, `.git`, `.jj`,
 * `node_modules`, `/nix/store`, Pi's `auth.json`), Git hook bypasses, and dangerous shell operations that
 * need the user's confirmation. It is an accident guard, not a sandbox.
 *
 * Bash commands are parsed with the shell walker shared with the Cloudflare deployment guard, so only words
 * of commands that actually run and real redirect targets decide anything. Quoted text, heredoc bodies,
 * `2>/dev/null`, and paths that are only read never trigger a block.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { protectedPathReason, secretFileLabel } from "./shared/protected-paths.ts";
import {
  createShellState,
  executableName,
  nestedShellScript,
  parseShellScript,
  walkShellProgram,
  type ShellState,
  type ShellWord,
  type SimpleShellCommand,
} from "./shared/shell-ast.ts";

type ToolInputWithPath = { path?: unknown };

/** What the guard decided about one bash command. */
export type BashInspection = {
  /** Operations that run only after the user confirms them. */
  readonly dangers: readonly string[];
  /** Why the command is blocked outright, if it is. */
  readonly blockReason: string | undefined;
  /** Whether the command runs Git, so editor-free Git variables are prepended. */
  readonly runsGit: boolean;
};

const NO_VERIFY_REASON =
  "Blocked a Git hook bypass. Fix the failing Git hook, or ask the user for help instead of bypassing it.";

/** Commands where every operand may be written, moved, or deleted. */
const OPERAND_WRITERS = new Set([
  "rm", "rmdir", "unlink", "mv", "touch", "mkdir", "chmod", "chown", "chgrp", "chflags", "truncate", "tee", "shred",
]);
/** Commands that write only their last operand. */
const DESTINATION_WRITERS = new Set(["cp", "install", "ln", "rsync", "ditto"]);
const SYSTEM_COMMANDS = new Set(["dd", "mkfs", "diskutil", "shutdown", "reboot", "halt"]);
const PRIVILEGE_WRAPPERS = new Set(["sudo", "doas"]);
const PLAIN_WRAPPERS = new Set(["command", "nohup", "exec", "time", "nice"]);
/** `git commit` short options that take the next word (or the rest of the cluster) as their value. */
const COMMIT_VALUE_LETTERS = new Set(["m", "F", "C", "c", "t"]);
const COMMIT_VALUE_OPTIONS = new Set([
  "--message", "--file", "--reuse-message", "--reedit-message", "--template", "--author", "--date",
  "--fixup", "--squash", "--trailer", "--cleanup",
]);
/** Git options that precede the subcommand and take a value. */
const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
/** Hook managers' documented skip switches. */
const HOOK_SKIP_ASSIGNMENTS: ReadonlyArray<readonly [name: string, value: string]> = [
  ["HUSKY", "0"],
  ["LEFTHOOK", "0"],
];

type CommandWords = { readonly words: readonly ShellWord[]; readonly privileged: boolean };

/** Strips `sudo`, `env VAR=value`, `timeout 60`, and similar prefixes from a command's words. */
function stripWrappers(words: readonly ShellWord[]): CommandWords {
  let rest = words;
  let privileged = false;
  while (rest.length > 0) {
    const name = rest[0]?.value === undefined ? undefined : executableName(rest[0].value);
    if (name === undefined) break;
    if (PRIVILEGE_WRAPPERS.has(name)) privileged = true;
    else if (!PLAIN_WRAPPERS.has(name) && name !== "env" && name !== "timeout") break;
    let next = 1;
    while (next < rest.length) {
      const value = rest[next]?.value;
      if (value === undefined) break;
      const isOption = value.startsWith("-");
      const isAssignment = name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
      if (!isOption && !isAssignment) break;
      next += 1;
    }
    if (name === "timeout") next += 1;
    rest = rest.slice(next);
  }
  return { words: rest, privileged };
}

function staticValues(words: readonly ShellWord[]): string[] {
  return words.flatMap((word) => (word.value === undefined ? [] : [word.value]));
}

function gitHookBypass(operands: readonly ShellWord[]): boolean {
  let index = 0;
  while (index < operands.length) {
    const value = operands[index]?.value;
    if (value === undefined || !value.startsWith("-")) break;
    if (value === "-c") {
      if (/^core\.hookspath=/i.test(operands[index + 1]?.value ?? "")) return true;
      index += 2;
    } else index += GIT_GLOBAL_VALUE_OPTIONS.has(value) ? 2 : 1;
  }
  const subcommand = operands[index]?.value;
  const rest = operands.slice(index + 1);
  for (let position = 0; position < rest.length; position += 1) {
    const value = rest[position]?.value;
    if (value === undefined) continue;
    if (value === "--") break;
    if (value === "--no-verify") return true;
    if (subcommand !== "commit") continue;
    if (COMMIT_VALUE_OPTIONS.has(value)) {
      position += 1;
      continue;
    }
    if (!/^-[A-Za-z]+$/.test(value)) continue;
    for (const [letterIndex, letter] of [...value.slice(1)].entries()) {
      if (letter === "n") return true;
      if (COMMIT_VALUE_LETTERS.has(letter)) {
        if (letterIndex === value.length - 2) position += 1;
        break;
      }
    }
  }
  return false;
}

/** The path operands a writing command modifies. */
function writtenOperands(name: string, operands: readonly ShellWord[]): string[] {
  const values = staticValues(operands);
  const paths = values.filter((value) => !value.startsWith("-"));
  if (OPERAND_WRITERS.has(name)) return paths;
  if (DESTINATION_WRITERS.has(name)) return paths.slice(-1);
  if (name === "dd") return values.filter((value) => value.startsWith("of=")).map((value) => value.slice(3));
  if (name === "sed" || name === "perl") {
    const inPlace = values.some(
      (value) => value.startsWith("--in-place") || (/^-[A-Za-z]*i/.test(value) && !value.startsWith("--")),
    );
    return inPlace ? paths : [];
  }
  return [];
}

function dangersOf(name: string, operands: readonly ShellWord[], privileged: boolean): string[] {
  const values = staticValues(operands);
  const dangers: string[] = [];
  if (privileged || name === "sudo" || name === "doas") dangers.push("privileged command");
  if (
    name === "rm" &&
    values.some((value) => value === "--recursive" || value === "--force" || /^-[A-Za-z]*[rRf]/.test(value))
  ) {
    dangers.push("recursive/forced remove");
  }
  if (["chmod", "chown", "chgrp"].includes(name) && values.some((value) => /^0?(?:777|666)$/.test(value))) {
    dangers.push("broad permission/ownership change");
  }
  if (SYSTEM_COMMANDS.has(name) || name.startsWith("mkfs.")) dangers.push("system/disk operation");
  return dangers;
}

const MAX_NESTING = 8;

function inspectSimpleCommand(
  simple: SimpleShellCommand,
  state: ShellState,
  depth: number,
  found: { dangers: string[]; runsGit: boolean },
): string | undefined {
  for (const redirect of simple.redirects) {
    if (redirect.kind !== "write" || redirect.target?.value === undefined) continue;
    const reason = protectedPathReason(redirect.target.value, state.cwd);
    if (reason) return `Blocked a shell redirect into a protected path (${reason}): ${redirect.target.value}`;
  }
  for (const [name, value] of HOOK_SKIP_ASSIGNMENTS) {
    if (simple.assignments.get(name) === value) return NO_VERIFY_REASON;
  }

  const { words, privileged } = stripWrappers(simple.words);
  const commandWord = words[0];
  if (commandWord?.value === undefined) return undefined;
  const name = executableName(commandWord.value);
  const operands = words.slice(1);

  const nested = nestedShellScript(words, simple.standardInput, simple.source);
  if (nested?.kind === "source") {
    const inner = inspectBash(nested.source, state.cwd, depth + 1);
    found.dangers.push(...inner.dangers);
    found.runsGit ||= inner.runsGit;
    return inner.blockReason;
  }
  if (nested?.kind === "opaque" && /\b(?:curl|wget)\b/.test(nested.evidence)) {
    found.dangers.push("downloaded script execution");
  }

  if (name === "git") {
    found.runsGit = true;
    if (gitHookBypass(operands)) return NO_VERIFY_REASON;
  }
  found.dangers.push(...dangersOf(name, operands, privileged));
  for (const target of writtenOperands(name, operands)) {
    const reason = protectedPathReason(target, state.cwd);
    if (reason) return `Blocked ${name} on a protected path (${reason}): ${target}`;
  }
  return undefined;
}

/** Decides what the guard does with a bash command run from `cwd`. */
export function inspectBash(command: string, cwd: string, depth = 0): BashInspection {
  const parsed = parseShellScript(command);
  if (parsed._tag === "err" || depth > MAX_NESTING) return inspectUnparsedBash(command);
  const found = { dangers: [] as string[], runsGit: false };
  const blockReason = walkShellProgram(parsed, createShellState(cwd), (simple, state) =>
    inspectSimpleCommand(simple, state, depth, found),
  );
  return { dangers: [...new Set(found.dangers)], blockReason, runsGit: found.runsGit };
}

/**
 * Bash rejects most input the parser rejects, so this fallback only needs to stay conservative: it asks
 * before anything that looks dangerous and blocks text that both names a protected path and writes.
 */
function inspectUnparsedBash(command: string): BashInspection {
  const dangers = [
    [/\brm\s+-[^\s]*[rf]/i, "recursive/forced remove"],
    [/\b(?:sudo|doas)\b/, "privileged command"],
    [/\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sh|bash|zsh)\b/, "downloaded script execution"],
  ] as const;
  const mentionsProtected = /(?:^|[\s'"/])(?:\.env\b|\.git\/|\.jj\/|node_modules\/|\/nix\/store\b)/.test(command);
  const writes = /(?:^|[^<\d&])>(?![&=])|\b(?:rm|mv|cp|tee|truncate|sed\s+-i)\b/.test(command);
  return {
    dangers: dangers.filter(([pattern]) => pattern.test(command)).map(([, label]) => label),
    blockReason: mentionsProtected && writes
      ? "Blocked a command the safety guard cannot parse that appears to write a protected path."
      : undefined,
    runsGit: /(?:^|[;&|(\n]\s*)git(?:\s|$)/.test(command),
  };
}

const GIT_ENV_PREFIX = "export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n";

async function confirmDanger(ctx: ExtensionContext, title: string, details: string) {
  if (!ctx.hasUI) return false;
  return ctx.ui.confirm(title, details, { timeout: 30_000 });
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as ToolInputWithPath;
      if (typeof input.path !== "string") return undefined;
      const reason = protectedPathReason(input.path, ctx.cwd);
      if (!reason) return undefined;
      const message = `Blocked ${event.toolName} to protected path (${reason}): ${input.path}`;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      return { block: true, reason: message };
    }

    if (event.toolName === "read") {
      const input = event.input as ToolInputWithPath;
      if (typeof input.path !== "string") return undefined;
      const label = secretFileLabel(input.path, ctx.cwd);
      if (!label) return undefined;
      const allowed = await confirmDanger(ctx, "Read a secrets file", `${input.path} (${label})\n\nAllow reading it?`);
      return allowed ? undefined : { block: true, reason: `Reading ${label} needs the user's approval.` };
    }

    if (event.toolName !== "bash") return undefined;
    const input = event.input as { command?: unknown };
    const command = String(input.command ?? "");
    const inspection = inspectBash(command, ctx.cwd);
    if (inspection.blockReason) return { block: true, reason: inspection.blockReason };

    if (inspection.dangers.length > 0) {
      const labels = inspection.dangers.join(", ");
      const allowed = await confirmDanger(ctx, "Dangerous bash command", `${labels}:\n\n${command}\n\nAllow this command?`);
      if (!allowed) return { block: true, reason: `Dangerous command blocked: ${labels}` };
    }

    if (inspection.runsGit) input.command = `${GIT_ENV_PREFIX}${command}`;
    return undefined;
  });
}
