import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BoxLitePartialCreateError,
  BoxLiteRestClient,
} from '../packages/sandbox/dist/index.js';
import {
  assertRealCliContinuousOutputEvidence,
  beginBoxLiteCreateAttempt,
  buildExactRuntimeProcessIdentityProbeCommand,
  buildRealCliPressurePlan,
  classifyApiRestartFrameReference,
  cleanupExactPressureWindow,
  cleanupAll,
  cleanupBoxLiteCreateAttempt,
  cleanupRuntimeResources,
  createAioTerminalFaultRelay,
  formatCanaryErrorTree,
  parseArgs,
  parseExactTmuxPaneIdentityOutput,
  parseExactTmuxWindowInventoryOutput,
  parseExactRuntimeProcessIdentityOutput,
  registerExactCleanup,
  runRealCliContinuousOutputPressure,
  signalExactRuntime,
} from './boxlite-real-cli-terminal-canary.mjs';

import { createRequire } from 'node:module';

const requireFromApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { WebSocket, WebSocketServer } = requireFromApi('ws');

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'boxlite-real-cli-terminal-canary.mjs',
);

test('real CLI pressure plan uses the pinned native shell shortcut without echoing output markers', () => {
  for (const runtimeId of ['codex', 'claude-code']) {
    const plan = buildRealCliPressurePlan(
      runtimeId,
      'pressure1234',
      'terminal-story-pressure-test',
    );
    assert.equal(plan.prompt, `!${plan.shellCommand}`);
    assert.equal(plan.prompt.includes(plan.beginMarker), false);
    assert.equal(plan.prompt.includes(plan.endMarker), false);
    assert.equal(plan.prompt.includes(plan.lineMarkerPrefix), false);
    assert.equal(
      plan.submitFlushKey,
      runtimeId === 'claude-code' ? 'ArrowRight' : null,
    );
    assert.equal(
      plan.pressureWindowName,
      runtimeId === 'claude-code'
        ? 'cap-pressure-pressure1234'
        : null,
    );
    assert.equal(plan.lineCount >= 1_200, true);
    assert.equal(plan.lineDelaySeconds > 0, true);
    assert.equal(
      spawnSync('bash', ['--noprofile', '--norc', '-n', '-c', plan.shellCommand])
        .status,
      0,
    );
  }
  assert.throws(
    () =>
      buildRealCliPressurePlan(
        'unsupported',
        'pressure1234',
        'terminal-story-pressure-test',
      ),
    /runtime must be codex or claude-code/u,
  );
  assert.throws(
    () =>
      buildRealCliPressurePlan(
        'codex',
        'UPPER',
        'terminal-story-pressure-test',
      ),
    /nonce must be bounded lowercase alphanumeric/u,
  );
});

test('direct real CLI pressure consumes the caller-owned terminal capture', async () => {
  const sentinel = new Error('capture reached');
  const writes = [];
  await assert.rejects(
    runRealCliContinuousOutputPressure({
      owner: { write: (value) => writes.push(value) },
      ownerCapture: {
        byteLength: 0,
        waitForRawMarker: async () => {
          throw sentinel;
        },
      },
      viewerFactory: null,
      commandExecutor: {
        async exec() {
          return {
            exitCode: 0,
            timedOut: false,
            output:
              'taskdirect-pressure-regression|@1|%1|42|/dev/pts/1|zsh|1|0\n',
          };
        },
      },
      runtimeId: 'codex',
      taskId: 'direct-pressure-regression',
      nonce: 'direct1234',
      quietMs: 120,
      maxSettleMs: 2_000,
    }),
    (error) => error === sentinel,
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].startsWith('!'), true);
  assert.equal(writes[1], '\r');
});

