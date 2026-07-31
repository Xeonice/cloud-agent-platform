#!/usr/bin/env node

/**
 * Destructive real-provider canary for enable-yolo-agent-launch.
 *
 * Every sandbox/container is uniquely named and deleted with an absence probe.
 * Runtime credentials are read into memory, delivered only through the provider
 * private-file port, never printed, and scanned in raw/base64/base64url/hex form
 * across ordinary request bodies, commands, terminal bytes, transcripts, and logs.
 *
 * BoxLite:
 *   node scripts/yolo-agent-canary.mjs boxlite \
 *     --endpoint http://127.0.0.1:18100 \
 *     --rootfs /absolute/path/to/oci
 *
 * AIO (run on the Linux Docker host):
 *   node scripts/yolo-agent-canary.mjs aio \
 *     --image cap-aio-sandbox:yolo-canary --network cap-net
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

import { CodexRuntime } from '../apps/api/dist/agent-runtime/codex-runtime.js';
import { ClaudeCodeRuntime } from '../apps/api/dist/agent-runtime/claude-code-runtime.js';
import {
  detachedSessionName,
  headlessExitFile,
} from '../apps/api/dist/terminal/codex-launch.js';
import {
  AioSandboxContainerController,
  BoxLiteRestClient,
  createAioRuntimePrivateFilePort,
  createBoxLiteWorkspaceSecurityAdapter,
  deleteBoxLiteSandboxAndConfirm,
  openSandboxTerminalPty,
  terminalSessionIdForTask,
} from '../packages/sandbox/dist/index.js';
// Provider-internal symbols: scripts canaries are not ratcheted apps/api
// consumers, so the reviewed facade whitelist (close-gate-blindspots 2.3) does
// not carry them — import them from the provider package dists directly, like
// aio-terminal-pair-stale-sweep-canary.mjs does.
import { createBoxLiteCommandExecutor } from '../packages/sandbox-provider-boxlite/dist/index.js';
import { extractFilesFromTar } from '../packages/sandbox-provider-aio/dist/index.js';

const requireFromApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const Docker = requireFromApi('dockerode');
// `@xterm/headless` is declared by apps/web, not apps/api — 68c0907 dropped it
// from apps/api while introducing this lookup. `terminal-active-buffer-snapshot`
// already resolves it the correct way; this follows it.
const requireFromWeb = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const { Terminal } = requireFromWeb('@xterm/headless');

const WORKSPACE = '/home/gem/workspace';
const DEFAULT_TIMEOUT_MS = 240_000;
const POLL_MS = 750;
const MAX_TERMINAL_BYTES = 32 * 1024 * 1024;
const MAX_PROVIDER_LOG_BYTES = 64 * 1024 * 1024;
const MAX_CREDENTIAL_STDIN_BYTES = 2 * 1024 * 1024;
const MAX_CODEX_AUTH_JSON_BYTES = 1024 * 1024;
const MAX_CLAUDE_OAUTH_TOKEN_BYTES = 64 * 1024;
const CREDENTIAL_STDIN_TIMEOUT_MS = 30_000;
const INTERACTIVE_COLS = 120;
const INTERACTIVE_ROWS = 36;
const activeSecretVariants = new Set();
let cleanupStack = [];

const RUNTIME_PRIVATE_PATHS = Object.freeze({
  codex: Object.freeze([
    '/home/gem/.codex/config.toml',
    '/home/gem/.codex/auth.json',
    '/home/gem/.codex/task-prompt.txt',
  ]),
  'claude-code': Object.freeze([
    '/home/gem/.claude/launch-env.sh',
    '/home/gem/.claude/settings.json',
    '/home/gem/.claude.json',
    '/home/gem/.claude/.claude.json',
    '/home/gem/.claude/task-prompt.txt',
  ]),
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanupAll().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  registerProviderSecrets(options);

  const report = {
    result: 'PASS',
    provider: options.provider,
    phase: options.phase,
    generatedAt: new Date().toISOString(),
    parser: null,
    cases: [],
    threatBoundary:
      'proves non-disclosure only across the scanned control-plane, argv, terminal, transcript, provider-log, and post-delete residue surfaces; credentials necessarily exist in sandbox-private files, Claude OAuth necessarily enters the Claude guest process environment, container deletion is lifecycle cleanup rather than forensic erasure, and this does not prove resistance to deliberate same-UID credential exfiltration',
  };

  if (options.phase !== 'real') {
    report.parser = await runParserProbe(options);
  }

  if (options.phase !== 'parser') {
    const credentials = await loadCredentials(
      options.runtime,
      options.credentialsSource,
    );
    registerSecrets(credentials);
    for (const runtimeId of selectedRuntimes(options.runtime)) {
      if (options.mode === 'all' || options.mode === 'interactive') {
        report.cases.push(
          await runInteractiveCase(options, runtimeId, credentials),
        );
      }
      if (options.mode === 'all' || options.mode === 'headless') {
        report.cases.push(
          await runHeadlessCase(options, runtimeId, credentials),
        );
      }
    }
  }

  await cleanupAll();
  assertNoSecrets(JSON.stringify(report), 'final report');
  console.log(JSON.stringify(report, null, 2));
}

async function runParserProbe(options) {
  const sandbox = await createSandbox(options, 'parser');
  const startedAt = Date.now();
  let primaryError = null;
  try {
    const initialCommit = await initializeWorkspace(sandbox);
    const probes = {
      codexVersion: await commandOutput(
        sandbox,
        'codex --version',
        'Codex version probe',
      ),
      claudeVersion: await commandOutput(
        sandbox,
        'claude --version',
        'Claude version probe',
      ),
      openspecVersion: await commandOutput(
        sandbox,
        'openspec --version',
        'OpenSpec version probe',
      ),
      codexInteractive: await commandOutput(
        sandbox,
        boundedHelpProbe(
          'codex --dangerously-bypass-approvals-and-sandbox --help',
          ['dangerously-bypass-approvals-and-sandbox'],
        ),
        'Codex interactive help probe',
      ),
      codexHeadless: await commandOutput(
        sandbox,
        boundedHelpProbe(
          'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --help',
          ['dangerously-bypass-approvals-and-sandbox', 'skip-git-repo-check'],
        ),
        'Codex headless help probe',
      ),
      codexResume: await commandOutput(
        sandbox,
        boundedHelpProbe(
          'codex exec resume --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check 00000000-0000-4000-8000-000000000000 --help',
          [
            '--json',
            'dangerously-bypass-approvals-and-sandbox',
            'skip-git-repo-check',
          ],
        ),
        'Codex resume help probe',
      ),
      claudeInteractive: await commandOutput(
        sandbox,
        boundedHelpProbe('claude --dangerously-skip-permissions --help', [
          'dangerously-skip-permissions',
          'session-id',
        ]),
        'Claude interactive help probe',
      ),
      claudeHeadless: await commandOutput(
        sandbox,
        boundedHelpProbe(
          'claude -p --dangerously-skip-permissions --output-format stream-json --verbose --help',
          ['dangerously-skip-permissions', 'output-format'],
        ),
        'Claude headless help probe',
      ),
      claudeResume: await commandOutput(
        sandbox,
        boundedHelpProbe(
          'claude -p --resume 00000000-0000-4000-8000-000000000000 --dangerously-skip-permissions --output-format stream-json --verbose --help',
          ['dangerously-skip-permissions', 'output-format', 'resume'],
        ),
        'Claude resume help probe',
      ),
    };
    assertMatch(probes.codexVersion, /codex-cli 0\.144\.1\b/u, 'pinned Codex version');
    assertMatch(probes.claudeVersion, /2\.1\.207/u, 'pinned Claude version');
    assertMatch(probes.openspecVersion, /1\.4\.1/u, 'pinned OpenSpec version');
    for (const [label, value, patterns] of [
      [
        'Codex interactive help',
        probes.codexInteractive,
        [/dangerously-bypass-approvals-and-sandbox/u],
      ],
      [
        'Codex headless help',
        probes.codexHeadless,
        [/dangerously-bypass-approvals-and-sandbox/u, /skip-git-repo-check/u],
      ],
      [
        'Codex resume help',
        probes.codexResume,
        [
          /--json/u,
          /dangerously-bypass-approvals-and-sandbox/u,
          /skip-git-repo-check/u,
        ],
      ],
      [
        'Claude interactive help',
        probes.claudeInteractive,
        [/dangerously-skip-permissions/u, /session-id/u],
      ],
      [
        'Claude headless help',
        probes.claudeHeadless,
        [/dangerously-skip-permissions/u, /output-format/u],
      ],
      [
        'Claude resume help',
        probes.claudeResume,
        [/dangerously-skip-permissions/u, /output-format/u, /resume/u],
      ],
    ]) {
      for (const pattern of patterns) assertMatch(value, pattern, label);
    }
    const contract = await commandOutput(
      sandbox,
      "test -f /etc/cap/sandbox-metadata.json && cat /etc/cap/sandbox-metadata.json",
    );
    const metadata = JSON.parse(contract);
    assert(
      metadata?.dependencies?.codex === '0.144.1' &&
        metadata?.dependencies?.['claude-code'] === '2.1.207',
      'image metadata does not match pinned runtime versions',
    );
    const privateArchiveIsolation = await probeClaudePrivateArchiveIsolation(
      sandbox,
      initialCommit,
    );
    await sandbox.captureProviderLogs();
    return {
      result: 'PASS',
      sandboxId: sandbox.id,
      versions: {
        codex: firstLine(probes.codexVersion),
        claude: firstLine(probes.claudeVersion),
        openspec: firstLine(probes.openspecVersion),
      },
      imageContract: metadata.dependencies,
      privateArchiveIsolation,
      durationMs: Date.now() - startedAt,
      cleanup: await sandbox.cleanupAndConfirm(),
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finalizeCanaryCleanup(primaryError, [() => sandbox.forceCleanup()]);
  }
}

async function runInteractiveCase(options, runtimeId, credentials) {
  const sandbox = await createSandbox(options, `${runtimeId}-interactive`);
  const runtime = runtimeFor(runtimeId);
  const taskId = safeTaskId(`yolo-${runtimeId}-i-${shortId()}`);
  const sessionId = terminalSessionIdForTask(taskId);
  const marker = `CAP_YOLO_${runtimeId.replaceAll('-', '_').toUpperCase()}_I_${shortId()}`;
  const markerPath = `.cap-canary/${marker}.txt`;
  const prompt = actionPrompt(marker, markerPath, 'interactive');
  let firstTerminal = null;
  let secondTerminal = null;
  const startedAt = Date.now();
  let primaryError = null;
  try {
    const initialCommit = await initializeWorkspace(sandbox);
    await applyRuntimeSetup(
      sandbox,
      runtime,
      { taskId, workspaceDir: WORKSPACE, prompt },
      authMaterial(runtimeId, credentials),
    );
    await assertFreshRuntimeFiles(sandbox, runtimeId);
    firstTerminal = await openProductionTerminalCapture({
      sandbox,
      taskId,
      runtime,
      mode: 'launch-or-attach',
    });
    assert(
      firstTerminal.launchOutcome.kind === 'launched',
      `${runtimeId} production terminal did not make a fresh-launch decision`,
    );
    await waitForSession(sandbox, taskId, firstTerminal);
    await waitForTmuxGeometry(
      sandbox,
      taskId,
      INTERACTIVE_COLS,
      INTERACTIVE_ROWS,
      firstTerminal,
    );
    const before = await sessionIdentity(sandbox, taskId);

    await firstTerminal.waitForOutput(45_000);
    const action = await waitForAction(
      sandbox,
      markerPath,
      marker,
      initialCommit,
      firstTerminal,
    );
    await firstTerminal.waitForQuiet(700, 20_000);
    await firstTerminal.drain();
    const firstRaw = firstTerminal.rawOutput();
    const firstState = firstTerminal.canonicalState();
    assertNoSecrets(firstRaw, `${runtimeId} first interactive attach`);
    assertNoBlockingPrompt(firstRaw, runtimeId);
    assert(
      firstRaw.includes(Buffer.from(marker, 'utf8')) &&
        firstState.visibleText.includes(marker) &&
        firstState.nonBlankCells > 20,
      `${runtimeId} first production terminal did not render the completed turn`,
    );
    await firstTerminal.close();
    firstTerminal = null;

    await delay(750);
    secondTerminal = await openProductionTerminalCapture({
      sandbox,
      taskId,
      runtime,
      mode: 'attach-only',
    });
    assert(
      secondTerminal.launchOutcome.kind === 'attached',
      `${runtimeId} production reconnect did not take attach-only`,
    );
    await waitForTmuxGeometry(
      sandbox,
      taskId,
      INTERACTIVE_COLS,
      INTERACTIVE_ROWS,
      secondTerminal,
    );
    await secondTerminal.waitForOutput(20_000);
    await secondTerminal.waitForQuiet(700, 20_000);
    await secondTerminal.drain();
    const secondRaw = secondTerminal.rawOutput();
    const secondState = secondTerminal.canonicalState();
    const attachBootstrapBytes = secondTerminal.attachBootstrapBytes;
    assertNoSecrets(secondRaw, `${runtimeId} fresh interactive reattach`);
    assertNoBlockingPrompt(secondRaw, runtimeId);
    assert(
      secondRaw.includes(Buffer.from(marker, 'utf8')) &&
        secondState.visibleText.includes(marker) &&
        secondState.nonBlankCells > 20,
      `${runtimeId} fresh production reconnect rendered a blank/incomplete frame`,
    );
    // `attach-bootstrap` is a durability/history classification, not a live
    // reconnect requirement.  A provider can deliver the complete tmux redraw
    // after that short classification window has closed.  Keep the byte count
    // as diagnostic evidence, while the assertions above and below prove the
    // user-visible frame, terminal-mode envelope, and pane identity directly.
    const stateComparison = compareTerminalStates(firstState, secondState);
    assert(
      stateComparison.firstBufferType === stateComparison.secondBufferType &&
        stateComparison.modesEqual,
      `${runtimeId} fresh reconnect changed the terminal buffer/mode envelope ` +
        JSON.stringify(stateComparison),
    );
    const after = await sessionIdentity(sandbox, taskId);
    assert(before === after, `${runtimeId} reconnect relaunched the tmux pane`);
    await secondTerminal.close();
    secondTerminal = null;

    const processArgs = await commandOutput(
      sandbox,
      "for f in /proc/[0-9]*/cmdline; do tr '\\000' ' ' < \"$f\" 2>/dev/null; printf '\\n'; done",
    );
    assertNoSecrets(processArgs, `${runtimeId} process argv`);
    assert(
      targetAgentArgvSeen(processArgs, runtimeId, 'interactive'),
      `${runtimeId} interactive agent argv was not observed`,
    );
    const transcript = await readTranscript(sandbox, runtime, {
      taskId,
      sessionId,
    }, [marker]);

    await execAllowFailure(
      sandbox,
      `tmux kill-session -t ${shellQuote(detachedSessionName(taskId))}`,
      15_000,
    );
    await cleanupRuntimePrivateState(sandbox, runtime);
    await sandbox.captureProviderLogs();
    const cleanup = await sandbox.cleanupAndConfirm();
    return {
      result: 'PASS',
      provider: options.provider,
      runtime: runtimeId,
      mode: 'interactive-pty',
      sandboxId: sandbox.id,
      taskId,
      sessionId,
      action,
      reconnect: {
        samePaneIdentity: true,
        firstAttachBytes: firstRaw.byteLength,
        secondAttachBytes: secondRaw.byteLength,
        firstAttachSha256: sha256(firstRaw),
        secondAttachSha256: sha256(secondRaw),
        visibleStateSha256: secondState.hash,
        visibleTextSha256: sha256(secondState.visibleText),
        visibleNonBlankCells: secondState.nonBlankCells,
        attachBootstrapBytes,
        frameComparison: stateComparison,
      },
      transcript,
      cleanup,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finalizeCanaryCleanup(primaryError, [
      () => firstTerminal?.close(),
      () => secondTerminal?.close(),
      () => sandbox.forceCleanup(),
    ]);
  }
}

