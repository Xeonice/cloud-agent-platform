#!/usr/bin/env node

/**
 * Real provider canary for terminal reconnect through a fresh PTY + tmux client.
 *
 * The fixture paints once and then sleeps. Two independent provider terminal
 * connections attach after that point, each backed by a brand-new headless xterm.
 * A pass means the second empty xterm reconstructed the complete current screen
 * from tmux's fresh-client redraw, without replaying PTY history or relying on new
 * application output.
 *
 * BoxLite (the script owns and deletes a throwaway box):
 *   BOXLITE_ROOTFS_PATH=/absolute/path/to/oci \
 *     node scripts/terminal-fresh-attach-canary.mjs boxlite \
 *       --endpoint http://127.0.0.1:8100 --playwright
 *
 * AIO (point at an isolated, throwaway AIO sandbox; the script only owns its
 * uniquely named tmux server and never deletes the sandbox/container):
 *   node scripts/terminal-fresh-attach-canary.mjs aio \
 *     --endpoint http://127.0.0.1:18080
 *
 * BOXLITE_API_TOKEN is read only from the environment and is never logged.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const requireFromApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
// `@xterm/headless` is declared by apps/web, NOT by apps/api. Commit 68c0907
// dropped it from apps/api's dependencies in the same change that started
// resolving it from there, so this line has thrown `Cannot find module` ever
// since — unnoticed because nothing ran these canaries. Resolve it from the
// package that actually declares it, following the same convention as the
// `ws` lookup above.
const requireFromWeb = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const { Terminal } = requireFromWeb('@xterm/headless');
const WebSocket = requireFromApi('ws');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_HISTORY_LINES = 0;
const DEFAULT_TMUX_MODE = 'isolated';
const STRICT_HISTORY_LINES = 50_000;
const CONNECT_TIMEOUT_MS = 15_000;
const SCREEN_TIMEOUT_MS = 15_000;
const PRESSURE_TIMEOUT_MS = 120_000;
const QUIET_WINDOW_MS = 300;
const SURPLUS_WINDOW_SECONDS = '0.30';
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLEANUP_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 100;

let sandboxProductModulePromise = null;

export function createCanaryLifecycle({
  cleanupAttempts = CLEANUP_ATTEMPTS,
  cleanupRetryDelayMs = CLEANUP_RETRY_DELAY_MS,
} = {}) {
  const controller = new AbortController();
  let stoppingSignal = null;
  let runPromise = Promise.resolve();
  let cleanup = async () => {};
  let cleanupPromise = null;
  let cleanupComplete = false;
  let cleanupEvidence;

  const lifecycle = {
    get signal() {
      return controller.signal;
    },
    get stopping() {
      return stoppingSignal !== null;
    },
    get stoppingSignal() {
      return stoppingSignal;
    },
    get cleanupEvidence() {
      return cleanupEvidence;
    },
    requestStop(signal) {
      if (stoppingSignal !== null) return false;
      stoppingSignal = signal;
      controller.abort(
        new Error(`terminal canary stopping after ${String(signal)}`),
      );
      return true;
    },
    assertCanCreate(label) {
      if (!controller.signal.aborted && stoppingSignal === null) return;
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error(`terminal canary stopped before creating ${label}`);
    },
    registerCleanup(fn) {
      if (typeof fn !== 'function') {
        throw new Error('terminal canary cleanup must be a function');
      }
      cleanup = fn;
    },
    trackRun(promise) {
      runPromise = Promise.resolve(promise);
      return runPromise;
    },
    async waitForRunUnwind() {
      await runPromise.catch(() => undefined);
    },
    runCleanup() {
      if (cleanupComplete) return Promise.resolve();
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        const failures = [];
        for (let attempt = 1; attempt <= cleanupAttempts; attempt += 1) {
          try {
            cleanupEvidence = await cleanup();
            cleanupComplete = true;
            return;
          } catch (error) {
            failures.push(error);
            if (attempt < cleanupAttempts) {
              console.error(
                `[canary] cleanup attempt ${attempt}/${cleanupAttempts} failed; retrying: ${errorMessage(error)}`,
              );
              await delay(cleanupRetryDelayMs);
            }
          }
        }
        throw new AggregateError(
          failures,
          `terminal canary cleanup failed after ${cleanupAttempts} attempts`,
        );
      })();
      return cleanupPromise.finally(() => {
        if (!cleanupComplete) cleanupPromise = null;
      });
    },
  };
  return lifecycle;
}

function installSignalCleanup(lifecycle) {
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      lifecycle.requestStop(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}

export async function drainConnectionRegistry(connections) {
  const failures = [];
  while (connections.size > 0) {
    const batch = [...connections];
    const results = await Promise.allSettled(
      batch.map((connection) => connection.close()),
    );
    let removed = 0;
    for (let index = 0; index < batch.length; index += 1) {
      const result = results[index];
      if (result.status === 'fulfilled') {
        if (connections.delete(batch[index])) removed += 1;
      } else {
        failures.push(result.reason);
      }
    }
    if (failures.length > 0 || removed === 0) break;
  }
  if (failures.length > 0 || connections.size > 0) {
    throw new AggregateError(
      failures.length > 0
        ? failures
        : [new Error('terminal connection cleanup made no progress')],
      'terminal connection registry did not drain',
    );
  }
}

async function runCanary(options, registerCleanup, lifecycle) {
  lifecycle.assertCanCreate('canary resources');
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const socketName = `capfresh${nonce}`;
  const sessionName =
    options.tmuxMode === 'product' ? `task${nonce}` : 'fixture';
  const pressureSessionName =
    options.tmuxMode === 'product'
      ? `task${nonce}pressure`
      : 'pressure';
  const ownedSessionNames = new Set([sessionName, pressureSessionName]);
  const setupDone = `CAP_SETUP_DONE_${nonce}`;
  const framePrefix = `CAP_FRAME_${nonce}`;
  const expectedLines = buildExpectedLines(framePrefix, options.rows);
  const openConnections = new Set();
  const exactTempFiles = new Set();
  const terminalIdentities = [];
  const seenTerminalIds = new Set();
  let provider = null;
  let providerCleanup = async () => {};
  registerCleanup(async () => {
    const cleanupFailures = [];
    if (options.provider === 'aio' && provider) {
      try {
        await provider.execCleanup({
          tmuxMode: options.tmuxMode,
          socketName,
          sessionNames: [...ownedSessionNames],
          exactTempFiles: [...exactTempFiles],
        });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await drainConnectionRegistry(openConnections);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await providerCleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'terminal canary cleanup failed');
    }
    return (
      provider?.cleanupEvidence ??
      providerCleanup.evidence ?? { result: 'PASS', providerResourceCreated: false }
    );
  });
  provider = await createProvider(
    options,
    nonce,
    (fn) => {
      providerCleanup = fn;
    },
    lifecycle,
  );
  if (options.provider === 'aio') {
    await provider.prepareCleanupControl();
  }

  console.error(
    `[canary] provider=${options.provider} tmux=${options.tmuxMode} ` +
      `geometry=${options.cols}x${options.rows}`,
  );

  const recordTerminalIdentity = (role, connection) => {
    const terminalId = connection.id;
    assert(
      typeof terminalId === 'string' && terminalId.length > 0,
      `${role} did not report a provider terminal identity`,
    );
    assert(
      !seenTerminalIds.has(terminalId),
      `${role} reused provider terminal identity ${terminalId}`,
    );
    seenTerminalIds.add(terminalId);
    const evidence = { role, terminalId };
    terminalIdentities.push(evidence);
    return terminalId;
  };

  const setup = await provider.openTerminal(options.cols, options.rows);
  openConnections.add(setup);
  const setupId = recordTerminalIdentity('owner-setup', setup);
  await setup.sendResize(options.cols, options.rows);
  setup.sendInput('stty -echo\n');
  await delay(150, undefined, { signal: lifecycle.signal });
  const setupCommand = buildSetupCommand({
    socketName,
    sessionName,
    tmuxMode: options.tmuxMode,
    markerNonce: nonce,
    expectedLines,
    cols: options.cols,
    rows: options.rows,
  });
  assert(
    !setupCommand.includes(setupDone),
    'setup marker must not appear literally in the submitted command',
  );
  if (process.env.CAP_TERMINAL_CANARY_DEBUG === '1') {
    console.error(`[canary] setup-command=${JSON.stringify(setupCommand)}`);
  }
  provider.markBusinessResourcesMayExist?.();
  setup.sendInput(`${setupCommand}\n`);
  await setup.waitForRaw(setupDone, SCREEN_TIMEOUT_MS);
  await setup.close();
  openConnections.delete(setup);
  await delay(500, undefined, { signal: lifecycle.signal });

  const first = await attachAndCapture({
    provider,
    socketName,
    sessionName,
    tmuxMode: options.tmuxMode,
    expectedLines,
    cols: options.cols,
    rows: options.rows,
  });
  openConnections.add(first.connection);
  const firstState = first.state;
  const firstId = recordTerminalIdentity('viewer-first', first.connection);
  const firstRaw = first.connection.rawOutput();
  await first.connection.close();
  openConnections.delete(first.connection);

  // The fixture is `sleep`, so this gap contains no application output. The
  // second connection must be populated entirely by a fresh tmux client redraw.
  await delay(750, undefined, { signal: lifecycle.signal });

  const second = await attachAndCapture({
    provider,
    socketName,
    sessionName,
    tmuxMode: options.tmuxMode,
    expectedLines,
    cols: options.cols,
    rows: options.rows,
  });
  openConnections.add(second.connection);
  const secondState = second.state;
  const secondId = recordTerminalIdentity('viewer-second', second.connection);
  const secondRaw = second.connection.rawOutput();
  const firstEvidence = rawEvidence(firstRaw);
  const secondEvidence = rawEvidence(secondRaw);

  assert(
    firstId && secondId && firstId !== secondId,
    'provider reused the terminal identity',
  );
  assert(
    firstState.canonical === secondState.canonical,
    `fresh attach states differ\nfirst:  ${firstState.hash}\nsecond: ${secondState.hash}`,
  );
  assertFixtureState(firstState, expectedLines, options.rows);
  assertFixtureState(secondState, expectedLines, options.rows);
  assert(
    firstEvidence.smcup && secondEvidence.smcup,
    'tmux attach did not enter alternate screen',
  );
  assert(
    firstEvidence.clear && secondEvidence.clear,
    'tmux attach did not emit a full-screen clear',
  );

  await second.connection.close();
  openConnections.delete(second.connection);
  let browserEvidence;
  if (options.playwright) {
    lifecycle.assertCanCreate('Playwright browser');
    browserEvidence = await compareBrowserScreens(
      firstRaw,
      secondRaw,
      options.cols,
      options.rows,
      expectedLines,
      lifecycle.signal,
    );
  }
  const pressureEvidence =
    options.historyLines > 0
      ? await runPressureScenario({
          provider,
          socketName,
          sessionName: pressureSessionName,
          nonce,
          options,
          lifecycle,
          openConnections,
          recordTerminalIdentity,
        })
      : undefined;
  const byteOracleEvidence = options.byteOracle
    ? await runByteOracleScenario({
        provider,
        nonce,
        socketName,
        options,
        openConnections,
        exactTempFiles,
        ownedSessionNames,
        recordTerminalIdentity,
      })
    : undefined;
  const aioJsonByteProbeEvidence = options.probeAioJsonBytes
    ? await runByteOracleScenario({
        provider,
        nonce,
        options,
        openConnections,
        exactTempFiles,
        recordTerminalIdentity,
        diagnosticJsonProbe: true,
      })
    : undefined;
  const aioBinaryFrameProbeEvidence = options.probeAioBinaryFrame
    ? await runByteOracleScenario({
        provider,
        nonce,
        options,
        openConnections,
        exactTempFiles,
        recordTerminalIdentity,
        diagnosticBinaryFrameProbe: true,
      })
    : undefined;

  const conformance = buildConformanceEvidence({
    options,
    browserEvidence,
    pressureEvidence,
    byteOracleEvidence,
    aioJsonByteProbeEvidence,
    aioBinaryFrameProbeEvidence,
    terminalIdentities,
  });
  if (options.strictConformance) {
    assert(
      conformance.result === 'PASS',
      `strict conformance is incomplete: ${conformance.missing.join(', ')}`,
    );
  }

  return {
    result: conformance.result,
    provider: options.provider,
    tmuxMode: options.tmuxMode,
    sessionName,
    geometry: `${options.cols}x${options.rows}`,
    proof:
      conformance.result === 'PASS'
        ? 'strict product-socket conformance restored the complete current frame without history replay and passed long-output, browser, and opaque-input-byte gates'
        : 'fresh PTY redraw checks passed, but the full strict conformance gate was not satisfied',
    ownerSetupTerminalId: setupId,
    terminalIds: terminalIdentities.map(({ terminalId }) => terminalId),
    terminalIdentities,
    conformance,
    screenStateSha256: secondState.hash,
    firstAttach: firstEvidence,
    secondAttach: secondEvidence,
    expectedRowsVerified: expectedLines.length,
    cursor: { x: secondState.cursorX, y: secondState.cursorY },
    bufferType: secondState.bufferType,
    ...(browserEvidence ? { playwrightScreenshot: browserEvidence } : {}),
    ...(pressureEvidence ? { longOutputPressure: pressureEvidence } : {}),
    ...(byteOracleEvidence ? { opaqueByteOracle: byteOracleEvidence } : {}),
    ...(aioJsonByteProbeEvidence
      ? { aioJsonStringByteProbe: aioJsonByteProbeEvidence }
      : {}),
    ...(aioBinaryFrameProbeEvidence
      ? { aioBinaryFrameByteProbe: aioBinaryFrameProbeEvidence }
      : {}),
    cleanup: provider?.cleanupEvidence ?? { result: 'PENDING' },
  };
}

function buildConformanceEvidence({
  options,
  browserEvidence,
  pressureEvidence,
  byteOracleEvidence,
  aioJsonByteProbeEvidence,
  aioBinaryFrameProbeEvidence,
  terminalIdentities,
}) {
  const roles = new Set(terminalIdentities.map(({ role }) => role));
  const terminalIds = terminalIdentities.map(({ terminalId }) => terminalId);
  const requiredIdentityRoles = [
    'owner-setup',
    'viewer-first',
    'viewer-second',
    'pressure-owner-setup',
    'pressure-viewer-live',
    'pressure-viewer-paused',
    'pressure-viewer-third',
    'byte-oracle',
    ...(options.provider === 'aio'
      ? ['byte-oracle-owner-setup', 'byte-oracle-injector']
      : []),
  ];
  const checks = {
    productDefaultSocket: options.tmuxMode === 'product',
    historyAtLeast50000:
      pressureEvidence?.result === 'PASS' &&
      pressureEvidence.historyLinesRequested >= STRICT_HISTORY_LINES &&
      pressureEvidence.historyMarkerCount >= STRICT_HISTORY_LINES,
    playwrightCurrentFrame:
      browserEvidence?.identical === true &&
      browserEvidence.nonBlank === true &&
      pressureEvidence?.playwrightScreenshot?.identical === true &&
      pressureEvidence.playwrightScreenshot.nonBlank === true,
    opaqueByteOracle: byteOracleEvidence?.result === 'PASS',
    distinctOwnerAndViewerIdentities:
      requiredIdentityRoles.every((role) => roles.has(role)) &&
      new Set(terminalIds).size === terminalIds.length,
  };
  const missing = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const diagnostics = {
    ...(aioJsonByteProbeEvidence
      ? { aioJsonStringBytes: aioJsonByteProbeEvidence.result }
      : {}),
    ...(aioBinaryFrameProbeEvidence
      ? { aioBinaryFrame: aioBinaryFrameProbeEvidence.result }
      : {}),
  };
  return {
    result: missing.length === 0 ? 'PASS' : 'UNVERIFIED',
    strictRequested: options.strictConformance,
    checks,
    missing,
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
  };
}

async function runByteOracleScenario({
  provider,
  nonce,
  socketName,
  options,
  openConnections,
  exactTempFiles,
  ownedSessionNames,
  recordTerminalIdentity,
  diagnosticJsonProbe = false,
  diagnosticBinaryFrameProbe = false,
}) {
  const diagnosticProbe =
    diagnosticJsonProbe || diagnosticBinaryFrameProbe;
  const readyMarker = `CAP_BYTE_ORACLE_READY_${nonce}`;
  const resultMarker = `CAP_BYTE_ORACLE_RESULT_${nonce}`;
  const byteFile = `/tmp/cap-byte-oracle-${nonce}.bin`;
  const surplusFile = `/tmp/cap-byte-oracle-${nonce}.surplus.bin`;
  exactTempFiles.add(byteFile);
  exactTempFiles.add(surplusFile);
  const fullRange = diagnosticProbe
    ? Buffer.from([0x80, 0xff])
    : Buffer.from(Array.from({ length: 256 }, (_, value) => value));
  const utf8 = diagnosticProbe
    ? Buffer.alloc(0)
    : Buffer.from('中文🙂', 'utf8');
  const legacyMouse = diagnosticProbe
    ? Buffer.alloc(0)
    : Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0xff, 0x80]);
  const payload = Buffer.concat([fullRange, utf8, legacyMouse]);
  const expectedSha256 = createHash('sha256').update(payload).digest('hex');
  const command = [
    `cap_oracle_nonce=${shellQuote(nonce)}`,
    `cap_byte_file=${shellQuote(byteFile)}`,
    `cap_surplus_file=${shellQuote(surplusFile)}`,
    'stty raw -echo',
    `printf '\\r\\nCAP_BYTE_ORACLE_READY_%s\\r\\n' "$cap_oracle_nonce"`,
    `dd if=/dev/stdin of="$cap_byte_file" bs=1 count=${payload.byteLength} 2>/dev/null`,
    `timeout ${SURPLUS_WINDOW_SECONDS} dd if=/dev/stdin of="$cap_surplus_file" bs=4096 2>/dev/null || true`,
    'stty sane',
    'cap_byte_size=$(wc -c < "$cap_byte_file" | tr -d " \\n")',
    'cap_surplus_size=$(wc -c < "$cap_surplus_file" | tr -d " \\n")',
    'cap_byte_sha=$(sha256sum "$cap_byte_file" | cut -d " " -f 1)',
    'rm -f -- "$cap_byte_file" "$cap_surplus_file"',
    `printf '\\r\\nCAP_BYTE_ORACLE_RESULT_%s size=%s surplus=%s sha256=%s\\r\\n' "$cap_oracle_nonce" "$cap_byte_size" "$cap_surplus_size" "$cap_byte_sha"`,
  ].join('; ');
  assert(
    !command.includes(readyMarker) && !command.includes(resultMarker),
    'byte-oracle marker must not appear literally in the submitted command',
  );

  console.error(
    `[canary] ${
      diagnosticJsonProbe
        ? 'AIO JSON byte probe'
        : diagnosticBinaryFrameProbe
          ? 'AIO binary-frame byte probe'
          : 'opaque-byte oracle'
    } ` +
      `bytes=${payload.byteLength} ` +
      `provider=${options.provider}`,
  );

  if (options.provider === 'aio' && !diagnosticProbe) {
    assert(
      options.tmuxMode === 'product',
      'AIO formal byte oracle requires --tmux-mode product',
    );
    assert(
      typeof socketName === 'string' && ownedSessionNames instanceof Set,
      'AIO product byte oracle did not receive its owned-session boundary',
    );
    return runAioProductByteOracleScenario({
      provider,
      nonce,
      options,
      openConnections,
      ownedSessionNames,
      recordTerminalIdentity,
      readyMarker,
      resultMarker,
      command,
      payload,
      expectedSha256,
      fullRange,
      utf8,
      legacyMouse,
    });
  }

  const connection = await provider.openTerminal(options.cols, options.rows);
  openConnections.add(connection);
  recordTerminalIdentity(
    diagnosticJsonProbe
      ? 'aio-json-byte-probe'
      : diagnosticBinaryFrameProbe
        ? 'aio-binary-frame-probe'
        : 'byte-oracle',
    connection,
  );
  try {
    await connection.sendResize(options.cols, options.rows);
    connection.sendInput(`${command}\n`);
    await connection.waitForRaw(readyMarker, SCREEN_TIMEOUT_MS);
    if (diagnosticJsonProbe) {
      connection.sendAioJsonStringBytesForProbe(payload);
    } else if (diagnosticBinaryFrameProbe) {
      connection.sendAioBinaryFrameForProbe(payload);
    } else {
      connection.sendOpaqueInputBytes(payload);
    }
    await connection.waitForRaw(resultMarker, SCREEN_TIMEOUT_MS);
    await connection.drain();
    const text = connection.rawOutput().toString('utf8');
    const markerOffset = text.lastIndexOf(`${resultMarker} `);
    const line =
      markerOffset === -1
        ? null
        : text.slice(markerOffset).split(/\r?\n/u, 1)[0].replace(/\r$/u, '');
    if (!line) {
      throw new Error(
        `opaque-byte oracle result is missing\n${text.slice(-2_048)}`,
      );
    }
    const match =
      /^\S+ size=(\d+) surplus=(\d+) sha256=([0-9a-f]{64})$/u.exec(line);
    if (!match) throw new Error(`malformed opaque-byte oracle result: ${line}`);
    const actualSize = Number(match[1]);
    const surplusBytes = Number(match[2]);
    const actualSha256 = match[3];
    const lossless =
      actualSize === payload.byteLength &&
      surplusBytes === 0 &&
      actualSha256 === expectedSha256;
    if (!diagnosticProbe) {
      assert(
        actualSize === payload.byteLength,
        `opaque-byte size mismatch: ${actualSize}/${payload.byteLength}`,
      );
      assert(
        actualSha256 === expectedSha256,
        `opaque-byte hash mismatch: ${actualSha256}/${expectedSha256}`,
      );
      assert(
        surplusBytes === 0,
        `opaque-byte input emitted ${surplusBytes} surplus byte(s)`,
      );
    }
    return {
      result: diagnosticProbe ? 'UNVERIFIED' : 'PASS',
      ...(diagnosticProbe
        ? {
            observation: lossless ? 'LOSSLESS' : 'REWRITTEN',
            verified: false,
            bytePreservingClaim: false,
            outputSemantics: 'aio-json-v1 UTF-8 terminal text only',
          }
        : {}),
      bytes: payload.byteLength,
      expectedSha256,
      actualSha256,
      surplusBytes,
      surplusWindowMs: Number(SURPLUS_WINDOW_SECONDS) * 1_000,
      fullRangeBytes: fullRange.byteLength,
      utf8Bytes: utf8.byteLength,
      legacyMouseHex: legacyMouse.toString('hex'),
    };
  } finally {
    await connection.close();
    openConnections.delete(connection);
  }
}

async function runAioProductByteOracleScenario({
  provider,
  nonce,
  options,
  openConnections,
  ownedSessionNames,
  recordTerminalIdentity,
  readyMarker,
  resultMarker,
  command,
  payload,
  expectedSha256,
  fullRange,
  utf8,
  legacyMouse,
}) {
  const byteTaskId = `${nonce}byte`;
  const byteSessionName = `task${byteTaskId}`;
  const setupMarker = `CAP_BYTE_SESSION_SETUP_${nonce}`;
  ownedSessionNames.add(byteSessionName);

  const setupCommand = buildAioByteOracleSessionSetupCommand({
    taskId: byteTaskId,
    markerNonce: nonce,
    fixtureCommand: command,
    cols: options.cols,
    rows: options.rows,
  });
  assert(
    !setupCommand.includes(setupMarker) &&
      !setupCommand.includes(readyMarker) &&
      !setupCommand.includes(resultMarker),
    'AIO product byte-oracle markers must not appear literally in the setup command',
  );

  const setup = await provider.openTerminal(options.cols, options.rows);
  openConnections.add(setup);
  const setupId = recordTerminalIdentity('byte-oracle-owner-setup', setup);
  assert(
    CANONICAL_UUID_PATTERN.test(setupId),
    `unsafe AIO byte-oracle owner terminal id: ${setupId}`,
  );
  try {
    await setup.sendResize(options.cols, options.rows);
    setup.sendInput('stty -echo\n');
    await delay(100, undefined, { signal: setup.signal });
    assert(
      setup.sendInput(`${setupCommand}\n`),
      'AIO byte-oracle task session setup command could not be sent',
    );
    await setup.waitForRaw(setupMarker, SCREEN_TIMEOUT_MS);
    await setup.drain();
    const setupText = setup.rawOutput().toString('utf8');
    assert(
      setupText.includes(`${setupMarker} status=0`),
      `AIO byte-oracle task session setup failed\n${setupText.slice(-2_048)}`,
    );
  } finally {
    await setup.close();
    openConnections.delete(setup);
  }

  const connection = await provider.openProductOpaqueViewer({
    taskId: byteTaskId,
    cols: options.cols,
    rows: options.rows,
  });
  openConnections.add(connection);
  const mainId = recordTerminalIdentity('byte-oracle', connection);
  const injectorId = recordTerminalIdentity('byte-oracle-injector', {
    id: connection.injectorId,
  });
  assert(
    CANONICAL_UUID_PATTERN.test(mainId) &&
      CANONICAL_UUID_PATTERN.test(injectorId) &&
      mainId !== injectorId,
    'AIO product byte oracle did not expose two distinct canonical viewer identities',
  );

  try {
    assert(
      connection.opaqueInputCapability === 'byte-preserving',
      'AIO product viewer did not advertise byte-preserving opaque input',
    );
    await connection.waitForRaw(readyMarker, SCREEN_TIMEOUT_MS);
    const writeOutcome = connection.sendOpaqueInputBytes(payload);
    assert(
      writeOutcome === 'written',
      `AIO product viewer opaque input was not written: ${writeOutcome}`,
    );
    await connection.waitForRaw(resultMarker, SCREEN_TIMEOUT_MS);
    await connection.drain();
    const { actualSize, surplusBytes, actualSha256 } =
      parseByteOracleResult(connection.rawOutput(), resultMarker);
    assert(
      actualSize === payload.byteLength,
      `opaque-byte size mismatch: ${actualSize}/${payload.byteLength}`,
    );
    assert(
      actualSha256 === expectedSha256,
      `opaque-byte hash mismatch: ${actualSha256}/${expectedSha256}`,
    );
    assert(
      surplusBytes === 0,
      `opaque-byte input emitted ${surplusBytes} surplus byte(s)`,
    );

    await connection.close();
    openConnections.delete(connection);
    return {
      result: 'PASS',
      bytes: payload.byteLength,
      expectedSha256,
      actualSha256,
      surplusBytes,
      surplusWindowMs: Number(SURPLUS_WINDOW_SECONDS) * 1_000,
      fullRangeBytes: fullRange.byteLength,
      utf8Bytes: utf8.byteLength,
      legacyMouseHex: legacyMouse.toString('hex'),
      inputPath: 'aio-product-viewer-send-keys-H',
      oracleScope: 'input-bytes-observed-in-target-pane',
      outputSemantics: 'aio-json-v1 UTF-8 terminal text only',
      outputBytePreservingClaim: false,
      productViewerTerminalIds: { main: mainId, injector: injectorId },
      productViewerSockets: connection.closeEvidence,
    };
  } finally {
    await connection.close();
    openConnections.delete(connection);
  }
}

function buildAioByteOracleSessionSetupCommand({
  taskId,
  markerNonce,
  fixtureCommand,
  cols,
  rows,
}) {
  const sessionName = `task${taskId}`;
  assert(
    /^[A-Za-z0-9_.-]+$/u.test(sessionName),
    `unsafe AIO byte-oracle task session name: ${sessionName}`,
  );
  return [
    `cap_byte_setup_nonce=${shellQuote(markerNonce)}`,
    `tmux -u new-session -d -s ${sessionName} -x ${cols} -y ${rows} ${shellQuote(fixtureCommand)}`,
    'cap_byte_setup_status=$?',
    `printf '\\r\\nCAP_BYTE_SESSION_SETUP_%s status=%s\\r\\n' "$cap_byte_setup_nonce" "$cap_byte_setup_status"`,
  ].join('; ');
}

function parseByteOracleResult(raw, resultMarker) {
  const text = raw.toString('utf8');
  const markerOffset = text.lastIndexOf(`${resultMarker} `);
  const line =
    markerOffset === -1
      ? null
      : text.slice(markerOffset).split(/\r?\n/u, 1)[0].replace(/\r$/u, '');
  if (!line) {
    throw new Error(
      `opaque-byte oracle result is missing\n${text.slice(-2_048)}`,
    );
  }
  const match = /^\S+ size=(\d+) surplus=(\d+) sha256=([0-9a-f]{64})$/u.exec(
    line,
  );
  if (!match) throw new Error(`malformed opaque-byte oracle result: ${line}`);
  return {
    actualSize: Number(match[1]),
    surplusBytes: Number(match[2]),
    actualSha256: match[3],
  };
}

async function runPressureScenario({
  provider,
  socketName,
  sessionName,
  nonce,
  options,
  lifecycle,
  openConnections,
  recordTerminalIdentity,
}) {
  const setupDone = `CAP_PRESSURE_SETUP_DONE_${nonce}`;
  const framePrefix = `CAP_PRESSURE_FRAME_${nonce}`;
  const historyPrefix = `CAP_HISTORY_${nonce}`;
  const liveToken = `CAP_PRESSURE_LIVE_TRIGGER_${nonce}`;
  const liveRow = Math.min(6, options.rows);
  const expectedLines = buildExpectedLines(framePrefix, options.rows);
  const liveExpectedLines = [...expectedLines];
  liveExpectedLines[liveRow - 1] =
    `${framePrefix}|ROW-${String(liveRow).padStart(2, '0')}|LIVE-AFTER-RECONNECT`;
  const timeoutMs = PRESSURE_TIMEOUT_MS;

  console.error(
    `[canary] long-output pressure lines=${options.historyLines} buffer=normal`,
  );

  const setup = await provider.openTerminal(options.cols, options.rows);
  openConnections.add(setup);
  const setupId = recordTerminalIdentity('pressure-owner-setup', setup);
  await setup.sendResize(options.cols, options.rows);
  setup.sendInput('stty -echo\n');
  await delay(150, undefined, { signal: setup.signal });
  const setupCommand = buildPressureSetupCommand({
    socketName,
    sessionName,
    tmuxMode: options.tmuxMode,
    markerNonce: nonce,
    historyPrefix,
    historyLines: options.historyLines,
    liveToken,
    liveExpectedLine: liveExpectedLines[liveRow - 1],
    liveRow,
    expectedLines,
    cols: options.cols,
    rows: options.rows,
  });
  assert(
    !setupCommand.includes(setupDone) &&
      !setupCommand.includes(`CAP_PRESSURE_SETUP_${socketName}`),
    'pressure markers must not appear literally in the submitted command',
  );
  if (options.provider === 'aio') {
    await sendAioChunkedShellCommand(setup, setupCommand, 'pressure');
  } else {
    setup.sendInput(`${setupCommand}\n`);
  }
  await setup.waitForRaw(setupDone, timeoutMs);
  await setup.drain();
  const setupEvidence = parsePressureSetupEvidence(
    setup.rawOutput(),
    nonce,
  );
  await setup.close();
  openConnections.delete(setup);

  assert(
    setupEvidence.historyLimit >= options.historyLines + options.rows,
    `tmux history limit is too small: ${setupEvidence.historyLimit}`,
  );
  assert(
    setupEvidence.historySize >= options.historyLines,
    `tmux retained only ${setupEvidence.historySize}/${options.historyLines} history lines`,
  );
  assert(
    setupEvidence.historyMarkerCount === options.historyLines,
    `tmux history marker count mismatch: ${setupEvidence.historyMarkerCount}/${options.historyLines}`,
  );
  assert(
    setupEvidence.firstSeen && setupEvidence.middleSeen && setupEvidence.lastSeen,
    'tmux history is missing a first, middle, or last sentinel',
  );
  assert(
    setupEvidence.alternateOn === false,
    'pressure pane unexpectedly entered its inner alternate screen',
  );
  assert(setupEvidence.paneDead === false, 'pressure pane exited before attach');

  const baseline = await attachAndCapture({
    provider,
    socketName,
    sessionName,
    tmuxMode: options.tmuxMode,
    expectedLines,
    cols: options.cols,
    rows: options.rows,
    timeoutMs,
  });
  openConnections.add(baseline.connection);
  const baselineId = recordTerminalIdentity(
    'pressure-viewer-live',
    baseline.connection,
  );
  const baselineRaw = baseline.connection.rawOutput();
  const baselineEvidence = rawEvidence(baselineRaw);
  const estimatedHistoryBytes =
    Buffer.byteLength(`${historyPrefix}|LINE-000001|PAYLOAD\n`, 'utf8') *
    options.historyLines;
  assertFixtureState(baseline.state, expectedLines, options.rows);
  assertNoHistoryReplay(baselineRaw, historyPrefix, options.historyLines);
  assert(
    baselineEvidence.bytes < Math.max(16_384, estimatedHistoryBytes / 100),
    `fresh attach was not bounded: ${baselineEvidence.bytes}/${estimatedHistoryBytes} bytes`,
  );

  const paused = await attachAndCapture({
    provider,
    socketName,
    sessionName,
    tmuxMode: options.tmuxMode,
    expectedLines,
    cols: options.cols,
    rows: options.rows,
    timeoutMs,
  });
  openConnections.add(paused.connection);
  const pausedId = recordTerminalIdentity(
    'pressure-viewer-paused',
    paused.connection,
  );
  assert(
    paused.state.canonical === baseline.state.canonical,
    'concurrent pressure viewer did not start from the baseline frame',
  );
  paused.connection.pauseOutput();

  await waitForQuiet(baseline.connection, QUIET_WINDOW_MS, timeoutMs);
  await baseline.connection.drain();
  const preLiveState = canonicalState(
    baseline.connection.term,
    options.cols,
    options.rows,
  );
  assert(
    preLiveState.canonical === baseline.state.canonical,
    'concurrent viewer attachment changed the live viewer frame',
  );
  const liveOffset = baseline.connection.rawOutput().byteLength;
  const liveStartedAt = Date.now();
  assert(
    baseline.connection.sendInput(`${liveToken}\n`),
    'pressure live trigger could not be sent',
  );
  await waitForExpectedScreen(
    baseline.connection,
    liveExpectedLines,
    timeoutMs,
  );
  await waitForQuiet(baseline.connection, QUIET_WINDOW_MS, timeoutMs);
  await baseline.connection.drain();
  const liveLatencyMs = Date.now() - liveStartedAt;
  const liveState = canonicalState(
    baseline.connection.term,
    options.cols,
    options.rows,
  );
  const liveRaw = baseline.connection.rawOutput();
  const liveDelta = liveRaw.subarray(liveOffset);
  const liveMarker = Buffer.from(liveExpectedLines[liveRow - 1], 'utf8');
  assertFixtureState(liveState, liveExpectedLines, options.rows);
  assertOnlyRowsChanged(baseline.state, liveState, [liveRow - 1]);
  assert(
    countBufferOccurrences(liveDelta, liveMarker) === 1,
    'live marker was missing or duplicated in the incremental stream',
  );
  assertNoHistoryReplay(liveDelta, historyPrefix, options.historyLines);
  assert(
    liveDelta.byteLength < 16_384,
    `live update unexpectedly emitted ${liveDelta.byteLength} bytes`,
  );

  paused.connection.resumeOutput();
  await waitForExpectedScreen(
    paused.connection,
    liveExpectedLines,
    timeoutMs,
  );
  await waitForQuiet(paused.connection, QUIET_WINDOW_MS, timeoutMs);
  await paused.connection.drain();
  const resumedState = canonicalState(
    paused.connection.term,
    options.cols,
    options.rows,
  );
  assert(
    resumedState.canonical === liveState.canonical,
    'paused pressure viewer did not converge after resume',
  );
  await paused.connection.close();
  openConnections.delete(paused.connection);

  const liveConnectionId = baseline.connection.id;
  await baseline.connection.close();
  openConnections.delete(baseline.connection);
  await delay(750, undefined, { signal: baseline.connection.signal });

  const freshAfterLive = await attachAndCapture({
    provider,
    socketName,
    sessionName,
    tmuxMode: options.tmuxMode,
    expectedLines: liveExpectedLines,
    cols: options.cols,
    rows: options.rows,
    timeoutMs,
  });
  openConnections.add(freshAfterLive.connection);
  const freshAfterLiveId = recordTerminalIdentity(
    'pressure-viewer-third',
    freshAfterLive.connection,
  );
  const freshAfterLiveRaw = freshAfterLive.connection.rawOutput();
  assert(
    baselineId &&
      freshAfterLiveId &&
      baselineId !== freshAfterLiveId,
    'provider reused the pressure terminal identity',
  );
  assert(
    liveState.canonical === freshAfterLive.state.canonical,
    `incremental state differs from authoritative fresh redraw\nlive:  ${liveState.hash}\nfresh: ${freshAfterLive.state.hash}`,
  );
  assertNoHistoryReplay(
    freshAfterLiveRaw,
    historyPrefix,
    options.historyLines,
  );

  await freshAfterLive.connection.close();
  openConnections.delete(freshAfterLive.connection);

  let browserEvidence;
  if (options.playwright) {
    lifecycle.assertCanCreate('Playwright pressure browser');
    browserEvidence = await compareBrowserScreens(
      liveRaw,
      freshAfterLiveRaw,
      options.cols,
      options.rows,
      liveExpectedLines,
      lifecycle.signal,
    );
  }
  return {
    result: 'PASS',
    proof:
      'tmux retained the numbered long output, a paused concurrent viewer resumed to the live frame, and the update converged with a third fresh redraw after that viewer closed',
    tmuxVersion: setupEvidence.tmuxVersion,
    historyLinesRequested: options.historyLines,
    historyLimit: setupEvidence.historyLimit,
    historySize: setupEvidence.historySize,
    historyMarkerCount: setupEvidence.historyMarkerCount,
    historySentinels: {
      first: setupEvidence.firstSeen,
      middle: setupEvidence.middleSeen,
      last: setupEvidence.lastSeen,
    },
    paneAlternateOn: setupEvidence.alternateOn,
    paneDead: setupEvidence.paneDead,
    estimatedHistoryBytes,
    freshAttachBytes: baselineEvidence.bytes,
    freshAttachToHistoryRatio: Number(
      (baselineEvidence.bytes / estimatedHistoryBytes).toFixed(6),
    ),
    freshAttachHistoryMarkersPresent: false,
    baselineStateSha256: baseline.state.hash,
    liveDeltaBytes: liveDelta.byteLength,
    liveDeltaSha256: createHash('sha256').update(liveDelta).digest('hex'),
    liveMarkerCount: 1,
    liveLatencyMs,
    postLiveStateSha256: liveState.hash,
    sameTerminalConnection: liveConnectionId === baselineId,
    pausedViewerConvergedAfterResume:
      resumedState.canonical === liveState.canonical,
    pausedViewerClosedBeforeFreshAttach: true,
    ownerSetupTerminalId: setupId,
    terminalIds: [setupId, baselineId, pausedId, freshAfterLiveId],
    ...(browserEvidence ? { playwrightScreenshot: browserEvidence } : {}),
  };
}

async function sendAioChunkedShellCommand(connection, command, label) {
  assert(
    /^[a-z][a-z0-9_]*$/u.test(label),
    `unsafe AIO chunked-command label: ${label}`,
  );
  const variable = `cap_${label}_command_b64`;
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  assert(
    connection.sendInput(`${variable}=''\n`),
    `AIO ${label} command initializer could not be sent`,
  );
  for (let offset = 0; offset < encoded.length; offset += 1_024) {
    const chunk = encoded.slice(offset, offset + 1_024);
    const currentValue = `\${${variable}}`;
    assert(
      connection.sendInput(`${variable}=\"${currentValue}${chunk}\"\n`),
      `AIO ${label} command chunk could not be sent`,
    );
  }
  assert(
    connection.sendInput(
      `eval \"$(printf '%s' \"$${variable}\" | base64 -d)\"\n`,
    ),
    `AIO ${label} command launcher could not be sent`,
  );
}

async function attachAndCapture({
  provider,
  socketName,
  sessionName,
  tmuxMode,
  expectedLines,
  cols,
  rows,
  timeoutMs = SCREEN_TIMEOUT_MS,
}) {
  const connection = await provider.openTerminal(cols, rows);
  try {
    await connection.sendResize(cols, rows);
    await delay(100, undefined, { signal: connection.signal });
    connection.sendInput(
      `export TERM=xterm-256color; stty cols ${cols} rows ${rows}; ` +
        `exec ${buildTmuxAttachCommand({ tmuxMode, socketName, sessionName })}\n`,
    );
    await waitForExpectedScreen(connection, expectedLines, timeoutMs);
    await waitForQuiet(connection, QUIET_WINDOW_MS, timeoutMs);
    await connection.drain();
    return { connection, state: canonicalState(connection.term, cols, rows) };
  } catch (error) {
    try {
      await connection.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'terminal attachment and exact close both failed',
      );
    }
    throw error;
  }
}

function buildPressureSetupCommand({
  socketName,
  sessionName,
  tmuxMode,
  markerNonce,
  historyPrefix,
  historyLines,
  liveToken,
  liveExpectedLine,
  liveRow,
  expectedLines,
  cols,
  rows,
}) {
  const historyLimit = historyLines + rows + 1_000;
  const middleLine = Math.ceil(historyLines / 2);
  const firstSentinel = `${historyPrefix}|LINE-000001|PAYLOAD`;
  const middleSentinel =
    `${historyPrefix}|LINE-${String(middleLine).padStart(6, '0')}|PAYLOAD`;
  const lastSentinel =
    `${historyPrefix}|LINE-${String(historyLines).padStart(6, '0')}|PAYLOAD`;
  const tmux = buildTmuxCommand({ tmuxMode, socketName });
  const sessionTarget = buildTmuxSessionTarget({ tmuxMode, sessionName });
  const windowTarget = `${sessionTarget}:0`;
  const paneTarget = `${sessionTarget}:0.0`;
  const paint = ['\\033[2J', '\\033[H'];
  for (let index = 0; index < expectedLines.length; index++) {
    const row = index + 1;
    const style =
      row === 1
        ? '\\033[1;38;5;39m'
        : row === Math.ceil(rows / 2)
          ? '\\033[38;5;82m'
          : '\\033[0m';
    paint.push(`\\033[${row};1H${style}${expectedLines[index]}`);
  }
  paint.push('\\033[0m', '\\033[17;40H');
  const livePaint =
    `\\033[${liveRow};1H\\033[0;38;5;214m${liveExpectedLine}` +
    '\\033[K\\033[0m\\033[17;40H';
  const historyGenerator =
    `awk -v count=${historyLines} -v prefix=${shellQuote(historyPrefix)} ` +
    `'BEGIN { for (i = 1; i <= count; i++) ` +
    `printf "%s|LINE-%06d|PAYLOAD\\n", prefix, i }'`;
  const paddingGenerator =
    `awk -v count=${rows} -v prefix=${shellQuote(historyPrefix)} ` +
    `'BEGIN { for (i = 1; i <= count; i++) ` +
    `printf "%s|PADDING-%06d\\n", prefix, i }'`;
  const fixtureCommand = [
    'set -eu',
    'stty -echo',
    historyGenerator,
    paddingGenerator,
    `printf '%b' ${shellQuote(paint.join(''))}`,
    'IFS= read -r cap_live_token',
    `test "$cap_live_token" = ${shellQuote(liveToken)}`,
    `printf '%b' ${shellQuote(livePaint)}`,
    'exec sleep 86400',
  ].join('; ');
  const waitForFrame =
    `cap_attempt=0; until ${tmux} capture-pane -p -t ${paneTarget} ` +
    `| grep -Fq -- ${shellQuote(expectedLines.at(-1))}; do ` +
    'cap_attempt=$((cap_attempt + 1)); ' +
    '[ "$cap_attempt" -lt 480 ] || exit 70; sleep 0.25; done';
  const captureHistory =
    `${tmux} capture-pane -p -S - -t ${paneTarget}`;
  const createPressureSession =
    tmuxMode === 'product'
      ? [
          `${tmux} new-session -d -s ${sessionName} -x ${cols} -y ${rows} ${shellQuote('exec sleep 86400')}`,
          `${tmux} set-option -t ${sessionTarget}: history-limit ${historyLimit}`,
          `${tmux} new-window -d -t ${sessionTarget}: -n cap-pressure ${shellQuote(fixtureCommand)}`,
          `${tmux} kill-window -t ${sessionTarget}:0`,
          `${tmux} move-window -s ${sessionTarget}:1 -t ${sessionTarget}:0`,
        ]
      : [
          `${tmux} set-option -g history-limit ${historyLimit}`,
          `${tmux} new-session -d -s ${sessionName} -x ${cols} -y ${rows} ${shellQuote(fixtureCommand)}`,
        ];
  const readHistoryLimit =
    tmuxMode === 'product'
      ? `${tmux} show-options -v -t ${sessionTarget}: history-limit`
      : `${tmux} show-options -gv history-limit`;

  return [
    ...createPressureSession,
    `${tmux} set-option -t ${sessionTarget}: status off`,
    `${tmux} set-window-option -t ${windowTarget} window-size manual`,
    `${tmux} resize-window -t ${windowTarget} -x ${cols} -y ${rows}`,
    `(${waitForFrame})`,
    `cap_history_size=$(${tmux} display-message -p -t ${paneTarget} '#{history_size}')`,
    `cap_history_limit=$(${readHistoryLimit})`,
    `cap_alternate_on=$(${tmux} display-message -p -t ${paneTarget} '#{alternate_on}')`,
    `cap_pane_dead=$(${tmux} display-message -p -t ${paneTarget} '#{pane_dead}')`,
    `cap_marker_count=$(${captureHistory} | grep -Fc -- ${shellQuote(`${historyPrefix}|LINE-`)})`,
    `${captureHistory} | grep -Fq -- ${shellQuote(firstSentinel)}`,
    'cap_first_seen=1',
    `${captureHistory} | grep -Fq -- ${shellQuote(middleSentinel)}`,
    'cap_middle_seen=1',
    `${captureHistory} | grep -Fq -- ${shellQuote(lastSentinel)}`,
    'cap_last_seen=1',
    `cap_tmux_version=$(tmux -V | tr ' ' '_')`,
    `printf '\\nCAP_PRESSURE_SETUP_%s history_size=%s history_limit=%s marker_count=%s first=%s middle=%s last=%s alternate_on=%s pane_dead=%s tmux=%s\\n' ` +
      `${shellQuote(socketName)} "$cap_history_size" "$cap_history_limit" "$cap_marker_count" ` +
      '"$cap_first_seen" "$cap_middle_seen" "$cap_last_seen" ' +
      '"$cap_alternate_on" "$cap_pane_dead" "$cap_tmux_version"',
    `printf 'CAP_PRESSURE_SETUP_DONE_%s\\n' ${shellQuote(markerNonce)}`,
  ].join(' && ');
}

function parsePressureSetupEvidence(raw, nonce) {
  const marker = `CAP_PRESSURE_SETUP_capfresh${nonce}`;
  const text = raw.toString('utf8');
  const markerOffset = text.lastIndexOf(`${marker} `);
  const line =
    markerOffset === -1
      ? null
      : text.slice(markerOffset).split(/\r?\n/u, 1)[0].replace(/\r$/u, '');
  if (!line) throw new Error('pressure setup evidence marker is missing');
  const values = new Map(
    line
      .slice(marker.length + 1)
      .split(' ')
      .map((part) => {
        const separator = part.indexOf('=');
        return [part.slice(0, separator), part.slice(separator + 1)];
      }),
  );
  const integer = (key) => {
    const value = Number(values.get(key));
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`invalid pressure setup ${key}: ${values.get(key)}`);
    }
    return value;
  };
  const boolean = (key) => {
    const value = values.get(key);
    if (value !== '0' && value !== '1') {
      throw new Error(`invalid pressure setup ${key}: ${value}`);
    }
    return value === '1';
  };
  return {
    historySize: integer('history_size'),
    historyLimit: integer('history_limit'),
    historyMarkerCount: integer('marker_count'),
    firstSeen: boolean('first'),
    middleSeen: boolean('middle'),
    lastSeen: boolean('last'),
    alternateOn: boolean('alternate_on'),
    paneDead: boolean('pane_dead'),
    tmuxVersion: values.get('tmux')?.replaceAll('_', ' ') ?? 'unknown',
  };
}

function buildExpectedLines(prefix, rows) {
  return Array.from({ length: rows }, (_, index) => {
    const row = index + 1;
    const label = String(row).padStart(2, '0');
    if (row === 1) return `${prefix}|ROW-${label}|TOP|BOLD-BLUE`;
    if (row === Math.ceil(rows / 2)) {
      return `${prefix}|ROW-${label}|CENTER|中文宽字符`;
    }
    if (row === rows) return `${prefix}|ROW-${label}|BOTTOM`;
    return `${prefix}|ROW-${label}`;
  });
}

function buildSetupCommand({
  socketName,
  sessionName,
  tmuxMode,
  markerNonce,
  expectedLines,
  cols,
  rows,
}) {
  const paint = ['\\033[?1049h', '\\033[2J'];
  for (let index = 0; index < expectedLines.length; index++) {
    const row = index + 1;
    const style =
      row === 1
        ? '\\033[1;38;5;39m'
        : row === Math.ceil(rows / 2)
          ? '\\033[38;5;82m'
          : '\\033[0m';
    paint.push(`\\033[${row};1H${style}${expectedLines[index]}`);
  }
  paint.push('\\033[0m', '\\033[17;40H');
  const fixtureCommand = `printf '%b' ${shellQuote(paint.join(''))}; exec sleep 86400`;
  const tmux = buildTmuxCommand({ tmuxMode, socketName });
  const sessionTarget = buildTmuxSessionTarget({ tmuxMode, sessionName });
  const windowTarget = `${sessionTarget}:0`;
  return [
    `${tmux} new-session -d -s ${sessionName} -x ${cols} -y ${rows} ${shellQuote(fixtureCommand)}`,
    `${tmux} set-option -t ${sessionTarget}: status off`,
    `${tmux} set-window-option -t ${windowTarget} window-size manual`,
    `${tmux} resize-window -t ${windowTarget} -x ${cols} -y ${rows}`,
    `printf '\\nCAP_SETUP_DONE_%s\\n' ${shellQuote(markerNonce)}`,
  ].join(' && ');
}

function buildTmuxCommand({ tmuxMode, socketName }) {
  return tmuxMode === 'product'
    ? 'tmux -u'
    : `tmux -L ${socketName} -f /dev/null`;
}

function buildTmuxSessionTarget({ tmuxMode, sessionName }) {
  return tmuxMode === 'product' ? `=${sessionName}` : sessionName;
}

function buildTmuxAttachCommand({ tmuxMode, socketName, sessionName }) {
  if (tmuxMode === 'product') {
    const target = buildTmuxSessionTarget({ tmuxMode, sessionName });
    return (
      `tmux -u set-option -t ${target}: status off \\; ` +
      `attach-session -f ignore-size -t ${target}`
    );
  }
  return `tmux -L ${socketName} -u attach-session -t ${sessionName}`;
}

function buildTmuxCleanupCommand({ tmuxMode, socketName, sessionNames }) {
  if (tmuxMode === 'product') {
    return sessionNames
      .map((sessionName) => {
        const target = buildTmuxSessionTarget({ tmuxMode, sessionName });
        return (
          `if tmux -u has-session -t ${target} 2>/dev/null; then ` +
          `tmux -u kill-session -t ${target} || exit $?; fi`
        );
      })
      .join('; ');
  }
  return (
    `if tmux -L ${socketName} list-sessions >/dev/null 2>&1; then ` +
    `tmux -L ${socketName} kill-server || exit $?; fi; ` +
    `rm -f -- "/tmp/tmux-$(id -u)/${socketName}"`
  );
}

function buildAioCleanupAndVerifyCommand({
  tmuxMode,
  socketName,
  sessionNames,
  exactTempFiles,
  markerNonce,
}) {
  const allowedTempFiles = new Set([
    `/tmp/cap-byte-oracle-${markerNonce}.bin`,
    `/tmp/cap-byte-oracle-${markerNonce}.surplus.bin`,
  ]);
  for (const path of exactTempFiles) {
    assert(
      allowedTempFiles.has(path),
      `unsafe AIO canary temporary path: ${path}`,
    );
  }

  const commands = [
    buildTmuxCleanupCommand({ tmuxMode, socketName, sessionNames }),
  ];
  if (exactTempFiles.length > 0) {
    commands.push(
      `rm -f -- ${exactTempFiles.map((path) => shellQuote(path)).join(' ')}`,
    );
  }

  if (tmuxMode === 'product') {
    for (const sessionName of sessionNames) {
      const target = `=${sessionName}`;
      commands.push(
        `if tmux -u has-session -t ${shellQuote(target)} 2>/dev/null; then exit 91; fi`,
      );
    }
  } else {
    commands.push(
      `if tmux -L ${socketName} list-sessions >/dev/null 2>&1; then exit 92; fi`,
      `test ! -e "/tmp/tmux-$(id -u)/${socketName}" || exit 93`,
    );
  }
  for (const path of exactTempFiles) {
    commands.push(`test ! -e ${shellQuote(path)} || exit 95`);
  }
  commands.push(
    `printf '\\nCAP_AIO_CLEANUP_VERIFY_%s business=absent temp=absent\\n' ${shellQuote(markerNonce)}`,
  );
  return commands.join('; ');
}

function buildAioPostAbsenceVerifyCommand({
  tmuxMode,
  socketName,
  sessionNames,
  exactTempFiles,
  markerNonce,
}) {
  const commands = ['stty -echo'];
  if (tmuxMode === 'product') {
    for (const sessionName of sessionNames) {
      const target = `=${sessionName}`;
      commands.push(
        `if tmux -u has-session -t ${shellQuote(target)} 2>/dev/null; then exit 96; fi`,
      );
    }
  } else {
    commands.push(
      `if tmux -L ${socketName} list-sessions >/dev/null 2>&1; then exit 97; fi`,
      `test ! -e "/tmp/tmux-$(id -u)/${socketName}" || exit 98`,
    );
  }
  for (const path of exactTempFiles) {
    commands.push(`test ! -e ${shellQuote(path)} || exit 100`);
  }
  commands.push(
    `printf '\\r\\nCAP_AIO_POST_ABSENCE_%s business=absent temp=absent\\r\\n' ${shellQuote(markerNonce)}`,
  );
  return commands.join('; ');
}

async function runAioCleanupControlCommand(
  connection,
  command,
  evidence,
  timeoutMs = SCREEN_TIMEOUT_MS,
) {
  const offset = connection.rawOutput().byteLength;
  assert(
    connection.sendInput(`${command}\n`),
    'AIO cleanup-control command could not be sent',
  );
  await connection.waitForRawAfter(evidence, offset, timeoutMs, {
    ignoreAbort: true,
  });
  await connection.drain();
  assert(
    connection.rawOutput().subarray(offset).includes(Buffer.from(evidence)),
    'AIO cleanup-control evidence was not emitted after its command',
  );
}

async function deleteAioSessionExact(baseUrl, terminalId) {
  const failures = [];
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(
        `${baseUrl}/v1/shell/sessions/${encodeURIComponent(terminalId)}`,
        {
          method: 'DELETE',
          signal: AbortSignal.timeout(5_000),
        },
      );
      const body = await response.json().catch(() => null);
      if (
        !response.ok ||
        !body ||
        typeof body !== 'object' ||
        !body.data ||
        typeof body.data !== 'object' ||
        body.data.session_id !== terminalId
      ) {
        throw new Error(
          `AIO terminal cleanup was not confirmed for ${terminalId}: HTTP ${response.status}`,
        );
      }
      if (body.success === true) return 'deleted';
      if (
        body.success === false &&
        body.message === `Session ${terminalId} not found`
      ) {
        return 'already-absent';
      }
      throw new Error(
        `AIO terminal cleanup returned invalid evidence for ${terminalId}`,
      );
    } catch (error) {
      failures.push(error);
      if (attempt < CLEANUP_ATTEMPTS) await delay(CLEANUP_RETRY_DELAY_MS);
    }
  }
  throw new AggregateError(
    failures,
    `AIO terminal cleanup was not confirmed for ${terminalId}`,
  );
}

export async function confirmAioSessionAbsence(baseUrl, record) {
  assert(
    record &&
      typeof record.role === 'string' &&
      CANONICAL_UUID_PATTERN.test(record.terminalId ?? ''),
    'AIO exact cleanup requires a safe role and canonical terminal id',
  );
  const deleted = await deleteAioSessionExact(baseUrl, record.terminalId);
  const absent = await deleteAioSessionExact(baseUrl, record.terminalId);
  assert(
    absent === 'already-absent',
    `AIO terminal ${record.terminalId} absence was not confirmed`,
  );
  return { ...record, deleted, absent };
}

async function waitForExpectedScreen(connection, expectedLines, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await connection.drain();
    const lines = visibleLines(connection.term, expectedLines.length);
    if (expectedLines.every((expected, index) => lines[index]?.startsWith(expected))) {
      return;
    }
    await delay(50, undefined, { signal: connection.signal });
  }
  const rendered = visibleLines(connection.term, expectedLines.length)
    .map((line, index) => `${String(index + 1).padStart(2, '0')}: ${line}`)
    .join('\n');
  throw new Error(`timed out waiting for complete tmux redraw\n${rendered}`);
}

async function waitForQuiet(connection, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Date.now() - connection.lastOutputAt >= quietMs) return;
    await delay(25, undefined, { signal: connection.signal });
  }
  throw new Error('terminal output did not become quiet');
}

function visibleLines(term, rows) {
  const buffer = term.buffer.active;
  return Array.from({ length: rows }, (_, row) =>
    buffer
      .getLine(buffer.viewportY + row)
      ?.translateToString(true, 0, term.cols) ?? '',
  );
}

function canonicalState(term, cols, rows) {
  const buffer = term.buffer.active;
  const cells = [];
  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    const serializedLine = [];
    for (let col = 0; col < cols; col++) {
      const cell = line?.getCell(col);
      serializedLine.push(
        cell
          ? [
              cell.getChars(),
              cell.getWidth(),
              callCell(cell, 'getFgColorMode'),
              callCell(cell, 'getFgColor'),
              callCell(cell, 'getBgColorMode'),
              callCell(cell, 'getBgColor'),
              callCell(cell, 'isBold'),
              callCell(cell, 'isItalic'),
              callCell(cell, 'isDim'),
              callCell(cell, 'isUnderline'),
              callCell(cell, 'isBlink'),
              callCell(cell, 'isInverse'),
              callCell(cell, 'isInvisible'),
              callCell(cell, 'isStrikethrough'),
              callCell(cell, 'isOverline'),
            ]
          : null,
      );
    }
    cells.push(serializedLine);
  }
  const modes = {};
  for (const key of Object.keys(term.modes ?? {}).sort()) {
    modes[key] = term.modes[key];
  }
  const value = {
    bufferType: buffer.type,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    modes,
    cells,
  };
  const canonical = JSON.stringify(value);
  return {
    ...value,
    canonical,
    hash: createHash('sha256').update(canonical).digest('hex'),
  };
}

function callCell(cell, method) {
  return typeof cell[method] === 'function' ? cell[method]() : null;
}

function assertFixtureState(state, expectedLines, rows) {
  assert(
    state.bufferType === 'alternate',
    `unexpected buffer type: ${state.bufferType}`,
  );
  assert(
    state.cursorX === 39 && state.cursorY === 16,
    `unexpected cursor: ${state.cursorX},${state.cursorY}`,
  );

  const topLeft = state.cells[0]?.[0];
  assert(topLeft?.[0] === 'C', 'top-left fixture cell is missing');
  assert(Boolean(topLeft?.[6]), 'bold fixture attribute was not restored');
  assert(
    topLeft?.[3] === 39,
    `fixture foreground color was not restored: ${topLeft?.[3]}`,
  );

  const centerRow = Math.ceil(rows / 2) - 1;
  const wideColumn = expectedLines[centerRow].indexOf('中');
  const wide = state.cells[centerRow]?.[wideColumn];
  const wideContinuation = state.cells[centerRow]?.[wideColumn + 1];
  assert(wide?.[0] === '中' && wide?.[1] === 2, 'CJK wide cell was not restored');
  assert(wideContinuation?.[1] === 0, 'CJK continuation cell was not restored');
}

function assertNoHistoryReplay(raw, historyPrefix, historyLines) {
  const sentinels = [1, Math.ceil(historyLines / 2), historyLines].map((line) =>
    Buffer.from(
      `${historyPrefix}|LINE-${String(line).padStart(6, '0')}|PAYLOAD`,
      'utf8',
    ),
  );
  assert(
    !raw.includes(Buffer.from(historyPrefix, 'utf8')) &&
      sentinels.every((sentinel) => !raw.includes(sentinel)),
    'fresh/incremental stream unexpectedly replayed tmux history',
  );
}

function assertOnlyRowsChanged(before, after, expectedChangedRows) {
  const changedRows = [];
  const rowCount = Math.max(before.cells.length, after.cells.length);
  for (let row = 0; row < rowCount; row++) {
    if (JSON.stringify(before.cells[row]) !== JSON.stringify(after.cells[row])) {
      changedRows.push(row);
    }
  }
  assert(
    JSON.stringify(changedRows) === JSON.stringify(expectedChangedRows),
    `unexpected changed rows: ${changedRows.map((row) => row + 1).join(',')}`,
  );
  assert(before.bufferType === after.bufferType, 'live update changed buffer type');
  assert(
    before.cursorX === after.cursorX && before.cursorY === after.cursorY,
    'live update changed the final cursor position',
  );
  assert(
    JSON.stringify(before.modes) === JSON.stringify(after.modes),
    'live update changed terminal modes',
  );
}

function countBufferOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, offset);
    if (found === -1) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function rawEvidence(raw) {
  return {
    bytes: raw.byteLength,
    sha256: createHash('sha256').update(raw).digest('hex'),
    smcup: raw.includes(Buffer.from('\u001b[?1049h')),
    clear: raw.includes(Buffer.from('\u001b[2J')),
  };
}

async function compareBrowserScreens(
  firstRaw,
  secondRaw,
  cols,
  rows,
  expectedLines,
  signal,
) {
  signal?.throwIfAborted();
  const requireFromWeb = createRequire(
    new URL('../apps/web/package.json', import.meta.url),
  );
  const { chromium } = requireFromWeb('@playwright/test');
  const xtermScript = requireFromWeb.resolve('@xterm/xterm');
  const xtermStyle = requireFromWeb.resolve('@xterm/xterm/css/xterm.css');
  const browser = await chromium.launch({ headless: true });
  const closeOnAbort = () => {
    void browser.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  try {
    const first = await renderBrowserTerminal(
      browser,
      xtermScript,
      xtermStyle,
      firstRaw,
      cols,
      rows,
      signal,
    );
    const second = await renderBrowserTerminal(
      browser,
      xtermScript,
      xtermStyle,
      secondRaw,
      cols,
      rows,
      signal,
    );
    const blank = await renderBrowserTerminal(
      browser,
      xtermScript,
      xtermStyle,
      Buffer.alloc(0),
      cols,
      rows,
      signal,
    );
    assertBrowserLines(first.lines, expectedLines, 'first');
    assertBrowserLines(second.lines, expectedLines, 'second');
    assert(
      blank.lines.every((line) => line === ''),
      'blank Playwright xterm unexpectedly contained text',
    );
    const firstHash = createHash('sha256')
      .update(first.screenshot)
      .digest('hex');
    const secondHash = createHash('sha256')
      .update(second.screenshot)
      .digest('hex');
    assert(
      first.screenshot.equals(second.screenshot),
      `Playwright screenshots differ\nfirst:  ${firstHash}\nsecond: ${secondHash}`,
    );
    assert(
      !first.screenshot.equals(blank.screenshot) &&
        !second.screenshot.equals(blank.screenshot),
      'Playwright screenshots matched an empty terminal',
    );
    return {
      identical: true,
      nonBlank: true,
      sha256: secondHash,
      contentRowsVerified: expectedLines.length,
    };
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    await browser.close();
  }
}

async function renderBrowserTerminal(
  browser,
  xtermScript,
  xtermStyle,
  raw,
  cols,
  rows,
  signal,
) {
  signal?.throwIfAborted();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 1,
  });
  try {
    await page.setContent(
      '<!doctype html><html><body><div id="terminal"></div></body></html>',
    );
    await page.addStyleTag({ path: xtermStyle });
    await page.addStyleTag({
      content:
        'html,body{margin:0;background:#0d1117}' +
        '#terminal{display:inline-block;background:#0d1117}' +
        '.xterm{padding:0}',
    });
    await page.addScriptTag({ path: xtermScript });
    await page.evaluate(
      ({ encoded, cols: terminalCols, rows: terminalRows }) =>
        new Promise((resolve) => {
          const binary = atob(encoded);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          const terminal = new globalThis.Terminal({
            cols: terminalCols,
            rows: terminalRows,
            scrollback: 0,
            cursorBlink: false,
            fontFamily: 'Menlo, Monaco, monospace',
            fontSize: 14,
            theme: {
              background: '#0d1117',
              foreground: '#e6edf3',
              cursor: '#e6edf3',
            },
          });
          terminal.open(document.querySelector('#terminal'));
          globalThis.__capCanaryTerminal = terminal;
          terminal.write(bytes, () => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          });
        }),
      { encoded: raw.toString('base64'), cols, rows },
    );
    const lines = await page.evaluate((terminalRows) => {
      const terminal = globalThis.__capCanaryTerminal;
      const buffer = terminal.buffer.active;
      return Array.from({ length: terminalRows }, (_, row) =>
        buffer
          .getLine(buffer.viewportY + row)
          ?.translateToString(true, 0, terminal.cols) ?? '',
      );
    }, rows);
    const screenshot = await page.locator('#terminal .xterm-screen').screenshot({
      animations: 'disabled',
    });
    return { screenshot, lines };
  } finally {
    await page.close();
  }
}

function assertBrowserLines(actualLines, expectedLines, label) {
  assert(
    expectedLines.every((expected, index) =>
      actualLines[index]?.startsWith(expected),
    ),
    `${label} Playwright xterm did not contain the expected current frame`,
  );
}

async function loadSandboxProductTerminalModule() {
  // The viewer surface comes from the product facade dist; the AIO transport
  // factory is provider-internal and no longer rides the reviewed facade
  // whitelist (close-gate-blindspots 2.3 — scripts canaries are not ratcheted
  // apps/api consumers), so it loads from the provider package dist directly,
  // like aio-terminal-pair-stale-sweep-canary.mjs does.
  sandboxProductModulePromise ??= Promise.all([
    import(new URL('../packages/sandbox/dist/index.js', import.meta.url)),
    import(
      new URL('../packages/sandbox-provider-aio/dist/index.js', import.meta.url)
    ),
  ]).then(([facadeModule, aioModule]) => {
    const module = {
      ...facadeModule,
      createAioTerminalTransportFactory:
        aioModule.createAioTerminalTransportFactory,
    };
    for (const exportName of [
      'createAioTerminalTransportFactory',
      'createAioHttpCommandExecutor',
      'SandboxTerminalViewerAttachmentFactory',
    ]) {
      if (typeof module[exportName] !== 'function') {
        throw new Error(`product terminal dist is missing ${exportName}`);
      }
    }
    return module;
  });
  try {
    return await sandboxProductModulePromise;
  } catch (error) {
    throw new Error(
      'AIO product viewer dist is unavailable or incompatible; run pnpm --filter @cap-console/sandbox build',
      { cause: error },
    );
  }
}

async function createProvider(
  options,
  nonce,
  registerProviderCleanup,
  lifecycle,
) {
  if (options.provider === 'aio') {
    registerProviderCleanup(async () => {});
    return createAioProvider(options.endpoint, nonce, lifecycle);
  }
  return createBoxLiteProvider(
    options,
    nonce,
    registerProviderCleanup,
    lifecycle,
  );
}

export function createAioProvider(
  endpoint,
  nonce,
  lifecycle,
  { cleanupControlTimeoutMs = SCREEN_TIMEOUT_MS } = {},
) {
  assert(
    Number.isSafeInteger(cleanupControlTimeoutMs) && cleanupControlTimeoutMs > 0,
    'AIO cleanup-control timeout must be a positive safe integer',
  );
  const baseUrl = normalizeHttpEndpoint(endpoint);
  const wsUrl = `${httpToWs(baseUrl)}/v1/shell/ws`;
  const connections = new Set();
  const productViewerConnections = new Set();
  const connectionRoles = new Map();
  const cleanupEvidence = { result: 'PENDING' };
  const admission = lifecycle ?? {
    signal: undefined,
    assertCanCreate() {},
  };
  let cleanupControl = null;
  let cleanupControlPromise = null;
  let businessResourcesMayExist = false;
  let businessCleanupConfirmed = false;

  const openDirectTerminal = async (cols, rows, role) => {
    admission.assertCanCreate(`AIO ${role} PTY`);
    let allocated = null;
    try {
      const connection = await TerminalConnection.open({
        kind: 'aio',
        wsUrl,
        cols,
        rows,
        signal: admission.signal,
        onAllocated(candidate) {
          allocated = candidate;
          connections.add(candidate);
          connectionRoles.set(candidate, role);
        },
      });
      await connection.waitForIdentity(SCREEN_TIMEOUT_MS);
      admission.assertCanCreate(`AIO ${role} PTY`);
      return connection;
    } catch (error) {
      await allocated?.close().catch(() => undefined);
      throw error;
    }
  };

  const provider = {
    cleanupEvidence,
    markBusinessResourcesMayExist() {
      businessResourcesMayExist = true;
    },
    async prepareCleanupControl() {
      admission.assertCanCreate('AIO cleanup-control PTY');
      cleanupControlPromise ??= (async () => {
        const connection = await openDirectTerminal(
          DEFAULT_COLS,
          DEFAULT_ROWS,
          'cleanup-control',
        );
        cleanupControl = connection;
        assert(
          connection.sendInput('stty -echo\n'),
          'AIO cleanup-control PTY could not disable shell echo',
        );
        await delay(100, undefined, { signal: admission.signal });
        admission.assertCanCreate('AIO cleanup-control PTY');
        return connection;
      })();
      return cleanupControlPromise;
    },
    async openTerminal(cols, rows) {
      return openDirectTerminal(cols, rows, 'terminal');
    },
    async openProductOpaqueViewer({ taskId, cols, rows }) {
      admission.assertCanCreate('AIO product viewer module');
      const {
        createAioTerminalTransportFactory,
        createAioHttpCommandExecutor,
        SandboxTerminalViewerAttachmentFactory,
      } = await loadSandboxProductTerminalModule();
      admission.assertCanCreate('AIO product viewer PTY pair');
      let observedTransport = null;
      const productTransportFactory = createAioTerminalTransportFactory({
        taskId,
        wsUrl,
        baseUrl,
        enableOpaqueInput: true,
        logger: {
          warn(message) {
            console.error(`[canary] AIO product viewer: ${message}`);
          },
        },
      });
      const transportFactory = {
        open() {
          assert(
            observedTransport === null,
            'AIO product viewer opened more than one transport',
          );
          observedTransport = productTransportFactory.open();
          return observedTransport;
        },
      };
      const attachmentFactory = new SandboxTerminalViewerAttachmentFactory({
        taskId,
        transportFactory,
        commandExecutor: createAioHttpCommandExecutor({ baseUrl }),
      });
      admission.assertCanCreate('AIO product viewer PTY pair');
      const attachment = attachmentFactory.open({
        cols,
        rows,
        signal: admission.signal,
      });
      assert(
        observedTransport,
        'AIO product viewer factory did not expose its opened transport',
      );
      const connection = new AioProductViewerConnection({
        attachment,
        transport: observedTransport,
        cols,
        rows,
        signal: admission.signal,
      });
      productViewerConnections.add(connection);
      try {
        await connection.waitForReady(SCREEN_TIMEOUT_MS);
        admission.assertCanCreate('AIO product viewer PTY pair');
        return connection;
      } catch (error) {
        await connection.close().catch(() => undefined);
        throw error;
      }
    },
    async execCleanup({
      tmuxMode,
      socketName,
      sessionNames,
      exactTempFiles,
    }) {
      const failures = [];
      if (businessResourcesMayExist && !businessCleanupConfirmed) {
        const businessFailures = [];
        for (
          let attempt = 1;
          attempt <= CLEANUP_ATTEMPTS && !businessCleanupConfirmed;
          attempt += 1
        ) {
          try {
            assert(
              cleanupControl && cleanupControl.isOpen(),
              'AIO cleanup-control PTY is unavailable after fixture mutation',
            );
            const verifyMarker = `CAP_AIO_CLEANUP_VERIFY_${nonce}`;
            const command = buildAioCleanupAndVerifyCommand({
              tmuxMode,
              socketName,
              sessionNames,
              exactTempFiles,
              markerNonce: nonce,
            });
            assert(
              !command.includes(verifyMarker),
              'AIO cleanup marker must not appear literally in the control command',
            );
            await runAioCleanupControlCommand(
              cleanupControl,
              command,
              `${verifyMarker} business=absent temp=absent`,
              cleanupControlTimeoutMs,
            );

            const postMarker = `CAP_AIO_POST_ABSENCE_${nonce}`;
            const postCommand = buildAioPostAbsenceVerifyCommand({
              tmuxMode,
              socketName,
              sessionNames,
              exactTempFiles,
              markerNonce: nonce,
            });
            assert(
              !postCommand.includes(postMarker),
              'AIO post-absence marker must not appear literally in the control command',
            );
            await runAioCleanupControlCommand(
              cleanupControl,
              postCommand,
              `${postMarker} business=absent temp=absent`,
              cleanupControlTimeoutMs,
            );
            businessCleanupConfirmed = true;
          } catch (error) {
            businessFailures.push(error);
            if (attempt < CLEANUP_ATTEMPTS) {
              await delay(CLEANUP_RETRY_DELAY_MS);
            }
          }
        }
        if (!businessCleanupConfirmed) {
          failures.push(
            new AggregateError(
              businessFailures,
              'AIO fixture cleanup was not confirmed',
            ),
          );
        }
      }

      const preserveCleanupControl =
        businessResourcesMayExist && !businessCleanupConfirmed;
      const directConnectionsToClose = [...connections].filter(
        (connection) =>
          !preserveCleanupControl || connection !== cleanupControl,
      );
      const closeResults = await Promise.allSettled(
        [...directConnectionsToClose, ...productViewerConnections].map(
          (connection) => connection.close(),
        ),
      );
      failures.push(
        ...closeResults
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason),
      );

      const identityRecords = [];
      for (const connection of connections) {
        if (preserveCleanupControl && connection === cleanupControl) continue;
        if (typeof connection.id === 'string') {
          identityRecords.push({
            role: connectionRoles.get(connection) ?? 'terminal',
            terminalId: connection.id,
          });
        } else if (connection.everOpened) {
          failures.push(
            new Error('AIO opened a terminal without reporting its exact identity'),
          );
        }
      }
      for (const connection of productViewerConnections) {
        for (const [role, terminalId] of [
          ['product-main', connection.id],
          ['product-injector', connection.injectorId],
        ]) {
          if (typeof terminalId === 'string') {
            identityRecords.push({ role, terminalId });
          } else {
            failures.push(
              new Error(`AIO ${role} did not report its exact terminal identity`),
            );
          }
        }
      }
      const identitySet = new Set(identityRecords.map(({ terminalId }) => terminalId));
      if (identitySet.size !== identityRecords.length) {
        failures.push(new Error('AIO cleanup terminal identities were reused'));
      }
      const providerSessionAbsence = [];
      const absenceResults = await Promise.allSettled(
        identityRecords.map((record) =>
          confirmAioSessionAbsence(baseUrl, record),
        ),
      );
      for (const result of absenceResults) {
        if (result.status === 'fulfilled') {
          providerSessionAbsence.push(result.value);
        } else {
          failures.push(result.reason);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'AIO canary cleanup failed');
      }
      Object.assign(cleanupEvidence, {
        result: 'PASS',
        businessSessionsAbsent: businessResourcesMayExist
          ? [...sessionNames]
          : [],
        businessSessionEvidence: businessResourcesMayExist
          ? 'control-probed-twice'
          : 'mutation-never-admitted',
        exactTempFilesAbsent: [...exactTempFiles],
        cleanupControlTerminalId: cleanupControl?.id ?? null,
        providerSessionAbsence,
        productViewerSocketsClosed: [...productViewerConnections].map(
          (connection) => connection.closeEvidence,
        ),
      });
    },
  };
  return provider;
}

export async function createBoxLiteProvider(
  options,
  nonce,
  registerProviderCleanup,
  lifecycle,
) {
  const admission = lifecycle ?? {
    signal: undefined,
    assertCanCreate() {},
  };
  admission.assertCanCreate('BoxLite provider inventory');
  const baseUrl = normalizeHttpEndpoint(options.endpoint);
  const boxesUrl = boxLiteBoxesUrl(baseUrl, options.pathPrefix);
  const headers = boxLiteHeaders();
  const source = options.rootfs
    ? { rootfs_path: options.rootfs }
    : options.image
      ? { image: options.image }
      : null;
  if (!source) {
    throw new Error(
      'BoxLite requires --rootfs/BOXLITE_ROOTFS_PATH or --image/BOXLITE_IMAGE',
    );
  }
  const name = `cap-terminal-fresh-attach-${nonce}`;
  const baseline = await readBoxLiteInventory(
    boxesUrl,
    headers,
    admission.signal,
  );
  const baselineIds = new Set(baseline.map((box) => box.id));
  const createAbortController = new AbortController();
  let createPromise = null;
  let boxId = null;
  const cleanupEvidence = { result: 'PENDING', boxId: null };
  let deleted = false;
  let deletion = null;
  const cleanup = async () => {
    if (deleted) return;
    if (!deletion) {
      deletion = (async () => {
        createAbortController.abort(
          new Error('BoxLite fresh-attach create cleanup'),
        );
        await createPromise?.catch(() => undefined);
        const deadline = Date.now() + 30_000;
        let quietSince = null;
        let reconciledCandidate = false;
        while (Date.now() < deadline) {
          const inventory = await readBoxLiteInventory(boxesUrl, headers);
          const candidates = inventory.filter(
            (box) =>
              !baselineIds.has(box.id) &&
              (box.name === name || box.id === boxId),
          );
          for (const box of candidates) {
            await deleteBoxLiteBoxAndConfirm(boxesUrl, headers, box.id);
            reconciledCandidate = true;
          }
          if (candidates.length > 0) {
            quietSince = null;
            continue;
          }
          if (boxId !== null || reconciledCandidate) {
            deleted = true;
            Object.assign(cleanupEvidence, {
              result: 'PASS',
              boxAbsent: true,
              ...(boxId === null
                ? { reconciledByUniqueName: true }
                : {}),
            });
            return;
          }
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= 5_000) {
            deleted = true;
            Object.assign(cleanupEvidence, {
              result: 'PASS',
              boxAbsent: true,
              reconciledByUniqueName: true,
            });
            return;
          }
          await delay(100);
        }
        throw new Error('BoxLite create cleanup reconciliation was indeterminate');
      })();
    }
    try {
      await deletion;
    } finally {
      if (!deleted) deletion = null;
    }
  };
  cleanup.evidence = cleanupEvidence;
  registerProviderCleanup(cleanup);

  admission.assertCanCreate('BoxLite sandbox');
  createPromise = requestJson(boxesUrl, {
    method: 'POST',
    headers,
    signal: admission.signal
      ? AbortSignal.any([createAbortController.signal, admission.signal])
      : createAbortController.signal,
    body: JSON.stringify({
      name,
      ...source,
      cpus: 1,
      memory_mib: 512,
      disk_size_gb: 5,
    }),
  });
  let created;
  try {
    created = await createPromise;
    admission.assertCanCreate('BoxLite sandbox');
  } catch (error) {
    if (admission.signal?.aborted) throw error;
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'BoxLite create and exact reconciliation failed',
      );
    }
    throw error;
  }
  boxId = readString(created, 'box_id', 'id');
  if (!boxId) {
    const error = new Error('BoxLite create response did not include box_id');
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'BoxLite create response and exact reconciliation failed',
      );
    }
    throw error;
  }
  cleanupEvidence.boxId = boxId;

  try {
    admission.assertCanCreate('BoxLite sandbox start');
    await requestJson(
      `${boxesUrl}/${encodeURIComponent(boxId)}/start`,
      { method: 'POST', headers, signal: admission.signal },
    );
    admission.assertCanCreate('BoxLite sandbox start');
  } catch (error) {
    if (admission.signal?.aborted) throw error;
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'BoxLite start and exact cleanup failed',
      );
    }
    throw error;
  }

  return {
    cleanupEvidence,
    async openTerminal(cols, rows) {
      admission.assertCanCreate('BoxLite terminal execution');
      const started = await requestJson(
        `${boxesUrl}/${encodeURIComponent(boxId)}/exec`,
        {
          method: 'POST',
          headers,
          signal: admission.signal,
          body: JSON.stringify({
            command: 'sh',
            args: [
              '-lc',
              'export TERM=xterm-256color; export LANG="${LANG:-C.UTF-8}"; exec bash --noprofile --norc',
            ],
            working_dir: '/home/gem',
            tty: true,
          }),
        },
      );
      const executionId = readString(started, 'execution_id', 'id');
      if (!executionId) {
        throw new Error('BoxLite exec response did not include execution_id');
      }
      admission.assertCanCreate('BoxLite terminal attachment');
      const wsBase = httpToWs(baseUrl);
      const wsUrl =
        `${boxLiteBoxesUrl(wsBase, options.pathPrefix)}/${encodeURIComponent(boxId)}` +
        `/executions/${encodeURIComponent(executionId)}/attach`;
      return TerminalConnection.open({
        kind: 'boxlite',
        wsUrl,
        id: executionId,
        headers,
        cols,
        rows,
        signal: admission.signal,
      });
    },
    async execCleanup() {},
  };
}

async function readBoxLiteInventory(boxesUrl, headers, signal) {
  const raw = await requestJson(boxesUrl, { method: 'GET', headers, signal });
  const value = raw?.data ?? raw;
  const boxes = Array.isArray(value)
    ? value
    : Array.isArray(value?.boxes)
      ? value.boxes
      : null;
  if (!boxes) throw new Error('BoxLite inventory response was invalid');
  return boxes.map((box) => {
    const id = readString(box, 'box_id', 'id', 'name');
    const boxName = readString(box, 'name');
    if (!id) throw new Error('BoxLite inventory item did not include an id');
    return { id, name: boxName };
  });
}

async function deleteBoxLiteBoxAndConfirm(boxesUrl, headers, boxId) {
  const response = await fetch(`${boxesUrl}/${encodeURIComponent(boxId)}`, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`BoxLite cleanup failed: HTTP ${response.status}`);
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const probe = await fetch(`${boxesUrl}/${encodeURIComponent(boxId)}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (probe.status === 404) return;
    if (!probe.ok) {
      throw new Error(
        `BoxLite cleanup absence probe failed: HTTP ${probe.status}`,
      );
    }
    await delay(250);
  }
  throw new Error('BoxLite cleanup could not verify box absence');
}

export class AioProductViewerConnection {
  constructor({ attachment, transport, cols, rows, signal }) {
    this.attachment = attachment;
    this.transport = transport;
    this.signal = signal;
    this.id = null;
    this.injectorId = null;
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 0,
    });
    this.chunks = [];
    this.lastOutputAt = 0;
    this.protocolFailure = null;
    this.closePromise = null;
    this.closeEvidence = { result: 'PENDING' };
    this.subscriptions = [
      attachment.onData((data) => this.acceptOutput(data)),
      attachment.onError((error) => {
        this.protocolFailure ??= error;
      }),
      attachment.onClose(() => {
        this.attachmentClosed = true;
      }),
    ];
    this.attachmentClosed = false;
  }

  get opaqueInputCapability() {
    return this.attachment.opaqueInputCapability;
  }

  async waitForReady(timeoutMs) {
    const outcome = await raceWithAbort(
      promiseWithTimeout(
        this.attachment.attachmentDecision,
        timeoutMs,
        'AIO product viewer attachment decision timed out',
      ),
      this.signal,
    );
    if (outcome?.kind !== 'ready') {
      throw new Error(
        `AIO product viewer attachment was not ready: ${JSON.stringify(outcome)}`,
      );
    }
    this.throwIfProtocolFailed();
    const identities = readAioProductViewerTransport(this.transport, true);
    this.id = identities.mainId;
    this.injectorId = identities.injectorId;
    assert(
      this.opaqueInputCapability === 'byte-preserving',
      'AIO product viewer opaque-input handshake was not ready',
    );
  }

  acceptOutput(data) {
    try {
      const chunk = Buffer.from(data);
      this.lastOutputAt = Date.now();
      this.chunks.push(chunk);
      this.term.write(chunk);
    } catch (error) {
      this.protocolFailure ??= error;
    }
  }

  sendOpaqueInputBytes(data) {
    this.throwIfProtocolFailed();
    return this.attachment.write(new Uint8Array(data));
  }

  pauseOutput() {
    this.attachment.pause();
  }

  resumeOutput() {
    this.attachment.resume();
  }

  async waitForRaw(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.throwIfProtocolFailed();
      if (this.rawOutput().includes(Buffer.from(needle, 'utf8'))) return;
      if (this.attachmentClosed) {
        throw new Error(
          `AIO product viewer closed before emitting marker ${needle}`,
        );
      }
      await delay(50, undefined, { signal: this.signal });
    }
    const tail = this.rawOutput().subarray(-4_096).toString('utf8');
    throw new Error(
      `AIO product viewer did not emit marker ${needle}` +
        (tail ? `\nterminal output tail:\n${tail}` : '\nterminal emitted no output'),
    );
  }

  drain() {
    this.throwIfProtocolFailed();
    return new Promise((resolve, reject) =>
      this.term.write('', () => {
        try {
          this.throwIfProtocolFailed();
          resolve();
        } catch (error) {
          reject(error);
        }
      }),
    );
  }

  throwIfProtocolFailed() {
    if (this.protocolFailure) throw this.protocolFailure;
  }

  rawOutput() {
    return Buffer.concat(this.chunks);
  }

  close() {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  async closeOnce() {
    let failure = null;
    let cleanupSettlement = null;
    const endpoints = readAioProductViewerTransport(this.transport, false);
    const sockets = [endpoints.mainSocket, endpoints.injectorSocket];
    try {
      this.attachment.close();
      cleanupSettlement = await promiseWithTimeout(
        this.attachment.cleanupDecision,
        30_000,
        'AIO product viewer exact cleanup decision timed out',
      );
      assertAioProductCleanupSettlement(
        cleanupSettlement,
        this.id,
        this.injectorId,
      );
      const deadline = Date.now() + 5_000;
      while (
        Date.now() < deadline &&
        sockets.some((socket) => socket.readyState !== WebSocket.CLOSED)
      ) {
        await delay(25);
      }
      if (sockets.some((socket) => socket.readyState !== WebSocket.CLOSED)) {
        for (const socket of sockets) socket.terminate?.();
        throw new Error('AIO product viewer sockets did not close cleanly');
      }
    } catch (error) {
      failure = error;
      for (const socket of sockets) socket.terminate?.();
    } finally {
      for (const subscription of this.subscriptions.splice(0)) {
        subscription.dispose();
      }
      this.term.dispose();
    }
    Object.assign(this.closeEvidence, {
      result: failure ? 'FAIL' : 'PASS',
      mainTerminalId: this.id,
      injectorTerminalId: this.injectorId,
      mainReadyState: endpoints.mainSocket.readyState,
      injectorReadyState: endpoints.injectorSocket.readyState,
      bothClosed: sockets.every(
        (socket) => socket.readyState === WebSocket.CLOSED,
      ),
      providerSessionCleanup: cleanupSettlement,
      ...(failure ? { error: errorMessage(failure) } : {}),
    });
    if (failure) throw failure;
  }
}

function assertAioProductCleanupSettlement(settlement, mainId, injectorId) {
  assert(
    CANONICAL_UUID_PATTERN.test(mainId ?? '') &&
      CANONICAL_UUID_PATTERN.test(injectorId ?? '') &&
      mainId !== injectorId,
    'AIO product viewer cleanup identities were unavailable or reused',
  );
  assert(
    settlement?.kind === 'confirmed' &&
      settlement.expectedIdentities === 2 &&
      settlement.observedIdentities === 2 &&
      settlement.confirmedIdentities === 2 &&
      settlement.deletedIdentities + settlement.alreadyAbsentIdentities === 2,
    `AIO product viewer provider sessions were not exactly absent: ${JSON.stringify(settlement)}`,
  );
}

function readAioProductViewerTransport(transport, requireIdentities) {
  const main = transport?.main;
  const injector = transport?.injector;
  const mainSocket = main?.socket;
  const injectorSocket = injector?.socket;
  assert(
    mainSocket && injectorSocket,
    'AIO product viewer dist did not expose its main/injector sockets for cleanup verification',
  );
  const mainId = main?.sessionFrame?.data;
  const injectorId = injector?.sessionFrame?.data;
  if (requireIdentities) {
    assert(
      typeof mainId === 'string' && typeof injectorId === 'string',
      'AIO product viewer dist did not expose its main/injector identities',
    );
    assert(
      CANONICAL_UUID_PATTERN.test(mainId) &&
        CANONICAL_UUID_PATTERN.test(injectorId) &&
        mainId !== injectorId,
      'AIO product viewer identities were invalid or reused',
    );
  }
  return { mainSocket, injectorSocket, mainId, injectorId };
}

class TerminalConnection {
  static async open(options) {
    options.signal?.throwIfAborted();
    const connection = new TerminalConnection(options);
    options.onAllocated?.(connection);
    try {
      await raceWithAbort(
        promiseWithTimeout(
          connection.ready,
          CONNECT_TIMEOUT_MS,
          `terminal connect timed out: ${options.wsUrl}`,
        ),
        options.signal,
      );
      options.signal?.throwIfAborted();
      return connection;
    } catch (error) {
      if (
        options.kind === 'aio' &&
        options.signal?.aborted &&
        typeof connection.id !== 'string'
      ) {
        await connection
          .waitForIdentity(250, { ignoreAbort: true })
          .catch(() => undefined);
      }
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  constructor({ kind, wsUrl, id, headers = {}, cols, rows, signal }) {
    this.kind = kind;
    this.id = id ?? null;
    this.signal = signal;
    this.everOpened = false;
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 0,
    });
    this.chunks = [];
    this.lastOutputAt = 0;
    this.closed = false;
    this.outputPaused = false;
    this.protocolFailure = null;
    this.closePromise = null;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ws = new WebSocket(wsUrl, { headers });
    this.ws.on('open', () => {
      this.everOpened = true;
      if (kind === 'boxlite') this.resolveReady();
    });
    this.ws.on('message', (raw, isBinary) => this.onMessage(raw, isBinary));
    this.ws.on('error', (error) => this.rejectReady(error));
    this.ws.on('close', () => {
      this.closed = true;
    });
    this.term.onData((data) => this.sendInput(data));
    this.term.onBinary((data) => {
      try {
        this.sendOpaqueInputBytes(Buffer.from(data, 'binary'));
      } catch (error) {
        this.protocolFailure ??= error;
      }
    });
  }

  onMessage(raw, isBinary) {
    if (this.kind === 'aio') {
      let frame;
      try {
        frame = JSON.parse(Buffer.from(raw).toString('utf8'));
      } catch {
        return;
      }
      if (frame.type === 'session_id' && typeof frame.data === 'string') {
        this.id = frame.data;
      } else if (frame.type === 'ready') {
        this.resolveReady();
      } else if (frame.type === 'output' && typeof frame.data === 'string') {
        this.acceptOutput(Buffer.from(frame.data, 'utf8'));
      } else if (frame.type === 'ping') {
        this.sendJson({ type: 'pong', timestamp: frame.timestamp });
      }
      return;
    }

    if (!isBinary) return;
    const message = Buffer.from(raw);
    if (message.length < 2 || (message[0] !== 1 && message[0] !== 2)) return;
    this.acceptOutput(message.subarray(1));
  }

  acceptOutput(chunk) {
    this.lastOutputAt = Date.now();
    this.chunks.push(Buffer.from(chunk));
    this.term.write(chunk);
  }

  async sendResize(cols, rows) {
    const open = await this.waitForOpen();
    if (!open) throw new Error('terminal closed before resize');
    if (this.kind === 'aio') {
      this.sendJson({ type: 'resize', data: { cols, rows } });
    } else {
      this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  sendInput(data) {
    if (Buffer.isBuffer(data)) return this.sendOpaqueInputBytes(data);
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.kind === 'aio') {
      this.sendJson({
        type: 'input',
        data,
      });
    } else {
      this.ws.send(Buffer.from(data, 'utf8'));
    }
    return true;
  }

  sendOpaqueInputBytes(data) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('terminal closed before opaque-byte input');
    }
    if (this.kind === 'aio') {
      throw new Error(
        'AIO JSON terminal input has no proven lossless opaque-byte encoding',
      );
    }
    this.ws.send(Buffer.from(data));
    return true;
  }

  sendAioJsonStringBytesForProbe(data) {
    if (this.kind !== 'aio') {
      throw new Error('AIO JSON byte probe requires the aio provider');
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('terminal closed before AIO JSON byte probe');
    }
    return this.sendJson({
      type: 'input',
      data: Buffer.from(data).toString('latin1'),
    });
  }

  sendAioBinaryFrameForProbe(data) {
    if (this.kind !== 'aio') {
      throw new Error('AIO binary-frame byte probe requires the aio provider');
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('terminal closed before AIO binary-frame byte probe');
    }
    this.ws.send(Buffer.from(data));
    return true;
  }

  sendJson(value) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(value));
    return true;
  }

  pauseOutput() {
    assert(
      this.ws.readyState === WebSocket.OPEN,
      'terminal closed before output pause',
    );
    this.ws.pause();
    this.outputPaused = true;
  }

  resumeOutput() {
    if (!this.outputPaused) return;
    this.ws.resume();
    this.outputPaused = false;
  }

  async waitForOpen() {
    await this.ready;
    return this.ws.readyState === WebSocket.OPEN;
  }

  async waitForIdentity(timeoutMs, { ignoreAbort = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (typeof this.id === 'string' && this.id.length > 0) return this.id;
      if (this.closed || this.ws.readyState === WebSocket.CLOSED) {
        throw new Error('terminal closed before reporting its provider identity');
      }
      await delay(
        25,
        undefined,
        ignoreAbort || !this.signal ? undefined : { signal: this.signal },
      );
    }
    throw new Error('terminal did not report its provider identity');
  }

  async waitForRaw(needle, timeoutMs) {
    return this.waitForRawAfter(needle, 0, timeoutMs);
  }

  async waitForRawAfter(
    needle,
    offset,
    timeoutMs,
    { ignoreAbort = false } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.throwIfProtocolFailed();
      if (
        this.rawOutput()
          .subarray(offset)
          .includes(Buffer.from(needle, 'utf8'))
      ) {
        return;
      }
      if (this.closed || this.ws.readyState === WebSocket.CLOSED) {
        throw new Error(`terminal closed before emitting marker ${needle}`);
      }
      await delay(
        50,
        undefined,
        ignoreAbort || !this.signal ? undefined : { signal: this.signal },
      );
    }
    const tail = this.rawOutput().subarray(-4_096).toString('utf8');
    throw new Error(
      `terminal did not emit setup marker ${needle}` +
        (tail ? `\nterminal output tail:\n${tail}` : '\nterminal emitted no output'),
    );
  }

  drain() {
    this.throwIfProtocolFailed();
    return new Promise((resolve, reject) =>
      this.term.write('', () => {
        try {
          this.throwIfProtocolFailed();
          resolve();
        } catch (error) {
          reject(error);
        }
      }),
    );
  }

  throwIfProtocolFailed() {
    if (this.protocolFailure) throw this.protocolFailure;
  }

  rawOutput() {
    return Buffer.concat(this.chunks);
  }

  isOpen() {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  async closeOnce() {
    if (this.closed || this.ws.readyState === WebSocket.CLOSED) {
      this.ws.removeAllListeners();
      this.term.dispose();
      return;
    }
    this.resumeOutput();
    if (this.kind === 'boxlite' && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stdin_eof' }));
    }
    const closed = new Promise((resolve) => this.ws.once('close', resolve));
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    } else {
      this.ws.close();
    }
    await Promise.race([closed, delay(2_000)]);
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
    this.closed = true;
    this.ws.removeAllListeners();
    this.term.dispose();
  }
}

async function requestJson(url, init) {
  const { signal: callerSignal, ...requestInit } = init;
  const timeoutSignal = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    ...requestInit,
    signal: callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 500);
    throw new Error(
      `${init.method} ${new URL(url).pathname} failed: HTTP ${response.status}` +
        (detail ? `: ${detail}` : ''),
    );
  }
  return response.json().catch(() => ({}));
}

function boxLiteHeaders() {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (process.env.BOXLITE_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.BOXLITE_API_TOKEN}`;
  }
  return headers;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const provider = argv[0];
  if (provider !== 'aio' && provider !== 'boxlite') {
    throw new Error(`provider must be aio or boxlite, received: ${provider}`);
  }
  const values = new Map();
  for (let index = 1; index < argv.length; ) {
    const key = argv[index];
    if (
      key === '--playwright' ||
      key === '--byte-oracle' ||
      key === '--strict-conformance' ||
      key === '--probe-aio-json-bytes' ||
      key === '--probe-aio-binary-frame'
    ) {
      values.set(key.slice(2), 'true');
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near ${key ?? '<end>'}`);
    }
    values.set(key.slice(2), value);
    index += 2;
  }
  const knownOptions = new Set([
    'endpoint',
    'cols',
    'rows',
    'history-lines',
    'tmux-mode',
    'rootfs',
    'image',
    'path-prefix',
    'playwright',
    'byte-oracle',
    'strict-conformance',
    'probe-aio-json-bytes',
    'probe-aio-binary-frame',
  ]);
  for (const key of values.keys()) {
    if (!knownOptions.has(key)) throw new Error(`unknown option --${key}`);
  }
  const endpoint = values.get('endpoint');
  if (!endpoint) throw new Error('--endpoint is required');
  const pathPrefixValue = values.get('path-prefix') ?? 'default';
  if (pathPrefixValue !== 'default' && pathPrefixValue !== 'none') {
    throw new Error('--path-prefix must be default or none');
  }
  const strictConformance = values.has('strict-conformance');
  const cols = positiveInteger(values.get('cols') ?? String(DEFAULT_COLS), 'cols');
  const rows = positiveInteger(values.get('rows') ?? String(DEFAULT_ROWS), 'rows');
  const historyLines = nonNegativeInteger(
    values.get('history-lines') ??
      String(strictConformance ? STRICT_HISTORY_LINES : DEFAULT_HISTORY_LINES),
    'history-lines',
  );
  if (cols < 60 || cols > 500) throw new Error('--cols must be between 60 and 500');
  if (rows < 17 || rows > 200) throw new Error('--rows must be between 17 and 200');
  if (historyLines > 200_000) {
    throw new Error('--history-lines must be at most 200000');
  }
  const tmuxMode =
    values.get('tmux-mode') ??
    (strictConformance ? 'product' : DEFAULT_TMUX_MODE);
  if (tmuxMode !== 'isolated' && tmuxMode !== 'product') {
    throw new Error('--tmux-mode must be isolated or product');
  }
  const byteProbeCount = [
    'byte-oracle',
    'probe-aio-json-bytes',
    'probe-aio-binary-frame',
  ].filter((key) => values.has(key)).length;
  if (byteProbeCount > 1) {
    throw new Error(
      '--byte-oracle and AIO byte probes are mutually exclusive',
    );
  }
  if (
    (values.has('probe-aio-json-bytes') ||
      values.has('probe-aio-binary-frame')) &&
    provider !== 'aio'
  ) {
    throw new Error('AIO byte probes require provider aio');
  }
  if (
    strictConformance &&
    (values.has('probe-aio-json-bytes') ||
      values.has('probe-aio-binary-frame'))
  ) {
    throw new Error(
      '--strict-conformance requires the formal byte oracle, not an AIO diagnostic probe',
    );
  }
  if (strictConformance && historyLines < STRICT_HISTORY_LINES) {
    throw new Error(
      `--strict-conformance requires --history-lines >= ${STRICT_HISTORY_LINES}`,
    );
  }
  if (strictConformance && tmuxMode !== 'product') {
    throw new Error('--strict-conformance requires --tmux-mode product');
  }
  if (
    provider === 'aio' &&
    (strictConformance || values.has('byte-oracle')) &&
    tmuxMode !== 'product'
  ) {
    throw new Error(
      'AIO formal byte oracle requires --tmux-mode product so it can exercise the product viewer injector',
    );
  }
  return {
    help: false,
    provider,
    endpoint,
    cols,
    rows,
    historyLines,
    tmuxMode,
    strictConformance,
    playwright: strictConformance || values.has('playwright'),
    byteOracle: strictConformance || values.has('byte-oracle'),
    probeAioJsonBytes: values.has('probe-aio-json-bytes'),
    probeAioBinaryFrame: values.has('probe-aio-binary-frame'),
    rootfs: values.get('rootfs') ?? process.env.BOXLITE_ROOTFS_PATH,
    image: values.get('image') ?? process.env.BOXLITE_IMAGE,
    pathPrefix: pathPrefixValue === 'none' ? '' : 'default',
  };
}

function printUsage() {
  console.log(`Usage:
  node scripts/terminal-fresh-attach-canary.mjs boxlite --endpoint URL [--rootfs PATH | --image IMAGE]
  node scripts/terminal-fresh-attach-canary.mjs aio --endpoint URL

Options:
  --cols N            fixed outer PTY and tmux width (default: ${DEFAULT_COLS})
  --rows N            fixed outer PTY and tmux height (default: ${DEFAULT_ROWS})
  --path-prefix VALUE BoxLite API prefix: default or none (default: default)
  --history-lines N   additionally validate N retained lines, fresh attach, and live delta
  --tmux-mode MODE    isolated named server or product default socket/exact target
                      (default: ${DEFAULT_TMUX_MODE})
  --strict-conformance
                      preset: product socket, >=50k history, Playwright, byte oracle
  --playwright        render reconnect streams in browser xterm and compare screenshots
  --byte-oracle       verify full-range, UTF-8, and legacy-mouse input at the target PTY
  --probe-aio-json-bytes
                      UNVERIFIED diagnostic: observe AIO JSON high-byte rewriting
  --probe-aio-binary-frame
                      diagnostic only: probe undocumented AIO binary input frames

Environment:
  BOXLITE_ROOTFS_PATH  local OCI rootfs used to create the throwaway box
  BOXLITE_IMAGE        pinned image alternative to BOXLITE_ROOTFS_PATH
  BOXLITE_API_TOKEN    optional bearer token; never printed

Safety:
  BoxLite mode creates and deletes one uniquely named box.
  AIO mode never creates or deletes a container; use an isolated throwaway endpoint.
  Isolated mode uses and cleans one uniquely named tmux server.
  Product mode uses the default socket and cleans only its exact unique sessions.`);
}

function normalizeHttpEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`endpoint must use http or https: ${value}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function httpToWs(value) {
  const url = new URL(value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString().replace(/\/$/, '');
}

function boxLiteBoxesUrl(baseUrl, pathPrefix) {
  const apiPath = pathPrefix ? `/v1/${encodeURIComponent(pathPrefix)}` : '/v1';
  return `${baseUrl}${apiPath}/boxes`;
}

function readString(raw, ...keys) {
  const value = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key];
  }
  return null;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function promiseWithTimeout(promise, timeoutMs, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeout);
  });
}

function raceWithAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('terminal canary operation was aborted'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function errorMessage(error, depth = 0) {
  const primary =
    error instanceof Error
      ? depth === 0
        ? (error.stack ?? error.message)
        : `${error.name}: ${error.message}`
      : String(error);
  if (!(error instanceof AggregateError) || depth >= 4) return primary;

  const nested = [...error.errors].slice(0, 8).map((cause, index) => {
    const detail = errorMessage(cause, depth + 1).replaceAll('\n', '\n    ');
    return `  [${index + 1}] ${detail}`;
  });
  if (error.errors.length > nested.length) {
    nested.push(`  [more] ${error.errors.length - nested.length} nested error(s) omitted`);
  }
  return nested.length > 0 ? `${primary}\n${nested.join('\n')}` : primary;
}

async function main(lifecycle) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  let result;
  let runFailure;
  let cleanupFailure;
  const runPromise = runCanary(
    args,
    (fn) => lifecycle.registerCleanup(fn),
    lifecycle,
  );
  lifecycle.trackRun(runPromise);
  try {
    result = await runPromise;
  } catch (error) {
    runFailure = error;
  }
  await lifecycle.waitForRunUnwind();
  try {
    await lifecycle.runCleanup();
  } catch (error) {
    cleanupFailure = error;
  }
  if (lifecycle.stoppingSignal) {
    if (cleanupFailure) {
      console.error(
        `cleanup failed after ${lifecycle.stoppingSignal}: ${errorMessage(cleanupFailure)}`,
      );
      process.exitCode = 1;
    } else {
      console.error(
        `[canary] ${lifecycle.stoppingSignal} cleanup PASS after main unwind: ` +
          JSON.stringify(
            lifecycle.cleanupEvidence ?? { result: 'PASS', evidence: 'empty' },
          ),
      );
      process.exitCode = lifecycle.stoppingSignal === 'SIGINT' ? 130 : 143;
    }
    return;
  }
  const failure =
    runFailure && cleanupFailure
      ? new AggregateError(
          [runFailure, cleanupFailure],
          'canary and cleanup both failed',
        )
      : runFailure ?? cleanupFailure;
  if (failure) {
    console.error(`FAIL: ${errorMessage(failure)}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const lifecycle = createCanaryLifecycle();
  const removeSignalCleanup = installSignalCleanup(lifecycle);
  try {
    await main(lifecycle);
  } finally {
    removeSignalCleanup();
  }
}