test('tmux pressure identities and window inventory fail closed on ambiguity', () => {
  assert.deepEqual(
    parseExactTmuxPaneIdentityOutput(
      'taskpressure|@1|%2|42|/dev/pts/3|claude|1|0\n',
    ),
    {
      sessionName: 'taskpressure',
      windowId: '@1',
      paneId: '%2',
      panePid: 42,
      paneTty: '/dev/pts/3',
      windowName: 'claude',
      windowActive: true,
      paneDead: false,
    },
  );
  for (const output of [
    '',
    'taskpressure|@1|%2|0|/dev/pts/3|claude|1|0\n',
    'taskpressure|@1|%2|42|/dev/tty3|claude|1|0\n',
    'taskpressure|@1|%2|42|/dev/pts/3|claude|2|0\n',
    'taskpressure|@1|%2|42|/dev/pts/3|claude|1|0\nsecond\n',
  ]) {
    assert.equal(parseExactTmuxPaneIdentityOutput(output), null);
  }

  assert.deepEqual(
    parseExactTmuxWindowInventoryOutput(
      '@1|claude|0|1\n@2|cap-pressure-pressure1234|1|1\n',
    ),
    [
      {
        windowId: '@1',
        windowName: 'claude',
        windowActive: false,
        paneCount: 1,
      },
      {
        windowId: '@2',
        windowName: 'cap-pressure-pressure1234',
        windowActive: true,
        paneCount: 1,
      },
    ],
  );
  assert.equal(
    parseExactTmuxWindowInventoryOutput('@1|pressure|1|0\n'),
    null,
  );
});