async function runHeadlessCase(options, runtimeId, credentials) {
  const sandbox = await createSandbox(options, `${runtimeId}-headless`);
  const runtime = runtimeFor(runtimeId);
  const newTaskId = safeTaskId(`yolo-${runtimeId}-h1-${shortId()}`);
  const resumeTaskId = safeTaskId(`yolo-${runtimeId}-h2-${shortId()}`);
  const sessionId = terminalSessionIdForTask(newTaskId);
  const marker1 = `CAP_YOLO_${runtimeId.replaceAll('-', '_').toUpperCase()}_H1_${shortId()}`;
  const marker2 = `CAP_YOLO_${runtimeId.replaceAll('-', '_').toUpperCase()}_H2_${shortId()}`;
  const path1 = `.cap-canary/${marker1}.txt`;
  const path2 = `.cap-canary/${marker2}.txt`;
  const startedAt = Date.now();
  let productionTerminal = null;
  let primaryError = null;
  try {
    const initialCommit = await initializeWorkspace(sandbox);
    const boundaryBeforeSetup = await inspectWorkspaceBoundary(
      sandbox,
      initialCommit,
    );
    const ctx1 = launchContext(newTaskId, sessionId);
    await applyRuntimeSetup(
      sandbox,
      runtime,
      {
        taskId: newTaskId,
        workspaceDir: WORKSPACE,
        prompt: actionPrompt(marker1, path1, 'headless new'),
      },
      authMaterial(runtimeId, credentials),
    );
    await assertFreshRuntimeFiles(sandbox, runtimeId);
    const boundaryBeforeLaunch = await inspectWorkspaceBoundary(
      sandbox,
      initialCommit,
    );
    const newLine = runtime.buildHeadlessLine(ctx1);
    assertNoSecrets(newLine, `${runtimeId} headless launch line`);
    productionTerminal = await openProductionTerminalCapture({
      sandbox,
      taskId: newTaskId,
      runtime,
      mode: 'launch-or-attach',
      executionMode: 'headless-exec',
    });
    assert(
      productionTerminal.launchOutcome.kind === 'launched',
      `${runtimeId} production headless terminal did not make a fresh-launch decision`,
    );
    const newObservation = await observeHeadlessExit(
      sandbox,
      newTaskId,
      runtimeId,
      productionTerminal,
    );
    const productionLifecycleExit = await productionTerminal.waitForExit(30_000);
    const newExit = newObservation.exitCode;
    assert(newExit === 0, `${runtimeId} headless new exited ${newExit}`);
    assert(
      productionLifecycleExit.code === 0 && !productionLifecycleExit.abnormal,
      `${runtimeId} production headless lifecycle did not report a clean exit`,
    );
    await productionTerminal.close();
    productionTerminal = null;
    const firstTranscript = await readTranscript(sandbox, runtime, {
      taskId: newTaskId,
      sessionId,
    }, [marker1]);
    const firstAction = await readAction(
      sandbox,
      path1,
      marker1,
      initialCommit,
    );
    if (!firstAction) {
      const evidence = await diagnoseAction(
        sandbox,
        path1,
        marker1,
        initialCommit,
      );
      throw new Error(
        `${runtimeId} headless new did not produce a committed action ` +
          `${JSON.stringify({
            boundaryBeforeSetup,
            boundaryBeforeLaunch,
            evidence,
            events: firstTranscript.eventCounts,
            signals: firstTranscript.diagnosticSignals,
          })}`,
      );
    }
    const previousSessionId =
      runtimeId === 'claude-code'
        ? sessionId
        : firstTranscript.runtimeSessionId;
    assert(previousSessionId, 'Codex headless transcript has no resumable session id');

    const ctx2 = launchContext(resumeTaskId, sessionId);
    await applyRuntimeSetup(
      sandbox,
      runtime,
      {
        taskId: resumeTaskId,
        workspaceDir: WORKSPACE,
        prompt: actionPrompt(marker2, path2, 'headless resume'),
      },
      authMaterial(runtimeId, credentials),
    );
    const resumeLine = runtime.buildResumeLine(ctx2, previousSessionId);
    assertNoSecrets(resumeLine, `${runtimeId} resume launch line`);
    await execStrict(sandbox, resumeLine, 30_000, 'headless resume launch');
    const resumeObservation = await observeHeadlessExit(
      sandbox,
      resumeTaskId,
      runtimeId,
    );
    const resumeExit = resumeObservation.exitCode;
    assert(resumeExit === 0, `${runtimeId} headless resume exited ${resumeExit}`);
    const resumedTranscript = await readTranscript(sandbox, runtime, {
      taskId: resumeTaskId,
      sessionId,
    }, [marker1, marker2]);
    assert(
      resumedTranscript.runtimeSessionId === previousSessionId,
      `${runtimeId} resume changed runtime session identity`,
    );
    assert(
      resumedTranscript.bytes > firstTranscript.bytes &&
        resumedTranscript.sha256 !== firstTranscript.sha256,
      `${runtimeId} resume did not extend the prior transcript`,
    );
    const resumedAction = await readAction(
      sandbox,
      path2,
      marker2,
      firstAction.commit,
    );
    if (!resumedAction) {
      const evidence = await diagnoseAction(
        sandbox,
        path2,
        marker2,
        firstAction.commit,
      );
      throw new Error(
        `${runtimeId} headless resume did not produce a committed action ` +
          `${JSON.stringify({
            evidence,
            events: resumedTranscript.eventCounts,
            signals: resumedTranscript.diagnosticSignals,
          })}`,
      );
    }

    const processArgs = await commandOutput(
      sandbox,
      "for f in /proc/[0-9]*/cmdline; do tr '\\000' ' ' < \"$f\" 2>/dev/null; printf '\\n'; done",
    );
    assertNoSecrets(processArgs, `${runtimeId} headless process argv`);
    await cleanupRuntimePrivateState(sandbox, runtime);
    await sandbox.captureProviderLogs();
    const cleanup = await sandbox.cleanupAndConfirm();
    return {
      result: 'PASS',
      provider: options.provider,
      runtime: runtimeId,
      mode: 'headless-exec-new-resume',
      orchestrationCoverage: {
        newLaunch: 'production-openSandboxTerminalPty',
        resume: 'runtime-provider-detached-command-compatibility',
      },
      sandboxId: sandbox.id,
      taskIds: [newTaskId, resumeTaskId],
      sessionId: previousSessionId,
      exits: [newExit, resumeExit],
      productionLifecycleExit,
      headlessObservations: [newObservation, resumeObservation],
      actions: [firstAction, resumedAction],
      transcripts: [firstTranscript, resumedTranscript],
      cleanup,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await finalizeCanaryCleanup(primaryError, [
      () => productionTerminal?.close(),
      () => sandbox.forceCleanup(),
    ]);
  }
}

async function createSandbox(options, label) {
  const suffix = shortId();
  const taskId = safeTaskId(`cap-yolo-${label}-${suffix}`);
  let sandbox;
  if (options.provider === 'boxlite') {
    sandbox = await BoxLiteCanarySandbox.create(options, taskId);
  } else {
    sandbox = await AioCanarySandbox.create(options, taskId);
  }
  return sandbox;
}

function registerSandboxCleanup(sandbox) {
  cleanupStack.push(() => sandbox.forceCleanup());
}

class BaseCanarySandbox {
  constructor(id) {
    this.id = id;
    this.commands = [];
    this.requestBodies = [];
    this.privateArchiveUploads = 0;
    this.privateArchiveRequestBodies = 0;
    this.privatePaths = new Set();
    this.cleaned = false;
  }

  recordBody(body, channel = 'ordinary') {
    if (typeof body === 'string') {
      this.requestBodies.push(body);
      assertNoSecrets(body, 'ordinary provider request body');
    } else if (body !== undefined && body !== null) {
      assert(
        channel === 'private-archive',
        'binary provider request body used a non-private endpoint',
      );
      this.privateArchiveRequestBodies += 1;
    }
  }

  async exec(command, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.commands.push(command);
    assertNoSecrets(command, 'sandbox exec command');
    const result = await this.execImpl(command, timeoutMs);
    const normalized = {
      exitCode: Number(result.exitCode),
      output: String(result.output ?? result.stdout ?? ''),
      timedOut: result.timedOut === true,
    };
    assertNoSecrets(normalized.output, 'sandbox exec output');
    return normalized;
  }

  trackPrivatePaths(paths) {
    for (const path of paths) this.privatePaths.add(path);
  }

  notePrivateArchiveUpload() {
    this.privateArchiveUploads += 1;
  }

  async provePrivatePathsAbsent() {
    if (this.privatePaths.size === 0) return;
    const tests = [...this.privatePaths]
      .sort()
      .map((path) => `test ! -e ${shellQuote(path)}`)
      .join(' && ');
    await execStrict(this, tests, 30_000, 'private path absence');
  }

  async forceCleanup() {
    if (this.cleaned) return;
    await this.deleteAndConfirm();
    this.cleaned = true;
  }
}

class BoxLiteCanarySandbox extends BaseCanarySandbox {
  static async create(options, taskId) {
    const instance = new BoxLiteCanarySandbox(taskId);
    instance.baseUrl = normalizeUrl(options.endpoint);
    instance.providerLogFile = options.providerLogFile;
    instance.providerLogStart = options.providerLogFile
      ? providerLogCursor(options.providerLogFile)
      : null;
    instance.apiToken = process.env.BOXLITE_API_TOKEN;
    instance.fetchImpl = async (input, init = {}) => {
      instance.recordBody(
        init.body,
        isBoxLitePrivateArchiveRequest(input, init)
          ? 'private-archive'
          : 'ordinary',
      );
      return fetch(input, init);
    };
    instance.client = new BoxLiteRestClient({
      baseUrl: instance.baseUrl,
      apiToken: instance.apiToken,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      protocolMode: 'native',
      pathPrefix: 'default',
      fetch: instance.fetchImpl,
    });
    let created;
    try {
      created = await instance.client.createSandbox({
        taskId,
        sandboxId: taskId,
        ...(options.rootfs
          ? { rootfsPath: options.rootfs }
          : { image: options.image }),
        diskSizeGb: 8,
        metadata: {
          'cap.resource-purpose': 'enable-yolo-agent-launch-canary',
        },
      });
    } catch (error) {
      try {
        await cleanupUnsettledBoxLiteCreate(instance.client, taskId, error);
      } catch {
        throw new Error(
          'BoxLite create failed and exact canary cleanup could not be confirmed',
        );
      }
      throw error;
    }
    instance.id = created.id;
    // Register as soon as the provider identity is known. Adapter construction
    // and every later initialization step are now covered by exact cleanup.
    registerSandboxCleanup(instance);
    instance.adapter = createBoxLiteWorkspaceSecurityAdapter({
      client: instance.client,
      sandboxId: instance.id,
      taskId,
      deletionConfirmation: { waitForRetry: async () => delay(50) },
    });
    instance.runtimePrivateFiles = instance.adapter.runtimePrivateFiles;
    return instance;
  }

  async execImpl(command, timeoutMs) {
    return this.client.exec({
      sandboxId: this.id,
      command,
      cwd: '/home/gem',
      timeoutMs,
    });
  }

  async readTranscriptBytes(dir) {
    return this.client.downloadArchive({ sandboxId: this.id, path: dir });
  }

  async settlePrivateFiles() {
    await this.adapter.settleCredentialSafety();
  }

  async captureProviderLogs() {
    assertNoSecrets(this.requestBodies.join('\n'), 'BoxLite request capture');
    assertNoSecrets(this.commands.join('\n'), 'BoxLite command capture');
    if (!this.providerLogFile) {
      this.providerLogEvidence = {
        daemonLogScanned: false,
        bytes: 0,
        sha256: null,
      };
      return;
    }
    const logs = await readProviderLogDelta(
      this.providerLogFile,
      this.providerLogStart,
    );
    try {
      assertNoSecrets(logs, 'BoxLite daemon log');
      this.providerLogEvidence = {
        daemonLogScanned: true,
        bytes: logs.byteLength,
        sha256: sha256(logs),
      };
    } finally {
      logs.fill(0);
    }
  }

  async cleanupAndConfirm() {
    await this.provePrivatePathsAbsent();
    await this.settlePrivateFiles();
    await this.provePrivatePathsAbsent();
    await this.deleteAndConfirm();
    await delay(250);
    await this.captureProviderLogs();
    this.cleaned = true;
    return {
      result: 'confirmed-absent',
      providerSandboxId: this.id,
      privatePathsChecked: this.privatePaths.size,
      ordinaryRequestBodiesScanned: this.requestBodies.length,
      privateArchiveUploads: this.privateArchiveUploads,
      privateArchiveRequestBodies: this.privateArchiveRequestBodies,
      providerLogs: this.providerLogEvidence,
    };
  }

  async deleteAndConfirm() {
    await deleteBoxLiteSandboxAndConfirm({
      client: this.client,
      sandboxId: this.id,
      waitForRetry: async () => delay(50),
    });
  }

  async forceCleanup() {
    if (this.cleaned) return;
    let deletionFailed = false;
    let logScanFailed = false;
    try {
      await this.deleteAndConfirm();
      this.cleaned = true;
    } catch {
      deletionFailed = true;
    }
    try {
      await delay(250);
      await this.captureProviderLogs();
    } catch {
      logScanFailed = true;
    }
    if (deletionFailed || logScanFailed) {
      throw new Error(
        'BoxLite canary cleanup or provider-log confirmation failed',
      );
    }
  }
}

async function cleanupUnsettledBoxLiteCreate(client, taskId, error) {
  const observedId =
    error &&
    typeof error === 'object' &&
    error.sandbox &&
    typeof error.sandbox === 'object' &&
    typeof error.sandbox.id === 'string'
      ? error.sandbox.id
      : null;
  if (observedId) {
    await deleteBoxLiteSandboxAndConfirm({
      client,
      sandboxId: observedId,
      waitForRetry: async () => delay(50),
    });
    return;
  }

  // Native BoxLite preserves the requested create `name`; BoxLiteRestClient
  // maps that field back to taskId so a lost create response is recoverable.
  const matches = (await client.listSandboxes()).filter(
    (sandbox) => sandbox.taskId === taskId,
  );
  for (const sandbox of matches) {
    await deleteBoxLiteSandboxAndConfirm({
      client,
      sandboxId: sandbox.id,
      waitForRetry: async () => delay(50),
    });
  }
}

function providerLogCursor(path) {
  const stat = statSync(path);
  assert(stat.isFile(), 'BoxLite daemon log is not a regular file');
  return { dev: stat.dev, ino: stat.ino, size: stat.size };
}

async function readProviderLogDelta(path, start) {
  assert(start, 'BoxLite daemon log cursor is unavailable');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fd = openSync(path, 'r');
    let logs = null;
    let stable = false;
    try {
      const before = fstatSync(fd);
      assert(
        before.isFile() &&
          before.dev === start.dev &&
          before.ino === start.ino &&
          before.size >= start.size,
        'BoxLite daemon log was rotated, replaced, or truncated',
      );
      const deltaBytes = before.size - start.size;
      assert(
        deltaBytes <= MAX_PROVIDER_LOG_BYTES,
        'BoxLite daemon log delta exceeds 64 MiB',
      );
      logs = Buffer.alloc(deltaBytes);
      let offset = 0;
      while (offset < logs.byteLength) {
        const bytesRead = readSync(
          fd,
          logs,
          offset,
          logs.byteLength - offset,
          start.size + offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = fstatSync(fd);
      assert(offset === logs.byteLength, 'BoxLite daemon log read was incomplete');
      stable = after.size === before.size;
    } catch (error) {
      logs?.fill(0);
      throw error;
    } finally {
      closeSync(fd);
    }
    if (stable) return logs;
    logs?.fill(0);
    await delay(100);
  }
  throw new Error('BoxLite daemon log did not settle for a bounded read');
}

class AioCanarySandbox extends BaseCanarySandbox {
  static async create(options, taskId) {
    const instance = new AioCanarySandbox(taskId);
    instance.docker = new Docker();
    instance.fetchImpl = async (input, init = {}) => {
      instance.recordBody(init.body);
      return fetch(input, init);
    };
    instance.controller = new AioSandboxContainerController({
      docker: instance.docker,
      fetch: instance.fetchImpl,
      env: {
        AIO_SANDBOX_IMAGE: options.image,
        AIO_SANDBOX_NETWORK: options.network,
      },
    });
    let created;
    try {
      created = await instance.controller.createAndStart(taskId, null, {
        'cap.resource-purpose': 'enable-yolo-agent-launch-canary',
      });
    } catch (error) {
      try {
        // AIO names containers deterministically from taskId, so even a lost
        // create response can be fenced, removed, and confirmed absent.
        await instance.controller.removeSandboxAndConfirm(taskId);
      } catch {
        throw new Error(
          'AIO create failed and exact canary cleanup could not be confirmed',
        );
      }
      throw error;
    }
    instance.container = created.container;
    instance.providerSandboxId = created.providerSandboxId;
    registerSandboxCleanup(instance);
    const inspected = await created.container.inspect();
    const ip = inspected?.NetworkSettings?.Networks?.[options.network]?.IPAddress;
    assert(ip, `AIO container has no address on ${options.network}`);
    instance.baseUrl = `http://${ip}:8080`;
    instance.wsUrl = `ws://${ip}:8080/v1/shell/ws`;
    await instance.controller.waitForReadiness({
      taskId,
      baseUrl: instance.baseUrl,
      timeoutMs: 120_000,
    });
    instance.runtimePrivateFiles = createAioRuntimePrivateFilePort({
      taskId,
      controller: instance.controller,
      executor: {
        exec: (request) => instance.exec(request.command, request.timeoutMs),
      },
    });
    return instance;
  }

  async execImpl(command, timeoutMs) {
    const result = await this.controller.runSandboxExec(this.baseUrl, command, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return result;
  }

  async readNewestTranscript(dir, glob) {
    return this.controller.readSingleNewestJsonl(this.id, dir, glob);
  }

  async settlePrivateFiles() {}

  async captureProviderLogs() {
    assertNoSecrets(this.requestBodies.join('\n'), 'AIO request capture');
    assertNoSecrets(this.commands.join('\n'), 'AIO command capture');
    const logs = Buffer.from(
      await this.container.logs({ stdout: true, stderr: true }),
    );
    try {
      assertNoSecrets(logs, 'AIO Docker logs');
      this.providerLogEvidence = {
        containerLogScanned: true,
        bytes: logs.byteLength,
        sha256: sha256(logs),
      };
    } finally {
      logs.fill(0);
    }
  }

  async cleanupAndConfirm() {
    await this.provePrivatePathsAbsent();
    await this.captureProviderLogs();
    await this.deleteAndConfirm();
    this.cleaned = true;
    return {
      result: 'confirmed-absent',
      providerSandboxId: this.providerSandboxId,
      privatePathsChecked: this.privatePaths.size,
      ordinaryRequestBodiesScanned: this.requestBodies.length,
      privateArchiveUploads: this.privateArchiveUploads,
      privateArchiveRequestBodies: this.privateArchiveRequestBodies,
      providerLogs: this.providerLogEvidence,
    };
  }

  async deleteAndConfirm() {
    await this.controller.removeSandboxAndConfirm(
      this.id,
      undefined,
      this.providerSandboxId,
    );
  }

  async forceCleanup() {
    if (this.cleaned) return;
    let logScanFailed = false;
    let deletionFailed = false;
    try {
      await this.captureProviderLogs();
    } catch {
      logScanFailed = true;
    }
    try {
      await this.deleteAndConfirm();
      this.cleaned = true;
    } catch {
      deletionFailed = true;
    }
    if (logScanFailed || deletionFailed) {
      throw new Error('AIO canary cleanup or provider-log confirmation failed');
    }
  }
}

async function openProductionTerminalCapture({
  sandbox,
  taskId,
  runtime,
  mode,
  executionMode = 'interactive-pty',
}) {
  const { connection, selectedRun } = productionTerminalTarget(sandbox, taskId);
  const exits = [];
  let runtimeSetupFailure = null;
  const pty = openSandboxTerminalPty({
    connection,
    selectedRun,
    mode,
    ...(mode === 'launch-or-attach'
      ? {
          resolveTaskLaunchContext: async () => ({
            runtime,
            executionMode,
            modelIntent: { kind: 'runtime-default' },
          }),
        }
      : {}),
    onExit: (status) => exits.push(status),
    onRuntimeSetupFailure: (code) => {
      runtimeSetupFailure = code;
    },
  });
  const capture = new ProductionTerminalCapture(
    pty,
    INTERACTIVE_COLS,
    INTERACTIVE_ROWS,
    exits,
  );
  // The transport can still be connecting here, so send once immediately and
  // once after the launch decision; the latter is the authoritative geometry.
  pty.resize(INTERACTIVE_COLS, INTERACTIVE_ROWS);
  capture.launchOutcome = await capture.guard(
    withTimeout(
      pty.launchDecision,
      60_000,
      'production terminal launch decision timed out',
    ),
  );
  pty.resize(INTERACTIVE_COLS, INTERACTIVE_ROWS);
  assert(!runtimeSetupFailure, 'production terminal reported runtime setup failure');
  if (executionMode === 'interactive-pty') {
    assert(exits.length === 0, 'production terminal exited before canary observation');
  }
  return capture;
}

function productionTerminalTarget(sandbox, taskId) {
  if (sandbox instanceof BoxLiteCanarySandbox) {
    const connection = {
      taskId,
      baseUrl:
        `${sandbox.baseUrl}/v1/default/boxes/` + encodeURIComponent(sandbox.id),
      wsUrl: httpToWs(sandbox.baseUrl),
    };
    const provider = {
      createCommandExecutor: (sandboxId) =>
        createBoxLiteCommandExecutor({
          client: sandbox.client,
          sandboxId,
        }),
    };
    return {
      connection,
      selectedRun: {
        taskId,
        providerId: 'boxlite-yolo-canary',
        providerSandboxId: sandbox.id,
        provider,
        capabilities: [
          'terminal.websocket',
          'terminal.interactive',
          'command.exec',
        ],
        connection,
        terminal: {
          protocol: 'boxlite-v1',
          wsUrl: httpToWs(sandbox.baseUrl),
          metadata: {
            endpoint: sandbox.baseUrl,
            sandboxId: sandbox.id,
            pathPrefix: 'default',
            workspacePath: WORKSPACE,
            protocolMode: 'native',
          },
        },
        command: {
          protocol: 'boxlite-exec-v1',
          baseUrl: sandbox.baseUrl,
          workingDirectory: WORKSPACE,
          metadata: { sandboxId: sandbox.id },
        },
      },
    };
  }

  const connection = {
    taskId,
    baseUrl: sandbox.baseUrl,
    wsUrl: sandbox.wsUrl,
  };
  return {
    connection,
    selectedRun: {
      taskId,
      providerId: 'aio-yolo-canary',
      providerSandboxId: sandbox.providerSandboxId,
      provider: sandbox.controller,
      capabilities: [
        'terminal.websocket',
        'terminal.interactive',
        'command.exec',
      ],
      connection,
      terminal: { protocol: 'aio-json-v1', wsUrl: sandbox.wsUrl },
      command: {
        protocol: 'aio-http-exec-v1',
        baseUrl: sandbox.baseUrl,
        workingDirectory: WORKSPACE,
      },
    },
  };
}

class ProductionTerminalCapture {
  constructor(pty, cols, rows, exitStatuses = []) {
    this.pty = pty;
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 0,
    });
    this.chunks = [];
    this.bytes = 0;
    this.attachBootstrapBytes = 0;
    this.lastOutputAt = 0;
    this.closed = false;
    this.launchOutcome = null;
    this.exitStatuses = exitStatuses;
    this.fatalError = null;
    this.fatalSignal = new Promise((resolve) => {
      this.resolveFatal = resolve;
    });
    this.subscription = pty.onData((chunk, meta) => {
      try {
        const bytes = Buffer.from(chunk, 'utf8');
        this.bytes += bytes.byteLength;
        if (meta?.recordable === false || meta?.source === 'attach-bootstrap') {
          this.attachBootstrapBytes += bytes.byteLength;
        }
        if (this.bytes > MAX_TERMINAL_BYTES) {
          throw new Error('production terminal exceeded the bounded capture size');
        }
        assertNoSecrets(bytes, 'production terminal output');
        this.chunks.push(bytes);
        this.lastOutputAt = Date.now();
        this.term.write(chunk);
      } catch (error) {
        this.fail(error);
      }
    });
  }

  fail(error) {
    if (this.fatalError) return;
    this.fatalError =
      error instanceof Error ? error : new Error('production terminal capture failed');
    this.resolveFatal(this.fatalError);
  }

  guard(promise) {
    this.assertHealthy();
    return Promise.race([
      promise,
      this.fatalSignal.then((error) => {
        throw error;
      }),
    ]);
  }

  async waitForOutput(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertHealthy();
      if (this.bytes > 0) return;
      await delay(50);
    }
    throw new Error('production terminal produced no output');
  }

  async waitForQuiet(windowMs, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertHealthy();
      if (this.lastOutputAt > 0 && Date.now() - this.lastOutputAt >= windowMs) return;
      await delay(50);
    }
    throw new Error('production terminal output did not become quiet');
  }

  async waitForExit(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertHealthy();
      if (this.exitStatuses.length > 0) return this.exitStatuses[0];
      await delay(50);
    }
    throw new Error('production terminal lifecycle did not report an exit');
  }

  drain() {
    this.assertHealthy();
    return new Promise((resolve) => this.term.write('', resolve));
  }

  rawOutput() {
    this.assertHealthy();
    return Buffer.concat(this.chunks);
  }

  canonicalState() {
    this.assertHealthy();
    return canonicalTerminalState(this.term, this.cols, this.rows);
  }

  assertHealthy() {
    if (this.fatalError) throw this.fatalError;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.subscription.dispose();
    this.pty.close?.();
    await delay(250);
    this.term.dispose();
  }
}

