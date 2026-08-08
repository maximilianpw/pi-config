import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type ReadSecretFile = (path: string, encoding: "utf8") => Promise<string>;

type CredentialOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readSecretFile?: ReadSecretFile;
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function defaultSecretPaths(home: string): string[] {
  return [
    join(home, ".config", "sops-nix", "secrets", "linear-api-key"),
    "/run/secrets/linear-api-key",
  ];
}

export async function loadLinearApiKey(options: CredentialOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const inlineKey = env.LINEAR_API_KEY?.trim();
  if (inlineKey) return inlineKey;

  const home = options.home ?? homedir();
  const readSecretFile = options.readSecretFile ?? readFile;
  const explicitPath = env.LINEAR_API_KEY_FILE?.trim();
  const paths = explicitPath ? [explicitPath] : defaultSecretPaths(home);

  for (const path of [...new Set(paths)]) {
    try {
      const key = (await readSecretFile(path, "utf8")).trim();
      if (!key) throw new Error("secret file is empty");
      return key;
    } catch (error) {
      if (!explicitPath && errorCode(error) === "ENOENT") continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not read the Linear API key from ${path}: ${message}`);
    }
  }

  throw new Error(
    "Linear API key not found. Configure the sops-nix linear-api-key secret, set LINEAR_API_KEY_FILE, or set LINEAR_API_KEY.",
  );
}
