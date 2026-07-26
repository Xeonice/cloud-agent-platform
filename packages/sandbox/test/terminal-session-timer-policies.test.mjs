import assert from 'node:assert/strict';

class FakeTransport {
  readyState = 'open';
  input = [];
  onFrame() {
    return { dispose() {} };
  }
  onClose() {
    return { dispose() {} };
  }
  onError() {
    return { dispose() {} };
  }
  sendInput(data) {
    this.input.push(data);
    return true;
  }
  sendResize() {
    return true;
  }
  sendPong() {
    return true;
  }
  pause() {}
  resume() {}
  close() {}
}

function makeClient(Session, taskId) {
  const transport = new FakeTransport();
  const client = new Session(
    taskId,
    'ws://unused',
    'http://unused',
    undefined,
    'replay-only',
    undefined,
    { open: () => transport },
    {
      async exec() {
        return {
          exitCode: 0,
          output: '',
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      },
    },
  );
  return { client, transport };
}

process.env.CODEX_ATTACH_BOOTSTRAP_MAX_MS = '0';
process.env.CODEX_ATTACH_BOOTSTRAP_QUIESCE_MS = '20';
const maxDisabled = await import(
  new URL('../dist/terminal/session-engine.js?max-disabled', import.meta.url).href
);
const maxDisabledClient = makeClient(
  maxDisabled.SandboxTerminalSession,
  'task-max-disabled',
);
maxDisabledClient.client.attachToNamedSession();
assert.equal(maxDisabledClient.client.attachBootstrapActive, false);
maxDisabledClient.client.close();

process.env.CODEX_ATTACH_BOOTSTRAP_MAX_MS = '50';
process.env.CODEX_ATTACH_BOOTSTRAP_QUIESCE_MS = '0';
const quietDisabled = await import(
  new URL('../dist/terminal/session-engine.js?quiet-disabled', import.meta.url).href
);
const quietDisabledClient = makeClient(
  quietDisabled.SandboxTerminalSession,
  'task-quiet-disabled',
);
quietDisabledClient.client.attachToNamedSession();
assert.equal(quietDisabledClient.client.attachBootstrapActive, false);
quietDisabledClient.client.close();

process.env.CODEX_ATTACH_BOOTSTRAP_MAX_MS = '5';
process.env.CODEX_ATTACH_BOOTSTRAP_QUIESCE_MS = '50';
const maxExpiry = await import(
  new URL('../dist/terminal/session-engine.js?max-expiry', import.meta.url).href
);
const maxExpiryClient = makeClient(
  maxExpiry.SandboxTerminalSession,
  'task-max-expiry',
);
maxExpiryClient.client.attachToNamedSession();
assert.equal(maxExpiryClient.client.attachBootstrapActive, true);
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(maxExpiryClient.client.attachBootstrapActive, false);
maxExpiryClient.client.close();

process.env.CODEX_ATTACH_BOOTSTRAP_MAX_MS = '100';
process.env.CODEX_ATTACH_BOOTSTRAP_QUIESCE_MS = '5';
const delayedFirstOutput = await import(
  new URL('../dist/terminal/session-engine.js?delayed-first-output', import.meta.url).href
);
const delayedFirstOutputClient = makeClient(
  delayedFirstOutput.SandboxTerminalSession,
  'task-delayed-first-output',
);
delayedFirstOutputClient.client.attachToNamedSession();
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(delayedFirstOutputClient.client.attachBootstrapActive, true);
assert.deepEqual(delayedFirstOutputClient.client.outputMeta(), {
  recordable: false,
  source: 'attach-bootstrap',
});
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(delayedFirstOutputClient.client.attachBootstrapActive, false);
delayedFirstOutputClient.client.close();

console.log('terminal-session-timer-policies.test.mjs passed');