function canonicalTerminalState(term, cols, rows) {
  const buffer = term.buffer.active;
  const cells = [];
  const visibleLines = [];
  let nonBlankCells = 0;
  for (let row = 0; row < rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    const serializedLine = [];
    let visibleLine = '';
    for (let col = 0; col < cols; col += 1) {
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
              callCell(cell, 'isOverline'),
            ]
          : null,
      );
    }
    cells.push(serializedLine);
    visibleLines.push(visibleLine.replace(/\s+$/u, ''));
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
    hash: sha256(canonical),
    visibleText: visibleLines.join('\n'),
    nonBlankCells,
  };
}

function callCell(cell, method) {
  return typeof cell[method] === 'function' ? cell[method]() : null;
}

function compareTerminalStates(first, second) {
  let differingCells = 0;
  for (let row = 0; row < Math.max(first.cells.length, second.cells.length); row += 1) {
    const firstRow = first.cells[row] ?? [];
    const secondRow = second.cells[row] ?? [];
    for (let col = 0; col < Math.max(firstRow.length, secondRow.length); col += 1) {
      if (JSON.stringify(firstRow[col]) !== JSON.stringify(secondRow[col])) {
        differingCells += 1;
      }
    }
  }
  return {
    canonicalEqual: first.canonical === second.canonical,
    firstStateSha256: first.hash,
    secondStateSha256: second.hash,
    visibleTextEqual: first.visibleText === second.visibleText,
    firstVisibleTextSha256: sha256(first.visibleText),
    secondVisibleTextSha256: sha256(second.visibleText),
    firstNonBlankCells: first.nonBlankCells,
    secondNonBlankCells: second.nonBlankCells,
    firstBufferType: first.bufferType,
    secondBufferType: second.bufferType,
    firstCursor: [first.cursorX, first.cursorY],
    secondCursor: [second.cursorX, second.cursorY],
    modesEqual: JSON.stringify(first.modes) === JSON.stringify(second.modes),
    differingCells,
  };
}

