/**
 * Minimal test: "Documented minimal Docker implementation forcing danger-full-access"
 *
 * Spec: openspec/changes/agent-control-platform/specs/sandbox-provider-port/spec.md
 *   Requirement: Documented minimal Docker implementation forcing danger-full-access
 *   Scenario: Docker impl reports danger-full-access mode
 *   Scenario: Trade-off is documented
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

// ─── Scenario: Docker impl reports danger-full-access mode ───────────────────
console.log('\nScenario: Docker impl reports danger-full-access mode');

const { DockerSandboxProvider } = require(
  './apps/api/dist/sandbox/docker-sandbox.provider.js'
);
const { SANDBOX_MODES } = require(
  './apps/api/dist/sandbox/sandbox-provider.port.js'
);

const provider = new DockerSandboxProvider();
const mode = provider.getSandboxMode();

assert(
  mode === 'danger-full-access',
  `DockerSandboxProvider.getSandboxMode() returns 'danger-full-access' (got: '${mode}')`
);

assert(
  SANDBOX_MODES.includes('read-only') &&
    SANDBOX_MODES.includes('workspace-write') &&
    SANDBOX_MODES.includes('danger-full-access'),
  'SANDBOX_MODES includes all three values: read-only, workspace-write, danger-full-access'
);

// ─── Scenario: Trade-off is documented ───────────────────────────────────────
console.log('\nScenario: Trade-off is documented in docker-sandbox.provider.ts source');

const srcPath = path.join(
  __dirname,
  'apps/api/src/sandbox/docker-sandbox.provider.ts'
);
const src = readFileSync(srcPath, 'utf8');

assert(
  /danger-full-access/i.test(src),
  'Source mentions danger-full-access'
);

assert(
  /bubblewrap|seccomp|inner.*sandbox|inner Codex.*sandbox/i.test(src),
  'Source states Docker-as-execution forces danger-full-access because inner Codex sandbox (bubblewrap/seccomp) collapses'
);

assert(
  /deploy plane/i.test(src),
  'Source states Docker is the platform deploy plane'
);

assert(
  /not the per.task execution sandbox/i.test(src),
  'Source states Docker is NOT the per-task execution sandbox'
);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
