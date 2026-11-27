/**
 * Paths agent tools must not write, and the subset whose contents are secrets. Shared by the safety guard
 * (writes and reads) and the browser tool (file uploads).
 */
import { homedir } from "node:os";
import path from "node:path";

export type ProtectedPathReason = ".env files" | "/nix/store" | ".git" | ".jj" | "node_modules" | "Pi auth.json";
export type SecretFileLabel = Extract<ProtectedPathReason, ".env files" | "Pi auth.json">;

const ENV_TEMPLATE_FILES = new Set([".env.example", ".env.sample", ".env.template"]);
const PROTECTED_SEGMENTS: ReadonlyArray<readonly [marker: string, reason: ProtectedPathReason]> = [
  [`${path.sep}.git${path.sep}`, ".git"],
  [`${path.sep}.jj${path.sep}`, ".jj"],
  [`${path.sep}node_modules${path.sep}`, "node_modules"],
  [`${path.sep}.pi${path.sep}agent${path.sep}auth.json${path.sep}`, "Pi auth.json"],
];

/** Resolves a tool path argument the way Pi's file tools do: `@` prefix stripped, `~` expanded. */
export function resolveToolPath(rawPath: string, cwd: string): string {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const expanded = /^~(?=\/|$)/.test(withoutAt) ? path.join(homedir(), withoutAt.slice(1)) : withoutAt;
  return path.resolve(cwd, expanded);
}

/** Why writing `rawPath` is forbidden, or undefined when it is not protected. */
export function protectedPathReason(rawPath: string, cwd: string): ProtectedPathReason | undefined {
  const absolutePath = resolveToolPath(rawPath, cwd);
  const basename = path.basename(absolutePath);
  if ((basename === ".env" || basename.startsWith(".env.")) && !ENV_TEMPLATE_FILES.has(basename)) {
    return ".env files";
  }
  if (absolutePath === "/nix/store" || absolutePath.startsWith("/nix/store/")) return "/nix/store";
  const withTrailingSeparator = `${absolutePath}${path.sep}`;
  return PROTECTED_SEGMENTS.find(([marker]) => withTrailingSeparator.includes(marker))?.[1];
}

/** Files whose contents are secrets: reading or uploading them needs the user's approval. */
export function secretFileLabel(rawPath: string, cwd: string): SecretFileLabel | undefined {
  const reason = protectedPathReason(rawPath, cwd);
  return reason === ".env files" || reason === "Pi auth.json" ? reason : undefined;
}