async function initializeWorkspace(sandbox) {
  const result = await execStrict(
    sandbox,
    // Match the production workspace materializer: the image may contain a
    // root-owned placeholder, so remove it and let the sandbox user recreate
    // the task workspace before Git touches it. Initializing inside the image
    // placeholder would trigger Git's dubious-ownership guard on BoxLite.
    `rm -rf -- ${WORKSPACE} && mkdir -p -- ${WORKSPACE} && cd ${WORKSPACE} && ` +
      `git init -q && git config user.email cap-canary@example.invalid && ` +
      `git config user.name 'CAP Canary' && printf '%s\\n' '# YOLO canary' > README.md && ` +
      `git add README.md && git commit -qm 'initialize canary' && git rev-parse HEAD`,
    30_000,
    'workspace initialization',
  );
  const commit = result.output.trim().split(/\r?\n/u).at(-1) ?? '';
  assert(/^[0-9a-f]{40}$/u.test(commit), 'workspace initial commit is invalid');
  return commit;
}

async function applyRuntimeSetup(sandbox, runtime, ctx, material) {
  const plan = runtime.sandboxSetupCommands(ctx, material);
  assert(plan.ok === true, `${runtime.id} setup plan rejected the canary credential`);
  // SandboxRuntimePrivateFile deliberately exposes neither path nor bytes.
  // Track the runtime contract's fixed safe paths independently instead of
  // weakening the opaque private-file boundary for test introspection.
  sandbox.trackPrivatePaths(RUNTIME_PRIVATE_PATHS[runtime.id]);
  for (const entry of plan.commands) {
    assertNoSecrets(JSON.stringify(entry), `${runtime.id} serialized setup plan`);
    for (const file of entry.privateFiles ?? []) {
      await sandbox.runtimePrivateFiles.writeFile(file);
      sandbox.notePrivateArchiveUpload();
    }
    const result = await sandbox.exec(entry.command, 30_000);
    const failed = Number.isNaN(result.exitCode)
      ? !entry.tolerateUnresolvedExit
      : result.exitCode !== 0;
    assert(!failed && !result.timedOut, `${runtime.id} setup command failed`);
  }
}

