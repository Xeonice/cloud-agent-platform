/**
 * Minimal test: "Path to restore OS-level isolation is preserved" requirement
 * (sandbox-provider-port spec, Requirement 3).
 *
 * Scenario: A stricter mode is expressible through the same port
 *   WHEN a future implementation is registered that reports a non-danger-full-access
 *        sandbox mode
 *   THEN existing port consumers use it through the unchanged SandboxProvider interface
 *   AND  no consumer code requires modification to honor the stricter mode
 *
 * Approach: we verify the structural property directly in-process using the
 * runner dist (same artifacts the other root-level tests use).
 */

import {
  sandboxModeArgs,
  DockerRunnerSandboxProvider,
} from './apps/runner/dist/sandbox/sandbox-provider.port.js';

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

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

console.log('\n=== Path to restore OS-level isolation is preserved ===\n');

// ── SCENARIO: A stricter mode is expressible through the same port ──────────

// 1. Define a future OS-isolating provider that satisfies the SAME SandboxProvider
//    interface (structural typing) — no interface modification required.
class FutureOsIsolatingProvider {
  getSandboxMode() {
    return 'workspace-write'; // stricter than danger-full-access
  }
}

class FutureReadOnlyProvider {
  getSandboxMode() {
    return 'read-only'; // most restrictive mode
  }
}

// 2. Verify existing consumer (sandboxModeArgs) honors the stricter mode WITHOUT
//    any change to consumer code — it only calls getSandboxMode() on the interface.
const dockerProvider = new DockerRunnerSandboxProvider();
const futureProvider = new FutureOsIsolatingProvider();
const readOnlyProvider = new FutureReadOnlyProvider();

// Existing Docker impl still returns danger-full-access as before
const dockerArgs = sandboxModeArgs(dockerProvider.getSandboxMode());
assert(
  deepEqual(dockerArgs, ['--sandbox', 'danger-full-access']),
  'Docker provider still produces --sandbox danger-full-access (baseline unchanged)',
);

// Future workspace-write provider produces stricter args through the SAME consumer
const workspaceWriteArgs = sandboxModeArgs(futureProvider.getSandboxMode());
assert(
  deepEqual(workspaceWriteArgs, ['--sandbox', 'workspace-write']),
  'Future workspace-write provider produces --sandbox workspace-write via same consumer',
);

// Future read-only provider produces strictest args through the SAME consumer
const readOnlyArgs = sandboxModeArgs(readOnlyProvider.getSandboxMode());
assert(
  deepEqual(readOnlyArgs, ['--sandbox', 'read-only']),
  'Future read-only provider produces --sandbox read-only via same consumer',
);

// 3. Verify the consumer is truly decoupled — it only calls getSandboxMode(),
//    making the concrete class irrelevant at the call site.
function simulateProvisioningCallSite(sandboxProvider) {
  // Mirrors the startTask provisioning call site in task-entry.ts (9.1b):
  //   const sandboxProvider = config.sandboxProvider ?? new DockerRunnerSandboxProvider();
  //   const codexArgs = [...sandboxModeArgs(sandboxProvider.getSandboxMode()), ...];
  const mode = sandboxProvider.getSandboxMode();
  return [...sandboxModeArgs(mode), '--other-arg'];
}

const dockerResult = simulateProvisioningCallSite(dockerProvider);
const futureResult = simulateProvisioningCallSite(futureProvider);

assert(
  dockerResult[0] === '--sandbox' && dockerResult[1] === 'danger-full-access',
  'Provisioning call site produces correct args for Docker provider',
);
assert(
  futureResult[0] === '--sandbox' && futureResult[1] === 'workspace-write',
  'Provisioning call site produces correct args for future stricter provider (same code path)',
);

// 4. Verify the port contract is satisfied by duck typing (structural interface):
//    both providers have getSandboxMode() that returns a valid SandboxMode.
const VALID_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

for (const [name, provider] of [
  ['DockerRunnerSandboxProvider', dockerProvider],
  ['FutureOsIsolatingProvider (workspace-write)', futureProvider],
  ['FutureReadOnlyProvider (read-only)', readOnlyProvider],
]) {
  const mode = provider.getSandboxMode();
  assert(
    typeof provider.getSandboxMode === 'function',
    `${name} satisfies SandboxProvider interface (has getSandboxMode)`,
  );
  assert(
    VALID_MODES.has(mode),
    `${name} returns a valid SandboxMode: "${mode}"`,
  );
}

// 5. Verify that the stricter modes differ from danger-full-access (they represent
//    actual OS-level isolation, not the weak Docker baseline).
assert(
  futureProvider.getSandboxMode() !== 'danger-full-access',
  'Future workspace-write provider does NOT report danger-full-access',
);
assert(
  readOnlyProvider.getSandboxMode() !== 'danger-full-access',
  'Future read-only provider does NOT report danger-full-access',
);

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
