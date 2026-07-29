#!/usr/bin/env node

/**
 * Real provider native-terminal canary (BoxLite or an externally managed AIO
 * container reached through an HTTP/WebSocket tunnel).
 *
 * This deliberately launches the pinned Codex and Claude Code binaries, in that
 * order, through CAP's production owner PTY and then reconnects twice through
 * the production viewer attachment factory. BoxLite may use a fresh
 * unauthenticated box or explicitly load a local credential through its
 * private-file port without printing it. AIO requires an isolated container
 * and, by default, owns a bounded stdin credential lease for the complete
 * preload -> real CLI -> exact cleanup transaction. A deprecated preloaded
 * compatibility mode is available only behind an explicit unsafe handoff
 * acknowledgement and is never release-gate eligible.
 *
 * Usage:
 *   node scripts/boxlite-real-cli-terminal-canary.mjs \
 *     --provider boxlite \
 *     --endpoint http://127.0.0.1:8100 \
 *     (--rootfs /absolute/path/to/oci | --image registry/image:tag) \
 *     [--path-prefix default|none] \
 *     [--runtime codex|claude-code|both] [--auth none|local] \
 *     [--surface direct|cap]
 *
 *   node scripts/boxlite-real-cli-terminal-canary.mjs \
 *     --provider aio \
 *     --endpoint http://127.0.0.1:18080 \
 *     --runtime codex \
 *     --auth stdin \
 *     --aio-state-ownership isolated-disposable \
 *     [--surface direct|cap] \
 *     [--owner-fault none|drop]
 *
 * The AIO ownership acknowledgement is intentionally mandatory. This canary
 * removes its workspace and the selected runtime's preloaded credential paths
 * while proving cleanup, so it must never be pointed at a shared or retained
 * sandbox by accident.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createAioCanaryCredentialLease,
  parseAioCanaryCredentialEnvelope,
  readAioCanaryCredentialStdin,
} from './aio-preload-canary-credential.mjs';

import { CodexRuntime } from '../apps/api/dist/agent-runtime/codex-runtime.js';
import { ClaudeCodeRuntime } from '../apps/api/dist/agent-runtime/claude-code-runtime.js';
import {
  DEFAULT_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS,
  TerminalGateway,
} from '../apps/api/dist/terminal/terminal.gateway.js';
import { WriteLockService } from '../apps/api/dist/write-lock/write-lock.service.js';
import {
  BoxLitePartialCreateError,
  BoxLiteRestClient,
  buildExactHasSessionCommand,
  buildSandboxCommandExecutor,
  buildSandboxTerminalViewerAttachmentFactory,
  createAioHttpCommandExecutor,
  createBoxLiteWorkspaceSecurityAdapter,
  deleteBoxLiteSandboxAndConfirm,
  detachedSessionName,
  openSandboxTerminalPty,
  terminalSessionIdForTask,
} from '../packages/sandbox/dist/index.js';

const requireFromApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const requireFromWeb = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
// `@xterm/headless` is declared by apps/web, not apps/api — 68c0907 dropped it
// from apps/api while introducing this lookup. `terminal-active-buffer-snapshot`
// already resolves it the correct way; this follows it.
const { Terminal } = requireFromWeb('@xterm/headless');
const {
  XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR,
  XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
} = requireFromApi('@cap-console/contracts');
const WsPackage = requireFromApi('ws');
const { WebSocket: NodeWebSocket, WebSocketServer } = WsPackage;
const { chromium } = requireFromWeb('@playwright/test');
const xtermBrowserScript = requireFromWeb.resolve('@xterm/xterm');
const xtermBrowserStyle = requireFromWeb.resolve('@xterm/xterm/css/xterm.css');

const WORKSPACE = '/home/gem/workspace';
const COLS = 120;
const ROWS = 36;
const RESIZED_COLS = 132;
const RESIZED_ROWS = 40;
const CREATE_TIMEOUT_MS = 240_000;
const CREATE_RECONCILE_TIMEOUT_MS = 30_000;
const CREATE_RECONCILE_QUIET_MS = 5_000;
const CREATE_RECONCILE_RETRY_MS = 100;
const TUI_TIMEOUT_MS = 45_000;
const VIEWER_TIMEOUT_MS = 20_000;
const REAL_CLI_PRESSURE_LINE_COUNT = 1_200;
const REAL_CLI_PRESSURE_LINE_DELAY_SECONDS = 0.01;
const REAL_CLI_PRESSURE_MIN_DURATION_MS = 8_000;
const REAL_CLI_PRESSURE_MAX_DURATION_MS = 20_000;
const REAL_CLI_PRESSURE_MIN_OUTPUT_BYTES = 32 * 1024;
const REAL_CLI_PRESSURE_MIN_OUTPUT_CHUNKS = 20;
const REAL_CLI_PRESSURE_MIN_POST_READY_BYTES = 4 * 1024;
const REAL_CLI_PRESSURE_MIN_POST_READY_CHUNKS = 5;
const REAL_CLI_PRESSURE_MIN_VISUAL_CHANGES = 3;
const REAL_CLI_PRESSURE_MIN_VISUAL_CHANGE_SPAN_MS = 1_000;
const REAL_CLI_PRESSURE_QUIET_MS = 120;
const REAL_CLI_PRESSURE_MAX_SETTLE_MS = 2_000;
const REAL_CLI_INITIAL_QUIET_TIMEOUT_MS = 15_000;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const CAP_STORY_VITE_CONFIG = fileURLToPath(
  new URL(
    '../apps/web/e2e/provider-terminal-story/vite.config.ts',
    import.meta.url,
  ),
);
const CAP_STORY_ARTIFACT_DIR = fileURLToPath(
  new URL(
    '../apps/web/e2e/test-results/provider-terminal-story',
    import.meta.url,
  ),
);
const activeSandboxes = new Map();
const activeBoxLiteCreateAttempts = new Set();
const activeExactCleanups = new Map();
const activeOuterTerminals = new Map();
const activeCapSurfaceHarnesses = new Set();
const activeAioFaultRelays = new Set();
const activeAioOperations = new Set();
const activeAioCredentialLeases = new Set();
const activeSecretVariants = new Set();
let cleanupPromise = null;
let canaryStopRequested = false;
let activeAioStdinAbortController = null;

export function buildRealCliPressurePlan(runtimeId, nonce, taskId = null) {
  assert(
    runtimeId === 'codex' || runtimeId === 'claude-code',
    'real CLI pressure runtime must be codex or claude-code',
  );
  assert(
    /^[a-z0-9]{8,32}$/u.test(nonce),
    'real CLI pressure nonce must be bounded lowercase alphanumeric text',
  );
  const beginMarker = `CAP_NATIVE_PRESSURE_BEGIN_${nonce}`;
  const endMarker = `CAP_NATIVE_PRESSURE_END_${nonce}`;
  const lineMarkerPrefix = `CAP_NATIVE_PRESSURE_${nonce}_`;
  const javascript =
    `const nonce='${nonce}', prefix='CAP_'+'NATIVE_PRESSURE_'+nonce+'_'; ` +
    `let i=0; console.log('CAP_'+'NATIVEPRESSURE'.replace('NATIVE','NATIVE_')+'_BEGIN_'+nonce); ` +
    `const timer=setInterval(()=>{console.log(prefix+String(i).padStart(4,'0')+'_'+'x'.repeat(48)); i+=1; ` +
    `if(i===${REAL_CLI_PRESSURE_LINE_COUNT}){clearInterval(timer); ` +
    `console.log('CAP_'+'NATIVEPRESSURE'.replace('NATIVE','NATIVE_')+'_END_'+nonce);}},` +
    `${Math.round(REAL_CLI_PRESSURE_LINE_DELAY_SECONDS * 1_000)});`;
  const nodeCommand = `node -e ${shellQuote(javascript)}`;
  const pressureWindowName =
    runtimeId === 'claude-code' ? `cap-pressure-${nonce}` : null;
  if (runtimeId === 'claude-code') {
    assert(
      typeof taskId === 'string' && taskId.length > 0,
      'Claude real CLI pressure requires an exact task identity',
    );
  }
  // Codex streams a foreground `!` command through its native TUI. Claude
  // buffers that command and renders only a bounded result preview, so it
  // cannot prove continuous PTY delivery. Ask Claude's real shell mode to
  // select a temporary window in the same task tmux session instead. That
  // window is a real foreground PTY, streams every byte to attached clients,
  // and disappears automatically when the command exits, returning viewers
  // to the unchanged Claude pane.
  const shellCommand =
    runtimeId === 'claude-code'
      ? `CAP_PRESSURE_WINDOW_ID=$(tmux new-window -d -P -F '#{window_id}' -t ${shellQuote(`=${detachedSessionName(taskId)}:`)} -n ${shellQuote(pressureWindowName)} ${shellQuote(`exec ${nodeCommand}`)}) && ` +
        `tmux set-option -w -t "$CAP_PRESSURE_WINDOW_ID" remain-on-exit off && ` +
        `tmux select-window -t "$CAP_PRESSURE_WINDOW_ID"`
      : nodeCommand;
  const submitFlushKey = runtimeId === 'claude-code' ? 'ArrowRight' : null;
  const outputMode =
    runtimeId === 'claude-code'
      ? 'temporary foreground tmux window launched by native CLI shell mode'
      : 'native CLI foreground shell output';
  // Both pinned native CLIs expose an interactive user-shell shortcut when the
  // first composer byte is `!`. This keeps the pressure deterministic and local:
  // no model request, tool scheduling, file mutation, or summarized output.
  const prompt = `!${shellCommand}`;
  // The literal markers must exist only in command output. If either marker is
  // already present in the submitted prompt, the gate could pass on input echo.
  assert(!prompt.includes(beginMarker), 'pressure prompt leaked its begin marker');
  assert(!prompt.includes(endMarker), 'pressure prompt leaked its end marker');
  assert(
    !prompt.includes(lineMarkerPrefix),
    'pressure prompt leaked its expanded line marker prefix',
  );
  return Object.freeze({
    runtimeId,
    prompt,
    shellCommand,
    beginMarker,
    endMarker,
    lineMarkerPrefix,
    pressureWindowName,
    submitFlushKey,
    outputMode,
    lineCount: REAL_CLI_PRESSURE_LINE_COUNT,
    lineDelaySeconds: REAL_CLI_PRESSURE_LINE_DELAY_SECONDS,
  });
}

export function assertRealCliContinuousOutputEvidence(evidence) {
  assert(
    evidence?.surface === 'direct' || evidence?.surface === 'cap',
    'real CLI pressure surface must be direct or cap',
  );
  assert(
    evidence?.actualInteractiveCli === true,
    'real CLI pressure did not use an actual interactive CLI',
  );
  assert(
    evidence.runtimeId === 'codex' || evidence.runtimeId === 'claude-code',
    'real CLI pressure runtime must be codex or claude-code',
  );
  const expectedOutputMode =
    evidence.runtimeId === 'claude-code'
      ? 'temporary foreground tmux window launched by native CLI shell mode'
      : 'native CLI foreground shell output';
  assert(
    evidence.commandExecution ===
      (evidence.surface === 'cap'
        ? `${expectedOutputMode} through CAP writer`
        : expectedOutputMode),
    'real CLI pressure runtime did not match its native command execution mode',
  );
  assert(evidence?.observed === true, 'real CLI pressure was not observed');
  assert(
    evidence.outputSource ===
      (evidence.surface === 'cap' ? 'cap-writer-viewer-pty' : 'owner-pty'),
    'real CLI pressure surface did not match its authoritative PTY output source',
  );
  assert(
    evidence.beginMarkerObserved === true &&
      evidence.endMarkerObserved === true,
    'real CLI pressure did not observe both command-output markers',
  );
  assert(
    evidence.observedOutputBytes >= REAL_CLI_PRESSURE_MIN_OUTPUT_BYTES,
    `real CLI pressure emitted fewer than ${REAL_CLI_PRESSURE_MIN_OUTPUT_BYTES} observed PTY bytes`,
  );
  assert(
    evidence.observedOutputChunks >= REAL_CLI_PRESSURE_MIN_OUTPUT_CHUNKS,
    `real CLI pressure emitted fewer than ${REAL_CLI_PRESSURE_MIN_OUTPUT_CHUNKS} observed PTY chunks`,
  );
  assert(
    evidence.durationMs >= REAL_CLI_PRESSURE_MIN_DURATION_MS,
    `real CLI pressure lasted less than ${REAL_CLI_PRESSURE_MIN_DURATION_MS}ms`,
  );
  assert(
    evidence.durationMs <= REAL_CLI_PRESSURE_MAX_DURATION_MS,
    `real CLI pressure lasted more than ${REAL_CLI_PRESSURE_MAX_DURATION_MS}ms`,
  );
  assert(
    evidence.quietWithinOneSecond === false,
    'real CLI pressure reached a quiet window before bounded reveal',
  );
  assert(
    evidence.preReadyTimelineComplete === true,
    'real CLI pressure output timeline was not complete before ready',
  );
  assert(
    evidence.preReadyOutputEvents > 0 && evidence.preReadyMaxGapMs >= 0,
    'real CLI pressure recorded no bounded pre-ready output timeline',
  );
  assert(
    evidence.quietThresholdMs === REAL_CLI_PRESSURE_QUIET_MS &&
      evidence.maxSettleMs === REAL_CLI_PRESSURE_MAX_SETTLE_MS,
    'real CLI pressure did not exercise the release-gate settle policy',
  );
  assert(
    evidence.wireContinuousBeforeReady ===
      (evidence.preReadyMaxGapMs < evidence.quietThresholdMs),
    'real CLI pressure wire-continuity classification was inconsistent',
  );
  assert(
    evidence.quietWithinOneSecond ===
      (evidence.preReadyMaxGapMs >= 1_000),
    'real CLI pressure one-second quiet classification was inconsistent',
  );
  assert(
    evidence.revealSettleMs >= evidence.maxSettleMs - 250,
    'real CLI pressure became ready before the maximum settle deadline',
  );
  assert(
    evidence.revealSettleMs <= evidence.maxSettleMs + 500,
    'real CLI pressure missed the bounded reveal deadline',
  );
  assert(
    evidence.hardDeadlineTimingObserved === true,
    'real CLI pressure did not exercise the maximum settle deadline',
  );
  assert(
    evidence.postReadyBytes >= REAL_CLI_PRESSURE_MIN_POST_READY_BYTES,
    `real CLI pressure emitted fewer than ${REAL_CLI_PRESSURE_MIN_POST_READY_BYTES} bytes after ready`,
  );
  assert(
    evidence.postReadyChunks >= REAL_CLI_PRESSURE_MIN_POST_READY_CHUNKS,
    `real CLI pressure emitted fewer than ${REAL_CLI_PRESSURE_MIN_POST_READY_CHUNKS} chunks after ready`,
  );
  if (evidence.runtimeId === 'claude-code') {
    const lifecycle = evidence.pressureWindowLifecycle;
    assert(
      lifecycle?.kind === 'temporary-window' &&
        /^cap-pressure-[a-z0-9]{8,32}$/u.test(lifecycle.windowName) &&
        isExactTmuxPaneIdentityShape(lifecycle.originalPaneIdentity) &&
        isExactTmuxPaneIdentityShape(lifecycle.pressurePaneIdentity) &&
        lifecycle.originalPaneIdentity.windowActive === true &&
        lifecycle.originalPaneIdentity.paneDead === false &&
        lifecycle.pressurePaneIdentity.windowActive === true &&
        lifecycle.pressurePaneIdentity.paneDead === false &&
        lifecycle.originalPaneIdentity?.sessionName ===
          lifecycle.pressurePaneIdentity?.sessionName &&
        lifecycle.originalPaneIdentity?.windowId !==
          lifecycle.pressurePaneIdentity?.windowId &&
        lifecycle.originalPaneIdentity?.paneId !==
          lifecycle.pressurePaneIdentity?.paneId &&
        lifecycle.originalPaneIdentity?.paneTty !==
          lifecycle.pressurePaneIdentity?.paneTty &&
        lifecycle.pressurePaneIdentity?.windowName === lifecycle.windowName &&
        lifecycle.pressureWindowAbsentAfterEnd === true &&
        lifecycle.originalPaneRestoredAfterEnd === true,
      'Claude pressure did not prove an exact temporary tmux pane lifecycle',
    );
  } else {
    assert(
      evidence.pressureWindowLifecycle?.kind === 'not-applicable',
      'Codex pressure must not claim a temporary tmux window lifecycle',
    );
  }
  if (evidence.surface === 'direct') {
    assert(
      evidence.quietCurrentFrameAfterPressure === true &&
        evidence.stableCurrentFrameAfterPressure === true,
      'direct real CLI pressure did not return to a quiet stable native frame',
    );
  }
  if (evidence.surface === 'cap') {
    assert(
      evidence.browserInputViaGateway === true,
      'real CLI pressure input did not cross the CAP Gateway',
    );
    assert(
      evidence.browserWriterOutputBytes >= REAL_CLI_PRESSURE_MIN_OUTPUT_BYTES,
      `real CLI pressure browser writer received fewer than ${REAL_CLI_PRESSURE_MIN_OUTPUT_BYTES} bytes`,
    );
    assert(
      evidence.browserWriterOutputChunks >= REAL_CLI_PRESSURE_MIN_OUTPUT_CHUNKS,
      `real CLI pressure browser writer received fewer than ${REAL_CLI_PRESSURE_MIN_OUTPUT_CHUNKS} chunks`,
    );
    assert(
      typeof evidence.writerAttachmentId === 'string' &&
        evidence.writerAttachmentId.length > 0 &&
        typeof evidence.pressureAttachmentId === 'string' &&
        evidence.pressureAttachmentId.length > 0 &&
        evidence.pressureAttachmentId !== evidence.writerAttachmentId,
      'real CLI pressure viewer did not have a fresh attachment identity',
    );
    assert(
      evidence.domRevealed === true,
      'real CLI pressure viewer did not reveal its production xterm',
    );
    assert(
      evidence.domRevealMs <= evidence.maxSettleMs + 1_000,
      'real CLI pressure production xterm missed its bounded DOM reveal',
    );
    assert(
      evidence.dynamicScreenshotBytes > 1_000,
      'real CLI pressure production xterm screenshot was blank',
    );
    assert(
      evidence.dynamicScreenshotDuringOutput === true,
      'real CLI pressure screenshot was not captured during live output',
    );
    assert(
      evidence.postScreenshotBytes > 0 &&
        evidence.postScreenshotPressureSequence >
          evidence.screenshotPressureSequence,
      'real CLI pressure xterm did not advance after its dynamic screenshot',
    );
    assert(
      evidence.visualStateChanges >= REAL_CLI_PRESSURE_MIN_VISUAL_CHANGES,
      `real CLI pressure production xterm changed fewer than ${REAL_CLI_PRESSURE_MIN_VISUAL_CHANGES} times`,
    );
    assert(
      evidence.visualChangeSpanMs >=
        REAL_CLI_PRESSURE_MIN_VISUAL_CHANGE_SPAN_MS,
      `real CLI pressure production xterm changed for less than ${REAL_CLI_PRESSURE_MIN_VISUAL_CHANGE_SPAN_MS}ms`,
    );
    assert(
      evidence.pressureViewerCleanup?.kind === 'confirmed',
      'real CLI pressure viewer cleanup was not confirmed',
    );
    assert(
      evidence.originalPaneRestoredAtCleanup === true &&
        evidence.originalPaneStopConfirmed === true &&
        evidence.originalPaneStableAfterStop === true &&
        /^[0-9a-f]{64}$/u.test(evidence.stoppedSourceSha256),
      'CAP pressure did not stop and stabilize the fixed original CLI pane',
    );
    if (evidence.runtimeId === 'claude-code') {
      assert(
        evidence.pressureWindowCleanupConfirmed === true,
        'Claude CAP pressure did not confirm exact temporary-window cleanup',
      );
    } else {
      assert(
        evidence.pressureWindowCleanupConfirmed === null,
        'Codex CAP pressure must report temporary-window cleanup as not applicable',
      );
    }
  }
  return evidence;
}

function requestCanaryStop() {
  canaryStopRequested = true;
  activeAioStdinAbortController?.abort();
  for (const lease of activeAioCredentialLeases) lease.requestStop();
}

function assertCanaryRunning(label) {
  assert(!canaryStopRequested, `${label} refused after canary stop`);
}

function trackAioOperation(operationFactory) {
  let operation;
  operation = Promise.resolve()
    .then(operationFactory)
    .finally(() => activeAioOperations.delete(operation));
  activeAioOperations.add(operation);
  return operation;
}

export function createSignalFencedAioCommandExecutor(rawCommandExecutor) {
  return {
    cleanupExec: (request) =>
      trackAioOperation(() => rawCommandExecutor.exec(request)),
    exec(request) {
      assertCanaryRunning('AIO command exec');
      return trackAioOperation(() => rawCommandExecutor.exec(request));
    },
  };
}

async function executeAioCredentialLeaseCommand({
  commandExecutor,
  endpoint,
  expectedEndpoint,
  command,
  label,
}) {
  const normalizedExpectedEndpoint = new URL(expectedEndpoint).href.replace(
    /\/+$/u,
    '',
  );
  assert(
    endpoint === normalizedExpectedEndpoint,
    'AIO credential endpoint changed',
  );
  const result = await trackAioOperation(() =>
    commandExecutor.exec({
      command,
      cwd: '/home/gem',
      timeoutMs: 60_000,
    }),
  );
  assert(
    result.exitCode === 0 && !result.timedOut,
    `${label} was not confirmed`,
  );
  return String(result.output ?? '');
}

async function waitForActiveAioOperations() {
  const settlements = await Promise.allSettled([...activeAioOperations]);
  const failures = settlements
    .filter((settlement) => settlement.status === 'rejected')
    .map((settlement) => settlement.reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'in-flight AIO command operations failed before cleanup',
    );
  }
}

function installCanarySignalHandlers() {
  const handlers = new Map();
  let signalCleanup;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (signalCleanup) return;
      requestCanaryStop();
      let cleanupFailed = false;
      signalCleanup = cleanupAll()
        .catch((error) => {
          cleanupFailed = true;
          console.error(error instanceof Error ? error.stack : error);
        })
        .finally(() =>
          process.exit(cleanupFailed ? 1 : signal === 'SIGINT' ? 130 : 143),
        );
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  let aioCredentialEnvelopeBytes = null;
  try {
    if (options.provider === 'aio' && options.auth === 'stdin') {
      assertCanaryRunning('AIO credential stdin read');
      const stdinAbortController = new AbortController();
      activeAioStdinAbortController = stdinAbortController;
      try {
        aioCredentialEnvelopeBytes = await readAioCanaryCredentialStdin({
          signal: stdinAbortController.signal,
        });
      } finally {
        if (activeAioStdinAbortController === stdinAbortController) {
          activeAioStdinAbortController = null;
        }
      }
      assertCanaryRunning('AIO credential stdin validation');
      registerAioCredentialSecrets(
        parseAioCanaryCredentialEnvelope(
          aioCredentialEnvelopeBytes,
          options.runtime,
        ),
        options.runtime,
      );
    }

    const client =
      options.provider === 'boxlite'
        ? new BoxLiteRestClient({
            baseUrl: options.endpoint,
            apiToken: process.env.BOXLITE_API_TOKEN,
            timeoutMs: CREATE_TIMEOUT_MS,
            protocolMode: 'native',
            pathPrefix: options.pathPrefix,
          })
        : null;
    const initialInventory = client ? await sandboxInventory(client) : null;
    const cases = [];
    const executionOrder =
      options.runtime === 'both'
        ? ['codex', 'claude-code']
        : [options.runtime];

    // In the release run, the order is part of the contract: Codex then Claude.
    for (const runtimeId of executionOrder) {
      assertCanaryRunning(`${runtimeId} runtime case`);
      cases.push(
        await runRuntimeCase({
          client,
          options,
          runtimeId,
          runtime:
            runtimeId === 'codex'
              ? new CodexRuntime()
              : new ClaudeCodeRuntime(),
          aioCredentialEnvelopeBytes,
        }),
      );
      if (client) {
        await assertInventory(client, initialInventory, `after ${runtimeId}`);
      }
    }

    await cleanupAll();
    if (client) await assertInventory(client, initialInventory, 'final');
    const report = {
      result: 'PASS',
      releaseGateEligible: options.releaseGateEligible,
      provider: options.provider,
      surface: options.surface,
      endpoint: options.endpoint,
      executionOrder,
      authentication: {
        mode: options.auth,
        atomicOwner: options.provider === 'aio' && options.auth === 'stdin',
        unsafePreloadedCredentialHandoff:
          options.unsafePreloadedCredentialHandoff,
      },
      ...(initialInventory ? { baselineSandboxIds: initialInventory } : {}),
      cases,
      cleanup:
        options.provider === 'boxlite'
          ? 'all throwaway boxes confirmed absent; inventory unchanged'
          : options.auth === 'stdin'
            ? 'atomic stdin credential lease, exact task tmux sessions, workspace, and selected runtime credential paths confirmed absent; isolated AIO container lifecycle untouched'
            : 'unsafe preloaded compatibility credential paths, exact task tmux sessions, and workspace confirmed absent; isolated AIO container lifecycle untouched',
    };
    const serializedReport = JSON.stringify(report, null, 2);
    assertNoSecrets(serializedReport, 'final report');
    console.log(serializedReport);
  } finally {
    aioCredentialEnvelopeBytes?.fill(0);
  }
}

async function runRuntimeCase({
  client,
  options,
  runtimeId,
  runtime,
  aioCredentialEnvelopeBytes,
}) {
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const boxName = `cap-real-cli-${runtimeId.replaceAll('-', '')}-${nonce}`;
  const runtimeSlug = runtimeId === 'claude-code' ? 'cc' : 'cx';
  const taskId = `${
    options.surface === 'cap' ? 'terminal-story' : 'realcli'
  }-${runtimeSlug}-${nonce}`;
  const sessionName = detachedSessionName(taskId);
  assert(
    Buffer.byteLength(sessionName, 'utf8') <= 48,
    'real CLI canary tmux session name exceeds the safe product-story bound',
  );
  const before = client ? await sandboxInventory(client) : null;
  let sandboxId = null;
  let connection = null;
  let selectedRun = null;
  let viewerConnection = null;
  let viewerSelectedRun = null;
  let commandExecutor = null;
  let cleanupCommandExecutor = null;
  let aioCredentialLease = null;
  let exactCleanup = null;
  let owner = null;
  let ownerCapture = null;
  let ownerQueryEvidence = null;
  let viewerOne = null;
  let viewerOneCapture = null;
  let warmupQueryEvidence = null;
  let viewerOneQueryEvidence = null;
  let viewerTwo = null;
  let viewerTwoCapture = null;
  let runtimeSecurityAdapter = null;
  let capGatewayBrowser = null;
  let aioFaultRelay = null;
  const ownerRecoveryEvents = [];
  let ownerTransportDropEvidence = null;
  let primaryError = null;
  const viewerCloseSettlementsMs = {};

  try {
    if (options.provider === 'boxlite') {
      const createAttempt = beginBoxLiteCreateAttempt({
        client,
        boxName,
        baselineSandboxIds: before,
        request: {
          taskId: boxName,
          sandboxId: boxName,
          ...(options.rootfs
            ? { rootfsPath: options.rootfs }
            : { image: options.image }),
          diskSizeGb: 8,
          // Override possible daemon/image auth injection without ever reading it.
          env: {
            OPENAI_API_KEY: '',
            CODEX_API_KEY: '',
            ANTHROPIC_API_KEY: '',
            ANTHROPIC_AUTH_TOKEN: '',
            CLAUDE_CODE_OAUTH_TOKEN: '',
          },
        },
      });
      let created;
      try {
        created = await createAttempt.promise;
      } catch (error) {
        try {
          await cleanupBoxLiteCreateAttempt(createAttempt);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'BoxLite create and exact reconciliation failed',
          );
        }
        throw error;
      }
      sandboxId = created.id;
      activeSandboxes.set(sandboxId, client);
      activeBoxLiteCreateAttempts.delete(createAttempt);
      connection = {
        taskId,
        baseUrl: `${nativeBoxesUrl(options.endpoint, options.pathPrefix)}/${encodeURIComponent(sandboxId)}`,
        wsUrl: httpToWs(options.endpoint),
      };
      selectedRun = buildBoxLiteSelectedRun({
        client,
        taskId,
        sandboxId,
        endpoint: options.endpoint,
        pathPrefix: options.pathPrefix,
        connection,
      });
      commandExecutor = buildSandboxCommandExecutor({ connection, selectedRun });
      cleanupCommandExecutor = commandExecutor;
    } else {
      const upstreamWsUrl = `${httpToWs(options.endpoint)}/v1/shell/ws`;
      if (options.ownerFault === 'drop') {
        aioFaultRelay = await createAioTerminalFaultRelay(upstreamWsUrl);
        activeAioFaultRelays.add(aioFaultRelay);
      }
      connection = {
        taskId,
        baseUrl: options.endpoint,
        wsUrl: aioFaultRelay?.wsUrl ?? upstreamWsUrl,
      };
      selectedRun = buildAioSelectedRun({ taskId, connection });
      // The fault relay exists only to sever the owner generation. Keeping
      // ordinary viewers behind it would let the relay complete its local close
      // before the upstream AIO close handshake finishes, so exact cleanup could
      // race an artificial still-open provider connection. Browser viewers and
      // API re-adoption must exercise the production direct AIO path.
      viewerConnection = {
        ...connection,
        wsUrl: upstreamWsUrl,
      };
      viewerSelectedRun = buildAioSelectedRun({
        taskId,
        connection: viewerConnection,
      });
      cleanupCommandExecutor = createAioHttpCommandExecutor({
        baseUrl: options.endpoint,
        taskId,
      });
      commandExecutor = createSignalFencedAioCommandExecutor(
        cleanupCommandExecutor,
      );
    }

    assertCanaryRunning(`${runtimeId} exact cleanup registration`);
    exactCleanup = registerExactCleanup(
      `${options.provider}:${taskId}`,
      async () => {
        const failures = [];
        if (aioCredentialLease) {
          try {
            await aioCredentialLease.cleanup();
            activeAioCredentialLeases.delete(aioCredentialLease);
            aioCredentialLease = null;
          } catch (error) {
            failures.push(error);
          }
        }
        let evidence = null;
        try {
          evidence = await cleanupRuntimeResources({
            commandExecutor: cleanupCommandExecutor,
            taskId,
            runtimeId,
            runtimeSecurityAdapter,
            provider: options.provider,
            ownsAioState: options.ownsAioState,
          });
          runtimeSecurityAdapter = null;
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            `${runtimeId} credential and runtime cleanup failed`,
          );
        }
        return evidence;
      },
    );

    if (options.auth === 'local') {
      runtimeSecurityAdapter = await prepareAuthenticatedRuntime({
        client,
        sandboxId,
        commandExecutor,
        runtimeId,
        runtime,
        taskId,
      });
    } else if (options.auth === 'none') {
      await prepareUnauthenticatedRuntime({
        commandExecutor,
        runtimeId,
      });
    } else {
      if (options.auth === 'stdin') {
        assert(
          Buffer.isBuffer(aioCredentialEnvelopeBytes),
          'AIO stdin credential envelope was not retained by the canary owner',
        );
        assertCanaryRunning(`${runtimeId} atomic credential preload`);
        aioCredentialLease = createAioCanaryCredentialLease({
          endpoint: options.endpoint,
          runtime: runtimeId,
          envelopeBytes: aioCredentialEnvelopeBytes,
          executeCommand: ({ endpoint, command, label }) =>
            executeAioCredentialLeaseCommand({
              commandExecutor: cleanupCommandExecutor,
              endpoint,
              expectedEndpoint: options.endpoint,
              command,
              label,
            }),
        });
        activeAioCredentialLeases.add(aioCredentialLease);
        await aioCredentialLease.preload();
        assertCanaryRunning(`${runtimeId} post-preload handoff`);
      }
      await preparePreloadedRuntime({ commandExecutor, runtimeId });
    }
    const versions = await readVersionsWithoutCredentials(commandExecutor);

    assertCanaryRunning(`${runtimeId} owner terminal launch`);
    owner = trackOuterTerminal(openSandboxTerminalPty({
      connection,
      selectedRun,
      mode: 'launch-or-attach',
      resolveTaskLaunchContext: async () => ({
        runtime,
        executionMode: 'interactive-pty',
        modelIntent: { kind: 'runtime-default' },
      }),
      ownerRecoveryPolicy: {
        onEvent(event) {
          ownerRecoveryEvents.push({ ...event, observedAt: Date.now() });
        },
      },
    }), `${options.provider}:${taskId}:owner`);
    ownerCapture = new TerminalCapture({
      endpoint: owner,
      cols: COLS,
      rows: ROWS,
      inputKind: 'text',
      // CAP's owner engine is the authoritative Codex startup-CPR responder.
      suppressCpr: runtimeId === 'codex',
    });
    owner.resize(COLS, ROWS);
    const launchOutcome = await withTimeout(
      owner.launchDecision,
      60_000,
      `${runtimeId} launch decision timed out`,
    );
    assert(
      launchOutcome.kind === 'launched',
      `${runtimeId} did not launch a fresh product terminal: ${JSON.stringify(launchOutcome)}`,
    );
    owner.resize(COLS, ROWS);
    await waitForExactSession(
      commandExecutor,
      taskId,
      ownerCapture,
      runtimeId,
    );
    await ownerCapture.waitForNativeTui(runtimeId, TUI_TIMEOUT_MS);
    const ownerQuietBeforePressure = await ownerCapture.waitForQuiet(
      1_000,
      REAL_CLI_INITIAL_QUIET_TIMEOUT_MS,
    );
    assert(
      ownerQuietBeforePressure,
      `${runtimeId} real CLI did not expose a quiet non-empty native frame: ${JSON.stringify(
        ownerCapture.outputDiagnostics(),
      )}`,
    );
    const ownerStableBeforeFreeze = await ownerCapture.waitForStableState(
      1_500,
      10_000,
    );
    assert(
      ownerStableBeforeFreeze,
      `${runtimeId} owner screen did not stabilize before reconnect test`,
    );
    await ownerCapture.drain();
    const ownerState = ownerCapture.state();
    assertNativeTui(ownerState, ownerCapture.raw(), runtimeId, 'owner');
    assertNoSecrets(ownerCapture.raw(), `${runtimeId} owner terminal`);
    ownerQueryEvidence = { ...ownerCapture.queryEvidence };
    const processEvidence = await verifyRealCliProcess({
      commandExecutor,
      runtimeId,
      taskId,
    });

    if (aioFaultRelay) {
      ownerTransportDropEvidence = await verifyAioOwnerTransportDrop({
        relay: aioFaultRelay,
        ownerCapture,
        ownerRecoveryEvents,
        commandExecutor,
        runtimeId,
        taskId,
      });
      ownerQueryEvidence = { ...ownerCapture.queryEvidence };
    }

    // Product owner resize drives both the provider PTY and the exact detached
    // tmux window. Restore the canonical geometry before reconnect comparison.
    owner.resize(RESIZED_COLS, RESIZED_ROWS);
    await waitForTmuxGeometry(
      commandExecutor,
      taskId,
      RESIZED_COLS,
      RESIZED_ROWS,
    );
    owner.resize(COLS, ROWS);
    await waitForTmuxGeometry(commandExecutor, taskId, COLS, ROWS);
    assert(
      await ownerCapture.waitForStableState(1_000, 5_000),
      `${runtimeId} owner screen did not stabilize after geometry restore`,
    );

    const viewerPolicy = {
      firstOutputTimeoutMs: 10_000,
      quietMs: REAL_CLI_PRESSURE_QUIET_MS,
      maxSettleMs: REAL_CLI_PRESSURE_MAX_SETTLE_MS,
      probeTimeoutMs: 10_000,
    };
    const viewerFactory = buildSandboxTerminalViewerAttachmentFactory({
      taskId,
      connection: viewerConnection ?? connection,
      selectedRun: viewerSelectedRun ?? selectedRun,
      policy: viewerPolicy,
    });

    let continuousDeadlineEvidence = null;
    if (options.surface !== 'cap') {
      continuousDeadlineEvidence =
        await runRealCliContinuousOutputPressure({
          owner,
          ownerCapture,
          viewerFactory,
          commandExecutor,
          runtimeId,
          taskId,
          nonce,
          quietMs: viewerPolicy.quietMs,
          maxSettleMs: viewerPolicy.maxSettleMs,
        });
      viewerCloseSettlementsMs.continuousPressure =
        await waitForNoTmuxClients(commandExecutor, taskId);
    }

    // Freeze only the processes attached to the exact tmux pane.  This turns
    // the already-rendered real CLI into a genuinely quiet frame while leaving
    // tmux alive, so two fresh provider PTYs must reconstruct the same screen.
    await signalExactRuntime(commandExecutor, taskId, 'STOP');
    const quietAfterStop = await ownerCapture.waitForQuiet(1_000, 5_000);
    const visualStableAfterStop = await ownerCapture.waitForStableState(
      1_000,
      5_000,
    );
    assert(
      visualStableAfterStop,
      `${runtimeId} screen did not stabilize after exact STOP: ${JSON.stringify(
        ownerCapture.outputDiagnostics(),
      )}`,
    );

    if (options.surface === 'cap') {
      const apiRestartOwnerEvidence = {
        openCalls: 0,
        launchContextCalls: 0,
        beforeAgentLaunchCalls: 0,
      };
      capGatewayBrowser = await runCapGatewayBrowserStory({
        taskId,
        runtimeId,
        provider: options.provider,
        providerEndpoint: options.endpoint,
        nonce,
        owner,
        viewerFactory,
        viewerPolicy,
        commandExecutor,
        apiRestartOwnerEvidence,
        openAttachOnlyOwner: () => {
          assertCanaryRunning(`${runtimeId} restart owner attachment`);
          apiRestartOwnerEvidence.openCalls += 1;
          return trackOuterTerminal(openSandboxTerminalPty({
            connection: viewerConnection ?? connection,
            selectedRun: viewerSelectedRun ?? selectedRun,
            mode: 'attach-only',
            resolveTaskLaunchContext: async () => {
              apiRestartOwnerEvidence.launchContextCalls += 1;
              throw new Error('attach-only API re-adoption requested launch context');
            },
            beforeAgentLaunch: async () => {
              apiRestartOwnerEvidence.beforeAgentLaunchCalls += 1;
              throw new Error('attach-only API re-adoption attempted a fresh launch');
            },
          }), `${options.provider}:${taskId}:restart-owner`);
        },
      });
      continuousDeadlineEvidence =
        capGatewayBrowser.continuousDeadlineEvidence;
    }
    assertRealCliContinuousOutputEvidence(continuousDeadlineEvidence);

    await ownerCapture.close();
    ownerCapture = null;
    await closeTrackedOuterTerminal(owner);
    owner = null;
    viewerCloseSettlementsMs.owner = await waitForNoTmuxClients(
      commandExecutor,
      taskId,
    );
    await assertExactSessionAlive(commandExecutor, taskId);
    const tmuxSourceBeforeFirst = await waitForTmuxPaneStable(
      commandExecutor,
      taskId,
      1_000,
      8_000,
    );
    const tmuxSnapshotBeforeFirst = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    assertNoSecrets(
      tmuxSnapshotBeforeFirst.output,
      `${runtimeId} tmux source before first viewer`,
    );
    assert(
      tmuxSnapshotBeforeFirst.digest === tmuxSourceBeforeFirst,
      `${runtimeId} tmux source changed after the stable-source fence`,
    );

    // The first client after a complete disconnect may make tmux canonicalize
    // its client viewport.  Treat it as an explicit warm-up and prove whether
    // that changed the authoritative pane before measuring two later viewers.
    ({ attachment: viewerOne, capture: viewerOneCapture } =
      await openViewerCapture(viewerFactory, runtimeId, true));
    assertNativeTui(
      viewerOneCapture.state(),
      viewerOneCapture.raw(),
      runtimeId,
      'post-disconnect warm-up viewer',
    );
    assertNoSecrets(
      viewerOneCapture.raw(),
      `${runtimeId} warm-up viewer terminal`,
    );
    warmupQueryEvidence = { ...viewerOneCapture.queryEvidence };
    const tmuxSnapshotAfterFirst = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    assertNoSecrets(
      tmuxSnapshotAfterFirst.output,
      `${runtimeId} tmux source after first viewer`,
    );
    const tmuxSourceAfterFirst = tmuxSnapshotAfterFirst.digest;
    const warmupSourceChanged = tmuxSourceAfterFirst !== tmuxSourceBeforeFirst;
    const warmupSourceDifference = warmupSourceChanged
      ? comparePaneSnapshots(
          tmuxSnapshotBeforeFirst.output,
          tmuxSnapshotAfterFirst.output,
        )
      : null;
    await viewerOneCapture.close();
    viewerOneCapture = null;
    await closeTrackedOuterTerminal(viewerOne);
    viewerOne = null;
    viewerCloseSettlementsMs.warmup = await waitForNoTmuxClients(
      commandExecutor,
      taskId,
    );

    const tmuxMeasurementSource = await waitForTmuxPaneStable(
      commandExecutor,
      taskId,
      1_000,
      8_000,
    );
    const tmuxMeasurementSnapshot = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    assert(
      tmuxMeasurementSnapshot.digest === tmuxMeasurementSource,
      `${runtimeId} tmux source changed after the measurement fence`,
    );
    ({ attachment: viewerOne, capture: viewerOneCapture } =
      await openViewerCapture(viewerFactory, runtimeId, true));
    const firstState = viewerOneCapture.state();
    const firstRaw = viewerOneCapture.raw();
    const firstUtf8Evidence = viewerOneCapture.utf8Evidence();
    assertNativeTui(firstState, firstRaw, runtimeId, 'first measured viewer');
    assertNoSecrets(firstRaw, `${runtimeId} first measured viewer terminal`);
    const tmuxMeasurementSnapshotAfterFirst = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    assert(
      tmuxMeasurementSnapshotAfterFirst.digest === tmuxMeasurementSource,
      `${runtimeId} tmux source changed during first measured attach: ${JSON.stringify(
        comparePaneSnapshots(
          tmuxMeasurementSnapshot.output,
          tmuxMeasurementSnapshotAfterFirst.output,
        ),
      )}`,
    );
    viewerOneQueryEvidence = { ...viewerOneCapture.queryEvidence };
    await viewerOneCapture.close();
    viewerOneCapture = null;
    await closeTrackedOuterTerminal(viewerOne);
    viewerOne = null;
    viewerCloseSettlementsMs.firstMeasured = await waitForNoTmuxClients(
      commandExecutor,
      taskId,
    );

    // No owner or application output is required in this gap.  The second empty
    // xterm must reconstruct the current frame from a brand-new tmux client.
    ({ attachment: viewerTwo, capture: viewerTwoCapture } =
      await openViewerCapture(viewerFactory, runtimeId, true));
    const secondState = viewerTwoCapture.state();
    const secondRaw = viewerTwoCapture.raw();
    const secondUtf8Evidence = viewerTwoCapture.utf8Evidence();
    assertNativeTui(secondState, secondRaw, runtimeId, 'second fresh viewer');
    assertNoSecrets(secondRaw, `${runtimeId} second viewer terminal`);
    const tmuxSourceAfterSecond = await captureTmuxPaneDigest(
      commandExecutor,
      taskId,
    );
    assert(
      tmuxSourceAfterSecond === tmuxMeasurementSource,
      `${runtimeId} tmux source changed between fresh attaches`,
    );
    const frameComparison = compareStates(firstState, secondState);
    assert(
      frameComparison.canonicalEqual,
      `${runtimeId} fresh viewer current frames differ: ${JSON.stringify({
        frameComparison,
        firstUtf8Evidence,
        secondUtf8Evidence,
        firstFocusModeEvidence: terminalModeEvidence(firstRaw, 1004),
        secondFocusModeEvidence: terminalModeEvidence(secondRaw, 1004),
      })}`,
    );

    const playwright = await compareBrowserScreens(
      firstRaw,
      secondRaw,
      COLS,
      ROWS,
    );

    await signalExactRuntime(commandExecutor, taskId, 'CONT');
    const beforeInputBytes = viewerTwoCapture.byteLength;
    const writeOutcome = viewerTwo.write(Buffer.from('\x0c', 'binary'));
    assert(writeOutcome === 'written', `${runtimeId} viewer input was not written`);
    await viewerTwoCapture.waitForAdditionalOutput(beforeInputBytes, 8_000);
    const quietAfterInput = await viewerTwoCapture.waitForQuiet(300, 2_000);
    await viewerTwoCapture.drain();
    const afterInputState = viewerTwoCapture.state();
    assert(
      afterInputState.nonBlankCells > 20,
      `${runtimeId} live continuation became blank after input`,
    );
    viewerTwo.resize(100, 30);
    await delay(150);
    viewerTwo.resize(COLS, ROWS);
    await delay(150);
    await assertExactSessionAlive(commandExecutor, taskId);

    const queryEvidence = mergeQueryEvidence(
      ownerQueryEvidence,
      warmupQueryEvidence,
      viewerOneQueryEvidence,
      viewerTwoCapture.queryEvidence,
    );
    const viewerTwoEvidence = viewerTwoCapture.queryEvidence;
    assert(
      viewerTwoEvidence.responsesForwarded > 0,
      `${runtimeId} fresh viewer produced no xterm device response`,
    );
    const observedQueryCount =
      queryEvidence.dsrQueries +
      queryEvidence.primaryDaQueries +
      queryEvidence.secondaryDaQueries +
      queryEvidence.colorQueries;
    assert(
      observedQueryCount > 0 && queryEvidence.responsesForwarded > 0,
      `${runtimeId} produced no correlated terminal query/response exchange`,
    );
    assert(
      queryEvidence.dsrQueries === 0 ||
        queryEvidence.cprResponsesGenerated > 0,
      `${runtimeId} emitted DSR without a generated CPR`,
    );

    await viewerTwoCapture.close();
    viewerTwoCapture = null;
    await closeTrackedOuterTerminal(viewerTwo);
    viewerTwo = null;
    viewerCloseSettlementsMs.secondMeasured = await waitForNoTmuxClients(
      commandExecutor,
      taskId,
    );

    const opaqueInputOracle = await runProductViewerByteOracle({
      commandExecutor,
      connection,
      selectedRun,
      nonce,
      provider: options.provider,
    });

    await closeAllTrackedOuterTerminals();
    const outerTerminalExecutionsClosedWithStdinEof =
      activeOuterTerminals.size === 0;
    assert(
      outerTerminalExecutionsClosedWithStdinEof,
      `${runtimeId} outer terminal cleanup remained indeterminate`,
    );
    let cleanupEvidence = {
      ...(await exactCleanup.run()),
      outerTerminalExecutionsClosedWithStdinEof,
    };
    exactCleanup = null;
    if (options.provider === 'boxlite') {
      await deleteBoxLiteSandboxAndConfirm({
        client,
        sandboxId,
        waitForRetry: async () => delay(50),
      });
      activeSandboxes.delete(sandboxId);
      sandboxId = null;
      await assertInventory(client, before, `after ${runtimeId} case`);
      cleanupEvidence = {
        ...cleanupEvidence,
        providerResourceLifecycle: 'throwaway BoxLite sandbox deleted',
        boxConfirmedAbsent: true,
        inventoryUnchanged: true,
      };
    } else {
      cleanupEvidence = {
        ...cleanupEvidence,
        providerResourceLifecycle:
          'isolated AIO container lifecycle externally managed and untouched',
        containerCreateAttempted: false,
        containerDeleteAttempted: false,
      };
    }

    return {
      result: 'PASS',
      releaseGateEligible: options.releaseGateEligible,
      runtime: runtimeId,
      provider: options.provider,
      surface: options.surface,
      versions,
      launchOutcome: 'launched',
      authBoundary:
        options.auth === 'local'
          ? 'local credential delivered only through the BoxLite private-file port; terminal, report, and cleanup surfaces scanned for secret variants'
          : options.auth === 'stdin'
            ? 'credential arrived only through bounded stdin and remained under the same canary owner from exact AIO preload through real CLI verification and confirmed cleanup; terminal and report surfaces were scanned for secret variants'
          : options.auth === 'preloaded'
            ? 'deprecated unsafe preloaded credential handoff was explicitly acknowledged; this compatibility result is not release-gate eligible and exact runtime credential paths were removed after verification'
            : 'fresh sandbox forced unauthenticated; only the real CLI login/auth TUI was inspected',
      visibleState: classifyVisibleState(secondState.visibleText),
      actualCliProcess: processEvidence,
      tmux: {
        socket: 'default',
        exactSession: sessionName,
        ownerResize: `${RESIZED_COLS}x${RESIZED_ROWS}`,
        restoredGeometry: `${COLS}x${ROWS}`,
      },
      reconnect: {
        firstNonBlankCells: firstState.nonBlankCells,
        secondNonBlankCells: secondState.nonBlankCells,
        firstStateSha256: firstState.hash,
        secondStateSha256: secondState.hash,
        currentFrameEqual: frameComparison.canonicalEqual,
        alternateScreen: secondState.bufferType === 'alternate',
        liveContinuationAfterInput: true,
        quietFrameAfterExactStop: quietAfterStop,
        visualStableAfterExactStop: visualStableAfterStop,
        quietAfterInput,
        viewerCloseSettlementsMs,
        continuousDeadlineEvidence,
        tmuxSourceSha256: tmuxMeasurementSource,
        postDisconnectWarmup: {
          sourceChanged: warmupSourceChanged,
          sourceBeforeSha256: tmuxSourceBeforeFirst,
          sourceAfterSha256: tmuxSourceAfterFirst,
          difference: warmupSourceDifference,
        },
        utf8: {
          first: firstUtf8Evidence,
          second: secondUtf8Evidence,
        },
      },
      terminalQueries: {
        ...queryEvidence,
        observedQueryCount,
        dsrWasObserved: queryEvidence.dsrQueries > 0,
        secondViewerResponsesForwarded: viewerTwoEvidence.responsesForwarded,
      },
      opaqueInputOracle,
      playwright,
      ...(ownerTransportDropEvidence
        ? { ownerTransportDrop: ownerTransportDropEvidence }
        : {}),
      ...(capGatewayBrowser ? { capGatewayBrowser } : {}),
      cleanup: cleanupEvidence,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupFailures = [];
    const captureClosures = await Promise.allSettled([
      viewerTwoCapture?.close(),
      viewerOneCapture?.close(),
      ownerCapture?.close(),
    ]);
    for (const outcome of captureClosures) {
      if (outcome.status === 'rejected') cleanupFailures.push(outcome.reason);
    }
    for (const terminal of [viewerTwo, viewerOne, owner]) {
      if (!terminal) continue;
      try {
        await closeTrackedOuterTerminal(terminal);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (aioFaultRelay) {
      try {
        await aioFaultRelay.close();
        activeAioFaultRelays.delete(aioFaultRelay);
        aioFaultRelay = null;
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (exactCleanup) {
      try {
        await exactCleanup.run();
        exactCleanup = null;
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (runtimeSecurityAdapter) {
      try {
        await runtimeSecurityAdapter.settleCredentialSafety();
        runtimeSecurityAdapter = null;
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (sandboxId && options.provider === 'boxlite') {
      try {
        await deleteBoxLiteSandboxAndConfirm({
          client,
          sandboxId,
          waitForRetry: async () => delay(50),
        });
        activeSandboxes.delete(sandboxId);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryError ? [primaryError, ...cleanupFailures] : cleanupFailures,
        `${runtimeId} cleanup could not be confirmed`,
      );
    }
  }
}

async function runProductViewerByteOracle({
  commandExecutor,
  connection,
  selectedRun,
  nonce,
  provider,
}) {
  const providerLabel = provider === 'aio' ? 'AIO' : 'BoxLite';
  const oracleTaskId = `byteoracle-${nonce}`;
  const oracleSessionName = detachedSessionName(oracleTaskId);
  const handshakeMarker = `CAP_BYTE_ORACLE_HANDSHAKE_${nonce}`;
  const readyMarker = `CAP_BYTE_ORACLE_READY_${nonce}`;
  const legacyReadyMarker = `CAP_BYTE_ORACLE_LEGACY_READY_${nonce}`;
  const resultMarker = `CAP_BYTE_ORACLE_RESULT_${nonce}`;
  const segments = [
    {
      name: 'focus-onData',
      // One real state transition. Sending focus-in and focus-out in the same
      // burst asks tmux to discard/reorder the redundant client-state event.
      bytes: Buffer.from('\x1b[O', 'binary'),
    },
    {
      name: 'keyboard-onData',
      bytes: Buffer.from('cap-keyboard-input\r', 'utf8'),
    },
    {
      name: 'bracketed-paste-onData',
      bytes: Buffer.from('\x1b[200~CAP-PASTE-中文🙂\x1b[201~', 'utf8'),
    },
    {
      name: 'sgr-mouse-onData',
      bytes: Buffer.from('\x1b[<0;5;7M\x1b[<0;5;7m', 'binary'),
    },
    {
      name: 'legacy-mouse-onBinary',
      // Classic X10: button 0, x=100, y=30. x+32=0x84 deliberately
      // exercises xterm's binary-string path while remaining in-pane.
      bytes: Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x84, 0x3e]),
    },
  ];
  const primarySegments = segments.filter(
    (segment) => segment.name !== 'legacy-mouse-onBinary',
  );
  const legacySegment = segments.find(
    (segment) => segment.name === 'legacy-mouse-onBinary',
  );
  assert(legacySegment, 'legacy mouse byte-oracle segment is missing');
  const primaryPayload = Buffer.concat(
    primarySegments.map((segment) => segment.bytes),
  );
  const payload = Buffer.concat([primaryPayload, legacySegment.bytes]);
  const expectedSha256 = sha256(payload);
  const oracleProgram = `
const { createHash } = require('node:crypto');
const expectedBytes = ${payload.byteLength};
const primaryExpectedBytes = ${primaryPayload.byteLength};
const chunks = [];
let bytes = 0;
let surplusBytes = 0;
let phase = 'drain';
let finished = false;
let deadline = null;
let surplusTimer = null;

function accept(data, limit) {
  const remaining = Math.max(0, limit - bytes);
  if (remaining > 0) {
    const accepted = data.subarray(0, remaining);
    chunks.push(Buffer.from(accepted));
    bytes += accepted.byteLength;
  }
  if (data.byteLength > remaining) {
    surplusBytes += data.byteLength - remaining;
  }
}

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearTimeout(surplusTimer);
  const data = Buffer.concat(chunks, bytes);
  const digest = createHash('sha256').update(data).digest('hex');
  process.stdout.write('\\r\\n${resultMarker} size=' + bytes + ' surplus=' + surplusBytes + ' sha256=' + digest + ' hex=' + data.toString('hex') + '\\r\\n');
  setTimeout(() => process.exit(0), 500);
}

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
process.stdin.on('data', (chunk) => {
  const data = Buffer.from(chunk);
  if (phase === 'drain' || finished) return;
  if (phase === 'primary') {
    accept(data, primaryExpectedBytes);
    if (bytes === primaryExpectedBytes) {
      phase = 'legacy';
      clearTimeout(deadline);
      process.stdout.write('\\x1b[?1006l\\x1b[?1005l\\x1b[?1015l\\r\\n${legacyReadyMarker}\\r\\n');
      deadline = setTimeout(finish, 5000);
    }
    return;
  }
  accept(data, expectedBytes);
  if (bytes === expectedBytes && surplusTimer === null) {
    surplusTimer = setTimeout(finish, 1000);
  }
});
process.stdin.resume();
process.stdout.write('\\x1b[?2004h\\x1b[?1004h\\x1b[?1000h\\x1b[?1006h\\r\\n${handshakeMarker}\\r\\n');
setTimeout(() => {
  phase = 'primary';
  process.stdout.write('\\r\\n${readyMarker}\\r\\n');
  deadline = setTimeout(finish, 5000);
}, 2500);
`.trim();
  const oracleCommand = `exec /usr/local/bin/node -e ${shellQuote(oracleProgram)}`;
  let attachment = null;
  let outputSubscription = null;
  let responseSubscription = null;
  let handshakeTerminal = null;
  let pendingTerminalWrite = Promise.resolve();
  let handshakeResponseBytes = 0;
  let handshakeResponses = 0;
  const chunks = [];
  assertCanaryRunning(`${providerLabel} product byte-oracle setup`);
  const exactCleanup = registerExactCleanup(
    `${provider}:byte-oracle:${oracleTaskId}`,
    async () => {
      const cleanup = await (
        commandExecutor.cleanupExec ?? commandExecutor.exec
      )({
        command:
          `tmux kill-session -t ${shellQuote(`=${oracleSessionName}`)} 2>/dev/null || true; ` +
          `if tmux -u has-session -t ${shellQuote(`=${oracleSessionName}`)} 2>/dev/null; then exit 71; fi`,
        timeoutMs: 10_000,
      });
      assert(
        cleanup.exitCode === 0 && !cleanup.timedOut,
        `${providerLabel} product byte-oracle cleanup could not be confirmed`,
      );
      return { exactTmuxSessionAbsent: true };
    },
  );

  try {
    const setup = await commandExecutor.exec({
      command:
        `tmux -u new-session -d -s ${shellQuote(oracleSessionName)} ` +
        `-x ${COLS} -y ${ROWS} ${shellQuote('sleep 30')} && ` +
        `tmux set-option -t ${shellQuote(`=${oracleSessionName}:`)} prefix None && ` +
        `tmux set-option -t ${shellQuote(`=${oracleSessionName}:`)} prefix2 None && ` +
        `tmux set-option -t ${shellQuote(`=${oracleSessionName}:`)} assume-paste-time 1000 && ` +
        `tmux set-option -t ${shellQuote(`=${oracleSessionName}:`)} focus-events on && ` +
        `tmux set-window-option -t ${shellQuote(`=${oracleSessionName}:`)} remain-on-exit on && ` +
        `tmux respawn-pane -k -t ${shellQuote(`=${oracleSessionName}:`)} ${shellQuote(oracleCommand)}`,
      timeoutMs: 10_000,
    });
    assert(
      setup.exitCode === 0 && !setup.timedOut,
      `${providerLabel} product byte-oracle setup failed: ${JSON.stringify(
        String(setup.output ?? '').slice(-2_000),
      )}`,
    );

    const oracleViewerFactory = buildSandboxTerminalViewerAttachmentFactory({
      taskId: oracleTaskId,
      connection,
      selectedRun,
      policy: {
        firstOutputTimeoutMs: 10_000,
        quietMs: REAL_CLI_PRESSURE_QUIET_MS,
        maxSettleMs: REAL_CLI_PRESSURE_MAX_SETTLE_MS,
        probeTimeoutMs: 10_000,
      },
    });
    attachment = trackOuterTerminal(
      oracleViewerFactory.open({ cols: COLS, rows: ROWS }),
      `${provider}:byte-oracle:${oracleTaskId}`,
    );
    handshakeTerminal = new Terminal({
      cols: COLS,
      rows: ROWS,
      allowProposedApi: true,
      scrollback: 0,
    });
    responseSubscription = handshakeTerminal.onData((data) => {
      const bytes = Buffer.from(data, 'utf8');
      if (bytes.byteLength === 0) return;
      const outcome = attachment.writeTerminalResponse(bytes);
      assert(
        outcome === 'written',
        `${providerLabel} byte-oracle xterm handshake response failed: ${outcome}`,
      );
      handshakeResponseBytes += bytes.byteLength;
      handshakeResponses += 1;
    });
    outputSubscription = attachment.onData((chunk) => {
      const bytes =
        chunk instanceof Uint8Array
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.from(chunk, 'utf8');
      if (bytes.byteLength === 0) return;
      chunks.push(Buffer.from(bytes));
      pendingTerminalWrite = pendingTerminalWrite.then(
        () => new Promise((resolve) => handshakeTerminal.write(bytes, resolve)),
      );
    });
    const decision = await withTimeout(
      attachment.attachmentDecision,
      VIEWER_TIMEOUT_MS,
      `${providerLabel} product byte-oracle attachment timed out`,
    );
    assert(
      decision.kind === 'ready',
      `${providerLabel} product byte-oracle attachment failed: ${JSON.stringify(decision)}`,
    );
    assert(
      attachment.opaqueInputCapability === 'byte-preserving',
      `${providerLabel} product viewer did not advertise byte-preserving opaque input`,
    );
    await waitForRawMarker(chunks, handshakeMarker, VIEWER_TIMEOUT_MS);
    await waitForRawMarker(chunks, readyMarker, VIEWER_TIMEOUT_MS);
    await pendingTerminalWrite;
    assert(
      handshakeResponses > 0 && handshakeResponseBytes > 0,
      `${providerLabel} product byte-oracle observed no xterm/tmux handshake response`,
    );
    const writeOutcome = attachment.write(primaryPayload);
    assert(
      writeOutcome === 'written',
      `${providerLabel} product byte-oracle write failed: ${writeOutcome}`,
    );
    await waitForRawMarker(
      chunks,
      legacyReadyMarker,
      VIEWER_TIMEOUT_MS,
      resultMarker,
    );
    await pendingTerminalWrite;
    const legacyWriteOutcome = attachment.write(legacySegment.bytes);
    assert(
      legacyWriteOutcome === 'written',
      `${providerLabel} product legacy byte-oracle write failed: ${legacyWriteOutcome}`,
    );
    await waitForRawMarker(chunks, resultMarker, VIEWER_TIMEOUT_MS);
    const result = parseByteOracleResult(Buffer.concat(chunks), resultMarker);
    assert(
      result.actualSize === payload.byteLength,
      `${providerLabel} product byte-oracle size mismatch: ${result.actualSize}/${payload.byteLength}`,
    );
    assert(
      result.actualSha256 === expectedSha256,
      `${providerLabel} product byte-oracle hash mismatch: ${result.actualSha256}/${expectedSha256}`,
    );
    assert(
      result.surplusBytes === 0,
      `${providerLabel} product byte-oracle observed ${result.surplusBytes} surplus byte(s)`,
    );

    return {
      result: 'PASS',
      provider,
      scope: `production ${providerLabel} viewer attachment semantic browser input through the exact task tmux pane`,
      bytes: payload.byteLength,
      expectedSha256,
      actualSha256: result.actualSha256,
      surplusBytes: result.surplusBytes,
      surplusWindowMs: 1_000,
      xtermHandshake: {
        responses: handshakeResponses,
        bytes: handshakeResponseBytes,
      },
      segments: Object.fromEntries(
        segments.map((segment) => [
          segment.name,
          {
            bytes: segment.bytes.byteLength,
            sha256: sha256(segment.bytes),
          },
        ]),
      ),
    };
  } finally {
    outputSubscription?.dispose();
    responseSubscription?.dispose();
    if (attachment) await closeTrackedOuterTerminal(attachment);
    await pendingTerminalWrite.catch(() => {});
    handshakeTerminal?.dispose();
    await exactCleanup.run();
  }
}

async function waitForRawMarker(chunks, marker, timeoutMs, failureMarker = null) {
  const markerBytes = Buffer.from(marker, 'utf8');
  const failureMarkerBytes = failureMarker
    ? Buffer.from(failureMarker, 'utf8')
    : null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = Buffer.concat(chunks);
    if (raw.includes(markerBytes)) return;
    if (failureMarkerBytes && raw.includes(failureMarkerBytes)) {
      const result = parseByteOracleResult(raw, failureMarker);
      throw new Error(
        `terminal emitted ${failureMarker} before ${marker}: ${JSON.stringify(result)}`,
      );
    }
    await delay(25);
  }
  throw new Error(
    `terminal output did not contain ${marker}: ${Buffer.concat(chunks)
      .subarray(-2_048)
      .toString('utf8')}`,
  );
}

function parseByteOracleResult(raw, resultMarker) {
  const text = raw.toString('utf8');
  const markerOffset = text.lastIndexOf(`${resultMarker} `);
  const line =
    markerOffset === -1
      ? null
      : text.slice(markerOffset).split(/\r?\n/u, 1)[0].replace(/\r$/u, '');
  if (!line) {
    throw new Error(`product byte-oracle result is missing`);
  }
  const match = /^\S+ size=(\d+) surplus=(\d+) sha256=([0-9a-f]{64}) hex=([0-9a-f]*)$/u.exec(
    line,
  );
  if (!match) {
    throw new Error(`malformed product byte-oracle result: ${line}`);
  }
  return {
    actualSize: Number(match[1]),
    surplusBytes: Number(match[2]),
    actualSha256: match[3],
    actualHex: match[4],
  };
}

async function prepareAuthenticatedRuntime({
  client,
  sandboxId,
  commandExecutor,
  runtimeId,
  runtime,
  taskId,
}) {
  const material = loadLocalAuthMaterial(runtimeId);
  registerSecrets(material);
  await execStrict(
    commandExecutor,
    `rm -rf -- ${WORKSPACE} && ` +
      `GEM_GROUP=$(id -gn gem) && ` +
      `install -d -m 700 -o gem -g "$GEM_GROUP" ${WORKSPACE}`,
    'authenticated workspace setup',
  );
  const adapter = createBoxLiteWorkspaceSecurityAdapter({
    client,
    sandboxId,
    taskId,
    deletionConfirmation: { waitForRetry: async () => delay(50) },
  });
  const plan = runtime.sandboxSetupCommands(
    { taskId, workspaceDir: WORKSPACE, prompt: '' },
    material,
  );
  assert(plan.ok === true, `${runtimeId} rejected the local canary credential`);
  try {
    for (const entry of plan.commands) {
      for (const file of entry.privateFiles ?? []) {
        await adapter.runtimePrivateFiles.writeFile(file);
      }
      await execStrict(
        commandExecutor,
        entry.command,
        `${runtimeId} private runtime setup`,
      );
    }
    return adapter;
  } catch (error) {
    await adapter.settleCredentialSafety();
    throw error;
  }
}

function loadLocalAuthMaterial(runtimeId) {
  if (runtimeId === 'codex') {
    const candidates = [
      process.env.CODEX_HOME
        ? join(process.env.CODEX_HOME, 'auth.json')
        : null,
      join(homedir(), '.codex', 'auth.json'),
    ].filter(Boolean);
    const path = candidates.find((candidate) => existsSync(candidate));
    assert(path, 'local Codex auth.json is unavailable');
    const authJson = readFileSync(path, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(authJson);
    } catch {
      throw new Error('local Codex auth.json is invalid');
    }
    assert(parsed && typeof parsed === 'object', 'local Codex auth is invalid');
    registerSecrets(parsed);
    return { authJson };
  }

  let raw;
  try {
    raw = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
      },
    ).trim();
  } catch {
    throw new Error('Claude Code credential is unavailable from Keychain');
  }
  let oauthToken = raw;
  if (raw.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Claude Code Keychain credential is invalid JSON');
    }
    oauthToken =
      parsed?.claudeAiOauth?.accessToken ??
      parsed?.oauthToken ??
      parsed?.accessToken;
  }
  assert(
    typeof oauthToken === 'string' && oauthToken.trim().length >= 8,
    'Claude Code Keychain credential has no OAuth token',
  );
  return { oauthToken: oauthToken.trim() };
}

function registerSecrets(value) {
  if (typeof value === 'string') {
    if (value.length < 8) return;
    const bytes = Buffer.from(value, 'utf8');
    for (const variant of [
      value,
      bytes.toString('base64'),
      bytes.toString('base64url'),
      bytes.toString('hex'),
    ]) {
      activeSecretVariants.add(variant);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) registerSecrets(child);
}

function registerAioCredentialSecrets(envelope, runtimeId) {
  if (runtimeId === 'codex') {
    let parsed;
    try {
      parsed = JSON.parse(envelope.codexAuthJson);
    } catch {
      throw new Error('Codex credential envelope was not valid JSON');
    }
    registerSecrets(parsed);
    return;
  }
  registerSecrets(envelope.claudeOauthToken);
}

function assertNoSecrets(value, label) {
  const text = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : String(value);
  for (const secret of activeSecretVariants) {
    if (text.includes(secret)) {
      throw new Error(`${label} exposed runtime credential material`);
    }
  }
}

export function formatCanaryErrorTree(error, seen = new Set()) {
  if (error && typeof error === 'object') {
    if (seen.has(error)) {
      return { name: 'CircularError', message: '[circular]' };
    }
    seen.add(error);
  }
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: redactCanaryErrorText(error.message),
      errors: [...error.errors].map((child) =>
        formatCanaryErrorTree(child, seen),
      ),
      ...(error.cause
        ? { cause: formatCanaryErrorTree(error.cause, seen) }
        : {}),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactCanaryErrorText(error.message),
      stack: redactCanaryErrorText(error.stack ?? '')
        .split('\n')
        .slice(0, 8)
        .join('\n'),
      ...(error.cause
        ? { cause: formatCanaryErrorTree(error.cause, seen) }
        : {}),
    };
  }
  return {
    name: typeof error,
    message: redactCanaryErrorText(String(error)),
  };
}

function redactCanaryErrorText(value) {
  let text = String(value).slice(0, 8_000);
  for (const secret of [...activeSecretVariants].sort(
    (left, right) => right.length - left.length,
  )) {
    text = text.replaceAll(secret, '[REDACTED]');
  }
  return text;
}

function assertGatewayCleanupEvidence(summary, token, providerEndpoint, label) {
  assert(
    summary?.kind === 'confirmed' &&
      summary.closedClientCount === 0 &&
      summary.closedSessionCount === 1 &&
      summary.sourceCount >= 1 &&
      summary.confirmedSourceCount === summary.sourceCount &&
      summary.indeterminateSourceCount === 0 &&
      summary.timedOutSourceCount === 0,
    `${label} cleanup was not fully confirmed: ${JSON.stringify(summary)}`,
  );
  assert(
    Number.isFinite(summary.elapsedMs) &&
      summary.elapsedMs >= 0 &&
      summary.elapsedMs <= summary.timeoutMs + 1_000,
    `${label} cleanup exceeded its hard bound`,
  );
  const serialized = JSON.stringify(summary);
  assertNoSecrets(serialized, `${label} cleanup evidence`);
  assert(
    !serialized.includes(token) &&
      !serialized.includes(providerEndpoint) &&
      !/"(?:executionId|sessionId|sandboxId|providerId|endpoint|url|token|authorization)"\s*:/iu.test(
        serialized,
      ) &&
      !/(?:https?|wss?):\/\//iu.test(serialized),
    `${label} cleanup evidence exposed provider identity or credentials`,
  );
}

function buildBoxLiteSelectedRun({
  client,
  taskId,
  sandboxId,
  endpoint,
  pathPrefix,
  connection,
}) {
  const provider = {
    createCommandExecutor: (providerSandboxId) =>
      createCommandExecutor(client, providerSandboxId),
  };
  return {
    taskId,
    providerId: 'boxlite-real-cli-canary',
    providerSandboxId: sandboxId,
    provider,
    capabilities: [
      'terminal.websocket',
      'terminal.interactive',
      'command.exec',
    ],
    connection,
    terminal: {
      protocol: 'boxlite-v1',
      wsUrl: httpToWs(endpoint),
      metadata: {
        endpoint,
        sandboxId,
        pathPrefix,
        workspacePath: WORKSPACE,
        protocolMode: 'native',
      },
    },
    command: {
      protocol: 'boxlite-exec-v1',
      baseUrl: endpoint,
      workingDirectory: WORKSPACE,
      metadata: { sandboxId },
    },
  };
}

function buildAioSelectedRun({ taskId, connection }) {
  const capabilities = [
    'terminal.websocket',
    'terminal.interactive',
    'command.exec',
  ];
  const providerId = 'aio-real-cli-canary';
  const provider = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => capabilities,
  };
  return {
    taskId,
    providerId,
    // This canary connects to an already isolated container through a tunnel;
    // its provider sandbox id is intentionally unknown and never fabricated.
    provider,
    capabilities,
    connection,
    terminal: {
      protocol: 'aio-json-v1',
      wsUrl: connection.wsUrl,
      metadata: { provider: providerId },
    },
    command: {
      protocol: 'aio-http-exec-v1',
      baseUrl: connection.baseUrl,
      workingDirectory: WORKSPACE,
      metadata: { provider: providerId },
    },
    workspace: {
      mode: 'git',
      path: WORKSPACE,
      git: { materialized: false, deliverable: false },
      metadata: { provider: providerId },
    },
    retention: {
      mode: 'stop-retain',
      retainTranscript: false,
      cleanupEligible: true,
      metadata: { provider: providerId },
    },
  };
}

function createCommandExecutor(client, sandboxId) {
  return {
    exec: (request) =>
      client.exec({
        sandboxId,
        command: request.command,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        cancellationSignal: request.signal,
      }),
  };
}

async function prepareUnauthenticatedRuntime({ commandExecutor, runtimeId }) {
  const claudePreseed = JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    numStartups: 5,
    hasAcknowledgedCostThreshold: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      [WORKSPACE]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  });
  const claudeSettings = JSON.stringify({
    permissions: { skipDangerousModePermissionPrompt: true },
  });
  const common = [
    `printf %s ${shellQuote(
      'unset OPENAI_API_KEY\n' +
        'unset CODEX_API_KEY\n' +
        'unset ANTHROPIC_API_KEY\n' +
        'unset ANTHROPIC_AUTH_TOKEN\n' +
        'unset CLAUDE_CODE_OAUTH_TOKEN\n',
    )} > /etc/profile.d/cap-real-cli-unauth.sh`,
    'chmod 644 /etc/profile.d/cap-real-cli-unauth.sh',
  ];
  const commands =
    runtimeId === 'codex'
      ? [
          ...common,
          `rm -rf -- ${WORKSPACE}`,
          `GEM_GROUP=$(id -gn gem) && install -d -m 700 -o gem -g "$GEM_GROUP" ${WORKSPACE} /home/gem/.codex`,
          'rm -f /home/gem/.codex/auth.json /home/gem/.codex/task-prompt.txt',
          `printf %s ${shellQuote(
            'cli_auth_credentials_store = "file"\n' +
              `[projects."${WORKSPACE}"]\ntrust_level = "trusted"\n`,
          )} > /home/gem/.codex/config.toml`,
          'chown gem:"$(id -gn gem)" /home/gem/.codex/config.toml',
          'chmod 600 /home/gem/.codex/config.toml',
        ]
      : [
          ...common,
          `rm -rf -- ${WORKSPACE}`,
          `GEM_GROUP=$(id -gn gem) && install -d -m 700 -o gem -g "$GEM_GROUP" ${WORKSPACE} /home/gem/.claude`,
          'rm -rf /home/gem/.claude/projects',
          'rm -f /home/gem/.claude/task-prompt.txt',
          `printf %s ${shellQuote(
            'unset CLAUDE_CODE_OAUTH_TOKEN\n' +
              'unset ANTHROPIC_API_KEY\n' +
              'unset ANTHROPIC_AUTH_TOKEN\n' +
              'unset apiKeyHelper\n',
          )} > /home/gem/.claude/launch-env.sh`,
          `printf %s ${shellQuote(claudePreseed)} > /home/gem/.claude.json`,
          `printf %s ${shellQuote(claudePreseed)} > /home/gem/.claude/.claude.json`,
          `printf %s ${shellQuote(claudeSettings)} > /home/gem/.claude/settings.json`,
          'chown -R gem:"$(id -gn gem)" /home/gem/.claude /home/gem/.claude.json',
          'chmod 600 /home/gem/.claude/launch-env.sh /home/gem/.claude/.claude.json /home/gem/.claude/settings.json /home/gem/.claude.json',
        ];
  for (let index = 0; index < commands.length; index += 1) {
    await execStrict(
      commandExecutor,
      commands[index],
      `unauthenticated runtime setup step ${index + 1}`,
    );
  }
}

async function preparePreloadedRuntime({ commandExecutor, runtimeId }) {
  const claudePreseed = JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    numStartups: 5,
    hasAcknowledgedCostThreshold: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      [WORKSPACE]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  });
  const claudeSettings = JSON.stringify({
    permissions: { skipDangerousModePermissionPrompt: true },
  });
  const commands =
    runtimeId === 'codex'
      ? [
          'test -s /home/gem/.codex/auth.json',
          'test "$(stat -c %a /home/gem/.codex/auth.json)" = 600',
          `rm -rf -- ${WORKSPACE}`,
          `GEM_GROUP=$(id -gn gem) && install -d -m 700 -o gem -g "$GEM_GROUP" ${WORKSPACE} /home/gem/.codex`,
          `printf %s ${shellQuote(
            'cli_auth_credentials_store = "file"\n' +
              `[projects."${WORKSPACE}"]\ntrust_level = "trusted"\n`,
          )} > /home/gem/.codex/config.toml`,
          'chown gem:"$(id -gn gem)" /home/gem/.codex/config.toml',
          'chmod 600 /home/gem/.codex/config.toml',
        ]
      : [
          'test -s /home/gem/.claude/launch-env.sh',
          'test "$(stat -c %a /home/gem/.claude/launch-env.sh)" = 600',
          'unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN && . /home/gem/.claude/launch-env.sh >/dev/null 2>&1 && test -n "${CLAUDE_CODE_OAUTH_TOKEN:-}"',
          `rm -rf -- ${WORKSPACE}`,
          `GEM_GROUP=$(id -gn gem) && install -d -m 700 -o gem -g "$GEM_GROUP" ${WORKSPACE} /home/gem/.claude`,
          `printf %s ${shellQuote(claudePreseed)} > /home/gem/.claude.json`,
          `printf %s ${shellQuote(claudePreseed)} > /home/gem/.claude/.claude.json`,
          `printf %s ${shellQuote(claudeSettings)} > /home/gem/.claude/settings.json`,
          'chown -R gem:"$(id -gn gem)" /home/gem/.claude /home/gem/.claude.json',
          'chmod 600 /home/gem/.claude/.claude.json /home/gem/.claude/settings.json /home/gem/.claude.json',
        ];
  for (let index = 0; index < commands.length; index += 1) {
    await execStrict(
      commandExecutor,
      commands[index],
      `preloaded runtime setup step ${index + 1}`,
    );
  }
}

async function readVersionsWithoutCredentials(commandExecutor) {
  const result = await execStrict(
    commandExecutor,
    "printf 'codex='; codex --version; printf 'claude='; claude --version",
    'runtime version probe',
  );
  const values = Object.fromEntries(
    result.output
      .split(/\r?\n/u)
      .filter((line) => line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      }),
  );
  return { codex: values.codex, claude: values.claude };
}

async function verifyRealCliProcess({
  commandExecutor,
  runtimeId,
  taskId,
}) {
  await readExactRuntimeProcessIdentity({
    commandExecutor,
    runtimeId,
    taskId,
  });
  return {
    binaryObserved: true,
    nativeInteractiveFlagsObserved: true,
    credentialContentRead: false,
    processArgvReturnedToHost: false,
  };
}

const EXACT_RUNTIME_PROCESS_IDENTITY_MARKER_PREFIX =
  'CAP_REAL_CLI_PROCESS_ID_';
const EXACT_RUNTIME_PROCESS_IDENTITY_NONCE_PATTERN = /^[0-9a-f]{32}$/u;

export function buildExactRuntimeProcessIdentityProbeCommand({
  runtimeId,
  taskId,
  nonce,
}) {
  if (!EXACT_RUNTIME_PROCESS_IDENTITY_NONCE_PATTERN.test(nonce)) {
    throw new Error('exact runtime process identity nonce must be 32 hex characters');
  }

  const target = shellQuote(`=${detachedSessionName(taskId)}:`);
  const expectedCasePattern = runtimeProcessCasePattern(runtimeId, taskId);
  const command =
    `IDENTITY_PREFIX=${shellQuote(EXACT_RUNTIME_PROCESS_IDENTITY_MARKER_PREFIX)} && ` +
      `IDENTITY_NONCE=${shellQuote(nonce)} && ` +
      `PANE_TTY=$(tmux display-message -p -t ${target} '#{pane_tty}') && ` +
      `PANE_TTY=\${PANE_TTY#/dev/} && BEST='' && BEST_DEPTH=-1 && TIED=0 && ` +
      `for PID in $(ps -t "$PANE_TTY" -o pid= 2>/dev/null); do ` +
      `f="/proc/$PID/cmdline"; [ -r "$f" ] || continue; ` +
      `EXE=$(basename "$(readlink "/proc/$PID/exe" 2>/dev/null)") || continue; ` +
      `case "$EXE" in sh|bash|dash|ash|zsh|busybox) continue;; esac; ` +
      `CMD=$(tr '\\000' ' ' < "$f" 2>/dev/null) || continue; ` +
      `case "$CMD" in ${expectedCasePattern}) ` +
      `STAT=$(cat "/proc/$PID/stat" 2>/dev/null) || exit 1; ` +
      `STAT_FIELDS=\${STAT##*) } && set -- $STAT_FIELDS && START=\${20}; ` +
      `DEPTH=0; CUR=$PID; ` +
      `while [ "$CUR" -gt 1 ] && [ "$DEPTH" -lt 128 ]; do ` +
      `CUR=$(awk '/^PPid:/ { print $2 }' "/proc/$CUR/status" 2>/dev/null) || break; ` +
      `[ -n "$CUR" ] || break; DEPTH=$((DEPTH + 1)); done; ` +
      `if [ "$DEPTH" -gt "$BEST_DEPTH" ]; then ` +
      `BEST="$PID $START"; BEST_DEPTH=$DEPTH; TIED=0; ` +
      `elif [ "$DEPTH" -eq "$BEST_DEPTH" ]; then TIED=1; fi;; esac; ` +
      `done; [ -n "$BEST" ] && [ "$TIED" -eq 0 ] || exit 1; ` +
      `printf '%s%s %s\n' "$IDENTITY_PREFIX" "$IDENTITY_NONCE" "$BEST"`;
  if (
    command.includes(
      `${EXACT_RUNTIME_PROCESS_IDENTITY_MARKER_PREFIX}${nonce}`,
    )
  ) {
    throw new Error(
      'exact runtime process identity marker must not appear in the echoed probe command',
    );
  }
  return command;
}

async function readExactRuntimeProcessIdentity({
  commandExecutor,
  runtimeId,
  taskId,
}) {
  const deadline = Date.now() + 20_000;
  let attempts = 0;
  let lastDiagnostic = null;
  while (Date.now() < deadline) {
    attempts += 1;
    const nonce = randomUUID().replaceAll('-', '');
    const command = buildExactRuntimeProcessIdentityProbeCommand({
      runtimeId,
      taskId,
      nonce,
    });
    try {
      const result = await commandExecutor.exec({
        command,
        cwd: '/home/gem',
        timeoutMs: 10_000,
      });
      const identity = parseExactRuntimeProcessIdentityOutput(
        result.output,
        nonce,
      );
      if (result.exitCode === 0 && !result.timedOut && identity) {
        return identity;
      }
      const output = Buffer.from(String(result.output ?? ''), 'utf8');
      lastDiagnostic = {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputBytes: output.byteLength,
        outputSha256: sha256(output),
        outputUtf8Hex: output.subarray(0, 128).toString('hex'),
      };
    } catch (error) {
      lastDiagnostic = {
        thrown: error instanceof Error ? error.name : typeof error,
      };
    }
    await delay(100);
  }
  throw new Error(
    `${runtimeId} exact pane process identity remained invalid: ${JSON.stringify({ attempts, lastDiagnostic })}`,
  );
}

export function parseExactRuntimeProcessIdentityOutput(output, nonce) {
  if (!EXACT_RUNTIME_PROCESS_IDENTITY_NONCE_PATTERN.test(nonce)) {
    return null;
  }
  let identity = null;
  const markerPattern =
    /^CAP_REAL_CLI_PROCESS_ID_([0-9a-f]{32}) ([1-9]\d*) ([1-9]\d*)$/u;
  for (const line of String(output ?? '').replace(/\r\n?/gu, '\n').split('\n')) {
    if (!line.startsWith(EXACT_RUNTIME_PROCESS_IDENTITY_MARKER_PREFIX)) {
      continue;
    }
    const match = markerPattern.exec(line);
    if (!match || match[1] !== nonce || identity) {
      return null;
    }
    const pid = Number(match[2]);
    const startTimeTicks = Number(match[3]);
    if (
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(startTimeTicks)
    ) {
      return null;
    }
    identity = { pid, startTimeTicks };
  }
  return identity;
}

function runtimeProcessCasePattern(runtimeId, taskId) {
  return runtimeId === 'codex'
    ? '*codex*--dangerously-bypass-approvals-and-sandbox*'
    : `*claude*--session-id*${terminalSessionIdForTask(taskId)}*--dangerously-skip-permissions*`;
}

async function openViewerCapture(viewerFactory, runtimeId, requireQuiet) {
  assertCanaryRunning(`${runtimeId} viewer attachment`);
  const attachment = trackOuterTerminal(
    viewerFactory.open({ cols: COLS, rows: ROWS }),
    `${runtimeId}:viewer`,
  );
  const capture = new TerminalCapture({
    endpoint: attachment,
    cols: COLS,
    rows: ROWS,
    inputKind: 'bytes',
    suppressCpr: false,
  });
  try {
    const startedAt = Date.now();
    const decision = await withTimeout(
      attachment.attachmentDecision,
      VIEWER_TIMEOUT_MS,
      `${runtimeId} viewer decision timed out`,
    );
    assert(
      decision.kind === 'ready',
      `${runtimeId} viewer did not become ready: ${JSON.stringify(decision)}`,
    );
    const readyAt = Date.now();
    const attachmentReadyMs = readyAt - startedAt;
    const revealSettleMs = readyAt - capture.firstOutputAt;
    const bytesAtReady = capture.byteLength;
    const chunksAtReady = capture.chunkCount();
    assert(
      capture.firstOutputAt > 0 && revealSettleMs >= 0,
      `${runtimeId} viewer became ready without a first redraw byte`,
    );
    const preReadyOutput = capture.outputGapEvidence(
      capture.firstOutputAt,
      readyAt,
    );
    await capture.waitForNativeTui(runtimeId, VIEWER_TIMEOUT_MS);
    const quiet = await capture.waitForQuiet(
      1_000,
      requireQuiet ? 2_000 : 1_000,
    );
    const visualStable = quiet
      ? true
      : await capture.waitForStableState(
          1_000,
          requireQuiet ? 5_000 : 1_500,
        );
    assert(
      !requireQuiet || visualStable,
      `${runtimeId} viewer redraw did not reach a stable screen`,
    );
    await capture.drain();
    return {
      attachment,
      capture,
      attachmentReadyMs,
      revealSettleMs,
      readyAt,
      preReadyOutput,
      bytesAtReady,
      chunksAtReady,
      quiet,
      visualStable,
    };
  } catch (error) {
    await capture.close();
    await closeTrackedOuterTerminal(attachment);
    throw error;
  }
}

export async function runRealCliContinuousOutputPressure({
  owner,
  ownerCapture,
  viewerFactory,
  commandExecutor,
  runtimeId,
  taskId,
  nonce,
  quietMs,
  maxSettleMs,
}) {
  const plan = buildRealCliPressurePlan(runtimeId, nonce, taskId);
  let continuous = null;
  let primaryError = null;
  let originalPaneIdentity = null;
  let pressurePaneIdentity = null;
  try {
    originalPaneIdentity = await readExactTmuxPaneIdentity(
      commandExecutor,
      taskId,
    );
    assert(
      originalPaneIdentity.windowActive && !originalPaneIdentity.paneDead,
      `${runtimeId} original CLI pane was not active and live before direct pressure`,
    );
    if (plan.pressureWindowName) {
      await assertPressureWindowAbsent(
        commandExecutor,
        taskId,
        plan.pressureWindowName,
      );
    }
    const markerSearchOffset = ownerCapture.byteLength;
    owner.write(plan.prompt);
    if (plan.submitFlushKey === 'ArrowRight') {
      owner.write('\x1b[C');
      await delay(50);
    } else {
      await delay(200);
    }
    owner.write('\r');
    const begin = await ownerCapture.waitForRawMarker(
      plan.beginMarker,
      markerSearchOffset,
      90_000,
    );
    if (plan.pressureWindowName) {
      pressurePaneIdentity = await readExactPressurePaneIdentity({
        commandExecutor,
        taskId,
        pressureWindowName: plan.pressureWindowName,
        originalPaneIdentity,
      });
    }
    continuous = await openViewerCapture(viewerFactory, runtimeId, false);
    const end = await ownerCapture.waitForRawMarker(
      plan.endMarker,
      begin.offset + plan.beginMarker.length,
      45_000,
    );
    const endOffset = end.offset + Buffer.byteLength(plan.endMarker, 'utf8');
    let pressureWindowLifecycle;
    if (plan.pressureWindowName) {
      await waitForPressureWindowExitAndOriginalRestore({
        commandExecutor,
        taskId,
        pressureWindowName: plan.pressureWindowName,
        originalPaneIdentity,
      });
      pressureWindowLifecycle = {
        kind: 'temporary-window',
        windowName: plan.pressureWindowName,
        originalPaneIdentity,
        pressurePaneIdentity,
        pressureWindowAbsentAfterEnd: true,
        originalPaneRestoredAfterEnd: true,
      };
    } else {
      pressureWindowLifecycle = { kind: 'not-applicable' };
    }
    const quietAfterPressure = await ownerCapture.waitForQuiet(1_000, 30_000);
    const stableAfterPressure = await ownerCapture.waitForStableState(
      1_000,
      15_000,
    );
    assert(
      quietAfterPressure && stableAfterPressure,
      `${runtimeId} did not return to a quiet native frame after real CLI pressure`,
    );
    await ownerCapture.drain();
    await continuous.capture.drain();
    assertNativeTui(
      ownerCapture.state(),
      ownerCapture.raw(),
      runtimeId,
      'owner after continuous pressure',
    );
    assertNativeTui(
      continuous.capture.state(),
      continuous.capture.raw(),
      runtimeId,
      'continuous-deadline viewer',
    );
    await verifyRealCliProcess({ commandExecutor, runtimeId, taskId });

    const evidence = {
      surface: 'direct',
      runtimeId,
      observed: true,
      actualInteractiveCli: true,
      outputSource: 'owner-pty',
      commandExecution: plan.outputMode,
      beginMarkerObserved: true,
      endMarkerObserved: true,
      requestedLineCount: plan.lineCount,
      requestedLineDelayMs: Math.round(plan.lineDelaySeconds * 1_000),
      observedOutputBytes: endOffset - begin.offset,
      observedOutputChunks: ownerCapture.chunkCountInRange(
        begin.offset,
        endOffset,
      ),
      durationMs: end.observedAt - begin.observedAt,
      attachmentReadyMs: continuous.attachmentReadyMs,
      revealSettleMs: continuous.revealSettleMs,
      quietWithinOneSecond: continuous.quiet,
      preReadyTimelineComplete: continuous.preReadyOutput.complete,
      preReadyOutputEvents: continuous.preReadyOutput.eventCount,
      preReadyMaxGapMs: continuous.preReadyOutput.maxGapMs,
      wireContinuousBeforeReady:
        continuous.preReadyOutput.maxGapMs < quietMs,
      hardDeadlineTimingObserved:
        continuous.revealSettleMs >= maxSettleMs - 250,
      quietThresholdMs: quietMs,
      maxSettleMs,
      postReadyBytes:
        continuous.capture.byteLength - continuous.bytesAtReady,
      postReadyChunks:
        continuous.capture.chunkCount() - continuous.chunksAtReady,
      quietCurrentFrameAfterPressure: quietAfterPressure,
      stableCurrentFrameAfterPressure: stableAfterPressure,
      pressureWindowLifecycle,
    };
    assertRealCliContinuousOutputEvidence(evidence);
    return evidence;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupFailures = [];
    if (plan.pressureWindowName) {
      try {
        await cleanupExactPressureWindow({
          commandExecutor,
          taskId,
          pressureWindowName: plan.pressureWindowName,
        });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (continuous) {
      try {
        await continuous.capture.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await closeTrackedOuterTerminal(continuous.attachment);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      const cleanupError = new AggregateError(
        cleanupFailures,
        `${runtimeId} continuous pressure viewer cleanup failed`,
      );
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `${runtimeId} continuous pressure and cleanup failed`,
        );
      }
      throw cleanupError;
    }
  }
}

class TerminalCapture {
  constructor({ endpoint, cols, rows, inputKind, suppressCpr }) {
    this.endpoint = endpoint;
    this.cols = cols;
    this.rows = rows;
    this.inputKind = inputKind;
    this.suppressCpr = suppressCpr;
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 0,
    });
    this.chunks = [];
    this.byteLength = 0;
    this.firstOutputAt = 0;
    this.lastOutputAt = 0;
    this.recentOutputEvents = [];
    this.outputTimeline = [];
    this.outputTimelineOverflow = false;
    this.producerEligibility = {
      eligibleChunks: 0,
      eligibleBytes: 0,
      lastEligibleAt: 0,
      attachBootstrapChunks: 0,
      attachBootstrapBytes: 0,
      firstAttachBootstrapAt: 0,
      lastAttachBootstrapAt: 0,
    };
    this.closed = false;
    this.pendingWrite = Promise.resolve();
    this.queryEvidence = {
      dsrQueries: 0,
      primaryDaQueries: 0,
      secondaryDaQueries: 0,
      colorQueries: 0,
      cprResponsesGenerated: 0,
      responsesForwarded: 0,
      responsesSuppressedByOwnerPolicy: 0,
    };
    this.outputSubscription = endpoint.onData((chunk, meta) => {
      const bytes =
        chunk instanceof Uint8Array
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.from(chunk, 'utf8');
      if (bytes.byteLength === 0) return;
      const observedAt = Date.now();
      if (this.outputTimeline.length < 65_536) {
        this.outputTimeline.push(observedAt);
      } else {
        this.outputTimelineOverflow = true;
      }
      if (meta?.recordable === false && meta.source === 'attach-bootstrap') {
        this.producerEligibility.attachBootstrapChunks += 1;
        this.producerEligibility.attachBootstrapBytes += bytes.byteLength;
        if (this.producerEligibility.firstAttachBootstrapAt === 0) {
          this.producerEligibility.firstAttachBootstrapAt = observedAt;
        }
        this.producerEligibility.lastAttachBootstrapAt = observedAt;
      } else {
        this.producerEligibility.eligibleChunks += 1;
        this.producerEligibility.eligibleBytes += bytes.byteLength;
        this.producerEligibility.lastEligibleAt = observedAt;
      }
      this.observeQueries(bytes);
      this.byteLength += bytes.byteLength;
      assert(
        this.byteLength <= MAX_CAPTURE_BYTES,
        'terminal capture exceeded 32 MiB',
      );
      this.chunks.push(Buffer.from(bytes));
      this.lastOutputAt = observedAt;
      if (this.firstOutputAt === 0) this.firstOutputAt = this.lastOutputAt;
      this.recentOutputEvents.push({
        at: this.lastOutputAt,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        hex: bytes.subarray(0, 160).toString('hex'),
      });
      if (this.recentOutputEvents.length > 20) {
        this.recentOutputEvents.shift();
      }
      this.pendingWrite = this.pendingWrite.then(
        () => new Promise((resolve) => this.term.write(bytes, resolve)),
      );
    });
    this.responseSubscription = this.term.onData((data) => {
      const cprMatches = data.match(/\u001b\[\??\d+;\d+R/gu) ?? [];
      this.queryEvidence.cprResponsesGenerated += cprMatches.length;
      let forward = data;
      if (this.suppressCpr && cprMatches.length > 0) {
        forward = forward.replace(/\u001b\[\??\d+;\d+R/gu, '');
        this.queryEvidence.responsesSuppressedByOwnerPolicy += cprMatches.length;
      }
      if (!forward) return;
      const outcome =
        this.inputKind === 'bytes'
          ? this.endpoint.writeTerminalResponse(Buffer.from(forward, 'utf8'))
          : (this.endpoint.write(forward), 'written');
      if (outcome === 'written' || outcome === undefined) {
        this.queryEvidence.responsesForwarded += 1;
      }
    });
  }

  observeQueries(bytes) {
    const text = bytes.toString('latin1');
    this.queryEvidence.dsrQueries += count(text, '\x1b[6n');
    this.queryEvidence.primaryDaQueries +=
      count(text, '\x1b[c') + count(text, '\x1b[0c');
    this.queryEvidence.secondaryDaQueries += count(text, '\x1b[>c');
    this.queryEvidence.colorQueries +=
      count(text, '\x1b]10;?') +
      count(text, '\x1b]11;?') +
      count(text, '\x1b]12;?');
  }

  raw() {
    return Buffer.concat(this.chunks);
  }

  chunkCount() {
    return this.chunks.length;
  }

  producerEvidence() {
    return { ...this.producerEligibility };
  }

  writeText(data) {
    assert(this.inputKind === 'text', 'terminal capture is not owner text input');
    this.endpoint.write(data);
  }

  async waitForProducerEligibleChunkAfter(previousChunks, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.producerEligibility.eligibleChunks > previousChunks) {
        return {
          chunks: this.producerEligibility.eligibleChunks - previousChunks,
          at: this.producerEligibility.lastEligibleAt,
        };
      }
      await delay(25);
    }
    throw new Error('owner producer eligibility did not resume after settle');
  }

  async waitForRawMarker(marker, startOffset, timeoutMs) {
    const markerBytes = Buffer.from(marker, 'utf8');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const offset = this.raw().indexOf(markerBytes, startOffset);
      if (offset !== -1) return { offset, observedAt: Date.now() };
      await delay(25);
    }
    throw new Error(`terminal output did not contain real CLI marker ${marker}`);
  }

  chunkCountInRange(startOffset, endOffset) {
    let offset = 0;
    let count = 0;
    for (const chunk of this.chunks) {
      const chunkStart = offset;
      const chunkEnd = offset + chunk.byteLength;
      if (chunkEnd > startOffset && chunkStart < endOffset) count += 1;
      offset = chunkEnd;
    }
    return count;
  }

  outputGapEvidence(startedAt, endedAt) {
    const times = this.outputTimeline.filter(
      (at) => at >= startedAt && at <= endedAt,
    );
    let previousAt = startedAt;
    let maxGapMs = 0;
    for (const at of times) {
      maxGapMs = Math.max(maxGapMs, at - previousAt);
      previousAt = at;
    }
    maxGapMs = Math.max(maxGapMs, endedAt - previousAt);
    return {
      complete: !this.outputTimelineOverflow,
      eventCount: times.length,
      maxGapMs,
    };
  }

  outputDiagnostics() {
    return {
      totalBytes: this.byteLength,
      recent: this.recentOutputEvents.map((event, index, events) => ({
        bytes: event.bytes,
        sha256: event.sha256,
        hex: event.hex,
        deltaMs: index === 0 ? null : event.at - events[index - 1].at,
      })),
      queryEvidence: this.queryEvidence,
    };
  }

  utf8Evidence() {
    const raw = this.raw();
    let fatalDecodeSucceeded = true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      fatalDecodeSucceeded = false;
    }
    const replacement = Buffer.from([0xef, 0xbf, 0xbd]);
    let replacementSequences = 0;
    let offset = 0;
    while (offset <= raw.byteLength - replacement.byteLength) {
      const found = raw.indexOf(replacement, offset);
      if (found === -1) break;
      replacementSequences += 1;
      offset = found + replacement.byteLength;
    }
    let continuationChunkStarts = 0;
    for (const chunk of this.chunks.slice(1)) {
      if (
        chunk.byteLength > 0 &&
        chunk[0] >= 0x80 &&
        chunk[0] <= 0xbf
      ) {
        continuationChunkStarts += 1;
      }
    }
    return {
      bytes: raw.byteLength,
      sha256: sha256(raw),
      fatalDecodeSucceeded,
      replacementSequences,
      chunks: this.chunks.length,
      continuationChunkStarts,
    };
  }

  async waitForNativeTui(runtimeId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.drain();
      const state = this.state();
      if (
        state.bufferType === 'alternate' &&
        state.nonBlankCells > 20 &&
        runtimeVisible(state.visibleText, runtimeId)
      ) {
        return;
      }
      await delay(75);
    }
    throw new Error(`${runtimeId} did not render a native alternate-screen TUI`);
  }

  async waitForAdditionalOutput(previousBytes, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.byteLength > previousBytes) return;
      await delay(50);
    }
    throw new Error('terminal produced no live output after viewer input');
  }

  async waitForQuiet(windowMs, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (
        this.lastOutputAt > 0 &&
        Date.now() - this.lastOutputAt >= windowMs
      ) {
        return true;
      }
      await delay(50);
    }
    return false;
  }

  async waitForStableState(windowMs, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let stableSince = Date.now();
    let priorHash = null;
    while (Date.now() < deadline) {
      await this.drain();
      const hash = this.state().hash;
      if (hash !== priorHash) {
        priorHash = hash;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= windowMs) {
        return true;
      }
      await delay(50);
    }
    return false;
  }

  async drain() {
    await this.pendingWrite;
    await new Promise((resolve) => this.term.write('', resolve));
  }

  state() {
    const buffer = this.term.buffer.active;
    const cells = [];
    const visibleLines = [];
    let nonBlankCells = 0;
    for (let row = 0; row < this.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      const serializedLine = [];
      let visibleLine = '';
      for (let col = 0; col < this.cols; col += 1) {
        const cell = line?.getCell(col);
        const chars = cell?.getChars() ?? '';
        const invisible = cell ? Boolean(callCell(cell, 'isInvisible')) : false;
        const visibleChars = invisible ? '' : chars;
        if (visibleChars && !/^\s+$/u.test(visibleChars)) nonBlankCells += 1;
        visibleLine += visibleChars || (cell?.getWidth() === 0 ? '' : ' ');
        serializedLine.push(
          cell
            ? [
                chars,
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
              ]
            : null,
        );
      }
      cells.push(serializedLine);
      visibleLines.push(visibleLine.replace(/\s+$/u, ''));
    }
    const modes = {};
    for (const key of Object.keys(this.term.modes ?? {}).sort()) {
      modes[key] = this.term.modes[key];
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
      hash: sha256(canonical),
      visibleText: visibleLines.join('\n'),
      nonBlankCells,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.outputSubscription.dispose();
    this.responseSubscription.dispose();
    await this.drain();
    this.term.dispose();
  }
}

function assertNativeTui(state, raw, runtimeId, label) {
  assert(
    state.bufferType === 'alternate',
    `${runtimeId} ${label} did not use alternate screen`,
  );
  assert(state.nonBlankCells > 20, `${runtimeId} ${label} was blank`);
  assert(
    runtimeVisible(state.visibleText, runtimeId),
    `${runtimeId} ${label} did not visibly identify the real CLI`,
  );
  assert(
    raw.includes(Buffer.from('\x1b[?1049h', 'binary')),
    `${runtimeId} ${label} did not receive the native smcup sequence`,
  );
}

function runtimeVisible(text, runtimeId) {
  return runtimeId === 'codex'
    ? /codex|openai|sign in|log in|login/iu.test(text)
    : /claude|anthropic|sign in|log in|login|authentication/iu.test(text);
}

function classifyVisibleState(text) {
  return /sign in|log in|login|authentication|api key|oauth/iu.test(text)
    ? 'real-cli-auth-or-login-tui'
    : 'real-cli-native-tui';
}

function compareStates(first, second) {
  let differingCells = 0;
  const firstDifferences = [];
  for (
    let row = 0;
    row < Math.max(first.cells.length, second.cells.length);
    row += 1
  ) {
    const a = first.cells[row] ?? [];
    const b = second.cells[row] ?? [];
    for (let col = 0; col < Math.max(a.length, b.length); col += 1) {
      if (JSON.stringify(a[col]) !== JSON.stringify(b[col])) {
        differingCells += 1;
        if (firstDifferences.length < 16) {
          firstDifferences.push({ row, col, first: a[col], second: b[col] });
        }
      }
    }
  }
  const firstLines = first.visibleText.split('\n');
  const secondLines = second.visibleText.split('\n');
  const visibleLineDifferences = [];
  for (
    let row = 0;
    row < Math.max(firstLines.length, secondLines.length);
    row += 1
  ) {
    if (firstLines[row] !== secondLines[row]) {
      visibleLineDifferences.push({
        row,
        first: firstLines[row] ?? '',
        second: secondLines[row] ?? '',
      });
      if (visibleLineDifferences.length >= 8) break;
    }
  }
  const modeDifferences = [];
  for (const key of new Set([
    ...Object.keys(first.modes),
    ...Object.keys(second.modes),
  ])) {
    if (first.modes[key] !== second.modes[key]) {
      modeDifferences.push({
        key,
        first: first.modes[key],
        second: second.modes[key],
      });
    }
  }
  return {
    canonicalEqual: first.canonical === second.canonical,
    firstHash: first.hash,
    secondHash: second.hash,
    bufferTypeEqual: first.bufferType === second.bufferType,
    firstCursor: { x: first.cursorX, y: first.cursorY },
    secondCursor: { x: second.cursorX, y: second.cursorY },
    cursorEqual:
      first.cursorX === second.cursorX && first.cursorY === second.cursorY,
    modeDifferences,
    visibleTextEqual: first.visibleText === second.visibleText,
    differingCells,
    firstDifferences,
    visibleLineDifferences,
  };
}

async function runCapGatewayBrowserStory({
  taskId,
  runtimeId,
  provider,
  providerEndpoint,
  nonce,
  owner,
  ownerCapture,
  viewerFactory,
  viewerPolicy,
  commandExecutor,
  openAttachOnlyOwner,
  apiRestartOwnerEvidence,
}) {
  const token = `cap-terminal-story-${nonce}`;
  const user = {
    id: `terminal-story-user-${nonce}`,
    githubId: null,
    login: null,
    name: 'Terminal canary',
    avatarUrl: null,
    allowed: true,
    role: 'admin',
    mustChangePassword: false,
  };
  const authSession = {
    resolveSession: async (presented) => (presented === token ? user : null),
    resolveApiKey: async () => null,
  };
  const gateway = new TerminalGateway(
    new WriteLockService(),
    undefined,
    authSession,
  );
  let currentGateway = gateway;
  const gateways = new Set([gateway]);
  const shutdownGateways = new Set();
  const restartOwners = new Set();
  const viewerCleanupRecords = [];
  const trackedViewerFactory = {
    open(args) {
      const attachment = viewerFactory.open(args);
      const record = {
        ordinal: viewerCleanupRecords.length + 1,
        settlement: null,
        decision: attachment.cleanupDecision,
      };
      viewerCleanupRecords.push(record);
      void record.decision.then((settlement) => {
        record.settlement = settlement;
      });
      return attachment;
    },
  };
  const events = [];
  const telemetry = gateway.observeProviderTerminalStory(taskId, {
    onEvent(event) {
      events.push({ ...event, observedAt: Date.now() });
    },
  });
  const telemetryHandles = new Set([telemetry]);
  gateway.registerSession({
    taskId,
    ownerPty: owner,
    viewerFactory: trackedViewerFactory,
    geometry: { cols: COLS, rows: ROWS },
    launchDecision: owner.launchDecision,
  });

  const sockets = new Set();
  const wireConnections = [];
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/terminal',
  });
  let vite = null;
  let browser = null;
  const pages = new Set();
  let closePromise = null;
  const previousViteWsUrl = process.env.VITE_WS_URL;
  const previousViteAuthToken = process.env.VITE_AUTH_TOKEN;
  let environmentChanged = false;

  const harness = {
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const failures = [];
        for (const page of [...pages]) {
          try {
            if (!page.isClosed()) await page.close();
          } catch (error) {
            failures.push(error);
          }
          pages.delete(page);
        }
        try {
          await browser?.close();
        } catch (error) {
          failures.push(error);
        }
        browser = null;
        for (const socket of sockets) {
          try {
            socket.terminate();
          } catch (error) {
            failures.push(error);
          }
        }
        sockets.clear();
        for (const terminalGateway of gateways) {
          try {
            if (!shutdownGateways.has(terminalGateway)) {
              await terminalGateway.onApplicationShutdown();
              shutdownGateways.add(terminalGateway);
            }
            const cleanup = await terminalGateway.shutdownTerminalResources();
            if (cleanup.kind !== 'confirmed') {
              failures.push(
                new Error('CAP Gateway terminal cleanup remained indeterminate'),
              );
            }
          } catch (error) {
            failures.push(error);
          }
        }
        for (const restartOwner of restartOwners) {
          try {
            restartOwner.close?.();
            const cleanup = await withTimeout(
              restartOwner.cleanupDecision,
              DEFAULT_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS,
              'attach-only restart owner cleanup timed out',
            );
            if (cleanup.kind !== 'confirmed') {
              failures.push(
                new Error('attach-only restart owner cleanup was not confirmed'),
              );
            }
          } catch (error) {
            failures.push(error);
          }
        }
        for (const handle of telemetryHandles) {
          try {
            handle.dispose();
          } catch (error) {
            failures.push(error);
          }
        }
        telemetryHandles.clear();
        try {
          await closeWebSocketServer(wss);
        } catch (error) {
          failures.push(error);
        }
        try {
          await vite?.close();
        } catch (error) {
          failures.push(error);
        }
        vite = null;
        if (environmentChanged) {
          restoreEnvironmentValue('VITE_WS_URL', previousViteWsUrl);
          restoreEnvironmentValue('VITE_AUTH_TOKEN', previousViteAuthToken);
          environmentChanged = false;
        }
        activeCapSurfaceHarnesses.delete(harness);
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'CAP Gateway/browser surface cleanup failed',
          );
        }
      })();
      return closePromise;
    },
  };
  activeCapSurfaceHarnesses.add(harness);

  try {
    await waitForWebSocketServer(wss);
    const wssAddress = wss.address();
    assert(
      wssAddress && typeof wssAddress === 'object',
      'CAP Gateway WebSocket server did not expose a local address',
    );
    wss.on('connection', (socket, request) => {
      sockets.add(socket);
      const wire = {
        path: new URL(request.url ?? '/', 'ws://127.0.0.1').pathname,
        inboundControlTypes: [],
        outboundControlTypes: [],
        rawBytes: 0,
        rawFrames: 0,
        rawChunks: [],
        rawTimeline: [],
        rawCaptureOverflow: false,
      };
      wireConnections.push(wire);
      socket.on('message', (raw) => observeGatewayWireFrame(wire, 'inbound', raw));
      const originalSend = socket.send.bind(socket);
      socket.send = (data, ...args) => {
        observeGatewayWireFrame(wire, 'outbound', data);
        return originalSend(data, ...args);
      };
      const connectionGateway = currentGateway;
      connectionGateway.handleConnection(socket, request);
      socket.once('close', () => {
        sockets.delete(socket);
        connectionGateway.handleDisconnect(socket);
      });
    });

    process.env.VITE_WS_URL = `ws://127.0.0.1:${wssAddress.port}`;
    process.env.VITE_AUTH_TOKEN = token;
    environmentChanged = true;
    const viteEntry = requireFromWeb.resolve('vite');
    const { createServer } = await import(pathToFileURL(viteEntry).href);
    vite = await createServer({
      configFile: CAP_STORY_VITE_CONFIG,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await vite.listen();
    const viteAddress = vite.httpServer?.address();
    assert(
      viteAddress && typeof viteAddress === 'object',
      'provider story Vite server did not expose a local address',
    );
    const storyUrl = `http://127.0.0.1:${viteAddress.port}/?external=1&sessionId=${encodeURIComponent(
      taskId,
    )}`;

    // Gateway removes a browser viewer synchronously, while the provider PTY
    // closes asynchronously.  A fresh tmux attach before the old client has
    // actually disappeared can race tmux's size/mode reconciliation and render
    // a different frame.  Fence the story on the provider-visible client count,
    // where the one remaining client is the already-open owner transport.
    const providerTmuxClientBaseline = 1;
    // AIO closes one viewer by reconnecting its independently persisted
    // main/injector pair and proving both guest fingerprints absent. That exact
    // release has a 20 s product envelope, so the story's guest-visible tmux
    // fence must use the Gateway's larger bounded cleanup envelope. BoxLite's
    // execution close is synchronous enough to retain the tighter story bound.
    const providerCleanupSettlementTimeoutMs =
      provider === 'aio'
        ? DEFAULT_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS
        : 15_000;
    const baselineSettlementMs = await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      providerTmuxClientBaseline,
      providerCleanupSettlementTimeoutMs,
    );
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const firstPage = await context.newPage();
    pages.add(firstPage);
    await firstPage.goto(storyUrl, { waitUntil: 'load' });
    const firstProbe = await waitForNativeStoryProbe(
      firstPage,
      taskId,
      runtimeId,
      'first CAP viewer',
    );
    let firstStable = await waitForStableStoryProbe(
      firstPage,
      taskId,
      runtimeId,
      'first CAP viewer',
    );
    await waitForTmuxPaneStable(commandExecutor, taskId, 750, 10_000);
    const initialSourceBeforeFreshAttach = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );

    const secondPage = await context.newPage();
    pages.add(secondPage);
    // Production SessionTerminal intentionally requests takeover before a reader's
    // human input. Suppress only that one outbound control frame in this page so
    // the following real onData -> keystroke frame exercises Gateway's reader
    // rejection boundary without replacing the production terminal component.
    await suppressBrowserTakeoverRequests(secondPage);
    await secondPage.goto(storyUrl, { waitUntil: 'load' });
    await waitForNativeStoryProbe(
      secondPage,
      taskId,
      runtimeId,
      'second CAP viewer',
    );
    let secondStable = await waitForStableStoryProbe(
      secondPage,
      taskId,
      runtimeId,
      'second CAP viewer',
    );
    ({ first: firstStable, second: secondStable } =
      await waitForMatchingStoryProbes({
        firstPage,
        secondPage,
        taskId,
        runtimeId,
      }));
    assert(
      secondStable.canonicalScreen === firstStable.canonicalScreen,
      `${runtimeId} simultaneous CAP viewers rendered different native screens: ${JSON.stringify(
        compareSerializedScreens(
          firstStable.canonicalScreen,
          secondStable.canonicalScreen,
        ),
      )}`,
    );
    await waitForCondition(
      () => gateway.getProviderTerminalStoryResourceState(taskId).activeViewerCount === 2,
      15_000,
      `${runtimeId} CAP gateway did not expose two independent viewers`,
    );
    await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      providerTmuxClientBaseline + 2,
      15_000,
    );

    const opened = events.filter((event) => event.type === 'viewer_opened');
    assert(
      opened.length === 2,
      `${runtimeId} CAP gateway did not open exactly two initial viewers`,
    );
    const writerAttachmentId = opened[0].attachmentId;
    const readerAttachmentId = opened[1].attachmentId;
    assert(
      writerAttachmentId !== readerAttachmentId,
      `${runtimeId} CAP viewers reused one attachment identity`,
    );
    await waitForCondition(
      () =>
        [writerAttachmentId, readerAttachmentId].every((attachmentId) =>
          hasCorrelatedTerminalResponse(events, attachmentId),
        ),
      15_000,
      `${runtimeId} CAP viewers did not complete correlated terminal responses`,
    );

    mkdirSync(CAP_STORY_ARTIFACT_DIR, { recursive: true });
    const artifactBase = `${provider}-${runtimeId}-${nonce}`;
    const initialWriterPath = join(
      CAP_STORY_ARTIFACT_DIR,
      `${artifactBase}-initial-writer.png`,
    );
    const initialReaderPath = join(
      CAP_STORY_ARTIFACT_DIR,
      `${artifactBase}-initial-reader.png`,
    );
    await Promise.all([
      firstPage.locator('h1').click(),
      secondPage.locator('h1').click(),
    ]);
    await delay(80);
    const [initialWriterShot, initialReaderShot] = await Promise.all([
      firstPage
        .locator('[data-testid="terminal-surface"]')
        .screenshot({ animations: 'disabled', path: initialWriterPath }),
      secondPage
        .locator('[data-testid="terminal-surface"]')
        .screenshot({ animations: 'disabled', path: initialReaderPath }),
    ]);
    assert(
      initialWriterShot.byteLength > 1_000 &&
        initialReaderShot.byteLength > 1_000,
      `${runtimeId} initial CAP viewer screenshot was blank`,
    );
    assert(
      initialWriterShot.equals(initialReaderShot),
      `${runtimeId} simultaneous CAP viewer screenshots differed`,
    );
    const initialSourceAfterFreshAttach = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    assert(
      initialSourceAfterFreshAttach.digest ===
        initialSourceBeforeFreshAttach.digest,
      `${runtimeId} authoritative tmux source changed during the initial uninterrupted/fresh comparison: ${JSON.stringify(
        comparePaneSnapshots(
          initialSourceBeforeFreshAttach.output,
          initialSourceAfterFreshAttach.output,
        ),
        )}`,
    );
    assert(
      gateway.getProviderTerminalStoryResourceState(taskId)
        .activeViewerCount === 2 &&
        events.every((event) => event.type !== 'viewer_closed'),
      `${runtimeId} an initial CAP viewer closed during parity capture`,
    );
    await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      providerTmuxClientBaseline + 2,
      15_000,
    );

    const readerWritesBefore = events.filter(
      (event) =>
        event.type === 'provider_write' &&
        event.source === 'keystroke' &&
        event.attachmentId === readerAttachmentId,
    ).length;
    await secondPage.locator('.xterm').click();
    await secondPage.keyboard.insertText('reader-input-must-not-write');
    await secondPage.keyboard.press('Enter');
    await delay(300);
    assert(
      (await secondPage.evaluate(
        () => window.__capSuppressedTakeovers ?? 0,
      )) > 0,
      `${runtimeId} reader rejection probe did not suppress a takeover request`,
    );
    assert(
      wireConnections[1]?.inboundControlTypes.includes('keystroke'),
      `${runtimeId} reader browser did not exercise the CAP keystroke frame`,
    );
    assert(
      events.filter(
        (event) =>
          event.type === 'provider_write' &&
          event.source === 'keystroke' &&
          event.attachmentId === readerAttachmentId,
      ).length === readerWritesBefore,
      `${runtimeId} reader input crossed the Gateway write lease`,
    );

    await firstPage.locator('h1').click();
    await delay(80);
    const uninterrupted = await readStoryProbe(firstPage);
    assert(
      uninterrupted.canonicalScreen === firstStable.canonicalScreen,
      `${runtimeId} stopped CLI screen changed before CAP reconnect measurement`,
    );
    const uninterruptedPath = join(
      CAP_STORY_ARTIFACT_DIR,
      `${artifactBase}-uninterrupted.png`,
    );
    const uninterruptedShot = await firstPage
      .locator('[data-testid="terminal-surface"]')
      .screenshot({ animations: 'disabled', path: uninterruptedPath });
    assert(
      uninterruptedShot.byteLength > 1_000,
      `${runtimeId} CAP uninterrupted screenshot was blank`,
    );
    const providerSourceBeforeDisconnect = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );

    await firstPage.close();
    pages.delete(firstPage);
    await secondPage.close();
    pages.delete(secondPage);
    await waitForCondition(
      () => gateway.getProviderTerminalStoryResourceState(taskId).activeViewerCount === 0,
      15_000,
      `${runtimeId} CAP viewers did not close after full browser disconnect`,
    );
    const initialViewerCleanupSettlements = await Promise.all(
      viewerCleanupRecords.slice(0, 2).map((record) =>
        withTimeout(
          record.decision,
          providerCleanupSettlementTimeoutMs,
          `${runtimeId} initial CAP viewer ${record.ordinal} cleanup timed out`,
        ),
      ),
    );
    assert(
      initialViewerCleanupSettlements.every(
        (settlement) => settlement.kind === 'confirmed',
      ),
      `${runtimeId} initial CAP viewer cleanup was not confirmed: ${JSON.stringify({
        settlements: initialViewerCleanupSettlements,
      })}`,
    );
    const fullDisconnectProviderSettlementMs = await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      providerTmuxClientBaseline,
      providerCleanupSettlementTimeoutMs,
    );
    const providerSourceAfterFullDisconnect = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    assert(
      providerSourceAfterFullDisconnect.digest ===
        providerSourceBeforeDisconnect.digest,
      `${runtimeId} tmux source changed across full CAP disconnect: ${JSON.stringify({
        beforeSha256: providerSourceBeforeDisconnect.digest,
        afterSha256: providerSourceAfterFullDisconnect.digest,
      })}`,
    );

    await waitForCondition(
      () => sockets.size === 0,
      15_000,
      `${runtimeId} old CAP browser sockets did not fully close`,
    );
    const oldGatewayBeforeRestart =
      gateway.getProviderTerminalStoryResourceState(taskId);
    assert(
      oldGatewayBeforeRestart.ownerRegistered &&
        oldGatewayBeforeRestart.activeViewerCount === 0,
      `${runtimeId} old Gateway did not reach owner-only restart baseline`,
    );
    const panePidBeforeApiRestart = await readExactTmuxPanePid(
      commandExecutor,
      taskId,
    );
    const cliProcessBeforeApiRestart = await readExactRuntimeProcessIdentity({
      commandExecutor,
      runtimeId,
      taskId,
    });
    const restartGeometry = firstStable.terminalGeometry;
    assert(
      restartGeometry &&
        Number.isInteger(restartGeometry.cols) &&
        Number.isInteger(restartGeometry.rows),
      `${runtimeId} CAP browser did not expose a restart geometry`,
    );
    await waitForTmuxGeometry(
      commandExecutor,
      taskId,
      restartGeometry.cols,
      restartGeometry.rows,
    );
    const windowPolicyBeforeShutdownMs =
      await waitForTmuxWindowSizePolicy(commandExecutor, taskId, 'manual');
    const providerSourceBeforeApiRestart =
      providerSourceAfterFullDisconnect.digest;
    const apiRestartStartedAt = Date.now();
    const oldGatewayShutdownStartedAt = Date.now();
    await gateway.onApplicationShutdown();
    shutdownGateways.add(gateway);
    const oldGatewayCleanup = await gateway.shutdownTerminalResources();
    const oldGatewayShutdownMs = Date.now() - oldGatewayShutdownStartedAt;
    assertGatewayCleanupEvidence(
      oldGatewayCleanup,
      token,
      providerEndpoint,
      `${runtimeId} old Gateway`,
    );
    const oldGatewayAfterShutdown =
      gateway.getProviderTerminalStoryResourceState(taskId);
    assert(
      !oldGatewayAfterShutdown.ownerRegistered &&
        oldGatewayAfterShutdown.activeViewerCount === 0,
      `${runtimeId} old Gateway retained owner/viewer resources after shutdown`,
    );
    const providerDownSettlementMs = await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      0,
      providerCleanupSettlementTimeoutMs,
    );
    const ownerAbsentStartedAt = Date.now();
    await assertExactSessionAlive(commandExecutor, taskId);
    await waitForTmuxGeometry(
      commandExecutor,
      taskId,
      restartGeometry.cols,
      restartGeometry.rows,
    );
    const windowPolicyWhileApiDownMs =
      await waitForTmuxWindowSizePolicy(commandExecutor, taskId, 'manual');
    const panePidWhileApiDown = await readExactTmuxPanePid(
      commandExecutor,
      taskId,
    );
    const cliProcessWhileApiDown = await readExactRuntimeProcessIdentity({
      commandExecutor,
      runtimeId,
      taskId,
    });
    await waitForTmuxPaneStable(commandExecutor, taskId, 750, 10_000);
    const providerSourceWhileApiDown = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    assert(
      panePidWhileApiDown === panePidBeforeApiRestart &&
        cliProcessWhileApiDown.pid === cliProcessBeforeApiRestart.pid &&
        cliProcessWhileApiDown.startTimeTicks ===
          cliProcessBeforeApiRestart.startTimeTicks,
      `${runtimeId} detached terminal process identity changed while the API was down`,
    );
    assert(
      providerSourceWhileApiDown.output.trim().length > 0,
      `${runtimeId} detached terminal source was blank while the API was down`,
    );
    const apiDownSourceTransition =
      providerSourceWhileApiDown.digest === providerSourceBeforeApiRestart
        ? null
        : summarizePaneTransition(
            providerSourceAfterFullDisconnect.output,
            providerSourceWhileApiDown.output,
          );

    const reAdoptStartedAt = Date.now();
    const restartOwner = openAttachOnlyOwner();
    restartOwners.add(restartOwner);
    const restartLaunchOutcome = await withTimeout(
      restartOwner.launchDecision,
      60_000,
      `${runtimeId} attach-only API re-adoption timed out`,
    );
    const reAdoptDecisionMs = Date.now() - reAdoptStartedAt;
    assert(
      restartLaunchOutcome.kind === 'attached',
      `${runtimeId} API restart did not re-adopt the existing terminal: ${JSON.stringify(
        restartLaunchOutcome,
      )}`,
    );
    assert(
      apiRestartOwnerEvidence.openCalls === 1 &&
        apiRestartOwnerEvidence.launchContextCalls === 0 &&
        apiRestartOwnerEvidence.beforeAgentLaunchCalls === 0,
      `${runtimeId} attach-only API restart crossed a fresh-launch boundary`,
    );
    const reAdoptProviderSettlementMs = await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      providerTmuxClientBaseline,
      15_000,
    );
    const ownerAbsentDurationMs = Date.now() - ownerAbsentStartedAt;
    await waitForTmuxGeometry(
      commandExecutor,
      taskId,
      restartGeometry.cols,
      restartGeometry.rows,
    );
    const windowPolicyAfterReAdoptMs =
      await waitForTmuxWindowSizePolicy(commandExecutor, taskId, 'manual');
    const panePidAfterReAdopt = await readExactTmuxPanePid(
      commandExecutor,
      taskId,
    );
    const cliProcessAfterReAdopt = await readExactRuntimeProcessIdentity({
      commandExecutor,
      runtimeId,
      taskId,
    });
    assert(
      panePidAfterReAdopt === panePidBeforeApiRestart &&
        cliProcessAfterReAdopt.pid === cliProcessBeforeApiRestart.pid &&
        cliProcessAfterReAdopt.startTimeTicks ===
          cliProcessBeforeApiRestart.startTimeTicks,
      `${runtimeId} API re-adoption relaunched or replaced the real CLI process`,
    );
    await waitForTmuxPaneStable(commandExecutor, taskId, 750, 10_000);
    const ownerAttachSettleDurationMs = Date.now() - reAdoptStartedAt;
    const providerSourceAfterReAdopt = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    const reAdoptSourceTransition =
      providerSourceAfterReAdopt.digest === providerSourceWhileApiDown.digest
        ? null
        : summarizePaneTransition(
            providerSourceWhileApiDown.output,
            providerSourceAfterReAdopt.output,
          );

    const restartEvents = [];
    const restartGateway = new TerminalGateway(
      new WriteLockService(),
      undefined,
      authSession,
    );
    gateways.add(restartGateway);
    const restartTelemetry = restartGateway.observeProviderTerminalStory(taskId, {
      onEvent(event) {
        restartEvents.push({ ...event, observedAt: Date.now() });
      },
    });
    telemetryHandles.add(restartTelemetry);
    restartGateway.registerSession({
      taskId,
      ownerPty: restartOwner,
      viewerFactory: trackedViewerFactory,
      geometry: { ...restartGeometry },
      launchDecision: restartOwner.launchDecision,
    });
    currentGateway = restartGateway;
    const restartGatewayState =
      restartGateway.getProviderTerminalStoryResourceState(taskId);
    assert(
      restartGatewayState.ownerRegistered &&
        restartGatewayState.activeViewerCount === 0,
      `${runtimeId} restarted Gateway did not register the re-adopted owner`,
    );

    const restartBrowserStartedAt = Date.now();
    const freshWireCountBefore = wireConnections.length;
    const freshPage = await context.newPage();
    pages.add(freshPage);
    await freshPage.goto(storyUrl, { waitUntil: 'load' });
    await waitForNativeStoryProbe(
      freshPage,
      taskId,
      runtimeId,
      'fresh CAP viewer',
    );
    assert(
      wireConnections.length === freshWireCountBefore + 1,
      `${runtimeId} fresh CAP viewer did not open exactly one wire`,
    );
    const freshWire = wireConnections.at(-1);
    assert(freshWire, `${runtimeId} fresh CAP viewer wire was missing`);
    let freshStable = await waitForStableStoryProbe(
      freshPage,
      taskId,
      runtimeId,
      'fresh CAP viewer',
    );
    const restartBrowserRedrawMs = Date.now() - restartBrowserStartedAt;
    const apiRestartReadyMs = Date.now() - apiRestartStartedAt;
    assert(
      JSON.stringify(freshStable.terminalGeometry) ===
        JSON.stringify(restartGeometry),
      `${runtimeId} CAP fresh attach did not restore the authoritative geometry: ${JSON.stringify(
        {
          expected: restartGeometry,
          actual: freshStable.terminalGeometry,
        },
      )}`,
    );
    await waitForTmuxPaneStable(commandExecutor, taskId, 750, 10_000);
    let providerSourceAfterFreshAttach = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    const restartReferenceKind = classifyApiRestartFrameReference({
      beforeSourceSha256: providerSourceBeforeDisconnect.digest,
      afterSourceSha256: providerSourceAfterFreshAttach.digest,
    });
    const sourceUnchangedAcrossRestart =
      restartReferenceKind === 'uninterrupted';
    let restartReferenceCanonical = firstStable.canonicalScreen;
    const restartReferenceGeometry = restartGeometry;
    let restartReferenceShot = uninterruptedShot;
    let restartReferencePath = uninterruptedPath;
    let restartPeerViewerCount = 0;
    let currentFramePeerPage = null;
    let currentFramePeerPath = null;
    let currentFramePeerAttachmentId = null;
    let currentFramePeerCleanupRecord = null;
    let currentFramePeerStable = null;
    let currentFrameSourceBeforePeer = null;
    let currentFrameSourceAfterPeer = null;

    await waitForCondition(
      () =>
        restartGateway.getProviderTerminalStoryResourceState(taskId)
          .activeViewerCount === 1,
      15_000,
      `${runtimeId} restarted CAP gateway did not expose the first fresh viewer`,
    );
    await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      providerTmuxClientBaseline + 1,
      15_000,
    );
    const freshOpened = restartEvents.filter(
      (event) => event.type === 'viewer_opened',
    );
    assert(
      freshOpened.length === 1,
      `${runtimeId} restarted CAP gateway exposed an unexpected fresh viewer count`,
    );
    const freshAttachmentId = freshOpened[0].attachmentId;
    await waitForCondition(
      () => hasCorrelatedTerminalResponse(restartEvents, freshAttachmentId),
      15_000,
      `${runtimeId} restarted CAP viewer did not complete terminal responses`,
    );

    if (!sourceUnchangedAcrossRestart) {
      await waitForTmuxPaneStable(commandExecutor, taskId, 750, 10_000);
      currentFrameSourceBeforePeer = await captureTmuxPaneSnapshot(
        commandExecutor,
        taskId,
      );
      currentFramePeerPage = await context.newPage();
      pages.add(currentFramePeerPage);
      await suppressBrowserTakeoverRequests(currentFramePeerPage);
      await currentFramePeerPage.goto(storyUrl, { waitUntil: 'load' });
      await waitForNativeStoryProbe(
        currentFramePeerPage,
        taskId,
        runtimeId,
        'current-frame peer CAP viewer',
      );
      currentFramePeerStable = await waitForStableStoryProbe(
        currentFramePeerPage,
        taskId,
        runtimeId,
        'current-frame peer CAP viewer',
      );
      await waitForCondition(
        () =>
          restartGateway.getProviderTerminalStoryResourceState(taskId)
            .activeViewerCount === 2,
        15_000,
        `${runtimeId} restarted CAP gateway did not expose two current-frame viewers`,
      );
      await waitForTmuxClientCount(
        commandExecutor,
        taskId,
        providerTmuxClientBaseline + 2,
        15_000,
      );
      ({ first: freshStable, second: currentFramePeerStable } =
        await waitForMatchingStoryProbes({
          firstPage: freshPage,
          secondPage: currentFramePeerPage,
          taskId,
          runtimeId,
        }));
      currentFrameSourceAfterPeer = await captureTmuxPaneSnapshot(
        commandExecutor,
        taskId,
      );
      assert(
        currentFrameSourceAfterPeer.digest ===
          currentFrameSourceBeforePeer.digest,
        `${runtimeId} authoritative tmux source changed after opening the current-frame peer: ${JSON.stringify(
          comparePaneSnapshots(
            currentFrameSourceBeforePeer.output,
            currentFrameSourceAfterPeer.output,
          ),
        )}`,
      );
      const peerOpened = restartEvents.filter(
        (event) => event.type === 'viewer_opened',
      );
      assert(
        peerOpened.length === 2,
        `${runtimeId} restarted CAP gateway did not expose two current-frame viewer identities`,
      );
      currentFramePeerAttachmentId = peerOpened.at(-1).attachmentId;
      currentFramePeerCleanupRecord = viewerCleanupRecords.at(-1);
      assert(
        currentFramePeerAttachmentId !== freshAttachmentId,
        `${runtimeId} current-frame CAP viewers reused one attachment identity`,
      );
      await waitForCondition(
        () =>
          [freshAttachmentId, currentFramePeerAttachmentId].every(
            (attachmentId) =>
              hasCorrelatedTerminalResponse(restartEvents, attachmentId),
          ),
        15_000,
        `${runtimeId} current-frame viewers did not complete terminal responses`,
      );
      assert(
        JSON.stringify(currentFramePeerStable.terminalGeometry) ===
          JSON.stringify(restartGeometry),
        `${runtimeId} current-frame peer did not restore the authoritative geometry: ${JSON.stringify(
          {
            expected: restartGeometry,
            actual: currentFramePeerStable.terminalGeometry,
          },
        )}`,
      );
      restartReferenceCanonical = currentFramePeerStable.canonicalScreen;
      currentFramePeerPath = join(
        CAP_STORY_ARTIFACT_DIR,
        `${artifactBase}-fresh-attach-peer.png`,
      );
      await currentFramePeerPage.locator('h1').click();
      await delay(80);
      restartReferenceShot = await currentFramePeerPage
        .locator('[data-testid="terminal-surface"]')
        .screenshot({ animations: 'disabled', path: currentFramePeerPath });
      restartReferencePath = currentFramePeerPath;
      restartPeerViewerCount = 1;
    }

    const restartSourceTransition =
      providerSourceAfterFreshAttach.digest ===
      providerSourceBeforeDisconnect.digest
        ? null
        : summarizePaneTransition(
            providerSourceBeforeDisconnect.output,
            providerSourceAfterFreshAttach.output,
          );
    const freshAttachSourceTransition =
      providerSourceAfterFreshAttach.digest ===
      providerSourceAfterReAdopt.digest
        ? null
        : summarizePaneTransition(
            providerSourceAfterReAdopt.output,
            providerSourceAfterFreshAttach.output,
          );

    assert(
      freshStable.canonicalScreen === restartReferenceCanonical,
      `${runtimeId} CAP fresh attach canonical screen differed: ${JSON.stringify(
        compareSerializedScreens(
          restartReferenceCanonical,
          freshStable.canonicalScreen,
        ),
      )}`,
    );
    assert(
      JSON.stringify(freshStable.terminalGeometry) ===
        JSON.stringify(restartReferenceGeometry),
      `${runtimeId} CAP fresh attach geometry differed: ${JSON.stringify({
        reference: restartReferenceGeometry,
        fresh: freshStable.terminalGeometry,
      })}`,
    );
    await freshPage.locator('h1').click();
    await delay(80);
    const freshPath = join(
      CAP_STORY_ARTIFACT_DIR,
      `${artifactBase}-fresh-attach.png`,
    );
    const freshShot = await freshPage
      .locator('[data-testid="terminal-surface"]')
      .screenshot({ animations: 'disabled', path: freshPath });
    assert(
      freshShot.equals(restartReferenceShot),
      `${runtimeId} CAP production SessionTerminal current-frame screenshots differed`,
    );
    if (currentFrameSourceBeforePeer) {
      const sourceAfterCurrentFrameScreenshots =
        await captureTmuxPaneSnapshot(commandExecutor, taskId);
      assert(
        sourceAfterCurrentFrameScreenshots.digest ===
          currentFrameSourceBeforePeer.digest,
        `${runtimeId} authoritative tmux source changed during current-frame screenshot comparison: ${JSON.stringify(
          comparePaneSnapshots(
            currentFrameSourceBeforePeer.output,
            sourceAfterCurrentFrameScreenshots.output,
          ),
        )}`,
      );
      providerSourceAfterFreshAttach = sourceAfterCurrentFrameScreenshots;
    }
    const restartParityViewerCount = currentFramePeerPage ? 2 : 1;
    assert(
      restartGateway.getProviderTerminalStoryResourceState(taskId)
        .activeViewerCount === restartParityViewerCount &&
        restartEvents.every((event) => event.type !== 'viewer_closed'),
      `${runtimeId} a restarted CAP viewer closed during parity capture`,
    );
    await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      providerTmuxClientBaseline + restartParityViewerCount,
      15_000,
    );
    if (currentFramePeerPage) {
      await currentFramePeerPage.close();
      pages.delete(currentFramePeerPage);
      await waitForCondition(
        () =>
          restartGateway.getProviderTerminalStoryResourceState(taskId)
            .activeViewerCount === 1,
        15_000,
        `${runtimeId} current-frame peer viewer did not close`,
      );
      await waitForTmuxClientCount(
        commandExecutor,
        taskId,
        providerTmuxClientBaseline + 1,
        providerCleanupSettlementTimeoutMs,
      );
      assert(
        currentFramePeerCleanupRecord,
        `${runtimeId} current-frame peer cleanup identity was missing`,
      );
      const currentFramePeerCleanup = await withTimeout(
        currentFramePeerCleanupRecord.decision,
        providerCleanupSettlementTimeoutMs,
        `${runtimeId} current-frame peer cleanup timed out`,
      );
      assert(
        currentFramePeerCleanup?.kind === 'confirmed',
        `${runtimeId} current-frame peer cleanup was not confirmed`,
      );
    }

    const continuousDeadlineEvidence =
      await runCapRealCliContinuousOutputPressure({
        taskId,
        runtimeId,
        nonce,
        commandExecutor,
        freshPage,
        freshAttachmentId,
        freshWire,
        context,
        pages,
        storyUrl,
        restartGateway,
        restartEvents,
        wireConnections,
        viewerCleanupRecords,
        providerTmuxClientBaseline,
        providerCleanupSettlementTimeoutMs,
        quietMs: viewerPolicy.quietMs,
        maxSettleMs: viewerPolicy.maxSettleMs,
        artifactBase,
      });
    const controlLBase64 = Buffer.from([0x0c]).toString('base64');
    await freshPage.locator('.xterm').click();
    await freshPage.keyboard.press('Control+l');
    await waitForCondition(
      () =>
        restartEvents.some(
          (event) =>
            event.type === 'provider_write' &&
            event.source === 'keystroke' &&
            event.attachmentId === freshAttachmentId &&
            event.bytesBase64 === controlLBase64 &&
            event.outcome === 'written',
        ),
      10_000,
      `${runtimeId} writer Ctrl-L did not cross the CAP Gateway`,
    );
    const bodyText = await freshPage.locator('body').innerText();
    assert(
      !bodyText.includes(providerEndpoint) &&
        !bodyText.includes('/v1/shell/ws') &&
        !bodyText.includes('snapshot') &&
        !bodyText.includes('tail_replay'),
      `${runtimeId} CAP browser exposed provider/replay internals`,
    );
    await freshPage.close();
    pages.delete(freshPage);
    await waitForCondition(
      () =>
        restartGateway.getProviderTerminalStoryResourceState(taskId)
          .activeViewerCount === 0,
      15_000,
      `${runtimeId} CAP fresh viewer did not close`,
    );
    const freshDisconnectProviderSettlementMs = await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      providerTmuxClientBaseline,
      providerCleanupSettlementTimeoutMs,
    );
    await waitForCondition(
      () => sockets.size === 0,
      15_000,
      `${runtimeId} restarted CAP browser socket did not close`,
    );
    const sourceBeforeFinalGatewayShutdown = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    const restartGatewayShutdownStartedAt = Date.now();
    await restartGateway.onApplicationShutdown();
    shutdownGateways.add(restartGateway);
    const restartGatewayCleanup =
      await restartGateway.shutdownTerminalResources();
    const restartGatewayShutdownMs =
      Date.now() - restartGatewayShutdownStartedAt;
    assertGatewayCleanupEvidence(
      restartGatewayCleanup,
      token,
      providerEndpoint,
      `${runtimeId} restarted Gateway`,
    );
    const restartGatewayAfterShutdown =
      restartGateway.getProviderTerminalStoryResourceState(taskId);
    assert(
      !restartGatewayAfterShutdown.ownerRegistered &&
        restartGatewayAfterShutdown.activeViewerCount === 0,
      `${runtimeId} restarted Gateway retained owner/viewer resources`,
    );
    const finalProviderClientSettlementMs = await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      0,
      providerCleanupSettlementTimeoutMs,
    );
    const windowPolicyAfterFinalShutdownMs =
      await waitForTmuxWindowSizePolicy(commandExecutor, taskId, 'manual');
    const panePidAfterFinalShutdown = await readExactTmuxPanePid(
      commandExecutor,
      taskId,
    );
    const cliProcessAfterFinalShutdown = await readExactRuntimeProcessIdentity({
      commandExecutor,
      runtimeId,
      taskId,
    });
    const providerSourceAfterFinalShutdown = await captureTmuxPaneSnapshot(
      commandExecutor,
      taskId,
    );
    assert(
      panePidAfterFinalShutdown === panePidBeforeApiRestart &&
        cliProcessAfterFinalShutdown.pid === cliProcessBeforeApiRestart.pid &&
        cliProcessAfterFinalShutdown.startTimeTicks ===
          cliProcessBeforeApiRestart.startTimeTicks,
      `${runtimeId} final Gateway shutdown changed the detached CLI`,
    );

    assert(
      wireConnections.length === 4 + restartPeerViewerCount,
      `${runtimeId} CAP story opened unexpected sockets`,
    );
    for (const wire of wireConnections) {
      assert(wire.path === '/terminal', `${runtimeId} browser bypassed CAP /terminal`);
      assert(wire.rawFrames > 0, `${runtimeId} CAP viewer received no raw bytes`);
      assert(
        wire.rawBytes > 0 && wire.rawBytes <= MAX_CAPTURE_BYTES,
        `${runtimeId} CAP current-frame bytes were empty or unbounded`,
      );
      assert(
        !wire.inboundControlTypes.includes('snapshot') &&
          !wire.inboundControlTypes.includes('tail_replay') &&
          !wire.outboundControlTypes.includes('snapshot') &&
          !wire.outboundControlTypes.includes('tail_replay'),
        `${runtimeId} CAP story observed removed replay controls`,
      );
    }

    const terminalInventory = [
      ...events.map((event) => ({ ...event, gatewayEpoch: 'initial' })),
      ...restartEvents.map((event) => ({ ...event, gatewayEpoch: 'restarted' })),
    ]
      .filter(
        (event) =>
          event.type === 'query' ||
          event.type === 'response' ||
          event.type === 'provider_write',
      )
      .map((event) => ({ ...event }));
    const terminalResponseCorrelation = assertExactTerminalResponseCorrelation(
      terminalInventory,
      runtimeId,
    );
    const result = {
      result: 'PASS',
      path: 'CAP Gateway /terminal -> production SessionTerminal',
      distinctViewerAttachmentIds: [writerAttachmentId, readerAttachmentId],
      restartViewerAttachmentIds: [
        freshAttachmentId,
        ...(currentFramePeerAttachmentId
          ? [currentFramePeerAttachmentId]
          : []),
        continuousDeadlineEvidence.pressureAttachmentId,
      ],
      simultaneousViewerCount: 2,
      readerInputRejected: true,
      writerInputWritten: true,
      fullDisconnectViewerCount: 0,
      freshAttachReference: restartReferenceKind,
      uninterruptedScreenSha256: sha256(firstStable.canonicalScreen),
      freshAttachScreenSha256: sha256(freshStable.canonicalScreen),
      providerTmuxSourceSha256: providerSourceBeforeDisconnect.digest,
      freshAttachTmuxSourceSha256: providerSourceAfterFreshAttach.digest,
      nonBlank: firstProbe.terminalText.trim().length > 0,
      continuousDeadlineEvidence,
      initialUninterruptedFreshParity: {
        result: 'PASS',
        canonicalEqual: true,
        exactScreenshotEqual: true,
        activeViewerCount: 2,
        providerTmuxClientCount:
          providerTmuxClientBaseline + 2,
        writerPath:
          relativeProviderStoryArtifactPath(initialWriterPath),
        readerPath:
          relativeProviderStoryArtifactPath(initialReaderPath),
        screenshotSha256: sha256(initialWriterShot),
        sourceBeforeFreshAttachSha256:
          initialSourceBeforeFreshAttach.digest,
        sourceAfterFreshAttachSha256:
          initialSourceAfterFreshAttach.digest,
      },
      apiRestartUninterruptedFreshParity: sourceUnchangedAcrossRestart
        ? {
            result: 'PASS',
            canonicalEqual: true,
            exactScreenshotEqual: true,
            geometryEqual: true,
            sourceSha256: providerSourceBeforeDisconnect.digest,
          }
        : {
            result: 'NOT_APPLICABLE_SOURCE_CHANGED',
            canonicalEqual: null,
            exactScreenshotEqual: null,
            geometryEqual: true,
            sourceBeforeSha256: providerSourceBeforeDisconnect.digest,
            sourceAtFreshAttachSha256:
              providerSourceAfterFreshAttach.digest,
          },
      apiRestartCurrentFramePeerParity: sourceUnchangedAcrossRestart
        ? null
        : {
            result: 'PASS',
            canonicalEqual: true,
            exactScreenshotEqual: true,
            geometryEqual: true,
            activeViewerCount: 2,
            providerTmuxClientCount:
              providerTmuxClientBaseline + 2,
            freshAttachmentId,
            peerAttachmentId: currentFramePeerAttachmentId,
            sourceBeforePeerSha256:
              currentFrameSourceBeforePeer?.digest,
            sourceAfterPeerSha256:
              currentFrameSourceAfterPeer?.digest,
          },
      screenshots: {
        initialViewerExactEqual: true,
        apiRestartReferenceExactEqual: true,
        apiRestartScreenshotSha256: sha256(freshShot),
        uninterruptedPath: relativeProviderStoryArtifactPath(uninterruptedPath),
        freshAttachPath: relativeProviderStoryArtifactPath(freshPath),
        apiRestartPath: relativeProviderStoryArtifactPath(freshPath),
        comparisonReference: restartReferenceKind,
        comparisonReferencePath:
          relativeProviderStoryArtifactPath(restartReferencePath),
      },
      apiLifecycleRestart: {
        result: 'PASS',
        lifecycleHook: 'TerminalGateway.onApplicationShutdown',
        restartReadyMs: apiRestartReadyMs,
        oldGatewayShutdownMs,
        providerDownSettlementMs,
        ownerAbsentDurationMs,
        reAdoptDecisionMs,
        reAdoptProviderSettlementMs,
        ownerAttachSettleDurationMs,
        missingByteCount: 'unknown',
        missingByteCountBasis:
          'real interactive CLI output has no independent API-outage byte oracle',
        windowSizePolicy: 'manual',
        windowPolicySettlementMs: {
          beforeShutdown: windowPolicyBeforeShutdownMs,
          whileApiDown: windowPolicyWhileApiDownMs,
          afterReAdopt: windowPolicyAfterReAdoptMs,
          afterFinalShutdown: windowPolicyAfterFinalShutdownMs,
        },
        browserRedrawMs: restartBrowserRedrawMs,
        restartGatewayShutdownMs,
        finalProviderClientSettlementMs,
        oldGatewayCleanup,
        restartGatewayCleanup,
        providerClients: {
          beforeShutdown: providerTmuxClientBaseline,
          whileApiDown: 0,
          afterReAdopt: providerTmuxClientBaseline,
          afterFinalShutdown: 0,
        },
        noRelaunchEvidence: {
          attachOnlyOwnerOpenCalls: apiRestartOwnerEvidence.openCalls,
          launchDecision: restartLaunchOutcome.kind,
          launchContextCalls: apiRestartOwnerEvidence.launchContextCalls,
          beforeAgentLaunchCalls: apiRestartOwnerEvidence.beforeAgentLaunchCalls,
          panePidStable: true,
          cliProcessStable: true,
          evidenceBasis: [
            'attach-only launchDecision=attached',
            'launch-context and before-launch callbacks were not invoked',
            'tmux pane PID remained stable',
            'CLI PID and proc start time remained stable',
          ],
          panePidBefore: panePidBeforeApiRestart,
          panePidWhileApiDown,
          panePidAfterReAdopt,
          panePidAfterFinalShutdown,
          cliProcessBefore: cliProcessBeforeApiRestart,
          cliProcessWhileApiDown,
          cliProcessAfterReAdopt,
          cliProcessAfterFinalShutdown,
        },
        redrawEvidence: {
          nonBlank: freshStable.terminalText.trim().length > 0,
          referenceCanonicalEqual: true,
          referenceExactScreenshotEqual: true,
          reference: restartReferenceKind,
          sourceUnchangedAcrossRestart,
          sourceTransition: restartSourceTransition,
          sourceTransitionWhileApiDown: apiDownSourceTransition,
          sourceTransitionAfterReAdopt: reAdoptSourceTransition,
          sourceTransitionAtFreshAttach: freshAttachSourceTransition,
          sourceBeforeSha256: providerSourceBeforeApiRestart,
          sourceWhileDownSha256: providerSourceWhileApiDown.digest,
          sourceAfterReAdoptSha256: providerSourceAfterReAdopt.digest,
          sourceAtFreshAttachSha256: providerSourceAfterFreshAttach.digest,
          sourceAfterBrowserSha256: sourceBeforeFinalGatewayShutdown.digest,
          sourceAfterFinalShutdownSha256:
            providerSourceAfterFinalShutdown.digest,
        },
      },
      terminalInventory,
      terminalResponseCorrelation,
      wire: wireConnections.map((wire) => ({
        path: wire.path,
        rawBytes: wire.rawBytes,
        rawFrames: wire.rawFrames,
        inboundControlTypes: [...new Set(wire.inboundControlTypes)],
        outboundControlTypes: [...new Set(wire.outboundControlTypes)],
      })),
      providerEndpointExposed: false,
      replayControlsObserved: false,
      cleanup: {
        browserViewersClosed: true,
        providerTmuxClientBaseline,
        providerTmuxClientCountAfterDisconnect: providerTmuxClientBaseline,
        baselineSettlementMs,
        fullDisconnectProviderSettlementMs,
        freshDisconnectProviderSettlementMs,
        gatewayOwnersReleasedByLifecycleHooks: true,
        providerTmuxClientCountAfterFinalGatewayShutdown: 0,
      },
    };
    assertNoSecrets(JSON.stringify(result), `${runtimeId} CAP browser report`);
    await harness.close();
    return result;
  } catch (error) {
    try {
      await harness.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${runtimeId} CAP Gateway/browser story and cleanup failed`,
      );
    }
    throw error;
  }
}

async function runCapRealCliContinuousOutputPressure({
  taskId,
  runtimeId,
  nonce,
  commandExecutor,
  freshPage,
  freshAttachmentId,
  freshWire,
  context,
  pages,
  storyUrl,
  restartGateway,
  restartEvents,
  wireConnections,
  viewerCleanupRecords,
  providerTmuxClientBaseline,
  providerCleanupSettlementTimeoutMs,
  quietMs,
  maxSettleMs,
  artifactBase,
}) {
  const plan = buildRealCliPressurePlan(runtimeId, nonce, taskId);
  const freshMarkerSearchOffset = freshWire.rawBytes;
  const inputEventOffset = restartEvents.length;
  const expectedPrompt = Buffer.from(plan.prompt, 'utf8');
  let continueAttempted = false;
  let pressurePage = null;
  let pressureWire = null;
  let pressureAttachmentId = null;
  let pressureCleanupRecord = null;
  let evidence = null;
  let primaryError = null;
  let originalPaneIdentity = null;
  let pressurePaneIdentity = null;
  let pressureWindowLifecycle = null;

  try {
    originalPaneIdentity = await readExactTmuxPaneIdentity(
      commandExecutor,
      taskId,
    );
    assert(
      originalPaneIdentity.windowActive && !originalPaneIdentity.paneDead,
      `${runtimeId} original CLI pane was not active and live before pressure`,
    );
    if (plan.pressureWindowName) {
      await assertPressureWindowAbsent(
        commandExecutor,
        taskId,
        plan.pressureWindowName,
      );
    }
    // A failed command can still have delivered SIGCONT to only part of the
    // pane process tree. Mark the attempt before I/O so finally always drives
    // the exact tree back to STOP before outer cleanup.
    continueAttempted = true;
    await signalExactRuntime(
      commandExecutor,
      taskId,
      'CONT',
      originalPaneIdentity,
    );
    await freshPage.locator('.xterm').click();
    await freshPage.keyboard.insertText(plan.prompt);
    const writtenInput = () =>
      Buffer.concat(
        restartEvents
          .slice(inputEventOffset)
          .filter(
            (event) =>
              event.type === 'provider_write' &&
              event.source === 'keystroke' &&
              event.attachmentId === freshAttachmentId &&
              event.outcome === 'written',
          )
          .map((event) => Buffer.from(event.bytesBase64, 'base64')),
      );
    await waitForCondition(
      () => writtenInput().indexOf(expectedPrompt) !== -1,
      10_000,
      `${runtimeId} pressure prompt did not fully cross the CAP Gateway`,
    );
    if (plan.submitFlushKey === 'ArrowRight') {
      const bytesBeforeFlush = writtenInput().byteLength;
      await freshPage.keyboard.press('ArrowRight');
      await waitForCondition(
        () => writtenInput().byteLength > bytesBeforeFlush,
        10_000,
        `${runtimeId} pressure paste-burst flush key did not cross the CAP Gateway`,
      );
      // Claude treats a non-character key after a rapid text burst as the
      // explicit flush boundary. ArrowRight is a no-op at the end of the
      // composer, but it forces the complete prompt to settle before Enter.
      await delay(50);
    } else {
      // Codex 0.144.1 clears its paste burst on the bounded TUI tick.
      await delay(200);
    }
    await freshPage.keyboard.press('Enter');

    await waitForCondition(
      () => {
        const written = writtenInput();
        const promptOffset = written.indexOf(expectedPrompt);
        return (
          promptOffset !== -1 &&
          written.indexOf(0x0d, promptOffset + expectedPrompt.byteLength) !== -1
        );
      },
      10_000,
      `${runtimeId} real CLI pressure input did not cross the CAP Gateway`,
    );
    let freshBegin;
    try {
      freshBegin = await waitForGatewayWireMarker(
        freshWire,
        plan.beginMarker,
        freshMarkerSearchOffset,
        30_000,
      );
    } catch (error) {
      const [probe, tmuxSource] = await Promise.all([
        readStoryProbe(freshPage),
        captureTmuxPaneSnapshot(commandExecutor, taskId),
      ]);
      throw new Error(
        `${runtimeId} received the complete pressure command but did not execute it: ${JSON.stringify(
          {
            browserWire: {
              rawBytes: freshWire.rawBytes,
              rawFrames: freshWire.rawFrames,
              rawCaptureOverflow: freshWire.rawCaptureOverflow,
            },
            browser: {
              canonicalScreenSha256: sha256(probe.canonicalScreen),
              terminalTextTail: probe.terminalText.slice(-2_000),
            },
            tmux: {
              sha256: tmuxSource.digest,
              outputTail: tmuxSource.output.slice(-4_000),
            },
          },
        )}`,
        { cause: error },
      );
    }
    if (plan.pressureWindowName) {
      pressurePaneIdentity = await readExactPressurePaneIdentity({
        commandExecutor,
        taskId,
        pressureWindowName: plan.pressureWindowName,
        originalPaneIdentity,
      });
    }

    const pressureWireCountBefore = wireConnections.length;
    const pressureEventOffset = restartEvents.length;
    const pressureCleanupOffset = viewerCleanupRecords.length;
    const pressurePageStartedAt = Date.now();
    pressurePage = await context.newPage();
    pages.add(pressurePage);
    await suppressBrowserTakeoverRequests(pressurePage);
    await pressurePage.goto(storyUrl, { waitUntil: 'load' });
    await waitForCondition(
      () => wireConnections.length === pressureWireCountBefore + 1,
      10_000,
      `${runtimeId} pressure CAP viewer did not open exactly one wire`,
    );
    pressureWire = wireConnections.at(-1);
    assert(pressureWire, `${runtimeId} pressure CAP viewer wire was missing`);
    await waitForCondition(
      () => pressureWire.rawTimeline.length > 0,
      10_000,
      `${runtimeId} pressure CAP viewer received no first redraw byte`,
    );
    const firstOutputAt = pressureWire.rawTimeline[0].at;

    await waitForCondition(
      () =>
        restartEvents
          .slice(pressureEventOffset)
          .filter((event) => event.type === 'viewer_opened').length === 1,
      10_000,
      `${runtimeId} pressure CAP viewer identity was not opened`,
    );
    const pressureOpened = restartEvents
      .slice(pressureEventOffset)
      .find((event) => event.type === 'viewer_opened');
    pressureAttachmentId = pressureOpened?.attachmentId ?? null;
    assert(
      pressureAttachmentId && pressureAttachmentId !== freshAttachmentId,
      `${runtimeId} pressure CAP viewer reused the writer attachment identity`,
    );
    assert(
      viewerCleanupRecords.length === pressureCleanupOffset + 1,
      `${runtimeId} pressure CAP viewer did not allocate one cleanup identity`,
    );
    pressureCleanupRecord = viewerCleanupRecords[pressureCleanupOffset];

    await waitForCondition(
      () =>
        restartEvents.slice(pressureEventOffset).some(
          (event) =>
            event.type === 'attachment_state' &&
            event.attachmentId === pressureAttachmentId &&
            event.state === 'ready',
        ),
      10_000,
      `${runtimeId} pressure CAP viewer did not reach ready`,
    );
    const readyEvent = restartEvents.slice(pressureEventOffset).find(
      (event) =>
        event.type === 'attachment_state' &&
        event.attachmentId === pressureAttachmentId &&
        event.state === 'ready',
    );
    const readyAt = readyEvent?.observedAt ?? 0;
    assert(
      readyAt >= firstOutputAt,
      `${runtimeId} pressure CAP viewer became ready before its first byte`,
    );
    const bytesAtReady = pressureWire.rawBytes;
    const chunksAtReady = pressureWire.rawFrames;
    const preReadyOutput = gatewayWireOutputGapEvidence(
      pressureWire,
      firstOutputAt,
      readyAt,
    );

    let domRevealed = false;
    await waitForCondition(
      async () => {
        const status = pressurePage.locator(
          '[data-testid="terminal-attachment-status"]',
        );
        if ((await status.count()) > 0 && (await status.isVisible())) {
          return false;
        }
        const xterm = pressurePage.locator('.xterm');
        if ((await xterm.count()) !== 1 || !(await xterm.isVisible())) {
          return false;
        }
        domRevealed = await xterm.evaluate((element) => {
          let current = element;
          while (current) {
            if (current.classList?.contains('opacity-100')) return true;
            current = current.parentElement;
          }
          return false;
        });
        return domRevealed;
      },
      maxSettleMs + 1_000,
      `${runtimeId} pressure CAP viewer did not reveal production xterm`,
    );
    const domRevealedAt = Date.now();
    let pressureProbeBeforeScreenshot = null;
    await waitForCondition(
      async () => {
        pressureProbeBeforeScreenshot = await readStoryProbe(pressurePage);
        return (
          pressureProbeBeforeScreenshot.canonicalScreen.length > 0 &&
          maxPressureSequence(
            pressureProbeBeforeScreenshot.terminalText,
            plan.lineMarkerPrefix,
          ) >= 0
        );
      },
      3_000,
      `${runtimeId} pressure CAP viewer revealed no real pressure output`,
    );
    assert(
      gatewayWireRawBuffer(freshWire)
        .indexOf(
          Buffer.from(plan.endMarker, 'utf8'),
          freshBegin.offset + plan.beginMarker.length,
        ) === -1,
      `${runtimeId} pressure command ended before dynamic browser evidence`,
    );

    const dynamicScreenshotPath = join(
      CAP_STORY_ARTIFACT_DIR,
      `${artifactBase}-continuous-output.png`,
    );
    await pressurePage.locator('h1').click();
    await delay(40);
    pressureProbeBeforeScreenshot = await readStoryProbe(pressurePage);
    const rawBytesAtScreenshot = pressureWire.rawBytes;
    const sequenceBeforeScreenshot = maxPressureSequence(
      pressureProbeBeforeScreenshot.terminalText,
      plan.lineMarkerPrefix,
    );
    assert(
      sequenceBeforeScreenshot >= 0,
      `${runtimeId} pressure output left xterm before screenshot capture`,
    );
    const dynamicScreenshot = await pressurePage
      .locator('[data-testid="terminal-surface"]')
      .screenshot({ animations: 'disabled', path: dynamicScreenshotPath });
    assert(
      dynamicScreenshot.byteLength > 1_000,
      `${runtimeId} pressure CAP viewer screenshot was blank`,
    );
    const dynamicScreenshotObservedAt = Date.now();
    assert(
      gatewayWireRawBuffer(freshWire)
        .indexOf(
          Buffer.from(plan.endMarker, 'utf8'),
          freshBegin.offset + plan.beginMarker.length,
        ) === -1,
      `${runtimeId} pressure command ended during dynamic screenshot capture`,
    );
    const pressureProbeAfterScreenshot = await readStoryProbe(pressurePage);
    const screenshotPressureSequence = Math.max(
      sequenceBeforeScreenshot,
      maxPressureSequence(
        pressureProbeAfterScreenshot.terminalText,
        plan.lineMarkerPrefix,
      ),
    );
    let postScreenshotPressureSequence = screenshotPressureSequence;
    await waitForCondition(
      async () => {
        const probe = await readStoryProbe(pressurePage);
        postScreenshotPressureSequence = maxPressureSequence(
          probe.terminalText,
          plan.lineMarkerPrefix,
        );
        return (
          pressureWire.rawBytes > rawBytesAtScreenshot &&
          postScreenshotPressureSequence > screenshotPressureSequence
        );
      },
      5_000,
      `${runtimeId} pressure CAP xterm did not advance after its screenshot`,
    );
    const postScreenshotBytes =
      pressureWire.rawBytes - rawBytesAtScreenshot;
    const dynamicScreenshotDuringOutput =
      postScreenshotBytes > 0 &&
      postScreenshotPressureSequence > screenshotPressureSequence;

    const visualChanges = [];
    let previousVisualHash = null;
    const sampleVisualState = async () => {
      const probe = await readStoryProbe(pressurePage);
      if (probe.canonicalScreen.length === 0) return;
      const hash = sha256(probe.canonicalScreen);
      if (hash !== previousVisualHash) {
        visualChanges.push({ at: Date.now(), sha256: hash });
        previousVisualHash = hash;
      }
    };
    await sampleVisualState();
    const endMarkerBytes = Buffer.from(plan.endMarker, 'utf8');
    const endSearchOffset = freshBegin.offset + plan.beginMarker.length;
    const endDeadline = Date.now() + 45_000;
    let freshEnd = null;
    while (!freshEnd && Date.now() < endDeadline) {
      await delay(100);
      await sampleVisualState();
      const offset = gatewayWireRawBuffer(freshWire).indexOf(
        endMarkerBytes,
        endSearchOffset,
      );
      if (offset !== -1) freshEnd = { offset, observedAt: Date.now() };
    }
    assert(
      freshEnd,
      `${runtimeId} pressure CAP writer did not emit its end marker`,
    );
    const pressureEnd = await waitForGatewayWireMarker(
      pressureWire,
      plan.endMarker,
      0,
      10_000,
    );
    if (plan.pressureWindowName) {
      await waitForPressureWindowExitAndOriginalRestore({
        commandExecutor,
        taskId,
        pressureWindowName: plan.pressureWindowName,
        originalPaneIdentity,
      });
      pressureWindowLifecycle = {
        kind: 'temporary-window',
        windowName: plan.pressureWindowName,
        originalPaneIdentity,
        pressurePaneIdentity,
        pressureWindowAbsentAfterEnd: true,
        originalPaneRestoredAfterEnd: true,
      };
    } else {
      pressureWindowLifecycle = { kind: 'not-applicable' };
    }
    const freshEndOffset =
      freshEnd.offset + Buffer.byteLength(plan.endMarker, 'utf8');
    const visualChangeSpanMs =
      visualChanges.length > 1
        ? visualChanges.at(-1).at - visualChanges[0].at
        : 0;

    evidence = {
      surface: 'cap',
      runtimeId,
      observed: true,
      actualInteractiveCli: true,
      outputSource: 'cap-writer-viewer-pty',
      commandExecution:
        `${plan.outputMode} through CAP writer`,
      beginMarkerObserved: true,
      endMarkerObserved: true,
      requestedLineCount: plan.lineCount,
      requestedLineDelayMs: Math.round(plan.lineDelaySeconds * 1_000),
      observedOutputBytes: freshEndOffset - freshBegin.offset,
      observedOutputChunks: gatewayWireChunkCountInRange(
        freshWire,
        freshBegin.offset,
        freshEndOffset,
      ),
      browserWriterOutputBytes: freshEndOffset - freshBegin.offset,
      browserWriterOutputChunks: gatewayWireChunkCountInRange(
        freshWire,
        freshBegin.offset,
        freshEndOffset,
      ),
      durationMs: freshEnd.observedAt - freshBegin.observedAt,
      attachmentReadyMs: readyAt - pressurePageStartedAt,
      revealSettleMs: readyAt - firstOutputAt,
      quietWithinOneSecond: preReadyOutput.maxGapMs >= 1_000,
      preReadyTimelineComplete: preReadyOutput.complete,
      preReadyOutputEvents: preReadyOutput.eventCount,
      preReadyMaxGapMs: preReadyOutput.maxGapMs,
      wireContinuousBeforeReady:
        preReadyOutput.maxGapMs < quietMs,
      hardDeadlineTimingObserved:
        readyAt - firstOutputAt >= maxSettleMs - 250,
      quietThresholdMs: quietMs,
      maxSettleMs,
      postReadyBytes: pressureWire.rawBytes - bytesAtReady,
      postReadyChunks: pressureWire.rawFrames - chunksAtReady,
      browserInputViaGateway: true,
      writerAttachmentId: freshAttachmentId,
      pressureAttachmentId,
      domRevealed,
      domRevealMs: domRevealedAt - firstOutputAt,
      dynamicScreenshotPath: relativeProviderStoryArtifactPath(
        dynamicScreenshotPath,
      ),
      dynamicScreenshotSha256: sha256(dynamicScreenshot),
      dynamicScreenshotBytes: dynamicScreenshot.byteLength,
      dynamicScreenshotDuringOutput,
      dynamicScreenshotObservedAt,
      screenshotPressureSequence,
      postScreenshotPressureSequence,
      postScreenshotBytes,
      visualStateChanges: Math.max(0, visualChanges.length - 1),
      visualChangeSpanMs,
      pressureEndObservedAt: pressureEnd.observedAt,
      pressureWindowLifecycle,
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupFailures = [];
  if (plan.pressureWindowName && originalPaneIdentity) {
    try {
      await cleanupExactPressureWindow({
        commandExecutor,
        taskId,
        pressureWindowName: plan.pressureWindowName,
      });
      if (evidence) evidence.pressureWindowCleanupConfirmed = true;
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await waitForPressureWindowExitAndOriginalRestore({
        commandExecutor,
        taskId,
        pressureWindowName: plan.pressureWindowName,
        originalPaneIdentity,
      });
      if (evidence) evidence.originalPaneRestoredAtCleanup = true;
    } catch (error) {
      cleanupFailures.push(error);
    }
  } else if (evidence) {
    evidence.pressureWindowCleanupConfirmed = null;
    evidence.originalPaneRestoredAtCleanup = true;
  }
  if (continueAttempted) {
    try {
      await signalExactRuntime(
        commandExecutor,
        taskId,
        'STOP',
        originalPaneIdentity,
      );
      const stoppedSourceSha256 = await waitForTmuxPaneStable(
        commandExecutor,
        taskId,
        1_000,
        5_000,
        originalPaneIdentity,
      );
      const stoppedSource = await captureTmuxPaneSnapshot(
        commandExecutor,
        taskId,
        originalPaneIdentity,
      );
      assert(
        stoppedSource.output.trim().length > 0 &&
          stoppedSource.digest === stoppedSourceSha256,
        `${runtimeId} pressure tmux source was blank or unstable after exact STOP`,
      );
      if (evidence) {
        evidence.stoppedSourceSha256 = stoppedSource.digest;
        evidence.originalPaneStopConfirmed = true;
        evidence.originalPaneStableAfterStop = true;
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (pressurePage) {
    try {
      if (!pressurePage.isClosed()) await pressurePage.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    pages.delete(pressurePage);
  }
  if (pressureAttachmentId) {
    try {
      await waitForCondition(
        () =>
          restartGateway.getProviderTerminalStoryResourceState(taskId)
            .activeViewerCount === 1,
        15_000,
        `${runtimeId} pressure CAP viewer did not close`,
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  let pressureViewerCleanup = null;
  if (pressureCleanupRecord) {
    try {
      pressureViewerCleanup = await withTimeout(
        pressureCleanupRecord.decision,
        providerCleanupSettlementTimeoutMs,
        `${runtimeId} pressure CAP viewer cleanup timed out`,
      );
      assert(
        pressureViewerCleanup.kind === 'confirmed',
        `${runtimeId} pressure CAP viewer cleanup was not confirmed`,
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await waitForTmuxClientCount(
      commandExecutor,
      taskId,
      providerTmuxClientBaseline + 1,
      providerCleanupSettlementTimeoutMs,
    );
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (evidence) evidence.pressureViewerCleanup = pressureViewerCleanup;

  if (primaryError && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupFailures],
      `${runtimeId} CAP pressure and cleanup failed`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      `${runtimeId} CAP pressure cleanup failed`,
    );
  }
  assert(evidence, `${runtimeId} CAP pressure produced no evidence`);
  assertRealCliContinuousOutputEvidence(evidence);
  return evidence;
}

function assertExactTerminalResponseCorrelation(events, runtimeId) {
  const activeClasses = new Set(
    XTERM_5_5_0_RESPONSE_PROFILE_DESCRIPTOR.responseClasses,
  );
  const queries = events.filter((event) => event.type === 'query');
  const responses = events.filter((event) => event.type === 'response');
  const responseWrites = events.filter(
    (event) =>
      event.type === 'provider_write' &&
      event.source === 'terminal_response',
  );
  const admittedQueries = queries.filter((event) => event.admitted);
  const profileDisabledQueries = queries.filter(
    (event) => !event.admitted && !activeClasses.has(event.responseClass),
  );
  const rejectedActiveQueries = queries.filter(
    (event) => !event.admitted && activeClasses.has(event.responseClass),
  );
  const rejectedResponses = responses.filter((event) => !event.accepted);
  const acceptedResponses = responses.filter((event) => event.accepted);

  assert(
    rejectedActiveQueries.length === 0,
    `${runtimeId} CAP story rejected an active-profile terminal query`,
  );
  assert(
    rejectedResponses.length === 0,
    `${runtimeId} CAP story observed a rejected browser terminal response`,
  );
  assert(
    responseWrites.every((event) => event.outcome === 'written'),
    `${runtimeId} CAP story observed a non-written terminal response`,
  );
  assert(
    admittedQueries.every(
      (event) =>
        Number.isSafeInteger(event.queryId) &&
        event.queryId > 0 &&
        activeClasses.has(event.responseClass),
    ),
    `${runtimeId} CAP story admitted a query without an active-profile identity`,
  );

  const queryCounts = countInventoryBy(
    admittedQueries,
    (event) =>
      `${terminalInventoryAttachmentKey(event)}\u0000${event.responseClass}`,
  );
  const responseCounts = countInventoryBy(
    acceptedResponses,
    (event) =>
      `${terminalInventoryAttachmentKey(event)}\u0000${event.responseClass ?? ''}`,
  );
  assertCountMapsEqual(
    queryCounts,
    responseCounts,
    `${runtimeId} active query/browser response`,
  );

  const acceptedBytes = countInventoryBy(
    acceptedResponses,
    (event) =>
      `${terminalInventoryAttachmentKey(event)}\u0000${event.bytesBase64}`,
  );
  const providerWriteBytes = countInventoryBy(
    responseWrites,
    (event) =>
      `${terminalInventoryAttachmentKey(event)}\u0000${event.bytesBase64}`,
  );
  assertCountMapsEqual(
    acceptedBytes,
    providerWriteBytes,
    `${runtimeId} browser response/provider write`,
  );

  const uniqueQueryIds = new Set(
    admittedQueries.map(
      (event) => `${terminalInventoryAttachmentKey(event)}\u0000${event.queryId}`,
    ),
  );
  assert(
    uniqueQueryIds.size === admittedQueries.length,
    `${runtimeId} CAP story reused an admitted query identity`,
  );
  assert(
    admittedQueries.length > 0 &&
      acceptedResponses.length === admittedQueries.length &&
      responseWrites.length === admittedQueries.length,
    `${runtimeId} CAP story did not correlate every active-profile query exactly once`,
  );

  const disabledClassCounts = Object.fromEntries(
    [...countInventoryBy(
      profileDisabledQueries,
      (event) => event.responseClass,
    ).entries()].sort(([first], [second]) => first.localeCompare(second)),
  );
  const observedActiveClassCounts = Object.fromEntries(
    [...countInventoryBy(
      admittedQueries,
      (event) => event.responseClass,
    ).entries()].sort(([first], [second]) => first.localeCompare(second)),
  );
  return {
    profileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
    profileFingerprint: XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT,
    activeProfileClasses: [...activeClasses],
    observedActiveClassCounts,
    profileDisabledNoResponseClassCounts: disabledClassCounts,
    admittedQueryCount: admittedQueries.length,
    acceptedBrowserResponseCount: acceptedResponses.length,
    writtenProviderResponseCount: responseWrites.length,
    rejectedActiveQueryCount: 0,
    rejectedResponseCount: 0,
    exactOnce: true,
  };
}

function terminalInventoryAttachmentKey(event) {
  return `${event.gatewayEpoch ?? 'unknown'}\u0000${event.attachmentId}`;
}

function countInventoryBy(entries, keyOf) {
  const counts = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function assertCountMapsEqual(first, second, label) {
  const keys = new Set([...first.keys(), ...second.keys()]);
  for (const key of keys) {
    assert(
      (first.get(key) ?? 0) === (second.get(key) ?? 0),
      `${label} count mismatch for ${JSON.stringify(key)}`,
    );
  }
}

function observeGatewayWireFrame(wire, direction, raw) {
  let frame;
  try {
    frame = JSON.parse(
      typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'),
    );
  } catch {
    return;
  }
  if (!frame || typeof frame !== 'object') return;
  if (
    direction === 'outbound' &&
    frame.channel === 'raw' &&
    typeof frame.data === 'string'
  ) {
    const bytes = Buffer.from(frame.data, 'base64');
    const startedAt = wire.rawBytes;
    wire.rawBytes += bytes.byteLength;
    wire.rawFrames += 1;
    if (wire.rawBytes <= MAX_CAPTURE_BYTES && wire.rawTimeline.length < 65_536) {
      wire.rawChunks.push(bytes);
      wire.rawTimeline.push({
        at: Date.now(),
        startOffset: startedAt,
        endOffset: wire.rawBytes,
      });
    } else {
      wire.rawCaptureOverflow = true;
    }
    return;
  }
  if (frame.channel !== 'control' || typeof frame.type !== 'string') return;
  const target =
    direction === 'inbound'
      ? wire.inboundControlTypes
      : wire.outboundControlTypes;
  target.push(frame.type);
}

function gatewayWireRawBuffer(wire) {
  return Buffer.concat(wire.rawChunks);
}

async function waitForGatewayWireMarker(
  wire,
  marker,
  startOffset,
  timeoutMs,
) {
  const markerBytes = Buffer.from(marker, 'utf8');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const offset = gatewayWireRawBuffer(wire).indexOf(markerBytes, startOffset);
    if (offset !== -1) return { offset, observedAt: Date.now() };
    await delay(25);
  }
  throw new Error(`CAP browser wire did not contain real CLI marker ${marker}`);
}

function gatewayWireOutputGapEvidence(wire, startedAt, endedAt) {
  const times = wire.rawTimeline
    .filter((entry) => entry.at >= startedAt && entry.at <= endedAt)
    .map((entry) => entry.at);
  let previousAt = startedAt;
  let maxGapMs = 0;
  for (const at of times) {
    maxGapMs = Math.max(maxGapMs, at - previousAt);
    previousAt = at;
  }
  maxGapMs = Math.max(maxGapMs, endedAt - previousAt);
  return {
    complete: !wire.rawCaptureOverflow,
    eventCount: times.length,
    maxGapMs,
  };
}

function gatewayWireChunkCountInRange(wire, startOffset, endOffset) {
  return wire.rawTimeline.filter(
    (entry) =>
      entry.endOffset > startOffset && entry.startOffset < endOffset,
  ).length;
}

function maxPressureSequence(text, markerPrefix) {
  let max = -1;
  let searchOffset = 0;
  while (searchOffset < text.length) {
    const markerOffset = text.indexOf(markerPrefix, searchOffset);
    if (markerOffset === -1) break;
    const digitsOffset = markerOffset + markerPrefix.length;
    const digits = text.slice(digitsOffset, digitsOffset + 4);
    if (/^\d{4}$/u.test(digits) && text[digitsOffset + 4] === '_') {
      max = Math.max(max, Number(digits));
    }
    searchOffset = markerOffset + markerPrefix.length;
  }
  return max;
}

function rawToBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw.map((chunk) => Buffer.from(chunk)));
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return Buffer.from(raw);
}

function hasCorrelatedTerminalResponse(events, attachmentId) {
  return (
    events.some(
      (event) =>
        event.type === 'query' &&
        event.attachmentId === attachmentId &&
        event.admitted === true,
    ) &&
    events.some(
      (event) =>
        event.type === 'response' &&
        event.attachmentId === attachmentId &&
        event.accepted === true,
    ) &&
    events.some(
      (event) =>
        event.type === 'provider_write' &&
        event.attachmentId === attachmentId &&
        event.source === 'terminal_response' &&
        event.outcome === 'written',
    )
  );
}

async function waitForNativeStoryProbe(
  page,
  taskId,
  runtimeId,
  label,
) {
  let observed = null;
  await waitForCondition(
    async () => {
      observed = await readStoryProbe(page);
      return (
        observed.mode === 'external' &&
        observed.external === true &&
        observed.status === 'running' &&
        observed.sessionId === taskId &&
        observed.canonicalScreen.length > 0 &&
        runtimeVisible(observed.terminalText, runtimeId)
      );
    },
    45_000,
    `${runtimeId} ${label} did not render the native CLI`,
  );
  return observed;
}

async function suppressBrowserTakeoverRequests(page) {
  await page.addInitScript(() => {
    const originalSend = WebSocket.prototype.send;
    Object.defineProperty(window, '__capSuppressedTakeovers', {
      value: 0,
      writable: true,
      configurable: true,
    });
    WebSocket.prototype.send = function patchedSend(data) {
      if (typeof data === 'string') {
        try {
          const frame = JSON.parse(data);
          if (
            frame?.channel === 'control' &&
            frame?.type === 'takeover_request'
          ) {
            window.__capSuppressedTakeovers += 1;
            return;
          }
        } catch {
          // Preserve every non-JSON or unrelated production frame unchanged.
        }
      }
      return originalSend.call(this, data);
    };
  });
}

async function waitForStableStoryProbe(
  page,
  taskId,
  runtimeId,
  label,
) {
  let previous = null;
  let stableSince = 0;
  let observed = null;
  await waitForCondition(
    async () => {
      observed = await readStoryProbe(page);
      if (
        observed.sessionId !== taskId ||
        !runtimeVisible(observed.terminalText, runtimeId) ||
        observed.canonicalScreen.length === 0
      ) {
        previous = null;
        stableSince = 0;
        return false;
      }
      const digest = sha256(observed.canonicalScreen);
      if (digest !== previous) {
        previous = digest;
        stableSince = Date.now();
        return false;
      }
      return Date.now() - stableSince >= 750;
    },
    20_000,
    `${runtimeId} ${label} did not reach a stable canonical screen`,
  );
  return observed;
}

async function waitForMatchingStoryProbes({
  firstPage,
  secondPage,
  taskId,
  runtimeId,
}) {
  let first = null;
  let second = null;
  let matchingDigest = null;
  let matchingSince = 0;
  try {
    await waitForCondition(
      async () => {
        [first, second] = await Promise.all([
          readStoryProbe(firstPage),
          readStoryProbe(secondPage),
        ]);
        if (
          first.sessionId !== taskId ||
          second.sessionId !== taskId ||
          !runtimeVisible(first.terminalText, runtimeId) ||
          !runtimeVisible(second.terminalText, runtimeId) ||
          first.canonicalScreen.length === 0 ||
          second.canonicalScreen.length === 0 ||
          first.canonicalScreen !== second.canonicalScreen
        ) {
          matchingDigest = null;
          matchingSince = 0;
          return false;
        }
        const digest = sha256(first.canonicalScreen);
        if (digest !== matchingDigest) {
          matchingDigest = digest;
          matchingSince = Date.now();
          return false;
        }
        return Date.now() - matchingSince >= 750;
      },
      20_000,
      `${runtimeId} simultaneous CAP viewers did not converge`,
    );
  } catch (error) {
    throw new Error(
      `${runtimeId} simultaneous CAP viewers did not converge: ${JSON.stringify({
        firstSessionId: first?.sessionId ?? null,
        secondSessionId: second?.sessionId ?? null,
        firstScreenSha256: first?.canonicalScreen
          ? sha256(first.canonicalScreen)
          : null,
        secondScreenSha256: second?.canonicalScreen
          ? sha256(second.canonicalScreen)
          : null,
        difference:
          first?.canonicalScreen && second?.canonicalScreen
            ? compareSerializedScreens(
                first.canonicalScreen,
                second.canonicalScreen,
              )
            : null,
      })}`,
      { cause: error },
    );
  }
  return { first, second };
}

async function readStoryProbe(page) {
  const text = await page
    .locator('[data-testid="provider-story-probe"]')
    .textContent();
  assert(text, 'provider story probe was missing');
  return JSON.parse(text);
}

export async function createAioTerminalFaultRelay(upstreamUrl) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const pairs = new Map();
  let totalConnections = 0;
  let inputFrames = 0;
  let attachCommands = 0;
  let newSessionCommands = 0;
  let closing = false;
  let closePromise = null;

  const terminate = (socket) => {
    if (!socket) return;
    try {
      socket.terminate();
    } catch {
      // A peer may have completed its close concurrently.
    }
  };

  const closeGracefully = (socket) => {
    if (!socket) return;
    try {
      if (socket.readyState === NodeWebSocket.OPEN) {
        socket.close(1000, 'relay peer closed');
      } else if (socket.readyState === NodeWebSocket.CONNECTING) {
        // There is no close handshake to preserve before the upstream opened.
        socket.terminate();
      }
    } catch {
      terminate(socket);
    }
  };

  const observeInput = (raw, isBinary) => {
    if (isBinary) return;
    let frame;
    try {
      frame = JSON.parse(rawToBuffer(raw).toString('utf8'));
    } catch {
      return;
    }
    if (frame?.type !== 'input' || typeof frame.data !== 'string') return;
    inputFrames += 1;
    if (frame.data.includes('tmux -u new-session')) newSessionCommands += 1;
    if (/\battach(?:-session)?\b/u.test(frame.data)) attachCommands += 1;
  };

  wss.on('connection', (downstream) => {
    const id = ++totalConnections;
    const upstream = new NodeWebSocket(upstreamUrl);
    const queued = [];
    let queuedBytes = 0;
    let pairClosed = false;
    const pair = { id, downstream, upstream, abort: null };
    pairs.set(id, pair);

    const closeFromDownstream = () => {
      if (pairClosed) return;
      pairClosed = true;
      pairs.delete(id);
      closeGracefully(upstream);
    };
    const closeFromUpstream = () => {
      if (pairClosed) return;
      pairClosed = true;
      pairs.delete(id);
      closeGracefully(downstream);
    };
    const abortPair = () => {
      if (pairClosed) return;
      pairClosed = true;
      pairs.delete(id);
      terminate(downstream);
      terminate(upstream);
    };
    pair.abort = abortPair;

    downstream.on('message', (raw, isBinary) => {
      observeInput(raw, isBinary);
      if (upstream.readyState === NodeWebSocket.OPEN) {
        upstream.send(raw, { binary: isBinary });
        return;
      }
      const bytes = rawToBuffer(raw).byteLength;
      queuedBytes += bytes;
      if (queuedBytes > 64 * 1024) {
        abortPair();
        return;
      }
      queued.push({ raw, isBinary });
    });
    downstream.once('close', closeFromDownstream);
    downstream.once('error', abortPair);

    upstream.once('open', () => {
      for (const message of queued.splice(0)) {
        if (upstream.readyState !== NodeWebSocket.OPEN) break;
        upstream.send(message.raw, { binary: message.isBinary });
      }
      queuedBytes = 0;
    });
    upstream.on('message', (raw, isBinary) => {
      if (downstream.readyState === NodeWebSocket.OPEN) {
        downstream.send(raw, { binary: isBinary });
      }
    });
    upstream.once('close', closeFromUpstream);
    upstream.once('error', abortPair);
  });

  await waitForWebSocketServer(wss);
  const address = wss.address();
  assert(
    address && typeof address === 'object',
    'AIO terminal fault relay did not expose a local address',
  );

  return {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    snapshot() {
      return {
        activeConnections: pairs.size,
        totalConnections,
        inputFrames,
        attachCommands,
        newSessionCommands,
      };
    },
    async waitForActiveConnections(expected, timeoutMs = 15_000) {
      await waitForCondition(
        () => pairs.size === expected,
        timeoutMs,
        `AIO terminal fault relay did not reach ${expected} active connections`,
      );
    },
    dropActiveOwnerGeneration() {
      const active = [...pairs.values()];
      assert(
        active.length === 2,
        `AIO owner fault expected exactly two active transport sockets, got ${active.length}`,
      );
      for (const pair of active) {
        pair.abort();
      }
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        for (const pair of [...pairs.values()]) {
          pair.abort();
        }
        pairs.clear();
        await closeWebSocketServer(wss);
      })();
      return closePromise;
    },
    get closing() {
      return closing;
    },
  };
}

async function verifyAioOwnerTransportDrop({
  relay,
  ownerCapture,
  ownerRecoveryEvents,
  commandExecutor,
  runtimeId,
  taskId,
}) {
  await relay.waitForActiveConnections(2);
  const relayBefore = relay.snapshot();
  const eventOffset = ownerRecoveryEvents.length;
  const outputBytesBefore = ownerCapture.byteLength;
  const producerBefore = ownerCapture.producerEvidence();
  const panePidBefore = await readExactTmuxPanePid(commandExecutor, taskId);
  const startedAt = Date.now();

  relay.dropActiveOwnerGeneration();

  await waitForCondition(
    () =>
      ownerRecoveryEvents
        .slice(eventOffset)
        .some((event) => event.kind === 'restored'),
    20_000,
    `${runtimeId} owner transport did not restore after a real socket drop`,
  );
  await relay.waitForActiveConnections(2);
  await ownerCapture.waitForAdditionalOutput(outputBytesBefore, 15_000);
  await ownerCapture.waitForNativeTui(runtimeId, 15_000);

  const recoveryEvents = ownerRecoveryEvents.slice(eventOffset);
  const restored = recoveryEvents.find((event) => event.kind === 'restored');
  assert(
    recoveryEvents.some((event) => event.kind === 'outage') && restored,
    `${runtimeId} owner recovery telemetry missed its outage/restored boundary`,
  );
  assert(
    !recoveryEvents.some((event) => event.kind === 'failed'),
    `${runtimeId} owner recovery reported failure after restoring`,
  );

  // Probe producer eligibility before issuing the slower remote process and
  // tmux inventory checks below. Measuring after those checks incorrectly
  // charged their HTTP/SSH latency to the attach-bootstrap settle window even
  // though the owner transport had already recovered.
  await waitForCondition(
    () =>
      ownerCapture.producerEvidence().attachBootstrapChunks >
      producerBefore.attachBootstrapChunks,
    3_000,
    `${runtimeId} owner recovery emitted no producer-ineligible redraw frame`,
  );
  const producerAfterBootstrap = ownerCapture.producerEvidence();
  const attachBootstrapChunks =
    producerAfterBootstrap.attachBootstrapChunks -
    producerBefore.attachBootstrapChunks;
  const attachBootstrapBytes =
    producerAfterBootstrap.attachBootstrapBytes -
    producerBefore.attachBootstrapBytes;
  assert(
    attachBootstrapChunks > 0 && attachBootstrapBytes > 0,
    `${runtimeId} owner recovery did not mark its redraw producer-ineligible`,
  );
  assert(
    await ownerCapture.waitForQuiet(350, 3_000),
    `${runtimeId} owner recovery redraw never reached its bounded settle window`,
  );
  const eligibleChunksBefore =
    ownerCapture.producerEvidence().eligibleChunks;
  const eligibleBytesBefore = ownerCapture.producerEvidence().eligibleBytes;
  const resumeOutputBytesBefore = ownerCapture.byteLength;
  const resumeProbeStartedAt = Date.now();
  ownerCapture.writeText('\x0c');
  await ownerCapture.waitForAdditionalOutput(resumeOutputBytesBefore, 5_000);
  const eligibleResume = await ownerCapture.waitForProducerEligibleChunkAfter(
    eligibleChunksBefore,
    5_000,
  );
  const producerAfterResume = ownerCapture.producerEvidence();
  const producerSettleDurationMs =
    eligibleResume.at - (restored.observedAt ?? startedAt);
  const producerResumeProbeMs = eligibleResume.at - resumeProbeStartedAt;
  assert(
    producerSettleDurationMs >= 0 && producerSettleDurationMs <= 5_000,
    `${runtimeId} owner producer eligibility did not resume within its bound: ${JSON.stringify({ producerSettleDurationMs, producerResumeProbeMs })}`,
  );
  assert(
    producerResumeProbeMs >= 0 && producerResumeProbeMs <= 5_000,
    `${runtimeId} owner producer resume probe exceeded its bound`,
  );
  assert(
    producerAfterResume.eligibleBytes > eligibleBytesBefore,
    `${runtimeId} owner emitted no eligible bytes after its settle window`,
  );

  const clientSettlementMs = await waitForTmuxClientCount(
    commandExecutor,
    taskId,
    1,
    20_000,
  );
  const panePidAfter = await readExactTmuxPanePid(commandExecutor, taskId);
  assert(
    panePidAfter === panePidBefore,
    `${runtimeId} owner transport recovery replaced the real tmux pane process`,
  );
  await verifyRealCliProcess({ commandExecutor, runtimeId, taskId });

  const relayAfter = relay.snapshot();
  const recoveryAttachCommands =
    relayAfter.attachCommands - relayBefore.attachCommands;
  assert(
    relayAfter.totalConnections >= relayBefore.totalConnections + 2,
    `${runtimeId} owner recovery did not open a fresh AIO main/injector pair`,
  );
  assert(
    relayAfter.newSessionCommands === relayBefore.newSessionCommands,
    `${runtimeId} owner recovery attempted a forbidden tmux relaunch`,
  );
  assert(
    recoveryAttachCommands === 1,
    `${runtimeId} owner recovery did not issue exactly one attach-only input: ${JSON.stringify({ recoveryAttachCommands })}`,
  );
  const wallClockRecoveryMs = Date.now() - startedAt;

  return {
    result: 'PASS',
    injectedFault: 'both AIO owner transport sockets terminated by local relay',
    freshTransportSockets: relayAfter.totalConnections - relayBefore.totalConnections,
    attachOnly: true,
    recoveryAttachCommands,
    relaunchCommandsAfterFault: 0,
    panePidStable: true,
    ownerRedrawObserved: ownerCapture.byteLength > outputBytesBefore,
    outageDurationMs: restored.durationMs,
    ownerAbsentDurationMs: restored.durationMs,
    producerSettleDurationMs,
    producerResumeProbeMs,
    missingByteCount: 'unknown',
    missingByteCountBasis:
      'real interactive CLI output has no independent owner-outage byte oracle',
    producerEligibility: {
      attachBootstrapChunks,
      attachBootstrapBytes,
      eligibleResumeChunks: eligibleResume.chunks,
      eligibleResumeBytes:
        producerAfterResume.eligibleBytes - eligibleBytesBefore,
    },
    wallClockRecoveryMs,
    clientSettlementMs,
    recoveryEvents,
  };
}

async function readExactTmuxPanePid(commandExecutor, taskId) {
  const target = shellQuote(`=${detachedSessionName(taskId)}:`);
  const result = await execStrict(
    commandExecutor,
    `tmux display-message -p -t ${target} '#{pane_pid}'`,
    'exact tmux pane identity probe',
  );
  const value = Number(String(result.output ?? '').trim());
  assert(Number.isSafeInteger(value) && value > 0, 'invalid tmux pane pid');
  return value;
}

async function waitForCondition(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  if (lastError) {
    throw new Error(message, { cause: lastError });
  }
  throw new Error(message);
}

function waitForWebSocketServer(wss) {
  if (wss.address()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
}

function closeWebSocketServer(wss) {
  if (!wss.address()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
}

function restoreEnvironmentValue(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function relativeProviderStoryArtifactPath(absolutePath) {
  return `apps/web/e2e/test-results/provider-terminal-story/${absolutePath
    .split('/')
    .at(-1)}`;
}

async function compareBrowserScreens(firstRaw, secondRaw, cols, rows) {
  const browser = await chromium.launch({ headless: true });
  try {
    const first = await renderBrowserTerminal(browser, firstRaw, cols, rows);
    const second = await renderBrowserTerminal(browser, secondRaw, cols, rows);
    const blank = await renderBrowserTerminal(
      browser,
      Buffer.alloc(0),
      cols,
      rows,
    );
    const firstHash = sha256(first.screenshot);
    const secondHash = sha256(second.screenshot);
    const blankHash = sha256(blank.screenshot);
    assert(
      first.screenshot.equals(second.screenshot),
      `Playwright reconnect screenshots differ: ${firstHash} != ${secondHash}`,
    );
    assert(
      !second.screenshot.equals(blank.screenshot),
      'Playwright reconnect screenshot matched a blank xterm',
    );
    return {
      identical: true,
      nonBlank: true,
      sha256: secondHash,
      blankSha256: blankHash,
    };
  } finally {
    await browser.close();
  }
}

async function renderBrowserTerminal(browser, raw, cols, rows) {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  try {
    await page.setContent(
      '<!doctype html><html><body><div id="terminal"></div></body></html>',
    );
    await page.addStyleTag({ path: xtermBrowserStyle });
    await page.addStyleTag({
      content:
        'html,body{margin:0;background:#0d1117}' +
        '#terminal{display:inline-block;background:#0d1117}' +
        '.xterm{padding:0}',
    });
    await page.addScriptTag({ path: xtermBrowserScript });
    await page.evaluate(
      ({ encoded, terminalCols, terminalRows }) =>
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
          terminal.write(bytes, () => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          });
        }),
      {
        encoded: raw.toString('base64'),
        terminalCols: cols,
        terminalRows: rows,
      },
    );
    const screenshot = await page.locator('#terminal .xterm-screen').screenshot({
      animations: 'disabled',
    });
    return { screenshot };
  } finally {
    await page.close();
  }
}

export async function cleanupRuntimeResources({
  commandExecutor,
  taskId,
  runtimeId,
  runtimeSecurityAdapter,
  provider,
  ownsAioState,
}) {
  assert(
    provider !== 'aio' || ownsAioState,
    'refusing destructive AIO cleanup without isolated-disposable state ownership',
  );
  const failures = [];
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(() =>
    execStrict(
      commandExecutor,
      `tmux kill-session -t ${shellQuote(`=${detachedSessionName(taskId)}`)} 2>/dev/null || true`,
      'exact tmux session cleanup',
    ),
  );
  if (runtimeSecurityAdapter) {
    await attempt(() => runtimeSecurityAdapter.settleCredentialSafety());
  }
  await attempt(() =>
    execStrict(
      commandExecutor,
      runtimeId === 'codex'
        ? 'rm -rf /home/gem/.codex'
        : 'rm -rf /home/gem/.claude /home/gem/.claude.json',
      'runtime credential path cleanup',
    ),
  );
  if (provider === 'boxlite') {
    await attempt(() =>
      execStrict(
        commandExecutor,
        'rm -f /etc/profile.d/cap-real-cli-unauth.sh',
        'unauthenticated profile cleanup',
      ),
    );
  }
  await attempt(() =>
    execStrict(
      commandExecutor,
      `rm -rf -- ${WORKSPACE}`,
      'workspace cleanup',
    ),
  );
  await attempt(async () => {
    const exactProbe = await commandExecutor.exec({
      command: buildExactHasSessionCommand(taskId),
      timeoutMs: 5_000,
    });
    assert(
      exactProbe.exitCode === 1 && !exactProbe.timedOut,
      'exact tmux session remained after cleanup',
    );
  });
  await attempt(() =>
    execStrict(
      commandExecutor,
      runtimeId === 'codex'
        ? 'test ! -e /home/gem/.codex'
        : 'test ! -e /home/gem/.claude && test ! -e /home/gem/.claude.json',
      'runtime credential path absence probe',
    ),
  );
  if (provider === 'boxlite') {
    await attempt(() =>
      execStrict(
        commandExecutor,
        'test ! -e /etc/profile.d/cap-real-cli-unauth.sh',
        'unauthenticated profile absence probe',
      ),
    );
  }
  await attempt(() =>
    execStrict(
      commandExecutor,
      `test ! -e ${WORKSPACE}`,
      'workspace absence probe',
    ),
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'exact runtime cleanup was not confirmed');
  }
  return {
    provider,
    exactTmuxSessionAbsent: true,
    workspaceAbsent: true,
    runtimeCredentialPathsAbsent: true,
    ...(provider === 'boxlite' ? { unauthProfileAbsent: true } : {}),
  };
}

async function waitForExactSession(
  commandExecutor,
  taskId,
  capture,
  runtimeId,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await commandExecutor.exec({
      command: buildExactHasSessionCommand(taskId),
      timeoutMs: 5_000,
    });
    if (result.exitCode === 0) return;
    await delay(100);
  }
  await capture.drain();
  const state = capture.state();
  throw new Error(
    `${runtimeId} exact task tmux session was not created: ${JSON.stringify({
      visibleText: state.visibleText.trim().slice(-2_000),
      bufferType: state.bufferType,
      nonBlankCells: state.nonBlankCells,
      output: capture.outputDiagnostics(),
    })}`,
  );
}

async function assertExactSessionAlive(commandExecutor, taskId) {
  const result = await commandExecutor.exec({
    command: buildExactHasSessionCommand(taskId),
    timeoutMs: 5_000,
  });
  assert(result.exitCode === 0, 'exact task tmux session is not alive');
}

export function parseExactTmuxPaneIdentityOutput(output) {
  const lines = String(output ?? '')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  if (lines.length !== 1) return null;
  const fields = lines[0].split('|');
  if (fields.length !== 8) return null;
  const [
    sessionName,
    windowId,
    paneId,
    panePidText,
    paneTty,
    windowName,
    windowActiveText,
    paneDeadText,
  ] = fields;
  const panePid = Number(panePidText);
  if (!/^[01]$/u.test(windowActiveText) || !/^[01]$/u.test(paneDeadText)) {
    return null;
  }
  const identity = {
    sessionName,
    windowId,
    paneId,
    panePid,
    paneTty,
    windowName,
    windowActive: windowActiveText === '1',
    paneDead: paneDeadText === '1',
  };
  return isExactTmuxPaneIdentityShape(identity) ? identity : null;
}

function isExactTmuxPaneIdentityShape(identity) {
  return Boolean(
    identity &&
      /^[A-Za-z0-9_.-]+$/u.test(identity.sessionName) &&
      /^@[0-9]+$/u.test(identity.windowId) &&
      /^%[0-9]+$/u.test(identity.paneId) &&
      Number.isSafeInteger(identity.panePid) &&
      identity.panePid > 0 &&
      /^\/dev\/pts\/[0-9]+$/u.test(identity.paneTty) &&
      typeof identity.windowName === 'string' &&
      identity.windowName.length > 0 &&
      !/[\u0000-\u001f|]/u.test(identity.windowName) &&
      typeof identity.windowActive === 'boolean' &&
      typeof identity.paneDead === 'boolean',
  );
}

export function parseExactTmuxWindowInventoryOutput(output) {
  const text = String(output ?? '').trim();
  if (text.length === 0) return [];
  const inventory = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(@[0-9]+)\|(.*)\|([01])\|([0-9]+)$/u.exec(line);
    if (!match || match[2].length === 0 || /[\u0000-\u001f]/u.test(match[2])) {
      return null;
    }
    const paneCount = Number(match[4]);
    if (!Number.isSafeInteger(paneCount) || paneCount <= 0) return null;
    inventory.push({
      windowId: match[1],
      windowName: match[2],
      windowActive: match[3] === '1',
      paneCount,
    });
  }
  return inventory;
}

async function readExactTmuxPaneIdentity(
  commandExecutor,
  taskId,
  paneId = null,
) {
  const target = shellQuote(paneId ?? `=${detachedSessionName(taskId)}:`);
  const result = await commandExecutor.exec({
    command:
      `tmux display-message -p -t ${target} ` +
      "'#{session_name}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_tty}|#{window_name}|#{window_active}|#{pane_dead}'",
    timeoutMs: 5_000,
  });
  const identity = parseExactTmuxPaneIdentityOutput(result.output);
  assert(
    result.exitCode === 0 &&
      !result.timedOut &&
      identity &&
      identity.sessionName === detachedSessionName(taskId) &&
      (!paneId || identity.paneId === paneId),
    `exact tmux pane identity could not be resolved: ${JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      paneId,
      outputSha256: sha256(String(result.output ?? '')),
    })}`,
  );
  return identity;
}

async function readExactTmuxWindowInventory(commandExecutor, taskId) {
  const result = await commandExecutor.exec({
    command:
      `tmux list-windows -t ${shellQuote(`=${detachedSessionName(taskId)}`)} ` +
      "-F '#{window_id}|#{window_name}|#{window_active}|#{window_panes}'",
    timeoutMs: 5_000,
  });
  const inventory = parseExactTmuxWindowInventoryOutput(result.output);
  assert(
    result.exitCode === 0 && !result.timedOut && inventory,
    `exact tmux window inventory could not be resolved: ${JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputSha256: sha256(String(result.output ?? '')),
    })}`,
  );
  return inventory;
}

function sameExactTmuxPaneIdentity(first, second) {
  return (
    first?.sessionName === second?.sessionName &&
    first?.windowId === second?.windowId &&
    first?.paneId === second?.paneId &&
    first?.panePid === second?.panePid &&
    first?.paneTty === second?.paneTty
  );
}

async function assertPressureWindowAbsent(
  commandExecutor,
  taskId,
  pressureWindowName,
) {
  const inventory = await readExactTmuxWindowInventory(commandExecutor, taskId);
  assert(
    inventory.every((window) => window.windowName !== pressureWindowName),
    `pressure tmux window already existed: ${pressureWindowName}`,
  );
}

async function readExactPressurePaneIdentity({
  commandExecutor,
  taskId,
  pressureWindowName,
  originalPaneIdentity,
}) {
  const inventory = await readExactTmuxWindowInventory(commandExecutor, taskId);
  const matches = inventory.filter(
    (window) => window.windowName === pressureWindowName,
  );
  assert(
    matches.length === 1 &&
      matches[0].windowActive &&
      matches[0].paneCount === 1,
    `pressure tmux window was not one exact active single-pane window: ${JSON.stringify(
      matches,
    )}`,
  );
  const identity = await readExactTmuxPaneIdentity(commandExecutor, taskId);
  assert(
    identity.windowId === matches[0].windowId &&
      identity.windowName === pressureWindowName &&
      identity.windowActive &&
      !identity.paneDead &&
      identity.paneTty !== originalPaneIdentity.paneTty &&
      !sameExactTmuxPaneIdentity(identity, originalPaneIdentity),
    'pressure tmux pane identity did not differ from the original live CLI pane',
  );
  return identity;
}

async function waitForPressureWindowExitAndOriginalRestore({
  commandExecutor,
  taskId,
  pressureWindowName,
  originalPaneIdentity,
  timeoutMs = 10_000,
}) {
  await waitForCondition(
    async () => {
      const inventory = await readExactTmuxWindowInventory(
        commandExecutor,
        taskId,
      );
      if (
        inventory.some((window) => window.windowName === pressureWindowName)
      ) {
        return false;
      }
      const current = await readExactTmuxPaneIdentity(commandExecutor, taskId);
      return (
        sameExactTmuxPaneIdentity(current, originalPaneIdentity) &&
        current.windowActive &&
        !current.paneDead
      );
    },
    timeoutMs,
    `pressure tmux window did not exit and restore the original pane: ${pressureWindowName}`,
  );
}

export async function cleanupExactPressureWindow({
  commandExecutor,
  taskId,
  pressureWindowName,
}) {
  const inventory = await readExactTmuxWindowInventory(commandExecutor, taskId);
  const matches = inventory.filter(
    (window) => window.windowName === pressureWindowName,
  );
  const failures = [];
  if (matches.length > 1) {
    failures.push(
      new Error(
        `pressure cleanup resolved more than one exact generated window: ${JSON.stringify(
          matches.map((window) => window.windowId),
        )}`,
      ),
    );
  }
  for (const match of matches) {
    try {
      const result = await commandExecutor.exec({
        command: `tmux kill-window -t ${shellQuote(match.windowId)}`,
        timeoutMs: 5_000,
      });
      assert(
        result.exitCode === 0 && !result.timedOut,
        `pressure tmux window ${match.windowId} could not be killed`,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await waitForCondition(
      async () =>
        (
          await readExactTmuxWindowInventory(commandExecutor, taskId)
        ).every((window) => window.windowName !== pressureWindowName),
      10_000,
      `pressure tmux window remained after exact cleanup: ${pressureWindowName}`,
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `pressure tmux window cleanup failed: ${pressureWindowName}`,
    );
  }
}

export async function signalExactRuntime(
  commandExecutor,
  taskId,
  signal,
  paneIdentity = null,
) {
  assert(signal === 'STOP' || signal === 'CONT', 'unsupported runtime signal');
  if (paneIdentity) {
    assert(
      isExactTmuxPaneIdentityShape(paneIdentity) &&
        paneIdentity.sessionName === detachedSessionName(taskId),
      'fixed runtime signal target was not an exact task pane identity',
    );
  }
  const target = shellQuote(
    paneIdentity?.paneId ?? `=${detachedSessionName(taskId)}:`,
  );
  const identityFence = paneIdentity
    ? `IDENTITY=$(tmux display-message -p -t ${target} ` +
      "'#{session_name}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_tty}') && " +
      `test "$IDENTITY" = ${shellQuote(
        `${paneIdentity.sessionName}|${paneIdentity.windowId}|${paneIdentity.paneId}|${paneIdentity.panePid}|${paneIdentity.paneTty}`,
      )} && `
    : '';
  const result = await commandExecutor.exec({
    command:
      identityFence +
      `collect_tree() { printf '%s\\n' "$1"; ` +
      `for CHILD in $(pgrep -P "$1" 2>/dev/null || true); do ` +
      `collect_tree "$CHILD"; done; }; ` +
      `PANE_PID=$(tmux display-message -p -t ${target} '#{pane_pid}') && ` +
      `PANE_TTY=$(tmux display-message -p -t ${target} '#{pane_tty}') && ` +
      `case "$PANE_TTY" in /dev/pts/[0-9]*) ;; *) exit 72;; esac && ` +
      `PIDS="$(collect_tree "$PANE_PID") ` +
      `$(ps -t "\${PANE_TTY#/dev/}" -o pid=)" && ` +
      `test -n "$PIDS" && ` +
      `for PID in $PIDS; do ` +
      `case "$PID" in *[!0-9]*) exit 73;; esac; ` +
      `kill -${signal} "$PID" 2>/dev/null || ` +
      `{ if kill -0 "$PID" 2>/dev/null; then exit 74; fi; true; }; ` +
      `done`,
    timeoutMs: 5_000,
  });
  assert(
    result.exitCode === 0 && !result.timedOut,
    `exact runtime ${signal} failed with exit ${result.exitCode}: ${JSON.stringify(
      String(result.output ?? '').slice(-1_000),
    )}`,
  );
}

async function captureTmuxPaneDigest(
  commandExecutor,
  taskId,
  paneIdentity = null,
) {
  return (
    await captureTmuxPaneSnapshot(commandExecutor, taskId, paneIdentity)
  ).digest;
}

async function captureTmuxPaneSnapshot(
  commandExecutor,
  taskId,
  paneIdentity = null,
) {
  const target = shellQuote(
    paneIdentity?.paneId ?? `=${detachedSessionName(taskId)}:`,
  );
  const identityFence = paneIdentity
    ? `IDENTITY=$(tmux display-message -p -t ${target} ${shellQuote(
        '#{session_name}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_tty}',
      )}) && ` +
      `test "$IDENTITY" = ${shellQuote(
        `${paneIdentity.sessionName}|${paneIdentity.windowId}|${paneIdentity.paneId}|${paneIdentity.panePid}|${paneIdentity.paneTty}`,
      )} && `
    : '';
  const result = await commandExecutor.exec({
    command: `${identityFence}tmux capture-pane -p -e -N -t ${target}`,
    timeoutMs: 5_000,
  });
  const output = String(result.output ?? '');
  assert(
    result.exitCode === 0 && !result.timedOut,
    'exact tmux pane snapshot could not be captured',
  );
  return { output, digest: sha256(output) };
}

function comparePaneSnapshots(first, second) {
  const firstLines = first.split('\n');
  const secondLines = second.split('\n');
  const differences = [];
  for (
    let row = 0;
    row < Math.max(firstLines.length, secondLines.length);
    row += 1
  ) {
    if (firstLines[row] !== secondLines[row]) {
      differences.push({
        row,
        first: firstLines[row] ?? '',
        second: secondLines[row] ?? '',
      });
      if (differences.length >= 8) break;
    }
  }
  return {
    firstSha256: sha256(first),
    secondSha256: sha256(second),
    firstBytes: Buffer.byteLength(first),
    secondBytes: Buffer.byteLength(second),
    differences,
  };
}

function summarizePaneTransition(first, second) {
  const comparison = comparePaneSnapshots(first, second);
  return {
    firstSha256: comparison.firstSha256,
    secondSha256: comparison.secondSha256,
    firstBytes: comparison.firstBytes,
    secondBytes: comparison.secondBytes,
    changedRows: comparison.differences.map(({ row }) => row),
  };
}

function compareSerializedScreens(first, second) {
  let commonPrefixChars = 0;
  while (
    commonPrefixChars < first.length &&
    commonPrefixChars < second.length &&
    first[commonPrefixChars] === second[commonPrefixChars]
  ) {
    commonPrefixChars += 1;
  }
  let commonSuffixChars = 0;
  while (
    commonSuffixChars < first.length - commonPrefixChars &&
    commonSuffixChars < second.length - commonPrefixChars &&
    first[first.length - 1 - commonSuffixChars] ===
      second[second.length - 1 - commonSuffixChars]
  ) {
    commonSuffixChars += 1;
  }
  const firstDeltaEnd = Math.max(
    commonPrefixChars,
    first.length - commonSuffixChars,
  );
  const secondDeltaEnd = Math.max(
    commonPrefixChars,
    second.length - commonSuffixChars,
  );
  return {
    firstSha256: sha256(first),
    secondSha256: sha256(second),
    firstChars: first.length,
    secondChars: second.length,
    commonPrefixChars,
    commonSuffixChars,
    firstDeltaUtf8Hex: Buffer.from(
      first.slice(commonPrefixChars, firstDeltaEnd).slice(0, 256),
    ).toString('hex'),
    secondDeltaUtf8Hex: Buffer.from(
      second.slice(commonPrefixChars, secondDeltaEnd).slice(0, 256),
    ).toString('hex'),
  };
}

async function waitForTmuxPaneStable(
  commandExecutor,
  taskId,
  stableMs,
  timeoutMs,
  paneIdentity = null,
) {
  const deadline = Date.now() + timeoutMs;
  let prior = null;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const digest = await captureTmuxPaneDigest(
      commandExecutor,
      taskId,
      paneIdentity,
    );
    if (digest !== prior) {
      prior = digest;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return digest;
    }
    await delay(100);
  }
  throw new Error('exact tmux pane did not reach a stable source frame');
}

async function waitForNoTmuxClients(
  commandExecutor,
  taskId,
  timeoutMs = 10_000,
) {
  return waitForTmuxClientCount(commandExecutor, taskId, 0, timeoutMs);
}

async function waitForTmuxClientCount(
  commandExecutor,
  taskId,
  expectedCount,
  timeoutMs = 10_000,
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const target = shellQuote(`=${detachedSessionName(taskId)}`);
  let lastOutput = '';
  let lastExitCode = Number.NaN;
  let transientExecFailures = 0;
  let lastExecFailure = '';
  while (Date.now() < deadline) {
    let result;
    try {
      result = await commandExecutor.exec({
        command:
          `tmux has-session -t ${target} && ` +
          // BoxLite's REST-backed PTY can legitimately expose an empty
          // `client_tty` even while tmux still owns the client. `client_pid` is
          // the provider-neutral non-empty existence field. Keep the remaining
          // non-secret identity/lifetime fields in the bounded failure evidence
          // so a leaked old owner can be distinguished from a viewer that did
          // not detach; one opaque PID alone cannot prove which generation
          // survived.
          `tmux list-clients -t ${target} -F '#{client_pid}|#{client_tty}|#{client_name}|#{client_created}|#{client_activity}|#{client_flags}|#{client_session}'`,
        timeoutMs: 5_000,
      });
    } catch (error) {
      // This helper is already a bounded eventual-state probe. BoxLite 0.9.5
      // can reject an individual short-lived exec while the previous exec's
      // guest-side teardown is settling; one rejection does not say anything
      // about the authoritative tmux client count. Retry inside the existing
      // deadline, but retain a non-secret diagnostic and fail if the provider
      // never becomes observable again.
      transientExecFailures += 1;
      lastExecFailure = error instanceof Error ? error.name : typeof error;
      await delay(100);
      continue;
    }
    lastExitCode = result.exitCode;
    lastOutput = String(result.output ?? '').trim();
    const clientCount = lastOutput.split('\n').filter(Boolean).length;
    if (
      result.exitCode === 0 &&
      !result.timedOut &&
      clientCount === expectedCount
    ) {
      return Date.now() - startedAt;
    }
    await delay(50);
  }
  throw new Error(
    `tmux client count did not become ${expectedCount} within ${timeoutMs}ms: ${JSON.stringify({
      exitCode: lastExitCode,
      clients: lastOutput.split('\n').filter(Boolean),
      transientExecFailures,
      lastExecFailure,
    })}`,
  );
}

async function waitForTmuxGeometry(
  commandExecutor,
  taskId,
  expectedCols,
  expectedRows,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await commandExecutor.exec({
      command:
        `tmux display-message -p -t ${shellQuote(`=${detachedSessionName(taskId)}`)}: ` +
        "'#{window_width}x#{window_height}'",
      timeoutMs: 5_000,
    });
    if (
      result.exitCode === 0 &&
      result.output.trim() === `${expectedCols}x${expectedRows}`
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `tmux geometry did not become ${expectedCols}x${expectedRows}`,
  );
}

async function waitForTmuxWindowSizePolicy(
  commandExecutor,
  taskId,
  expectedPolicy,
  timeoutMs = 10_000,
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const target = shellQuote(`=${detachedSessionName(taskId)}:`);
  let lastPolicy = '';
  let transientExecFailures = 0;
  while (Date.now() < deadline) {
    try {
      const result = await commandExecutor.exec({
        command: `tmux show-window-options -v -t ${target} window-size`,
        timeoutMs: 5_000,
      });
      lastPolicy = String(result.output ?? '').trim();
      if (
        result.exitCode === 0 &&
        !result.timedOut &&
        lastPolicy === expectedPolicy
      ) {
        return Date.now() - startedAt;
      }
    } catch {
      transientExecFailures += 1;
    }
    await delay(100);
  }
  throw new Error(
    `tmux window-size policy did not become ${expectedPolicy}: ${JSON.stringify({
      lastPolicy,
      transientExecFailures,
    })}`,
  );
}

async function execStrict(commandExecutor, command, label) {
  const result = await commandExecutor.exec({
    command,
    cwd: '/home/gem',
    timeoutMs: 60_000,
  });
  assert(
    result.exitCode === 0 && !result.timedOut,
    `${label} failed with exit ${result.exitCode}: ${JSON.stringify(
      String(result.output ?? '').slice(-2_000),
    )}`,
  );
  return result;
}

async function sandboxInventory(client) {
  return (await client.listSandboxes()).map((sandbox) => sandbox.id).sort();
}

export function beginBoxLiteCreateAttempt({
  client,
  boxName,
  baselineSandboxIds,
  request,
}) {
  const abortController = new AbortController();
  const attempt = {
    client,
    boxName,
    baselineSandboxIds: new Set(baselineSandboxIds ?? []),
    abortController,
    observedSandboxId: null,
    promise: null,
    cleanupPromise: null,
  };
  const onSandboxCreateObserved = request.onSandboxCreateObserved;
  attempt.promise = client
    .createSandbox({
      ...request,
      cancellationSignal: abortController.signal,
      onSandboxCreateObserved: async (observation) => {
        if (observation?.kind === 'created') {
          attempt.observedSandboxId = observation.providerSandboxId;
        }
        await onSandboxCreateObserved?.(observation);
      },
    })
    .then((sandbox) => {
      attempt.observedSandboxId = sandbox.id;
      return sandbox;
    })
    .catch((error) => {
      if (error instanceof BoxLitePartialCreateError) {
        attempt.observedSandboxId = error.sandbox.id;
      }
      throw error;
    });
  activeBoxLiteCreateAttempts.add(attempt);
  return attempt;
}

export function cleanupBoxLiteCreateAttempt(
  attempt,
  {
    timeoutMs = CREATE_RECONCILE_TIMEOUT_MS,
    quietMs = CREATE_RECONCILE_QUIET_MS,
    retryMs = CREATE_RECONCILE_RETRY_MS,
  } = {},
) {
  if (attempt.cleanupPromise) return attempt.cleanupPromise;
  const cleanup = (async () => {
    attempt.abortController.abort(new Error('BoxLite canary create cleanup'));
    await attempt.promise.catch(() => undefined);
    const deadline = Date.now() + timeoutMs;
    let quietSince = null;
    let reconciledCandidate = false;
    while (Date.now() <= deadline) {
      const inventory = await attempt.client.listSandboxes();
      const candidates = inventory.filter(
        (sandbox) =>
          !attempt.baselineSandboxIds.has(sandbox.id) &&
          (sandbox.id === attempt.boxName ||
            sandbox.taskId === attempt.boxName ||
            sandbox.id === attempt.observedSandboxId),
      );
      for (const sandbox of candidates) {
        await deleteBoxLiteSandboxAndConfirm({
          client: attempt.client,
          sandboxId: sandbox.id,
          waitForRetry: async () => delay(retryMs),
        });
        reconciledCandidate = true;
        activeSandboxes.delete(sandbox.id);
      }
      if (candidates.length > 0) {
        quietSince = null;
        continue;
      }
      if (attempt.observedSandboxId !== null || reconciledCandidate) return true;
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quietMs) return true;
      await delay(retryMs);
    }
    throw new Error('BoxLite create reconciliation remained indeterminate');
  })();
  attempt.cleanupPromise = cleanup.then(
    (result) => {
      activeBoxLiteCreateAttempts.delete(attempt);
      return result;
    },
    (error) => {
      attempt.cleanupPromise = null;
      throw error;
    },
  );
  return attempt.cleanupPromise;
}

async function assertInventory(client, expected, label) {
  const actual = await sandboxInventory(client);
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} BoxLite inventory changed: ${JSON.stringify(actual)}`,
  );
}

function trackOuterTerminal(terminal, label) {
  assertCanaryRunning(label);
  assert(
    terminal && typeof terminal.close === 'function',
    `${label} did not expose a close seam`,
  );
  assert(
    !activeOuterTerminals.has(terminal),
    `${label} was registered more than once`,
  );
  activeOuterTerminals.set(terminal, label);
  return terminal;
}

async function closeTrackedOuterTerminal(terminal) {
  const label = activeOuterTerminals.get(terminal);
  if (!label) return true;
  terminal.close();
  assert(terminal.cleanupDecision, `${label} exposed no cleanup decision`);
  const settlement = await withTimeout(
    terminal.cleanupDecision,
    DEFAULT_TERMINAL_SHUTDOWN_CLEANUP_TIMEOUT_MS,
    `${label} cleanup decision timed out`,
  );
  assert(
    settlement?.kind === 'confirmed',
    `${label} cleanup remained indeterminate`,
  );
  activeOuterTerminals.delete(terminal);
  return true;
}

async function closeAllTrackedOuterTerminals() {
  const failures = [];
  for (const terminal of [...activeOuterTerminals.keys()]) {
    try {
      await closeTrackedOuterTerminal(terminal);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'outer terminal cleanup failed');
  }
}

export function cleanupAll() {
  if (cleanupPromise) return cleanupPromise;
  const attempt = (async () => {
    const failures = [];
    try {
      await waitForActiveAioOperations();
    } catch (error) {
      failures.push(error);
    }
    for (const attempt of [...activeBoxLiteCreateAttempts]) {
      try {
        await cleanupBoxLiteCreateAttempt(attempt);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const harness of [...activeCapSurfaceHarnesses]) {
      try {
        await harness.close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await closeAllTrackedOuterTerminals();
    } catch (error) {
      failures.push(error);
    }
    for (const relay of [...activeAioFaultRelays]) {
      try {
        await relay.close();
        activeAioFaultRelays.delete(relay);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const cleanup of [...activeExactCleanups.values()]) {
      try {
        await cleanup.run();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const lease of [...activeAioCredentialLeases]) {
      try {
        await lease.cleanup();
        activeAioCredentialLeases.delete(lease);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const [sandboxId, client] of activeSandboxes) {
      try {
        await deleteBoxLiteSandboxAndConfirm({
          client,
          sandboxId,
          waitForRetry: async () => delay(50),
        });
        activeSandboxes.delete(sandboxId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'provider canary cleanup failed');
    }
  })();
  cleanupPromise = attempt.then(
    (result) => result,
    (error) => {
      cleanupPromise = null;
      throw error;
    },
  );
  return cleanupPromise;
}

export function registerExactCleanup(key, cleanup) {
  assertCanaryRunning(`${key} cleanup registration`);
  assert(!activeExactCleanups.has(key), `duplicate exact cleanup key: ${key}`);
  let settled = null;
  const handle = {
    run() {
      if (!settled) {
        const attempt = Promise.resolve().then(cleanup);
        settled = attempt.then(
          (result) => {
            activeExactCleanups.delete(key);
            return result;
          },
          (error) => {
            settled = null;
            throw error;
          },
        );
      }
      return settled;
    },
  };
  activeExactCleanups.set(key, handle);
  return handle;
}

function mergeQueryEvidence(...entries) {
  const result = {
    dsrQueries: 0,
    primaryDaQueries: 0,
    secondaryDaQueries: 0,
    colorQueries: 0,
    cprResponsesGenerated: 0,
    responsesForwarded: 0,
    responsesSuppressedByOwnerPolicy: 0,
  };
  for (const entry of entries.filter(Boolean)) {
    for (const key of Object.keys(result)) result[key] += entry[key] ?? 0;
  }
  return result;
}

function count(haystack, needle) {
  let occurrences = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, offset);
    if (found === -1) break;
    occurrences += 1;
    offset = found + needle.length;
  }
  return occurrences;
}

function terminalModeEvidence(raw, mode) {
  const text = raw.toString('latin1');
  const enabled = `\x1b[?${mode}h`;
  const disabled = `\x1b[?${mode}l`;
  const transitions = [];
  for (const [state, sequence] of [
    ['enabled', enabled],
    ['disabled', disabled],
  ]) {
    let offset = text.indexOf(sequence);
    while (offset !== -1) {
      transitions.push({ offset, state });
      offset = text.indexOf(sequence, offset + sequence.length);
    }
  }
  transitions.sort((first, second) => first.offset - second.offset);
  return {
    enabled: count(text, enabled),
    disabled: count(text, disabled),
    transitions,
  };
}

function callCell(cell, method) {
  return typeof cell[method] === 'function' ? cell[method]() : null;
}

export function classifyApiRestartFrameReference({
  beforeSourceSha256,
  afterSourceSha256,
}) {
  for (const [label, value] of [
    ['beforeSourceSha256', beforeSourceSha256],
    ['afterSourceSha256', afterSourceSha256],
  ]) {
    assert(
      typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value),
      `${label} must be a SHA-256 digest`,
    );
  }
  return beforeSourceSha256 === afterSourceSha256
    ? 'uninterrupted'
    : 'same-epoch-fresh-peer';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function httpToWs(value) {
  return value.replace(/^http/iu, 'ws').replace(/\/+$/u, '');
}

function nativeBoxesUrl(endpoint, pathPrefix) {
  const apiPath = pathPrefix ? `/v1/${encodeURIComponent(pathPrefix)}` : '/v1';
  return `${endpoint}${apiPath}/boxes`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function parseArgs(argv) {
  if (argv.includes('--help')) {
    assert(argv.length === 1, '--help cannot be combined with other arguments');
    return { help: true };
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (
      key !== '--endpoint' &&
      key !== '--provider' &&
      key !== '--rootfs' &&
      key !== '--image' &&
      key !== '--path-prefix' &&
      key !== '--runtime' &&
      key !== '--auth' &&
      key !== '--surface' &&
      key !== '--owner-fault' &&
      key !== '--aio-state-ownership' &&
      key !== '--unsafe-preloaded-credential-handoff'
    ) {
      throw new Error(`unknown argument: ${key}`);
    }
    const value = argv[index + 1];
    assert(value && !value.startsWith('--'), `missing value for ${key}`);
    assert(!values.has(key), `duplicate argument: ${key}`);
    values.set(key, value);
    index += 1;
  }
  const endpoint = (values.get('--endpoint') ?? 'http://127.0.0.1:8100')
    .replace(/\/+$/u, '');
  const provider = values.get('--provider');
  assert(
    provider !== undefined,
    '--provider is required; real provider stories never infer a default',
  );
  assert(
    provider === 'boxlite' || provider === 'aio',
    '--provider must be boxlite or aio',
  );
  assert(
    provider === 'boxlite' || !values.has('--image'),
    '--image is only valid for BoxLite',
  );
  if (provider === 'aio') {
    assert(
      values.has('--endpoint'),
      'AIO --endpoint is required and must target the isolated container tunnel',
    );
  }
  const rootfs = values.get('--rootfs');
  const image = values.get('--image');
  if (provider === 'boxlite') {
    assert(
      Boolean(rootfs) !== Boolean(image),
      'BoxLite requires exactly one of --rootfs or --image',
    );
  }
  const pathPrefixValue = values.get('--path-prefix') ?? 'default';
  const pathPrefix = pathPrefixValue === 'none' ? '' : pathPrefixValue;
  assert(
    pathPrefix === '' || !pathPrefix.includes('/'),
    '--path-prefix must be one segment or none',
  );
  const runtime = values.get('--runtime') ?? 'both';
  assert(
    runtime === 'codex' || runtime === 'claude-code' || runtime === 'both',
    '--runtime must be codex, claude-code, or both',
  );
  const auth =
    values.get('--auth') ?? (provider === 'aio' ? 'stdin' : 'none');
  const surface = values.get('--surface') ?? 'direct';
  assert(
    surface === 'direct' || surface === 'cap',
    '--surface must be direct or cap',
  );
  const ownerFault = values.get('--owner-fault') ?? 'none';
  assert(
    ownerFault === 'none' || ownerFault === 'drop',
    '--owner-fault must be none or drop',
  );
  assert(
    provider === 'aio' || ownerFault === 'none',
    '--owner-fault drop is currently supported only for AIO',
  );
  if (provider === 'boxlite') {
    assert(
      auth === 'none' || auth === 'local',
      'BoxLite --auth must be none or local',
    );
  } else {
    assert(
      auth === 'stdin' || auth === 'preloaded',
      'AIO --auth must be stdin or preloaded',
    );
    if (auth === 'stdin') {
      assert(
        runtime !== 'both',
        'AIO --auth stdin requires exactly one --runtime value: codex or claude-code',
      );
      assert(
        !values.has('--unsafe-preloaded-credential-handoff'),
        '--unsafe-preloaded-credential-handoff is invalid with AIO --auth stdin',
      );
    } else {
      assert(
        values.get('--unsafe-preloaded-credential-handoff') ===
          'acknowledged',
        'deprecated AIO --auth preloaded requires --unsafe-preloaded-credential-handoff acknowledged',
      );
    }
    assert(
      values.get('--aio-state-ownership') === 'isolated-disposable',
      'AIO requires --aio-state-ownership isolated-disposable because cleanup removes canary workspace and runtime credential paths',
    );
  }
  assert(
    provider === 'aio' || !values.has('--aio-state-ownership'),
    '--aio-state-ownership is only valid for AIO',
  );
  assert(
    provider === 'aio' ||
      !values.has('--unsafe-preloaded-credential-handoff'),
    '--unsafe-preloaded-credential-handoff is only valid for AIO --auth preloaded',
  );
  return {
    provider,
    endpoint,
    rootfs,
    ...(provider === 'boxlite' ? { image } : {}),
    pathPrefix,
    runtime,
    auth,
    surface,
    ownerFault,
    ownsAioState: provider === 'aio',
    releaseGateEligible: provider !== 'aio' || auth === 'stdin',
    unsafePreloadedCredentialHandoff:
      provider === 'aio' && auth === 'preloaded',
  };
}

function printUsage() {
  console.log(`Usage:
  node scripts/boxlite-real-cli-terminal-canary.mjs --provider boxlite --endpoint URL (--rootfs PATH | --image IMAGE) [--path-prefix default|none] [--runtime codex|claude-code|both] [--auth none|local] [--surface direct|cap]
  node scripts/boxlite-real-cli-terminal-canary.mjs --provider aio --endpoint URL --runtime codex|claude-code [--auth stdin] --aio-state-ownership isolated-disposable [--surface direct|cap] [--owner-fault none|drop]
  node scripts/boxlite-real-cli-terminal-canary.mjs --provider aio --endpoint URL --auth preloaded --unsafe-preloaded-credential-handoff acknowledged --aio-state-ownership isolated-disposable [--runtime codex|claude-code|both] [--surface direct|cap] [--owner-fault none|drop]`);
}

const invokedPath = process.argv[1] ? fileURLToPath(pathToFileURL(process.argv[1])) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const removeSignalHandlers = installCanarySignalHandlers();
  try {
    await main();
  } catch (error) {
    requestCanaryStop();
    try {
      await cleanupAll();
    } catch (cleanupError) {
      console.error(
        JSON.stringify(
          formatCanaryErrorTree(
            new AggregateError(
              [error, cleanupError],
              'canary and cleanup failed',
            ),
          ),
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
    if (process.exitCode !== 1) {
      console.error(JSON.stringify(formatCanaryErrorTree(error), null, 2));
      process.exitCode = 1;
    }
  } finally {
    removeSignalHandlers();
  }
}