async function probeClaudePrivateArchiveIsolation(sandbox, initialCommit) {
  const runtime = new ClaudeCodeRuntime();
  let writeOrdinal = 0;
  const plan = runtime.sandboxSetupCommands(
    {
      taskId: safeTaskId(`private-archive-probe-${shortId()}`),
      workspaceDir: WORKSPACE,
      prompt: 'provider private archive isolation probe',
    },
    { oauthToken: 'cap-private-archive-probe-placeholder' },
  );
  assert(plan.ok === true, 'Claude private archive probe setup was rejected');
  sandbox.trackPrivatePaths(RUNTIME_PRIVATE_PATHS[runtime.id]);
  try {
    const firstCommandFiles = [...(plan.commands[0]?.privateFiles ?? [])];
    const promptFiles = [...(plan.commands[1]?.privateFiles ?? [])];
    assert(
      firstCommandFiles.length === 4 && promptFiles.length === 1,
      'Claude private archive probe file contract changed',
    );
    const orderedCases = [
      ['launch-env-nested-directory', firstCommandFiles[0]],
      ['settings-leaf-nested-directory', firstCommandFiles[1]],
      ['hidden-leaf-runtime-home', firstCommandFiles[2]],
      ['hidden-leaf-nested-directory', firstCommandFiles[3]],
      ['prompt-leaf-nested-directory', promptFiles[0]],
    ];
    for (const [probeCase, file] of orderedCases) {
      writeOrdinal += 1;
      await sandbox.runtimePrivateFiles.writeFile(file);
      sandbox.notePrivateArchiveUpload();
      const preserved = await sandbox.exec(
        `cd ${WORKSPACE} && test "$(git rev-parse HEAD)" = ` +
          `${shellQuote(initialCommit)} && git cat-file -e ` +
          `${shellQuote(`${initialCommit}^{commit}`)}`,
        10_000,
      );
      if (preserved.exitCode !== 0 || preserved.timedOut) {
        const snapshot = await inspectWorkspaceBoundary(sandbox, initialCommit);
        throw new Error(
          `BoxLite private archive write ${writeOrdinal} changed the Git repository ` +
            JSON.stringify({ probeCase, snapshot }),
        );
      }
    }
    const verificationScript = `
      const fs = require('node:fs');
      const paths = [
        '/home/gem/.claude/launch-env.sh',
        '/home/gem/.claude/settings.json',
        '/home/gem/.claude.json',
        '/home/gem/.claude/.claude.json',
        '/home/gem/.claude/task-prompt.txt',
      ];
      for (const path of paths) {
        if (!fs.statSync(path).isFile() || (fs.statSync(path).mode & 0o777) !== 0o600) {
          process.exit(10);
        }
      }
      const settings = JSON.parse(fs.readFileSync(paths[1], 'utf8'));
      if (settings?.permissions?.skipDangerousModePermissionPrompt !== true) {
        process.exit(11);
      }
      const home = JSON.parse(fs.readFileSync(paths[2], 'utf8'));
      const config = JSON.parse(fs.readFileSync(paths[3], 'utf8'));
      if (JSON.stringify(home) !== JSON.stringify(config)) process.exit(12);
      if (
        home?.theme !== 'dark' ||
        home?.hasCompletedOnboarding !== true ||
        home?.hasAcknowledgedCostThreshold !== true ||
        home?.bypassPermissionsModeAccepted !== true ||
        home?.projects?.['/home/gem/workspace']?.hasTrustDialogAccepted !== true ||
        home?.projects?.['/home/gem/workspace']?.hasCompletedProjectOnboarding !== true
      ) {
        process.exit(13);
      }
      const launch = fs.readFileSync(paths[0], 'utf8');
      if (
        !launch.startsWith('export CLAUDE_CODE_OAUTH_TOKEN=') ||
        !launch.includes('unset ANTHROPIC_API_KEY') ||
        !launch.includes('unset ANTHROPIC_AUTH_TOKEN')
      ) {
        process.exit(14);
      }
    `;
    await execStrict(
      sandbox,
      `node -e ${shellQuote(verificationScript)}`,
      30_000,
      'Claude fresh settings/onboarding verification',
    );
    return {
      result: 'PASS',
      writes: writeOrdinal,
      repositoryPreservedAfterEveryWrite: true,
      freshFiles: {
        checked: 5,
        modes: '0600',
        settingsAcknowledgement: true,
        onboardingCopiesIdentical: true,
        workspaceTrustPreseeded: true,
      },
    };
  } finally {
    await cleanupRuntimePrivateState(sandbox, runtime);
  }
}

async function assertFreshRuntimeFiles(sandbox, runtimeId) {
  const command =
    runtimeId === 'codex'
      ? "test -s /home/gem/.codex/config.toml && test \"$(stat -c %a /home/gem/.codex/config.toml)\" = 600 && test -s /home/gem/.codex/auth.json && test \"$(stat -c %a /home/gem/.codex/auth.json)\" = 600"
      : "for p in /home/gem/.claude/launch-env.sh /home/gem/.claude/settings.json /home/gem/.claude.json /home/gem/.claude/.claude.json; do test -s \"$p\" && test \"$(stat -c %a \"$p\")\" = 600 || exit 1; done";
  await execStrict(sandbox, command, 30_000, `${runtimeId} private file modes`);
}

async function cleanupRuntimePrivateState(sandbox, runtime) {
  for (const command of runtime.preStopTrimCommands()) {
    await execStrict(sandbox, command, 30_000, `${runtime.id} private cleanup`);
  }
  await sandbox.settlePrivateFiles();
  await sandbox.provePrivatePathsAbsent();
}

async function waitForSession(sandbox, taskId, terminal = null) {
  await waitUntil(async () => {
    const result = await sandbox.exec(
      `tmux has-session -t ${shellQuote(detachedSessionName(taskId))}`,
      5_000,
    );
    return result.exitCode === 0;
  }, 30_000, 'detached tmux session did not start', () => terminal?.assertHealthy());
}

async function waitForTmuxGeometry(sandbox, taskId, cols, rows, terminal = null) {
  const expected = `${cols}x${rows}`;
  await waitUntil(async () => {
    const result = await sandbox.exec(
      `tmux display-message -p -t ${shellQuote(detachedSessionName(taskId))} ` +
        `'#{window_width}x#{window_height}'`,
      5_000,
    );
    return result.exitCode === 0 && result.output.trim() === expected;
  }, 15_000, 'production terminal geometry did not converge', () => terminal?.assertHealthy());
}

