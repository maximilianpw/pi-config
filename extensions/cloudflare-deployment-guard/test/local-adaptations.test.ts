/**
 * Behavior this checkout adds to dmmulroy's upstream guard: home-relative policy paths, Bun workspace
 * resolution that ignores pnpm-workspace.yaml, case-insensitive policy names, and a git-tracked policy.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateCloudflareDeploymentCommand } from "../evaluate.ts";
import {
	POLICY_FILE_NAME,
	POLICY_FILE_PATH,
	findsCloudflarePolicyMutation,
	parseCloudflareDeploymentPolicy,
	type CloudflareDeploymentPolicy,
} from "../policy.ts";

function workerPolicy(workers: Readonly<Record<string, readonly string[]>>): CloudflareDeploymentPolicy {
	const parsed = parseCloudflareDeploymentPolicy({ version: 1, workers });
	if (parsed._tag !== "ok") assert.fail(parsed.error.message);
	return parsed.value;
}

test("expands home-relative Alchemy project paths", (t) => {
	const home = mkdtempSync(join(tmpdir(), "cloudflare-guard-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	writeFileSync(join(home, "alchemy.run.ts"), "export {};\n");
	for (const project of ["~/alchemy.run.ts", "$HOME/alchemy.run.ts", "${HOME}/alchemy.run.ts"]) {
		const parsed = parseCloudflareDeploymentPolicy(
			{ version: 2, workers: {}, alchemy: [{ project, stages: ["prod"] }] },
			home,
		);
		assert.equal(parsed._tag, "ok", project);
		if (parsed._tag === "ok" && parsed.value.version === 2)
			assert.equal(parsed.value.alchemy[0]?.project, realpathSync(join(home, "alchemy.run.ts")));
	}
});

test("rejects relative Alchemy project paths without a home prefix", () => {
	const parsed = parseCloudflareDeploymentPolicy({
		version: 2,
		workers: {},
		alchemy: [{ project: "Local/example/alchemy.run.ts", stages: ["prod"] }],
	});
	assert.equal(parsed._tag, "err");
	if (parsed._tag === "err") assert.match(parsed.error.message, /must start with/);
});

test("the checked-in policy does not hardcode a user's home directory", () => {
	const policy: unknown = JSON.parse(readFileSync(POLICY_FILE_PATH, "utf8"));
	assert.ok(policy !== null && typeof policy === "object" && !Array.isArray(policy));
	const alchemy: unknown = Reflect.get(policy, "alchemy");
	assert.ok(Array.isArray(alchemy));
	for (const entry of alchemy) {
		assert.ok(entry !== null && typeof entry === "object");
		assert.match(String(Reflect.get(entry, "project")), /^(?:~|\$HOME|\$\{HOME\})\//);
	}
});

test("Bun uses its own workspace inventory even when pnpm declares another package", (t) => {
	const root = mkdtempSync(join(tmpdir(), "cloudflare-bun-workspace-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const api = join(root, "apps", "api");
	const decoy = join(root, "decoy");
	mkdirSync(api, { recursive: true });
	mkdirSync(decoy);
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["apps/*"] }));
	writeFileSync(
		join(api, "package.json"),
		JSON.stringify({ name: "@example/api", scripts: { ship: "wrangler deploy --env production" } }),
	);
	writeFileSync(join(api, "wrangler.jsonc"), JSON.stringify({ name: "example-api", env: { production: {} } }));
	writeFileSync(join(decoy, "package.json"), JSON.stringify({ name: "@example/api", scripts: { ship: "tsc" } }));
	writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - decoy\n");

	const denied = workerPolicy({});
	const decide = (command: string) =>
		evaluateCloudflareDeploymentCommand(command, { cwd: root, policy: denied })._tag;
	assert.equal(decide("bun run --filter @example/api ship"), "block");
	assert.notEqual(decide("pnpm --filter @example/api run ship"), "block");
});

test("detects policy mutations through any case spelling on case-insensitive file systems", (t) => {
	if (process.platform !== "darwin" && process.platform !== "win32") return t.skip("case-sensitive platform");
	const upper = POLICY_FILE_PATH.replace(POLICY_FILE_NAME, POLICY_FILE_NAME.toUpperCase());
	assert.equal(findsCloudflarePolicyMutation(`printf '{}' > ${upper}`, tmpdir()), true);
	assert.equal(findsCloudflarePolicyMutation(`rm ${upper}`, tmpdir()), true);
});

test("git commands that rewrite the tracked policy are mutations; reads are not", () => {
	const cwd = POLICY_FILE_PATH.slice(0, POLICY_FILE_PATH.lastIndexOf("/"));
	for (const command of [
		`git checkout -- ${POLICY_FILE_NAME}`,
		`git restore ${POLICY_FILE_NAME}`,
		`git rm ${POLICY_FILE_NAME}`,
		`git mv ${POLICY_FILE_NAME} other.json`,
	])
		assert.equal(findsCloudflarePolicyMutation(command, cwd), true, command);
	for (const command of [
		`git diff -- ${POLICY_FILE_NAME}`,
		`git log -p -- ${POLICY_FILE_NAME}`,
		`git show HEAD:${POLICY_FILE_NAME}`,
		`cat ${POLICY_FILE_NAME}`,
		`wc -l ${POLICY_FILE_NAME}`,
		`cat > /tmp/note.md <<'EOF'\nthe policy lives in ${POLICY_FILE_NAME}\nEOF`,
	])
		assert.equal(findsCloudflarePolicyMutation(command, cwd), false, command);
});