test('pressure cleanup kills only the exact generated window identity', async () => {
  let windows = [
    '@1|claude|1|1',
    '@2|cap-pressure-pressure1234|0|1',
  ];
  const commands = [];
  const commandExecutor = {
    async exec({ command }) {
      commands.push(command);
      if (command.startsWith('tmux list-windows')) {
        return {
          exitCode: 0,
          timedOut: false,
          output: `${windows.join('\n')}\n`,
        };
      }
      if (command === "tmux kill-window -t '@2'") {
        windows = windows.filter((line) => !line.startsWith('@2|'));
        return { exitCode: 0, timedOut: false, output: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };
  await cleanupExactPressureWindow({
    commandExecutor,
    taskId: 'pressure',
    pressureWindowName: 'cap-pressure-pressure1234',
  });
  assert.deepEqual(windows, ['@1|claude|1|1']);
  assert.equal(
    commands.filter((command) => command.startsWith('tmux kill-window'))
      .length,
    1,
  );
});

test('fixed runtime signaling fences the original pane identity', async () => {
  let command = '';
  await signalExactRuntime(
    {
      async exec(request) {
        command = request.command;
        return { exitCode: 0, timedOut: false, output: '' };
      },
    },
    'pressure',
    'STOP',
    {
      sessionName: 'taskpressure',
      windowId: '@1',
      paneId: '%1',
      panePid: 41,
      paneTty: '/dev/pts/1',
      windowName: 'claude',
      windowActive: true,
      paneDead: false,
    },
  );
  assert.match(command, /display-message -p -t '%1'/u);
  assert.match(command, /taskpressure\|@1\|%1\|41\|\/dev\/pts\/1/u);
  assert.doesNotMatch(command, /display-message -p -t '=taskpressure:'/u);
});

test('real CLI pressure evidence fails closed on every continuous browser invariant', () => {
  const passing = {
    surface: 'cap',
    runtimeId: 'codex',
    actualInteractiveCli: true,
    observed: true,
    outputSource: 'cap-writer-viewer-pty',
    commandExecution: 'native CLI foreground shell output through CAP writer',
    beginMarkerObserved: true,
    endMarkerObserved: true,
    observedOutputBytes: 64 * 1024,
    observedOutputChunks: 80,
    durationMs: 10_000,
    quietWithinOneSecond: false,
    preReadyTimelineComplete: true,
    preReadyOutputEvents: 20,
    preReadyMaxGapMs: 80,
    wireContinuousBeforeReady: true,
    hardDeadlineTimingObserved: true,
    quietThresholdMs: 120,
    revealSettleMs: 2_000,
    maxSettleMs: 2_000,
    postReadyBytes: 8 * 1024,
    postReadyChunks: 20,
    browserWriterOutputBytes: 64 * 1024,
    browserWriterOutputChunks: 80,
    browserInputViaGateway: true,
    writerAttachmentId: 'writer-1',
    pressureAttachmentId: 'pressure-2',
    domRevealed: true,
    domRevealMs: 2_200,
    dynamicScreenshotBytes: 4_096,
    dynamicScreenshotDuringOutput: true,
    screenshotPressureSequence: 200,
    postScreenshotPressureSequence: 400,
    postScreenshotBytes: 8 * 1024,
    visualStateChanges: 5,
    visualChangeSpanMs: 4_000,
    pressureWindowLifecycle: { kind: 'not-applicable' },
    pressureViewerCleanup: { kind: 'confirmed' },
    pressureWindowCleanupConfirmed: null,
    originalPaneRestoredAtCleanup: true,
    originalPaneStopConfirmed: true,
    originalPaneStableAfterStop: true,
    stoppedSourceSha256: 'a'.repeat(64),
  };
  assert.strictEqual(assertRealCliContinuousOutputEvidence(passing), passing);
  const coalescedBrowserWire = {
    ...passing,
    preReadyMaxGapMs: 180,
    wireContinuousBeforeReady: false,
  };
  assert.strictEqual(
    assertRealCliContinuousOutputEvidence(coalescedBrowserWire),
    coalescedBrowserWire,
  );

  const failures = [
    ['surface', 'bogus'],
    ['runtimeId', 'bogus'],
    ['actualInteractiveCli', false],
    ['commandExecution', 'synthetic command'],
    ['observed', false],
    ['outputSource', 'synthetic-history'],
    ['beginMarkerObserved', false],
    ['endMarkerObserved', false],
    ['observedOutputBytes', 32 * 1024 - 1],
    ['observedOutputChunks', 19],
    ['durationMs', 7_999],
    ['durationMs', 20_001],
    ['quietWithinOneSecond', true],
    ['preReadyTimelineComplete', false],
    ['preReadyOutputEvents', 0],
    ['quietThresholdMs', 0],
    ['maxSettleMs', 0],
    ['wireContinuousBeforeReady', false],
    ['hardDeadlineTimingObserved', false],
    ['revealSettleMs', 1_749],
    ['revealSettleMs', 2_501],
    ['postReadyBytes', 4 * 1024 - 1],
    ['postReadyChunks', 4],
    ['browserWriterOutputBytes', 32 * 1024 - 1],
    ['browserWriterOutputChunks', 19],
    ['browserInputViaGateway', false],
    ['writerAttachmentId', ''],
    ['pressureAttachmentId', 'writer-1'],
    ['domRevealed', false],
    ['domRevealMs', 3_001],
    ['dynamicScreenshotBytes', 1_000],
    ['dynamicScreenshotDuringOutput', false],
    ['postScreenshotBytes', 0],
    ['postScreenshotPressureSequence', 200],
    ['visualStateChanges', 2],
    ['visualChangeSpanMs', 999],
    ['pressureViewerCleanup', { kind: 'indeterminate' }],
    ['originalPaneRestoredAtCleanup', false],
    ['originalPaneStopConfirmed', false],
    ['originalPaneStableAfterStop', false],
    ['stoppedSourceSha256', 'not-a-digest'],
  ];
  for (const [key, value] of failures) {
    assert.throws(() =>
      assertRealCliContinuousOutputEvidence({
        ...passing,
        [key]: value,
      }),
    );
  }
  assert.throws(() =>
    assertRealCliContinuousOutputEvidence({
      ...passing,
      surface: 'direct',
      outputSource: 'cap-writer-viewer-pty',
    }),
  );
  assert.throws(() =>
    assertRealCliContinuousOutputEvidence({
      ...passing,
      surface: 'cap',
      outputSource: 'owner-pty',
    }),
  );

  const directPassing = {
    ...passing,
    surface: 'direct',
    outputSource: 'owner-pty',
    commandExecution: 'native CLI foreground shell output',
    quietCurrentFrameAfterPressure: true,
    stableCurrentFrameAfterPressure: true,
  };
  assert.strictEqual(
    assertRealCliContinuousOutputEvidence(directPassing),
    directPassing,
  );
  for (const key of [
    'quietCurrentFrameAfterPressure',
    'stableCurrentFrameAfterPressure',
  ]) {
    assert.throws(() =>
      assertRealCliContinuousOutputEvidence({
        ...directPassing,
        [key]: false,
      }),
    );
  }

  const claudePassing = {
    ...passing,
    runtimeId: 'claude-code',
    commandExecution:
      'temporary foreground tmux window launched by native CLI shell mode through CAP writer',
    pressureWindowCleanupConfirmed: true,
    pressureWindowLifecycle: {
      kind: 'temporary-window',
      windowName: 'cap-pressure-pressure1234',
      originalPaneIdentity: {
        sessionName: 'taskpressure',
        windowId: '@1',
        paneId: '%1',
        panePid: 41,
        paneTty: '/dev/pts/1',
        windowName: 'claude',
        windowActive: true,
        paneDead: false,
      },
      pressurePaneIdentity: {
        sessionName: 'taskpressure',
        windowId: '@2',
        paneId: '%2',
        panePid: 42,
        paneTty: '/dev/pts/2',
        windowName: 'cap-pressure-pressure1234',
        windowActive: true,
        paneDead: false,
      },
      pressureWindowAbsentAfterEnd: true,
      originalPaneRestoredAfterEnd: true,
    },
  };
  assert.strictEqual(
    assertRealCliContinuousOutputEvidence(claudePassing),
    claudePassing,
  );
  assert.throws(() =>
    assertRealCliContinuousOutputEvidence({
      ...claudePassing,
      pressureWindowLifecycle: {
        ...claudePassing.pressureWindowLifecycle,
        pressureWindowAbsentAfterEnd: false,
      },
    }),
  );
  assert.throws(() =>
    assertRealCliContinuousOutputEvidence({
      ...claudePassing,
      pressureWindowLifecycle: {
        ...claudePassing.pressureWindowLifecycle,
        originalPaneIdentity: {
          ...claudePassing.pressureWindowLifecycle.originalPaneIdentity,
          paneId: null,
        },
      },
    }),
  );
});

test('API restart parity reference follows the authoritative tmux source digest', () => {
  const beforeSourceSha256 = createHash('sha256')
    .update('stable native TUI frame')
    .digest('hex');
  const changedSourceSha256 = createHash('sha256')
    .update('new authoritative native TUI frame')
    .digest('hex');

  assert.equal(
    classifyApiRestartFrameReference({
      beforeSourceSha256,
      afterSourceSha256: beforeSourceSha256,
    }),
    'uninterrupted',
  );
  assert.equal(
    classifyApiRestartFrameReference({
      beforeSourceSha256,
      afterSourceSha256: changedSourceSha256,
    }),
    'same-epoch-fresh-peer',
  );
  assert.throws(
    () =>
      classifyApiRestartFrameReference({
        beforeSourceSha256,
        afterSourceSha256: 'not-a-digest',
      }),
    /afterSourceSha256 must be a SHA-256 digest/u,
  );
});

test('exact runtime process identity tolerates AIO command echo but requires one nonce-bound marker', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const marker = `CAP_REAL_CLI_PROCESS_ID_${nonce}`;
  assert.deepEqual(parseExactRuntimeProcessIdentityOutput(`${marker} 97 303\r\n`, nonce), {
    pid: 97,
    startTimeTicks: 303,
  });
  assert.deepEqual(
    parseExactRuntimeProcessIdentityOutput(
      `sh -lc 'IDENTITY_PREFIX=CAP_REAL_CLI_PROCESS_ID_ && IDENTITY_NONCE=${nonce}'\r\n` +
        `${marker} 97 303\r\ngem@aio:~$ `,
      nonce,
    ),
    { pid: 97, startTimeTicks: 303 },
  );
  const wrongNonce = 'fedcba9876543210fedcba9876543210';
  for (const output of [
    '',
    '97 303\n',
    `${marker} 0 303\n`,
    `${marker} 97 0\n`,
    `${marker} 97 303 extra\n`,
    `${marker} 97 303\n${marker} 97 303\n`,
    `${marker} 97 303\n${marker} 98 304\n`,
    `CAP_REAL_CLI_PROCESS_ID_${wrongNonce} 97 303\n`,
    'CAP_REAL_CLI_PROCESS_ID_invalid 97 303\n',
    `${marker} 97 -303\n`,
    `${marker} 9007199254740992 303\n`,
  ]) {
    assert.equal(parseExactRuntimeProcessIdentityOutput(output, nonce), null);
  }
  assert.equal(parseExactRuntimeProcessIdentityOutput(`${marker} 97 303\n`, 'invalid'), null);
});

test('exact runtime process identity probe keeps its complete marker out of echoed command text', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const command = buildExactRuntimeProcessIdentityProbeCommand({
    runtimeId: 'codex',
    taskId: 'probe-task',
    nonce,
  });
  assert.equal(command.includes(`CAP_REAL_CLI_PROCESS_ID_${nonce}`), false);
  assert.match(command, /tmux display-message/u);
  assert.match(command, /PANE_TTY/u);
  assert.match(command, /sh\|bash\|dash\|ash\|zsh\|busybox/u);
  assert.equal(spawnSync('bash', ['--noprofile', '--norc', '-n', '-c', command]).status, 0);
  assert.throws(
    () =>
      buildExactRuntimeProcessIdentityProbeCommand({
        runtimeId: 'codex',
        taskId: 'probe-task',
        nonce: 'invalid',
      }),
    /nonce must be 32 hex characters/u,
  );
});

test('nested canary cleanup errors remain observable instead of collapsing arrays', () => {
  const formatted = formatCanaryErrorTree(
    new AggregateError(
      [new Error('primary failed'), new AggregateError([new Error('cleanup failed')], 'cleanup tree')],
      'canary and cleanup failed',
    ),
  );
  assert.equal(formatted.message, 'canary and cleanup failed');
  assert.equal(formatted.errors[0].message, 'primary failed');
  assert.equal(formatted.errors[1].message, 'cleanup tree');
  assert.equal(formatted.errors[1].errors[0].message, 'cleanup failed');
});

test('real provider selection is mandatory and invalid values fail closed', () => {
  assert.throws(
    () => parseArgs(['--rootfs', '/unused-test-rootfs']),
    /--provider is required/,
  );
  assert.throws(
    () =>
      parseArgs([
        '--provider',
        'docker',
        '--rootfs',
        '/unused-test-rootfs',
      ]),
    /--provider must be boxlite or aio/,
  );
});

test('AIO release auth defaults to atomic stdin and unsafe preload stays ineligible', () => {
  const aioBase = [
    '--provider',
    'aio',
    '--endpoint',
    'http://127.0.0.1:18100',
    '--aio-state-ownership',
    'isolated-disposable',
  ];
  const atomic = parseArgs([...aioBase, '--runtime', 'codex']);
  assert.equal(atomic.auth, 'stdin');
  assert.equal(atomic.releaseGateEligible, true);
  assert.equal(atomic.unsafePreloadedCredentialHandoff, false);

  assert.throws(
    () =>
      parseArgs([
        ...aioBase,
        '--auth',
        'stdin',
        '--runtime',
        'both',
      ]),
    /requires exactly one --runtime value/u,
  );
  assert.throws(
    () =>
      parseArgs([
        ...aioBase,
        '--auth',
        'preloaded',
        '--runtime',
        'codex',
      ]),
    /requires --unsafe-preloaded-credential-handoff acknowledged/u,
  );
  assert.throws(
    () =>
      parseArgs([
        ...aioBase,
        '--auth',
        'stdin',
        '--runtime',
        'codex',
        '--unsafe-preloaded-credential-handoff',
        'acknowledged',
      ]),
    /invalid with AIO --auth stdin/u,
  );

  const unsafe = parseArgs([
    ...aioBase,
    '--auth',
    'preloaded',
    '--runtime',
    'both',
    '--unsafe-preloaded-credential-handoff',
    'acknowledged',
  ]);
  assert.equal(unsafe.releaseGateEligible, false);
  assert.equal(unsafe.unsafePreloadedCredentialHandoff, true);
});

test('AIO fault relay preserves normal close handshakes outside the injected owner fault', async () => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolvePromise, reject) => {
    upstream.once('listening', resolvePromise);
    upstream.once('error', reject);
  });
  const address = upstream.address();
  assert(address && typeof address === 'object');
  const upstreamClose = new Promise((resolvePromise) => {
    upstream.once('connection', (socket) => {
      socket.once('close', (code) => resolvePromise(code));
    });
  });
  const relay = await createAioTerminalFaultRelay(
    `ws://127.0.0.1:${address.port}`,
  );
  try {
    const client = new WebSocket(relay.wsUrl);
    await new Promise((resolvePromise, reject) => {
      client.once('open', resolvePromise);
      client.once('error', reject);
    });
    await relay.waitForActiveConnections(1);
    client.close(1000, 'normal viewer cleanup');
    assert.equal(await upstreamClose, 1000);
    await relay.waitForActiveConnections(0);
  } finally {
    await relay.close();
    await new Promise((resolvePromise) => upstream.close(resolvePromise));
  }
});