async function sessionIdentity(sandbox, taskId) {
  const name = shellQuote(detachedSessionName(taskId));
  const value = await commandOutput(
    sandbox,
    `tmux display-message -p -t ${name} '#{session_id}|#{pane_id}|#{pane_pid}|#{pane_start_command}'`,
  );
  assert(value.trim(), 'tmux pane identity is empty');
  assertNoSecrets(value, 'tmux pane identity');
  return value.trim();
}

async function waitForAction(
  sandbox,
  path,
  marker,
  previousCommit,
  terminal = null,
) {
  let action = null;
  let observationFailures = 0;
  await waitUntil(async () => {
    try {
      action = await readAction(sandbox, path, marker, previousCommit);
    } catch {
      observationFailures += 1;
      assert(
        observationFailures <= 5,
        'provider repeatedly failed the canary action observation probe',
      );
      return false;
    }
    return action !== null;
  }, DEFAULT_TIMEOUT_MS, 'agent did not complete the write/git action', () =>
    terminal?.assertHealthy(),
  );
  return { ...action, observationFailures };
}

async function readAction(sandbox, path, marker, previousCommit) {
  const result = await sandbox.exec(
    `cd ${WORKSPACE} && test -f ${shellQuote(path)} && ` +
      `test \"$(cat ${shellQuote(path)})\" = ${shellQuote(marker)} && ` +
      `test \"$(git show ${shellQuote(`HEAD:${path}`)})\" = ${shellQuote(marker)} && ` +
      `head=$(git rev-parse HEAD) && test \"$head\" != ${shellQuote(previousCommit)} && ` +
      `git merge-base --is-ancestor ${shellQuote(previousCommit)} \"$head\" && ` +
      `test -z \"$(git status --porcelain)\" && printf '%s\\n' \"$head\"`,
    10_000,
  );
  if (result.exitCode !== 0 || result.timedOut) return null;
  const commit = result.output.trim().split(/\r?\n/u).at(-1) ?? '';
  return /^[0-9a-f]{40}$/u.test(commit) ? { marker, path, commit } : null;
}

async function diagnoseAction(sandbox, path, marker, previousCommit) {
  const checks = {
    gitDirectoryExists: 'test -d .git',
    gitRepositoryReadable: 'git rev-parse --is-inside-work-tree >/dev/null',
    fileExists: `test -f ${shellQuote(path)}`,
    worktreeContentMatches:
      `test \"$(cat ${shellQuote(path)} 2>/dev/null)\" = ${shellQuote(marker)}`,
    committedContentMatches:
      `test \"$(git show ${shellQuote(`HEAD:${path}`)} 2>/dev/null)\" = ` +
      shellQuote(marker),
    previousCommitIsAncestor:
      `git merge-base --is-ancestor ${shellQuote(previousCommit)} HEAD`,
    fileTracked: `git ls-files --error-unmatch -- ${shellQuote(path)} >/dev/null`,
    fileHasNoStagedDiff:
      `git diff --cached --quiet -- ${shellQuote(path)}`,
  };
  const evidence = {};
  for (const [key, command] of Object.entries(checks)) {
    const result = await sandbox.exec(`cd ${WORKSPACE} && ${command}`, 10_000);
    evidence[key] = result.exitCode === 0 && !result.timedOut;
  }
  const head = await sandbox.exec(
    `cd ${WORKSPACE} && git rev-parse HEAD && git rev-list --count HEAD`,
    10_000,
  );
  const lines = head.output.trim().split(/\r?\n/u);
  const currentCommit = lines[0] ?? '';
  evidence.headChanged =
    head.exitCode === 0 &&
    /^[0-9a-f]{40}$/u.test(currentCommit) &&
    currentCommit !== previousCommit;
  evidence.commitCount = /^\d+$/u.test(lines[1] ?? '')
    ? Number(lines[1])
    : null;
  const status = await sandbox.exec(
    `cd ${WORKSPACE} && git status --porcelain`,
    10_000,
  );
  evidence.gitStatusSucceeded = status.exitCode === 0 && !status.timedOut;
  evidence.worktreeClean =
    evidence.gitStatusSucceeded && status.output.trim().length === 0;
  evidence.boundaryAfterLaunch = await inspectWorkspaceBoundary(
    sandbox,
    previousCommit,
  );
  return evidence;
}

async function inspectWorkspaceBoundary(sandbox, expectedCommit = null) {
  const checks = {
    workspaceDirectoryExists: 'test -d .',
    workspaceReadable: 'test -r .',
    workspaceWritable: 'test -w .',
    workspaceSearchable: 'test -x .',
    gitDirectoryExists: 'test -d .git',
    gitDirectoryIsSymlink: 'test -L .git',
    gitDirectoryReadable: 'test -r .git',
    gitDirectoryWritable: 'test -w .git',
    gitDirectorySearchable: 'test -x .git',
    gitHeadExists: 'test -e .git/HEAD',
    gitHeadReadable: 'test -r .git/HEAD',
    gitConfigExists: 'test -e .git/config',
    gitConfigRegularFile: 'test -f .git/config',
    gitConfigReadable: 'test -r .git/config',
    gitConfigParses:
      'test "$(git config --file .git/config --get core.repositoryformatversion 2>/dev/null)" = 0',
    gitIndexExists: 'test -e .git/index',
    gitIndexReadable: 'test -r .git/index',
    gitIndexLockExists: 'test -e .git/index.lock',
    gitExecutableAvailable: 'command -v git >/dev/null',
    gitObjectsDirectoryExists: 'test -d .git/objects',
    gitRefsDirectoryExists: 'test -d .git/refs',
    repositoryRecognized: 'git rev-parse --is-inside-work-tree >/dev/null',
    headObjectReadable: 'git cat-file -e HEAD^{commit}',
    explicitGitDirectoryReadable:
      `git --git-dir=${WORKSPACE}/.git --work-tree=${WORKSPACE} ` +
      'rev-parse --verify HEAD >/dev/null',
    workspaceSafeDirectoryConfigured:
      `git config --global --get-all safe.directory 2>/dev/null | ` +
      `grep -Fqx ${shellQuote(WORKSPACE)}`,
  };
  const result = {};
  for (const [key, command] of Object.entries(checks)) {
    const check = await sandbox.exec(
      `cd ${WORKSPACE} && ${command}`,
      10_000,
    );
    result[key] = check.exitCode === 0 && !check.timedOut;
  }

  for (const [key, path] of [
    ['workspaceStat', '.'],
    ['gitDirectoryStat', '.git'],
    ['gitHeadStat', '.git/HEAD'],
    ['gitConfigStat', '.git/config'],
    ['gitIndexStat', '.git/index'],
  ]) {
    const stat = await sandbox.exec(
      `cd ${WORKSPACE} && stat -c '%u:%g:%a:%s' -- ${shellQuote(path)}`,
      10_000,
    );
    const value = stat.output.trim();
    result[key] =
      stat.exitCode === 0 && /^\d+:\d+:\d{3,4}:\d+$/u.test(value)
        ? value
        : null;
    const digest = await sandbox.exec(
      `cd ${WORKSPACE} && sha256sum -- ${shellQuote(path)} | cut -d' ' -f1`,
      10_000,
    );
    const digestValue = digest.output.trim();
    result[`${key}Sha256`] =
      digest.exitCode === 0 && /^[0-9a-f]{64}$/u.test(digestValue)
        ? digestValue
        : null;
  }

  const identity = await sandbox.exec("printf '%s:%s' \"$(id -u)\" \"$(id -g)\"", 10_000);
  const identityValue = identity.output.trim();
  result.effectiveIdentity =
    identity.exitCode === 0 && /^\d+:\d+$/u.test(identityValue)
      ? identityValue
      : null;

  const entryCount = await sandbox.exec(
    `cd ${WORKSPACE} && find .git -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c`,
    10_000,
  );
  const entryCountValue = entryCount.output.trim();
  result.gitTopLevelEntryCount =
    entryCount.exitCode === 0 && /^\d+$/u.test(entryCountValue)
      ? Number(entryCountValue)
      : null;

  const gitProbe = await sandbox.exec(
    `cd ${WORKSPACE} && git rev-parse --is-inside-work-tree 2>&1`,
    10_000,
  );
  result.gitProbe = {
    exitCode: gitProbe.exitCode,
    outputBytes: Buffer.byteLength(gitProbe.output),
    outputSha256: sha256(gitProbe.output),
    badConfig: /bad config|config file|config line/iu.test(gitProbe.output),
    dubiousOwnership: /dubious ownership|safe\.directory/iu.test(gitProbe.output),
    notRepository: /not a git repository/iu.test(gitProbe.output),
    permissionDenied: /permission denied/iu.test(gitProbe.output),
    badObject: /bad object|invalid object|corrupt/iu.test(gitProbe.output),
  };

  for (const variable of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_GLOBAL',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
  ]) {
    const environmentCheck = await sandbox.exec(
      `test -z "\${${variable}+x}"`,
      10_000,
    );
    result[`environment${variable.replaceAll('_', '')}Unset`] =
      environmentCheck.exitCode === 0 && !environmentCheck.timedOut;
  }

  if (typeof expectedCommit === 'string' && /^[0-9a-f]{40}$/u.test(expectedCommit)) {
    const objectPath =
      `.git/objects/${expectedCommit.slice(0, 2)}/${expectedCommit.slice(2)}`;
    const commitChecks = {
      expectedCommitRefMatches:
        `test "$(cat .git/refs/heads/master 2>/dev/null || ` +
        `cat .git/refs/heads/main 2>/dev/null)" = ${shellQuote(expectedCommit)}`,
      expectedCommitObjectExists: `test -e ${shellQuote(objectPath)}`,
      expectedCommitObjectReadable: `test -r ${shellQuote(objectPath)}`,
    };
    for (const [key, command] of Object.entries(commitChecks)) {
      const check = await sandbox.exec(
        `cd ${WORKSPACE} && ${command}`,
        10_000,
      );
      result[key] = check.exitCode === 0 && !check.timedOut;
    }
    const objectStat = await sandbox.exec(
      `cd ${WORKSPACE} && stat -c '%u:%g:%a:%s' -- ${shellQuote(objectPath)}`,
      10_000,
    );
    const objectStatValue = objectStat.output.trim();
    result.expectedCommitObjectStat =
      objectStat.exitCode === 0 && /^\d+:\d+:\d{3,4}:\d+$/u.test(objectStatValue)
        ? objectStatValue
        : null;
  }
  return result;
}

