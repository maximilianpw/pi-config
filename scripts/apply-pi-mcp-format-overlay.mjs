#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const START = "// pi-mcp-cua-integer-formats:start";
const END = "// pi-mcp-cua-integer-formats:end";
const HELPER = `${START}
function addCuaIntegerFormats(instance: Ajv): void {
  // Cua schemas already constrain these values with integer + minimum.
  // Register the Rust width annotations so Ajv does not warn about them.
  instance.addFormat("uint32", true);
  instance.addFormat("uint64", true);
}
${END}`;
const DECLARATION = "const addFormats = addFormatsImport as unknown as (instance: Ajv) => void;";
const STANDARD_FORMAT_PATTERN = /^(\s*)addFormats\(ajv\);$/gm;
const CUSTOM_FORMAT_PATTERN = /^\s*addCuaIntegerFormats\(ajv\);$/gm;

function parseArgs(argv) {
  let target = resolve(
    homedir(),
    ".pi/agent/npm/node_modules/pi-mcp-adapter/json-schema-validator.ts",
  );
  let mode = "apply";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      mode = "check";
      continue;
    }
    if (argument === "--remove") {
      mode = "remove";
      continue;
    }
    if (argument === "--target") {
      const value = argv[index + 1];
      if (!value) throw new Error("--target requires a path");
      target = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { mode, target };
}

function matchingLines(source, pattern) {
  return source.match(pattern) ?? [];
}

function applyOverlay(source) {
  if (source.includes(START) || source.includes(END)) {
    if (
      source.split(START).length !== 2 ||
      source.split(END).length !== 2 ||
      matchingLines(source, CUSTOM_FORMAT_PATTERN).length !== 2
    ) {
      throw new Error("Installed adapter contains an incomplete or duplicate format overlay");
    }
    return source;
  }

  if (source.split(DECLARATION).length !== 2) {
    throw new Error("Installed adapter does not contain the expected addFormats declaration");
  }
  if (matchingLines(source, STANDARD_FORMAT_PATTERN).length !== 2) {
    throw new Error("Installed adapter does not contain exactly two standard format registrations");
  }

  return source
    .replace(DECLARATION, `${DECLARATION}\n\n${HELPER}`)
    .replace(STANDARD_FORMAT_PATTERN, "$&\n$1addCuaIntegerFormats(ajv);");
}

function removeOverlay(source) {
  if (!source.includes(START) && !source.includes(END)) return source;
  if (
    source.split(START).length !== 2 ||
    source.split(END).length !== 2 ||
    matchingLines(source, CUSTOM_FORMAT_PATTERN).length !== 2
  ) {
    throw new Error("Installed adapter contains an incomplete or duplicate format overlay");
  }

  const helperPattern = new RegExp(
    `\\n\\n${escapeRegExp(HELPER)}\\n`,
  );
  return source
    .replace(helperPattern, "\n")
    .replace(CUSTOM_FORMAT_PATTERN, "")
    .replace(/\n\n(\s*return new AjvJsonSchemaValidator)/g, "\n$1");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
  const { mode, target } = parseArgs(process.argv.slice(2));
  if (!existsSync(target)) throw new Error(`pi-mcp-adapter source not found: ${target}`);

  const source = readFileSync(target, "utf8");
  if (mode === "remove") {
    const clean = removeOverlay(source);
    if (clean !== source) writeFileSync(target, clean);
    console.log(`Removed Pi MCP Cua format overlay: ${target}`);
    return;
  }

  const patched = applyOverlay(source);
  if (mode === "check") {
    if (patched !== source) {
      throw new Error(`Pi MCP Cua format overlay is missing: ${target}`);
    }
    console.log(`Pi MCP Cua format overlay is current: ${target}`);
    return;
  }

  if (patched !== source) writeFileSync(target, patched);
  console.log(`Applied Pi MCP Cua format overlay: ${target}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