function fakeBoxLiteClient(initialSandboxes = []) {
  const sandboxes = [...initialSandboxes];
  const deleted = [];
  return {
    sandboxes,
    deleted,
    async listSandboxes() {
      return sandboxes.map((sandbox) => ({ ...sandbox }));
    },
    async deleteSandbox(sandboxId) {
      deleted.push(sandboxId);
      const index = sandboxes.findIndex((sandbox) => sandbox.id === sandboxId);
      if (index >= 0) sandboxes.splice(index, 1);
    },
    async getSandbox(sandboxId) {
      return sandboxes.find((sandbox) => sandbox.id === sandboxId) ?? null;
    },
  };
}

test('a start failure retains and exact-cleans the partial BoxLite identity', async () => {
  const baseline = { id: 'baseline-box', taskId: 'unrelated' };
  const partial = { id: 'partial-box', taskId: 'cap-real-cli-partial' };
  const client = fakeBoxLiteClient([baseline, partial]);
  client.createSandbox = async ({ onSandboxCreateObserved }) => {
    await onSandboxCreateObserved({
      kind: 'created',
      providerSandboxId: partial.id,
    });
    throw new BoxLitePartialCreateError(partial, new Error('start failed'));
  };

  const attempt = beginBoxLiteCreateAttempt({
    client,
    boxName: partial.taskId,
    baselineSandboxIds: [baseline.id],
    request: { taskId: partial.taskId, sandboxId: partial.taskId },
  });
  await assert.rejects(attempt.promise, BoxLitePartialCreateError);
  await cleanupBoxLiteCreateAttempt(attempt, {
    timeoutMs: 100,
    quietMs: 0,
    retryMs: 0,
  });

  assert.deepEqual(client.deleted, [partial.id]);
  assert.deepEqual(client.sandboxes, [baseline]);
});

