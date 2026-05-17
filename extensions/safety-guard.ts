import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ToolInputWithPath = { path?: unknown };

const DANGEROUS_BASH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(?:-[^\s]*r[^\s]*f?|-[^\s]*f[^\s]*r|--recursive|--force)/i, label: "recursive/forced remove" },
  { pattern: /\bsudo\b/i, label: "sudo" },
  { pattern: /\b(chmod|chown|chgrp)\b.*\b(?:777|666)\b/i, label: "broad permission/ownership change" },
  { pattern: /\b(?:dd|mkfs|diskutil|shutdown|reboot)\b/i, label: "system/disk operation" },
  { pattern: /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sh|bash|zsh)\b/i, label: "downloaded script execution" },
  { pattern: /(?:^|\s)>\s*(?:~?\/?\.env\b|[^\s]*\.env\b)/i, label: "shell redirect to .env" },
  { pattern: /(?:^|\s)>\s*\/nix\/store\b/i, label: "shell redirect to /nix/store" },
];

const WRITEISH_BASH_PATTERNS = [
  /\b(?:rm|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|mkfs|install)\b/i,
  /(?:^|[^<])>(?!>)/,
  />>/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|uninstall|update|ci|link|publish)\b/i,
  /\b(?:git|jj)\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|branch|stash|cherry-pick|revert|tag|init|clone|new|squash|describe|bookmark)\b/i,
];

const PROTECTED_PATH_MARKERS = [
  ".env",
  ".env.",
  `${path.sep}.git${path.sep}`,
  `${path.sep}node_modules${path.sep}`,
  `${path.sep}.jj${path.sep}`,
  `${path.sep}.pi${path.sep}agent${path.sep}auth.json`,
  `${path.sep}nix${path.sep}store${path.sep}`,
];

function normalizePathForCheck(rawPath: string, cwd: string): string {
  const stripped = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return path.resolve(cwd, stripped);
}

function isProtectedPath(rawPath: string, cwd: string): string | undefined {
  const absolutePath = normalizePathForCheck(rawPath, cwd);
  const withSeps = absolutePath.includes(path.sep) ? absolutePath : `${path.sep}${absolutePath}`;
  const basename = path.basename(absolutePath);

  if (basename === ".env" || basename.startsWith(".env.")) return ".env files";
  if (absolutePath === "/nix/store" || absolutePath.startsWith("/nix/store/")) return "/nix/store";

  for (const marker of PROTECTED_PATH_MARKERS) {
    if (withSeps.includes(marker)) return marker.replaceAll(path.sep, "/");
  }
  return undefined;
}

function commandTouchesProtectedPath(command: string): string | undefined {
  if (/\/nix\/store(?:\/|\b)/.test(command)) return "/nix/store";
  if (/(?:^|[\s'\"])(?:\.\/)?\.env(?:\b|\.)/.test(command)) return ".env files";
  if (/(?:^|[\s'\"])node_modules(?:\/|\b)/.test(command)) return "node_modules";
  if (/(?:^|[\s'\"])\.git(?:\/|\b)/.test(command)) return ".git";
  if (/(?:^|[\s'\"])\.jj(?:\/|\b)/.test(command)) return ".jj";
  return undefined;
}

async function confirmDanger(ctx: ExtensionContext, title: string, details: string) {
  if (!ctx.hasUI) return false;
  return ctx.ui.confirm(title, details, { timeout: 30_000 });
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as ToolInputWithPath;
      if (typeof input.path !== "string") return undefined;

      const protectedReason = isProtectedPath(input.path, ctx.cwd);
      if (!protectedReason) return undefined;

      const reason = `Blocked ${event.toolName} to protected path (${protectedReason}): ${input.path}`;
      if (ctx.hasUI) ctx.ui.notify(reason, "warning");
      return { block: true, reason };
    }

    if (event.toolName !== "bash") return undefined;

    const command = String((event.input as { command?: unknown }).command ?? "");
    const dangerous = DANGEROUS_BASH_PATTERNS.find(({ pattern }) => pattern.test(command));
    if (dangerous) {
      const allowed = await confirmDanger(ctx, "Dangerous bash command", `${dangerous.label}:\n\n${command}\n\nAllow this command?`);
      if (!allowed) return { block: true, reason: `Dangerous command blocked: ${dangerous.label}` };
    }

    const protectedPath = commandTouchesProtectedPath(command);
    const writeish = WRITEISH_BASH_PATTERNS.some((pattern) => pattern.test(command));
    if (protectedPath && writeish) {
      return {
        block: true,
        reason: `Blocked bash command that appears to modify protected path (${protectedPath}).`,
      };
    }

    return undefined;
  });
}