async function observeHeadlessExit(
  sandbox,
  taskId,
  runtimeId,
  terminal = null,
) {
  const path = headlessExitFile(taskId);
  const sessionName = shellQuote(detachedSessionName(taskId));
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let latestTerminalOutput = '';
  let terminalSnapshots = 0;
  let processArgSnapshots = 0;
  let targetAgentArgSnapshots = 0;
  while (Date.now() < deadline) {
    terminal?.assertHealthy();
    const paneCapture = await sandbox.exec(
      `tmux capture-pane -p -e -t ${sessionName} -S - 2>/dev/null | ` +
        `tail -c ${MAX_TERMINAL_BYTES}`,
      5_000,
    );
    if (paneCapture.exitCode === 0 && paneCapture.output.length > 0) {
      latestTerminalOutput = paneCapture.output;
      terminalSnapshots += 1;
      assertNoBlockingPrompt(paneCapture.output, runtimeId);
    }

    const processArgs = await sandbox.exec(
      "for f in /proc/[0-9]*/cmdline; do tr '\\000' ' ' < \"$f\" 2>/dev/null; printf '\\n'; done",
      5_000,
    );
    if (processArgs.exitCode === 0) {
      processArgSnapshots += 1;
      if (targetAgentArgvSeen(processArgs.output, runtimeId, 'headless')) {
        targetAgentArgSnapshots += 1;
      }
    }

    const sentinel = await sandbox.exec(
      `test -f ${shellQuote(path)} && cat ${shellQuote(path)}`,
      5_000,
    );
    if (sentinel.exitCode === 0) {
      const exitCode = Number(sentinel.output.trim());
      if (Number.isInteger(exitCode)) {
        assert(terminalSnapshots > 0, 'headless terminal output was never observed');
        assert(processArgSnapshots > 0, 'headless process argv was never observed');
        assert(
          targetAgentArgSnapshots > 0,
          `${runtimeId} headless agent argv was not observed while it was running`,
        );
        return {
          exitCode,
          terminalSnapshots,
          terminalBytes: Buffer.byteLength(latestTerminalOutput),
          terminalSha256: sha256(latestTerminalOutput),
          processArgSnapshots,
          targetAgentArgSnapshots,
        };
      }
    }
    terminal?.assertHealthy();
    await delay(POLL_MS);
  }
  terminal?.assertHealthy();
  throw new Error('headless exit sentinel was not written');
}

function targetAgentArgvSeen(output, runtimeId, mode) {
  const lines = String(output).split(/\r?\n/u);
  return lines.some((line) => {
    if (runtimeId === 'codex') {
      return (
        /(?:^|[ /])codex(?:[ /]|$)/u.test(line) &&
        line.includes('--dangerously-bypass-approvals-and-sandbox') &&
        !line.includes('--no-alt-screen') &&
        (mode !== 'headless' || /(?:^| )exec(?: |$)/u.test(line))
      );
    }
    return (
      /(?:^|[ /])claude(?:[ /]|$)/u.test(line) &&
      line.includes('--dangerously-skip-permissions') &&
      (mode !== 'headless' || /(?:^| )-p(?: |$)/u.test(line))
    );
  });
}

async function readTranscript(sandbox, runtime, ctx, requiredMarkers = []) {
  const artifact = runtime.transcriptArtifact({
    taskId: ctx.taskId,
    workspaceDir: WORKSPACE,
    sessionId: ctx.sessionId,
  });
  let jsonl = null;
  let fileCount = 1;
  if (sandbox instanceof AioCanarySandbox) {
    jsonl = await sandbox.readNewestTranscript(
      artifact.dir,
      artifact.filenameGlob,
    );
  } else {
    const archive = await sandbox.readTranscriptBytes(artifact.dir);
    assert(archive, `${runtime.id} transcript archive is absent`);
    const files = extractFilesFromTar(Buffer.from(archive), (name) =>
      artifact.filenameGlob.test(name),
    );
    files.sort((a, b) => a.name.localeCompare(b.name));
    fileCount = files.length;
    jsonl = files.at(-1)?.content.toString('utf8') ?? null;
  }
  assert(jsonl && jsonl.trim(), `${runtime.id} transcript is empty`);
  assertNoSecrets(jsonl, `${runtime.id} transcript`);
  for (const marker of requiredMarkers) {
    assert(
      jsonl.includes(marker),
      `${runtime.id} transcript is missing a required canary turn`,
    );
  }
  return {
    format: runtime.transcriptFormat,
    files: fileCount,
    bytes: Buffer.byteLength(jsonl),
    sha256: sha256(jsonl),
    eventCounts: transcriptEventCounts(jsonl),
    diagnosticSignals: transcriptDiagnosticSignals(jsonl),
    runtimeSessionId:
      runtime.id === 'codex' ? codexSessionId(jsonl) : ctx.sessionId,
  };
}

function transcriptDiagnosticSignals(jsonl) {
  return {
    gitAddMentioned: /git add/iu.test(jsonl),
    gitCommitMentioned: /git commit/iu.test(jsonl),
    notGitRepositoryMentioned: /not a git repository/iu.test(jsonl),
    permissionDeniedMentioned: /permission denied/iu.test(jsonl),
    approvalOrPermissionPromptMentioned:
      /(?:approval|permission).*(?:required|denied|prompt)/iu.test(jsonl),
  };
}

function transcriptEventCounts(jsonl) {
  const counts = {};
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let key = 'unparsed';
    try {
      const value = JSON.parse(line);
      const type = typeof value?.type === 'string' ? value.type : 'unknown';
      const payloadType =
        typeof value?.payload?.type === 'string' ? value.payload.type : null;
      const candidate = payloadType ? `${type}:${payloadType}` : type;
      key = /^[A-Za-z0-9_.:-]{1,96}$/u.test(candidate) ? candidate : 'other';
    } catch {
      // A count is sufficient for safe diagnostics; never echo the line.
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function codexSessionId(jsonl) {
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      const id = value?.type === 'session_meta' ? value?.payload?.id : null;
      if (typeof id === 'string' && /^[0-9a-f-]{36}$/iu.test(id)) return id;
    } catch {
      // Ignore non-JSON diagnostic lines; the transcript hash still covers them.
    }
  }
  return null;
}

function actionPrompt(marker, path, phase) {
  return [
    `This is an automated ${phase} canary inside a disposable sandbox.`,
    'Do not ask questions and do not wait for confirmation.',
    `Use your shell/tools to create ${path} with exactly this single line: ${marker}`,
    `Then run git add and create a git commit whose message is: ${marker}`,
    'Verify the file and commit exist, then finish the turn.',
  ].join('\n');
}

function launchContext(taskId, sessionId) {
  return {
    taskId,
    workspaceDir: WORKSPACE,
    sessionId,
    model: { kind: 'runtime-default' },
  };
}

function runtimeFor(runtimeId) {
  return runtimeId === 'codex' ? new CodexRuntime() : new ClaudeCodeRuntime();
}

function authMaterial(runtimeId, credentials) {
  return runtimeId === 'codex'
    ? { authJson: credentials.codexAuthJson }
    : { oauthToken: credentials.claudeOauthToken };
}

async function loadCredentials(runtimeSelection, source = 'local') {
  if (source === 'stdin') {
    return await loadCredentialsFromStdin(runtimeSelection);
  }
  const needCodex = runtimeSelection === 'all' || runtimeSelection === 'codex';
  const needClaude = runtimeSelection === 'all' || runtimeSelection === 'claude-code';
  return {
    codexAuthJson: needCodex ? loadCodexAuthJson() : null,
    claudeOauthToken: needClaude ? loadClaudeOauthToken() : null,
  };
}

async function loadCredentialsFromStdin(runtimeSelection) {
  const payload = await readCredentialStdin();
  assert(payload.byteLength > 0, 'credential stdin payload is empty');
  let parsed;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    parsed = JSON.parse(json);
  } catch {
    throw new Error('credential stdin payload is not valid JSON');
  } finally {
    payload.fill(0);
  }
  assert(
    parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    'credential stdin payload must be a JSON object',
  );
  const requiredKeys =
    runtimeSelection === 'all'
      ? ['claudeOauthToken', 'codexAuthJson']
      : runtimeSelection === 'codex'
        ? ['codexAuthJson']
        : ['claudeOauthToken'];
  assert(
    JSON.stringify(Object.keys(parsed).sort()) ===
      JSON.stringify(requiredKeys),
    'credential stdin payload fields do not match the selected runtime',
  );
  const needCodex = runtimeSelection === 'all' || runtimeSelection === 'codex';
  const needClaude =
    runtimeSelection === 'all' || runtimeSelection === 'claude-code';
  const codexAuthJson = needCodex ? parsed.codexAuthJson : null;
  const claudeOauthToken = needClaude ? parsed.claudeOauthToken : null;
  if (needCodex) {
    assert(
      typeof codexAuthJson === 'string' && codexAuthJson.trim(),
      'credential stdin payload has no Codex auth JSON',
    );
    assert(
      Buffer.byteLength(codexAuthJson, 'utf8') <= MAX_CODEX_AUTH_JSON_BYTES,
      'credential stdin Codex auth JSON exceeds 1 MiB',
    );
    let codexAuth;
    try {
      codexAuth = JSON.parse(codexAuthJson);
    } catch {
      throw new Error('credential stdin Codex auth JSON is not valid JSON');
    }
    assert(
      codexAuth && typeof codexAuth === 'object' && !Array.isArray(codexAuth),
      'credential stdin Codex auth JSON is invalid',
    );
  }
  if (needClaude) {
    assert(
      typeof claudeOauthToken === 'string' &&
        claudeOauthToken.trim().length >= 8,
      'credential stdin payload has no Claude OAuth token',
    );
    assert(
      Buffer.byteLength(claudeOauthToken, 'utf8') <=
        MAX_CLAUDE_OAUTH_TOKEN_BYTES,
      'credential stdin Claude OAuth token exceeds 64 KiB',
    );
    assert(
      !/[\u0000-\u001f\u007f]/u.test(claudeOauthToken),
      'credential stdin Claude OAuth token contains a control character',
    );
  }
  return {
    codexAuthJson: needCodex ? codexAuthJson : null,
    claudeOauthToken: needClaude ? claudeOauthToken.trim() : null,
  };
}

function readCredentialStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let timer;

    const zeroChunks = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdin.pause();
      zeroChunks();
      process.stdin.destroy();
      reject(new Error(message));
    };
    const onData = (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (totalBytes + chunk.byteLength > MAX_CREDENTIAL_STDIN_BYTES) {
        chunk.fill(0);
        fail('credential stdin payload exceeds 2 MiB');
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const payload = Buffer.concat(chunks, totalBytes);
      zeroChunks();
      resolve(payload);
    };
    const onError = () => fail('credential stdin could not be read');
    timer = setTimeout(
      () => fail('credential stdin timed out'),
      CREDENTIAL_STDIN_TIMEOUT_MS,
    );

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

function loadCodexAuthJson() {
  const candidates = [
    process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'auth.json') : null,
    join(homedir(), '.codex', 'auth.json'),
  ].filter(Boolean);
  const path = candidates.find((candidate) => existsSync(candidate));
  assert(path, 'local Codex auth.json is unavailable');
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('local Codex auth.json is not valid JSON');
  }
  assert(parsed && typeof parsed === 'object', 'local Codex auth.json is invalid');
  return raw;
}

function loadClaudeOauthToken() {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  let raw;
  try {
    raw = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 },
    ).trim();
  } catch {
    throw new Error('Claude Code credential is unavailable from the macOS keychain');
  }
  if (raw.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Claude keychain credential is not valid JSON');
    }
    const token =
      parsed?.claudeAiOauth?.accessToken ??
      parsed?.oauthToken ??
      parsed?.accessToken;
    assert(typeof token === 'string' && token.trim(), 'Claude keychain credential has no OAuth token');
    return token.trim();
  }
  assert(raw, 'Claude keychain credential is empty');
  return raw;
}

function registerSecrets(credentials) {
  if (credentials.codexAuthJson) {
    addSecret(credentials.codexAuthJson);
    try {
      collectSensitiveStrings(JSON.parse(credentials.codexAuthJson));
    } catch {
      // The loader already validates JSON; retain the full-document variant.
    }
  }
  if (credentials.claudeOauthToken) addSecret(credentials.claudeOauthToken);
}

function registerProviderSecrets(options) {
  if (options.provider !== 'boxlite') return;
  const endpoint = new URL(options.endpoint);
  assert(
    !endpoint.username && !endpoint.password,
    'BoxLite endpoint URL must not contain userinfo',
  );
  if (process.env.BOXLITE_API_TOKEN) addSecret(process.env.BOXLITE_API_TOKEN);
}

function collectSensitiveStrings(value, key = '') {
  if (typeof value === 'string') {
    addSecret(value);
    if (/(token|secret|api[_-]?key)/iu.test(key) && value.length >= 16) {
      for (const length of [16, 24, 32]) {
        if (value.length >= length) {
          addSecret(value.slice(0, length));
          addSecret(value.slice(-length));
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveStrings(item, key);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) {
    collectSensitiveStrings(child, childKey);
  }
}

function addSecret(value) {
  if (typeof value !== 'string' || value.length < 8) return;
  const bytes = Buffer.from(value, 'utf8');
  for (const variant of [
    value,
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
  ]) {
    if (variant.length >= 8) activeSecretVariants.add(variant);
  }
}

function assertNoSecrets(value, label) {
  if (activeSecretVariants.size === 0) return;
  const haystack = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : value instanceof Uint8Array
      ? Buffer.from(value).toString('utf8')
      : String(value ?? '');
  for (const variant of activeSecretVariants) {
    assert(!haystack.includes(variant), `${label} contains credential material`);
  }
}

function assertNoBlockingPrompt(raw, runtimeId) {
  const text = Buffer.from(raw).toString('utf8');
  const patterns =
    runtimeId === 'codex'
      ? [
          /do you want to proceed\?/iu,
          /allow (?:this|the) (?:command|tool)/iu,
          /press enter to continue/iu,
        ]
      : [
          /choose (?:a )?theme/iu,
          /yes, i trust this folder/iu,
          /do you want to proceed\?/iu,
          /allow (?:this|the) (?:command|tool)/iu,
        ];
  for (const pattern of patterns) {
    assert(!pattern.test(text), `${runtimeId} displayed a blocking first-run/approval prompt`);
  }
}

async function execStrict(sandbox, command, timeoutMs, label) {
  const result = await sandbox.exec(command, timeoutMs);
  if (result.exitCode === 0 && !result.timedOut) return result;
  const output = String(result.output ?? '');
  assertNoSecrets(output, `${label} failure output`);
  throw new Error(
    `${label} failed ${JSON.stringify({
      exitCode: Number.isFinite(result.exitCode) ? result.exitCode : null,
      timedOut: result.timedOut === true,
      outputBytes: Buffer.byteLength(output),
      outputSha256: sha256(output),
    })}`,
  );
}

async function execAllowFailure(sandbox, command, timeoutMs) {
  return sandbox.exec(command, timeoutMs);
}

async function commandOutput(sandbox, command, label = 'canary probe command') {
  const result = await execStrict(sandbox, command, 60_000, label);
  return result.output;
}

function boundedHelpProbe(command, requiredFlags) {
  const pattern = requiredFlags
    .map((flag) => flag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|');
  const script =
    `TERM=dumb NO_COLOR=1 CI=1 timeout --foreground --signal=TERM ` +
    `--kill-after=2s 20s ${command} </dev/null 2>&1 | ` +
    `grep -E -- ${shellQuote(pattern)}`;
  return `bash -o pipefail -c ${shellQuote(script)}`;
}

async function waitUntil(check, timeoutMs, message, assertHealthy = () => undefined) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertHealthy();
    if (await check()) return;
    assertHealthy();
    await delay(POLL_MS);
  }
  assertHealthy();
  throw new Error(message);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isBoxLitePrivateArchiveRequest(input, init) {
  if (String(init.method ?? 'GET').toUpperCase() !== 'PUT') return false;
  const rawUrl =
    typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  if (!rawUrl) return false;
  try {
    const pathname = new URL(rawUrl).pathname;
    return pathname.endsWith('/files') || pathname.endsWith('/archive');
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const provider = argv[0];
  assert(provider === 'boxlite' || provider === 'aio', 'provider must be boxlite or aio');
  const allowedKeys = new Set([
    'phase',
    'runtime',
    'mode',
    'credentials-source',
    ...(provider === 'boxlite'
      ? ['endpoint', 'rootfs', 'image', 'provider-log-file']
      : ['image', 'network']),
  ]);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(key?.startsWith('--') && value !== undefined, `invalid argument near ${key}`);
    const name = key.slice(2);
    assert(allowedKeys.has(name), `unsupported argument --${name}`);
    assert(!values.has(name), `duplicate argument --${name}`);
    values.set(name, value);
  }
  const phase = values.get('phase') ?? 'all';
  const runtime = values.get('runtime') ?? 'all';
  const mode = values.get('mode') ?? 'all';
  const credentialsSource = values.get('credentials-source') ?? 'local';
  assert(['all', 'parser', 'real'].includes(phase), '--phase must be all, parser, or real');
  assert(['all', 'codex', 'claude-code'].includes(runtime), '--runtime must be all, codex, or claude-code');
  assert(['all', 'interactive', 'headless'].includes(mode), '--mode must be all, interactive, or headless');
  assert(
    ['local', 'stdin'].includes(credentialsSource),
    '--credentials-source must be local or stdin',
  );
  assert(
    phase !== 'parser' || credentialsSource === 'local',
    '--phase parser does not accept credential stdin',
  );
  if (provider === 'boxlite') {
    const endpoint = values.get('endpoint');
    const rootfs = values.get('rootfs') ?? process.env.BOXLITE_ROOTFS_PATH;
    const image = values.get('image') ?? process.env.BOXLITE_IMAGE;
    const providerLogFile = values.get('provider-log-file');
    assert(endpoint, 'BoxLite --endpoint is required');
    assert(Boolean(rootfs) !== Boolean(image), 'BoxLite requires exactly one of --rootfs or --image');
    assert(
      phase === 'parser' || (providerLogFile && existsSync(providerLogFile)),
      'BoxLite real phases require an existing --provider-log-file',
    );
    return {
      help: false,
      provider,
      endpoint,
      rootfs,
      image,
      phase,
      runtime,
      mode,
      credentialsSource,
      providerLogFile,
    };
  }
  const image = values.get('image') ?? process.env.AIO_SANDBOX_IMAGE;
  const network = values.get('network') ?? process.env.AIO_SANDBOX_NETWORK ?? 'cap-net';
  assert(image, 'AIO --image is required');
  return {
    help: false,
    provider,
    image,
    network,
    phase,
    runtime,
    mode,
    credentialsSource,
  };
}

function printUsage() {
  console.log(`Usage:
  node scripts/yolo-agent-canary.mjs boxlite --endpoint URL (--rootfs PATH | --image IMAGE) [--provider-log-file PATH] [--phase all|parser|real] [--runtime all|codex|claude-code] [--mode all|interactive|headless] [--credentials-source local|stdin]
  node scripts/yolo-agent-canary.mjs aio --image IMAGE [--network NAME] [--phase all|parser|real] [--runtime all|codex|claude-code] [--mode all|interactive|headless] [--credentials-source local|stdin]`);
}

function selectedRuntimes(value) {
  return value === 'all' ? ['codex', 'claude-code'] : [value];
}

function normalizeUrl(value) {
  return new URL(value).toString().replace(/\/$/u, '');
}

function httpToWs(value) {
  const url = new URL(value);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString().replace(/\/$/u, '');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function safeTaskId(value) {
  return value.replace(/[^A-Za-z0-9_.-]/gu, '-').slice(0, 96);
}

function shortId() {
  return randomUUID().replaceAll('-', '').slice(0, 10);
}

function firstLine(value) {
  return value.trim().split(/\r?\n/u)[0] ?? '';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertMatch(value, pattern, label) {
  assert(pattern.test(value), `${label} did not expose the required flag/version`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function finalizeCanaryCleanup(primaryError, cleanups) {
  const cleanupErrors = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) return;
  if (primaryError) {
    const primaryMessage =
      primaryError instanceof Error ? primaryError.message : 'canary case failed';
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `${primaryMessage}; one or more cleanup confirmations also failed`,
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(
    cleanupErrors,
    'one or more canary cleanup confirmations failed',
  );
}

async function cleanupAll() {
  const cleanups = cleanupStack;
  cleanupStack = [];
  let failed = false;
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new Error('one or more canary sandboxes could not be confirmed absent');
  }
}

function sanitizeError(error) {
  let message = error instanceof Error ? error.stack ?? error.message : String(error);
  for (const variant of activeSecretVariants) message = message.replaceAll(variant, '<redacted>');
  return message;
}

main().catch(async (error) => {
  let cleanupFailed = false;
  try {
    await cleanupAll();
  } catch {
    cleanupFailed = true;
  }
  console.error(sanitizeError(error));
  if (cleanupFailed) {
    console.error('Error: one or more canary sandboxes could not be confirmed absent');
  }
  process.exitCode = 1;
});
