import assert from 'node:assert/strict';
const mod = await import(new URL('../dist/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

await test('buildSandboxSettlePlan centralizes common settle side effects', () => {
  assert.deepEqual(
    mod.buildSandboxSettlePlan({
      sessionReason: 'failed',
      deliverWorkspace: false,
    }),
    {
      sessionReason: 'failed',
      captureTranscript: true,
      deliverWorkspace: false,
      teardownSandbox: true,
      teardownSession: true,
      releaseSlot: true,
    },
  );
});

await test('terminalSettlePlan enables workspace delivery on natural completion', () => {
  assert.deepEqual(mod.terminalSettlePlan(), {
    sessionReason: 'completed',
    captureTranscript: true,
    deliverWorkspace: true,
    teardownSandbox: true,
    teardownSession: true,
    releaseSlot: true,
  });
});

await test('forceFailSettlePlan disables workspace delivery for failed and graceful reclamation paths', () => {
  assert.deepEqual(mod.forceFailSettlePlan({ terminal: 'failed' }), {
    sessionReason: 'failed',
    captureTranscript: true,
    deliverWorkspace: false,
    teardownSandbox: true,
    teardownSession: true,
    releaseSlot: true,
  });
  assert.deepEqual(mod.forceFailSettlePlan({ terminal: 'completed' }), {
    sessionReason: 'completed',
    captureTranscript: true,
    deliverWorkspace: false,
    teardownSandbox: true,
    teardownSession: true,
    releaseSlot: true,
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
