/**
 * Minimal test: SandboxProvider port exposing sandbox-mode as a capability.
 *
 * Tests that:
 *   1. DockerSandboxProvider (api-side) implements SandboxProvider and returns
 *      'danger-full-access' from getSandboxMode() — honoring the port contract.
 *   2. DockerRunnerSandboxProvider (runner-side) returns the same mode.
 *   3. sandboxModeArgs() maps a SandboxMode to the correct '--sandbox <mode>' tokens.
 *   4. SANDBOX_MODES covers exactly the three valid modes, in restrictive order.
 *   5. SANDBOX_PROVIDER DI token is a Symbol (so injection is decoupled from class).
 */

import assert from 'node:assert/strict';

// ── api-side port ────────────────────────────────────────────────────────────
// Inline the api-side port + implementation — they are plain JS value objects
// with no NestJS runtime dependency, so we can import the compiled dist.

const apiPort = await import(
  './apps/api/dist/sandbox/sandbox-provider.port.js'
).catch(() => null);

const apiImpl = await import(
  './apps/api/dist/sandbox/docker-sandbox.provider.js'
).catch(() => null);

// ── runner-side port ─────────────────────────────────────────────────────────
const runnerPort = await import(
  './apps/runner/dist/sandbox/sandbox-provider.port.js'
).catch(() => null);

// ── contracts SandboxMode ────────────────────────────────────────────────────
const contracts = await import('./packages/contracts/dist/sandbox.js').catch(
  () => null,
);

// ── helpers ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── 1. api-side: SANDBOX_PROVIDER token is a Symbol ─────────────────────────
console.log('\n[api-side port]');

if (!apiPort) {
  console.log('  SKIP — dist not built (run: pnpm --filter @cap/api build)');
} else {
  test('SANDBOX_PROVIDER is a Symbol', () => {
    assert.equal(typeof apiPort.SANDBOX_PROVIDER, 'symbol');
  });

  test('SANDBOX_MODES contains exactly 3 modes', () => {
    assert.equal(apiPort.SANDBOX_MODES.length, 3);
  });

  test('SANDBOX_MODES[0] is most restrictive (read-only)', () => {
    assert.equal(apiPort.SANDBOX_MODES[0], 'read-only');
  });

  test('SANDBOX_MODES[2] is least restrictive (danger-full-access)', () => {
    assert.equal(apiPort.SANDBOX_MODES[2], 'danger-full-access');
  });
}

if (!apiImpl) {
  console.log('  SKIP (impl) — dist not built');
} else {
  test('DockerSandboxProvider.getSandboxMode() returns danger-full-access', () => {
    const provider = new apiImpl.DockerSandboxProvider();
    assert.equal(provider.getSandboxMode(), 'danger-full-access');
  });

  test('DockerSandboxProvider satisfies SandboxProvider shape', () => {
    const provider = new apiImpl.DockerSandboxProvider();
    assert.equal(typeof provider.getSandboxMode, 'function');
  });
}

// ── 2. runner-side: DockerRunnerSandboxProvider + sandboxModeArgs ────────────
console.log('\n[runner-side port]');

if (!runnerPort) {
  console.log('  SKIP — dist not built (run: pnpm --filter @cap/runner build)');
} else {
  test('DockerRunnerSandboxProvider.getSandboxMode() returns danger-full-access', () => {
    const provider = new runnerPort.DockerRunnerSandboxProvider();
    assert.equal(provider.getSandboxMode(), 'danger-full-access');
  });

  test('sandboxModeArgs maps danger-full-access to [--sandbox, danger-full-access]', () => {
    const args = runnerPort.sandboxModeArgs('danger-full-access');
    assert.deepEqual(Array.from(args), ['--sandbox', 'danger-full-access']);
  });

  test('sandboxModeArgs maps workspace-write to [--sandbox, workspace-write]', () => {
    const args = runnerPort.sandboxModeArgs('workspace-write');
    assert.deepEqual(Array.from(args), ['--sandbox', 'workspace-write']);
  });

  test('sandboxModeArgs maps read-only to [--sandbox, read-only]', () => {
    const args = runnerPort.sandboxModeArgs('read-only');
    assert.deepEqual(Array.from(args), ['--sandbox', 'read-only']);
  });
}

// ── 3. contracts SandboxMode schema ─────────────────────────────────────────
console.log('\n[contracts SandboxMode]');

if (!contracts) {
  console.log('  SKIP — dist not built');
} else {
  test('SandboxModeSchema accepts danger-full-access', () => {
    const result = contracts.SandboxModeSchema.safeParse('danger-full-access');
    assert.ok(result.success, 'Expected parse success');
  });

  test('SandboxModeSchema accepts workspace-write', () => {
    const result = contracts.SandboxModeSchema.safeParse('workspace-write');
    assert.ok(result.success, 'Expected parse success');
  });

  test('SandboxModeSchema accepts read-only', () => {
    const result = contracts.SandboxModeSchema.safeParse('read-only');
    assert.ok(result.success, 'Expected parse success');
  });

  test('SandboxModeSchema rejects unknown mode', () => {
    const result = contracts.SandboxModeSchema.safeParse('unrestricted');
    assert.ok(!result.success, 'Expected parse failure for unknown mode');
  });
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