test('an aborted lost create response reconciles a late box by unique name', async () => {
  const baseline = { id: 'baseline-box', taskId: 'unrelated' };
  const late = { id: 'late-box', taskId: 'cap-real-cli-late' };
  const client = fakeBoxLiteClient([baseline]);
  client.createSandbox = ({ cancellationSignal }) =>
    new Promise((resolve, reject) => {
      cancellationSignal.addEventListener(
        'abort',
        () => {
          setTimeout(() => client.sandboxes.push(late), 15);
          reject(cancellationSignal.reason);
        },
        { once: true },
      );
      void resolve;
    });

  const attempt = beginBoxLiteCreateAttempt({
    client,
    boxName: late.taskId,
    baselineSandboxIds: [baseline.id],
    request: { taskId: late.taskId, sandboxId: late.taskId },
  });
  await cleanupBoxLiteCreateAttempt(attempt, {
    timeoutMs: 250,
    quietMs: 50,
    retryMs: 5,
  });

  assert.deepEqual(client.deleted, [late.id]);
  assert.deepEqual(client.sandboxes, [baseline]);
});

test('the real BoxLite client start-failure path exact-cleans its partial box', async () => {
  const boxes = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/default/boxes') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ boxes }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/default/boxes') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const created = {
          box_id: 'partial-http-box',
          name: body.name,
          status: 'created',
        };
        boxes.push(created);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(created));
      });
      return;
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/v1/default/boxes/partial-http-box/start'
    ) {
      response.statusCode = 500;
      response.end('start fault');
      return;
    }
    if (
      request.method === 'DELETE' &&
      url.pathname === '/v1/default/boxes/partial-http-box'
    ) {
      boxes.splice(0, boxes.length);
      response.statusCode = 204;
      response.end();
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/v1/default/boxes/partial-http-box'
    ) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    const client = new BoxLiteRestClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      protocolMode: 'native',
      pathPrefix: 'default',
      timeoutMs: 1_000,
    });
    const attempt = beginBoxLiteCreateAttempt({
      client,
      boxName: 'cap-real-cli-partial-http',
      baselineSandboxIds: [],
      request: {
        taskId: 'cap-real-cli-partial-http',
        sandboxId: 'cap-real-cli-partial-http',
        rootfsPath: '/unused-test-rootfs',
        diskSizeGb: 8,
      },
    });
    await assert.rejects(attempt.promise, BoxLitePartialCreateError);
    await cleanupBoxLiteCreateAttempt(attempt, {
      timeoutMs: 500,
      quietMs: 20,
      retryMs: 5,
    });
    assert.deepEqual(boxes, []);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SIGTERM during a committed real-CLI create exits 143 without a new box', async () => {
  const baseline = {
    box_id: 'baseline-real-cli-box',
    name: 'unrelated-real-cli-box',
    status: 'stopped',
  };
  const boxes = [baseline];
  let resolveCreateSeen;
  const createSeen = new Promise((resolve) => {
    resolveCreateSeen = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/default/boxes') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ boxes }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/default/boxes') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        boxes.push({
          box_id: 'late-real-cli-box',
          name: body.name,
          status: 'created',
        });
        resolveCreateSeen();
      });
      return;
    }
    if (
      request.method === 'DELETE' &&
      url.pathname === '/v1/default/boxes/late-real-cli-box'
    ) {
      const index = boxes.findIndex(
        (box) => box.box_id === 'late-real-cli-box',
      );
      if (index >= 0) boxes.splice(index, 1);
      response.statusCode = 204;
      response.end();
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/v1/default/boxes/late-real-cli-box'
    ) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const child = spawn(
    process.execPath,
    [
      SCRIPT_PATH,
      '--provider',
      'boxlite',
      '--endpoint',
      `http://127.0.0.1:${address.port}`,
      '--rootfs',
      '/unused-test-rootfs',
      '--runtime',
      'codex',
      '--auth',
      'none',
      '--surface',
      'direct',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  try {
    await createSeen;
    assert.equal(child.kill('SIGTERM'), true);
    assert.deepEqual(await exit, { code: 143, signal: null });
    assert.deepEqual(boxes, [baseline]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('tmux cleanup failure cannot skip credential adapter or workspace cleanup', async () => {
  const commands = [];
  let credentialAdapterSettled = false;
  const commandExecutor = {
    async exec({ command }) {
      commands.push(command);
      if (command.startsWith('tmux kill-session')) {
        return { exitCode: 73, timedOut: false, output: 'injected tmux fault' };
      }
      if (command.includes('tmux has-session')) {
        return { exitCode: 1, timedOut: false, output: '' };
      }
      return { exitCode: 0, timedOut: false, output: '' };
    },
  };

  await assert.rejects(
    cleanupRuntimeResources({
      commandExecutor,
      taskId: 'cleanup-barrier-test',
      runtimeId: 'codex',
      runtimeSecurityAdapter: {
        async settleCredentialSafety() {
          credentialAdapterSettled = true;
        },
      },
      provider: 'aio',
      ownsAioState: true,
    }),
    AggregateError,
  );

  assert.equal(credentialAdapterSettled, true);
  assert.equal(
    commands.some((command) => command === 'rm -rf /home/gem/.codex'),
    true,
  );
  assert.equal(
    commands.some((command) => command === 'rm -rf -- /home/gem/workspace'),
    true,
  );
  assert.equal(
    commands.some((command) => command === 'test ! -e /home/gem/.codex'),
    true,
  );
  assert.equal(
    commands.some((command) => command === 'test ! -e /home/gem/workspace'),
    true,
  );
});

test('failed cleanup remains owned, retries, and concurrent cleanup is single-flight', async () => {
  const key = `cleanup-retry-${randomUUID()}`;
  let attempts = 0;
  let notifyRetryStarted;
  let releaseRetry;
  const retryStarted = new Promise((resolveStarted) => {
    notifyRetryStarted = resolveStarted;
  });
  const retryBarrier = new Promise((resolveRetry) => {
    releaseRetry = resolveRetry;
  });
  registerExactCleanup(key, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('injected cleanup failure');
    notifyRetryStarted();
    await retryBarrier;
  });

  const failedFirst = cleanupAll();
  const failedConcurrent = cleanupAll();
  assert.strictEqual(failedConcurrent, failedFirst);
  await assert.rejects(failedFirst, /provider canary cleanup failed/u);
  assert.equal(attempts, 1);

  const retry = cleanupAll();
  const retryConcurrent = cleanupAll();
  assert.notStrictEqual(retry, failedFirst);
  assert.strictEqual(retryConcurrent, retry);
  await retryStarted;
  assert.equal(attempts, 2);
  releaseRetry();
  await retry;
  assert.equal(attempts, 2);
});
