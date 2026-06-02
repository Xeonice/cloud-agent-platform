/**
 * Minimal test for requirement "Hooks baked into a version-pinned runner image"
 * (openspec/changes/agent-control-platform/specs/agent-events-and-approvals/spec.md)
 *
 * Scenarios tested:
 *   1. hooks.json lives at ~/.codex/hooks.json (user-level), not repo-local .codex/config.toml
 *   2. The Dockerfile copies hooks.json to /home/runner/.codex/hooks.json (user HOME, not repo)
 *   3. The Dockerfile installs a pinned, specific Codex version (not an unqualified "latest")
 *   4. hooks.json itself is valid JSON and contains PreToolUse / PermissionRequest / PostToolUse
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// ── Load artifacts ────────────────────────────────────────────────────────────

const dockerfilePath = resolve(ROOT, "apps/runner/Dockerfile");
const hooksJsonPath  = resolve(ROOT, "apps/runner/hooks.json");

const dockerfile = readFileSync(dockerfilePath, "utf8");
const hooksRaw   = readFileSync(hooksJsonPath, "utf8");
let   hooksJson;

try {
  hooksJson = JSON.parse(hooksRaw);
} catch (e) {
  console.error("FATAL: hooks.json is not valid JSON:", e.message);
  process.exit(1);
}

// ── Scenario 1: hooks.json must be placed at the user-level ~/.codex/hooks.json ──

console.log("\nScenario 1: Hooks live in the user-level hooks.json");

// The Dockerfile must COPY to /home/runner/.codex/hooks.json (HOME-relative path)
assert(
  dockerfile.includes("/home/runner/.codex/hooks.json"),
  "Dockerfile places hooks.json at /home/runner/.codex/hooks.json (HOME-level)"
);

// The Dockerfile must NOT COPY hooks to a repo-local .codex/config.toml path.
// (Mentioning the path in a comment to explain why it is NOT used is fine.)
// We check that no COPY instruction targets a repo-local config.toml path.
const configTomlCopyMatch = dockerfile.match(/^COPY[^\n]+\.codex\/config\.toml/m);
assert(
  !configTomlCopyMatch,
  "Dockerfile has no COPY instruction that places a repo-local .codex/config.toml"
);

// The Dockerfile must not create or rely on a repo-local .codex/config.toml via
// a RUN command that writes to that path.
const configTomlRunMatch = dockerfile.match(/^RUN[^\n]+\.codex\/config\.toml/m);
assert(
  !configTomlRunMatch,
  "Dockerfile has no RUN command that writes a repo-local .codex/config.toml"
);

// ── Scenario 2: Codex version is pinned ──────────────────────────────────────

console.log("\nScenario 2: Codex version is pinned");

// The Dockerfile should declare CODEX_VERSION as an ARG with a concrete version
// e.g.  ARG CODEX_VERSION=0.42.0
const codexVersionArgMatch = dockerfile.match(/ARG\s+CODEX_VERSION\s*=\s*(.+)/);

assert(
  codexVersionArgMatch !== null,
  "Dockerfile declares a CODEX_VERSION ARG with a default value"
);

if (codexVersionArgMatch) {
  const pinned = codexVersionArgMatch[1].trim();
  // Must not be empty, "latest", or "*"
  const isSpecificVersion = pinned.length > 0 && pinned !== "latest" && pinned !== "*";
  // Must look like a semver x.y.z
  const looksLikeSemver = /^\d+\.\d+\.\d+/.test(pinned);

  assert(isSpecificVersion, `CODEX_VERSION is not "latest" or wildcard (got: ${pinned})`);
  assert(looksLikeSemver,   `CODEX_VERSION looks like a semver version (got: ${pinned})`);
}

// The npm install line must use the pinned variable, not an unqualified "latest"
assert(
  dockerfile.includes('"@openai/codex@${CODEX_VERSION}"') ||
  dockerfile.includes('"@openai/codex@$CODEX_VERSION"'),
  "Dockerfile installs codex using the pinned CODEX_VERSION variable"
);

assert(
  !dockerfile.includes('"@openai/codex@latest"') &&
  !dockerfile.includes("'@openai/codex@latest'"),
  'Dockerfile does NOT install "@openai/codex@latest"'
);

// ── Bonus: hooks.json wire-up is complete ─────────────────────────────────────

console.log("\nBonus: hooks.json contains the required hook events");

assert(
  hooksJson.hooks && typeof hooksJson.hooks === "object",
  "hooks.json has a top-level 'hooks' object"
);

assert(
  Array.isArray(hooksJson.hooks?.PreToolUse) && hooksJson.hooks.PreToolUse.length > 0,
  "hooks.json wires up PreToolUse"
);

assert(
  Array.isArray(hooksJson.hooks?.PermissionRequest) && hooksJson.hooks.PermissionRequest.length > 0,
  "hooks.json wires up PermissionRequest"
);

assert(
  Array.isArray(hooksJson.hooks?.PostToolUse) && hooksJson.hooks.PostToolUse.length > 0,
  "hooks.json wires up PostToolUse"
);

// PreToolUse and PermissionRequest hooks must be blocking
const preBlocking  = hooksJson.hooks?.PreToolUse?.every(h => h.blocking === true);
const permBlocking = hooksJson.hooks?.PermissionRequest?.every(h => h.blocking === true);
assert(preBlocking,  "PreToolUse hooks are all blocking: true");
assert(permBlocking, "PermissionRequest hooks are all blocking: true");

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("ALL TESTS PASSED");
} else {
  console.log("SOME TESTS FAILED");
  process.exit(1);
}
