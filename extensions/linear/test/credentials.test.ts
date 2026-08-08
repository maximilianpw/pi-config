import assert from "node:assert/strict";
import test from "node:test";

import { loadLinearApiKey } from "../credentials.ts";

test("LINEAR_API_KEY takes precedence without reading a file", async () => {
  let reads = 0;
  const key = await loadLinearApiKey({
    env: { LINEAR_API_KEY: "  inline-key  ", LINEAR_API_KEY_FILE: "/ignored" },
    readSecretFile: async () => {
      reads += 1;
      return "file-key";
    },
  });

  assert.equal(key, "inline-key");
  assert.equal(reads, 0);
});

test("LINEAR_API_KEY_FILE reads and trims an explicit secret file", async () => {
  const paths: string[] = [];
  const key = await loadLinearApiKey({
    env: { LINEAR_API_KEY_FILE: "/secrets/linear" },
    readSecretFile: async (path) => {
      paths.push(path);
      return "  file-key\n";
    },
  });

  assert.equal(key, "file-key");
  assert.deepEqual(paths, ["/secrets/linear"]);
});

test("sops-nix Home Manager secret is discovered automatically", async () => {
  const paths: string[] = [];
  const key = await loadLinearApiKey({
    env: {},
    home: "/home/testuser",
    readSecretFile: async (path) => {
      paths.push(path);
      if (path === "/home/testuser/.config/sops-nix/secrets/linear-api-key") return "sops-key";
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  });

  assert.equal(key, "sops-key");
  assert.deepEqual(paths, ["/home/testuser/.config/sops-nix/secrets/linear-api-key"]);
});

test("NixOS system secret is used when the Home Manager secret is absent", async () => {
  const paths: string[] = [];
  const key = await loadLinearApiKey({
    env: {},
    home: "/home/testuser",
    readSecretFile: async (path) => {
      paths.push(path);
      if (path === "/run/secrets/linear-api-key") return "system-sops-key";
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  });

  assert.equal(key, "system-sops-key");
  assert.deepEqual(paths, [
    "/home/testuser/.config/sops-nix/secrets/linear-api-key",
    "/run/secrets/linear-api-key",
  ]);
});

test("an unreadable explicit secret file fails without falling back", async () => {
  await assert.rejects(
    loadLinearApiKey({
      env: { LINEAR_API_KEY_FILE: "/explicit/linear" },
      readSecretFile: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    }),
    /Could not read the Linear API key from \/explicit\/linear: permission denied/,
  );
});

test("missing credentials fail without exposing a secret value", async () => {
  await assert.rejects(
    loadLinearApiKey({
      env: {},
      home: "/home/testuser",
      readSecretFile: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    }),
    /Linear API key not found/,
  );
});
