#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createCurrentTerminalAttachFrame,
  TERMINAL_PROTOCOL_VERSION,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
} from '../packages/contracts/dist/index.js';
import {
  SandboxTerminalSession,
  SandboxTerminalViewerAttachmentFactory,
  detachedSessionName,
} from '../packages/sandbox/dist/index.js';
import gatewayModule from '../apps/api/dist/terminal/terminal.gateway.js';
import {
  N_MINUS_ONE_TERMINAL_BUILD,
  createNMinusOneTerminalAttachFrame,
  negotiateNMinusOneTerminalAttach,
} from './fixtures/terminal-coordinated-rollback/n-minus-one-adapter.mjs';

const { TerminalGateway } = gatewayModule;
const here = dirname(fileURLToPath(import.meta.url));
const detachedCliPath = join(
  here,
  'fixtures',
  'terminal-coordinated-rollback',
  'detached-cli.mjs',
);
const localPtyBridgePath = join(
  here,
  'fixtures',
  'terminal-coordinated-rollback',
  'local-pty-bridge.py',
);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TMUX_UNIX_SOCKET_PATH_BYTES = 100;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(predicate, description, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function killExactProcessGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function runProcess(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const abort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolveRun({
        exitCode: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        signal,
      });
    });
  });
}

function isolatedTmuxEnvironment(tmuxTmpDir) {
  const environment = {
    ...process.env,
    TERM: 'xterm-256color',
    TMUX_TMPDIR: tmuxTmpDir,
  };
  delete environment.TMUX;
  delete environment.TMUX_PANE;
  return environment;
}

async function requireExecutable(command) {
  const result = await runProcess('/usr/bin/env', ['sh', '-c', `command -v ${shellQuote(command)}`]);
  if (result.exitCode !== 0) throw new Error(`Required executable not found: ${command}`);
  return result.stdout.trim();
}

class LocalPtyTransport {
  opaqueInputCapability = 'byte-preserving';
  readyState = 'connecting';

  constructor(context, label) {
    this.context = context;
    this.label = label;
    this.frameListeners = new Set();
    this.closeListeners = new Set();
    this.errorListeners = new Set();
    this.inputs = [];
    this.closed = false;
    this.cleanupSettled = false;
    this.cleanupDecision = new Promise((resolveCleanup) => {
      this.resolveCleanup = resolveCleanup;
    });
    this.child = spawn(
      context.pythonPath,
      ['-u', localPtyBridgePath, context.shellPath, '100', '30'],
      {
      env: context.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.context.transports.push(this);
    this.context.activeProcessGroups.add(this.child.pid);
    this.child.stdout.on('data', (chunk) => this.emitFrame({
      type: 'output',
      bytes: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    }));
    this.child.stderr.on('data', (chunk) => {
      this.context.diagnostics.push({
        event: 'pty_stderr',
        label,
        text: chunk.toString('utf8').trim().slice(0, 300),
      });
      this.emitFrame({
        type: 'output',
        bytes: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      });
    });
    this.child.once('spawn', () => {
      if (this.closed) return;
      this.readyState = 'open';
      this.context.diagnostics.push({ event: 'pty_spawned', label });
      queueMicrotask(() => {
        this.emitFrame({ type: 'session_id', data: `local-${label}-${this.child.pid}` });
        this.emitFrame({ type: 'ready' });
      });
    });
    this.child.once('error', (error) => {
      this.context.diagnostics.push({
        event: 'pty_error',
        label,
        code: typeof error?.code === 'string' ? error.code : 'unknown',
      });
      for (const listener of this.errorListeners) listener(error);
      this.settleCleanup('identity-unavailable');
    });
    this.child.once('exit', (code, signal) => {
      this.context.diagnostics.push({
        event: 'pty_exit',
        label,
        code,
        signal,
        requested: this.closed,
      });
      this.readyState = 'closed';
      this.context.activeProcessGroups.delete(this.child.pid);
      this.settleCleanup(null);
      for (const listener of this.closeListeners) listener();
    });
  }

  onFrame(listener) {
    this.frameListeners.add(listener);
    return { dispose: () => this.frameListeners.delete(listener) };
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  onError(listener) {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  emitFrame(frame) {
    if (this.closed) return;
    for (const listener of this.frameListeners) listener(frame);
  }

  sendInput(data) {
    this.inputs.push(data);
    const outcome = this.writeBytes(Buffer.from(data, 'utf8'));
    this.context.diagnostics.push({
      event: 'pty_input',
      label: this.label,
      kind: data.includes('attach-session')
        ? 'attach'
        : data.includes('new-session')
          ? 'launch'
          : 'other',
      outcome,
    });
    return outcome === 'written';
  }

  sendInputBytes(data) {
    return this.writeBytes(Buffer.from(data));
  }

  sendTerminalResponseBytes(data) {
    return this.writeBytes(Buffer.from(data));
  }

  writeBytes(data) {
    if (this.closed || this.readyState !== 'open' || !this.child.stdin.writable) {
      return 'closed';
    }
    try {
      this.child.stdin.write(data);
      return 'written';
    } catch {
      return 'closed';
    }
  }

  sendResize() {
    return !this.closed;
  }

  sendPong() {
    return !this.closed;
  }

  pause() {
    this.child.stdout.pause();
    this.child.stderr.pause();
  }

  resume() {
    this.child.stdout.resume();
    this.child.stderr.resume();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 'closed';
    const pid = this.child.pid;
    try {
      if (this.child.stdin.writable) {
        this.child.stdin.write(Buffer.from([0x02, 0x64]));
        this.child.stdin.end('exit\r');
      }
    } catch {
      // The exact process-group fence below owns the final cleanup decision.
    }
    const terminate = setTimeout(() => killExactProcessGroup(pid, 'SIGTERM'), 50);
    const force = setTimeout(() => killExactProcessGroup(pid, 'SIGKILL'), 400);
    this.child.once('exit', () => {
      clearTimeout(terminate);
      clearTimeout(force);
    });
  }

  settleCleanup(cause) {
    if (this.cleanupSettled) return;
    this.cleanupSettled = true;
    this.resolveCleanup(
      cause === null
        ? {
            kind: 'confirmed',
            expectedIdentities: 1,
            observedIdentities: 1,
            confirmedIdentities: 1,
            deletedIdentities: 1,
            alreadyAbsentIdentities: 0,
            cause: null,
          }
        : {
            kind: 'indeterminate',
            expectedIdentities: 1,
            observedIdentities: 0,
            confirmedIdentities: 0,
            deletedIdentities: 0,
            alreadyAbsentIdentities: 0,
            cause,
          },
    );
  }
}

class LocalPtyTransportFactory {
  constructor(context, buildLabel) {
    this.context = context;
    this.buildLabel = buildLabel;
    this.openCount = 0;
  }

  open() {
    this.openCount += 1;
    return new LocalPtyTransport(this.context, `${this.buildLabel}-${this.openCount}`);
  }
}

class FakeSocket {
  OPEN = 1;
  readyState = this.OPEN;
  frames = [];
  closedWith = null;

  on() {}

  send(text) {
    this.frames.push(JSON.parse(text));
  }

  close(code) {
    this.closedWith = code;
    this.readyState = 3;
  }
}

function makeAuthService() {
  return {
    async resolveSession(token) {
      if (token !== 'local-rollback-token') return null;
      return {
        id: 'local-rollback-user',
        githubId: null,
        login: null,
        name: 'Local rollback canary',
        avatarUrl: null,
        allowed: true,
        role: 'member',
        mustChangePassword: false,
      };
    },
    async resolveApiKey() {
      return null;
    },
  };
}

async function settleGateway() {
  await new Promise((resolveSettle) => setImmediate(resolveSettle));
  await new Promise((resolveSettle) => setImmediate(resolveSettle));
  await delay(15);
}

async function connectGateway(gateway, socket, taskId) {
  gateway.handleConnection(socket, {
    url: `/terminal?taskId=${taskId}&token=local-rollback-token`,
    headers: {},
  });
  await settleGateway();
}

function sendGatewayFrame(gateway, socket, frame) {
  gateway.handleMessage(JSON.stringify(frame), socket);
}

function frameOf(socket, type) {
  return socket.frames.filter((frame) => frame.type === type).at(-1);
}

function rawSocketBytes(socket) {
  return Buffer.concat(
    socket.frames
      .filter((frame) => frame.channel === 'raw' && typeof frame.data === 'string')
      .map((frame) => Buffer.from(frame.data, 'base64')),
  );
}

function assertReloadRequired(socket, reason) {
  const state = frameOf(socket, 'terminal_attachment_state');
  assert.equal(state?.state, 'failed');
  assert.equal(state?.reason, reason);
  assert.equal(state?.reloadRequired, true);
  assert.equal(socket.closedWith, 1008);
}

function sendFixtureFailure(socket, frame) {
  socket.send(JSON.stringify(frame));
  socket.close(1008);
}

class NMinusOneApiBuild {
  constructor(gateway) {
    this.gateway = gateway;
    this.buildId = N_MINUS_ONE_TERMINAL_BUILD.buildId;
  }

  async attach(socket, taskId, nMinusOneWebFrame) {
    const negotiation = negotiateNMinusOneTerminalAttach(nMinusOneWebFrame);
    if (!negotiation.ok) {
      sendFixtureFailure(socket, negotiation.frame);
      return { delegated: false, negotiation };
    }
    await connectGateway(this.gateway, socket, taskId);
    sendGatewayFrame(
      this.gateway,
      socket,
      createCurrentTerminalAttachFrame(negotiation.frame.cols, negotiation.frame.rows),
    );
    return { delegated: true, negotiation };
  }
}

function makeCommandExecutor(context, auditCommands) {
  return {
    async exec(request) {
      auditCommands.push(request.command);
      const result = await runProcess('/bin/sh', ['-c', request.command], {
        env: context.env,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
      context.diagnostics.push({
        event: 'shell_exec',
        kind: request.command.includes('has-session')
          ? 'probe'
          : request.command.includes('resize-window')
            ? 'resize'
            : 'other',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        probeMarkerObserved: /__cap_has__-?\d+/u.test(`${result.stdout}${result.stderr}`),
      });
      const output = `${result.stdout}${result.stderr}`;
      return {
        exitCode: result.exitCode,
        output,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    },
  };
}

async function createGatewayBuild(context, buildLabel) {
  const commands = [];
  const commandExecutor = makeCommandExecutor(context, commands);
  const transportFactory = new LocalPtyTransportFactory(context, buildLabel);
  const owner = new SandboxTerminalSession(
    context.taskId,
    'local://terminal',
    'local://shell',
    undefined,
    'attach-only',
    undefined,
    transportFactory,
    commandExecutor,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      maxAttempts: 2,
      baseDelayMs: 5,
      maxDelayMs: 5,
      readyTimeoutMs: 1_000,
      cleanupTimeoutMs: 1_000,
      jitterRatio: 0,
    },
  );
  const viewerFactory = new SandboxTerminalViewerAttachmentFactory({
    taskId: context.taskId,
    transportFactory,
    commandExecutor,
    policy: {
      firstOutputTimeoutMs: 2_000,
      quietMs: 40,
      maxSettleMs: 500,
      probeTimeoutMs: 1_000,
    },
  });
  const gateway = new TerminalGateway(
    undefined,
    undefined,
    makeAuthService(),
  );
  gateway.registerSession({
    taskId: context.taskId,
    ownerPty: owner,
    viewerFactory,
    geometry: { cols: 100, rows: 30 },
    launchDecision: owner.launchDecision,
  });
  const ownerDecision = await Promise.race([
    owner.launchDecision,
    delay(2_000).then(() => ({ kind: 'timeout' })),
  ]);
  if (ownerDecision.kind !== 'attached') {
    throw new Error(
      `${buildLabel} owner attach-only decision was ${ownerDecision.kind}: ` +
        JSON.stringify({
          diagnostics: context.diagnostics,
          commandCount: commands.length,
          probeMarkerObserved: commands.some((command) => command.includes('__cap_has__')),
          transportStates: context.transports
            .filter((transport) => transport.label.startsWith(buildLabel))
            .map((transport) => ({
              label: transport.label,
              readyState: transport.readyState,
              closed: transport.closed,
              inputKinds: transport.inputs.map((input) =>
                input.includes('attach-session') ? 'attach' : 'other',
              ),
            })),
        }),
    );
  }
  return { buildLabel, gateway, owner, transportFactory, commands };
}

async function shutdownGatewayBuild(build) {
  const cleanup = await build.gateway.shutdownTerminalResources();
  assert.equal(cleanup.kind, 'confirmed', `${build.buildLabel} cleanup must be confirmed`);
  await waitFor(
    () => build.transportFactory.context.activeProcessGroups.size === 0,
    `${build.buildLabel} local PTY cleanup`,
  );
  return cleanup;
}

async function attachCurrentWeb(build, context) {
  const socket = new FakeSocket();
  await connectGateway(build.gateway, socket, context.taskId);
  sendGatewayFrame(build.gateway, socket, createCurrentTerminalAttachFrame(100, 30));
  await waitFor(
    () => frameOf(socket, 'terminal_attachment_state')?.state === 'ready',
    `${build.buildLabel} current Web ready`,
  );
  await waitFor(
    () => rawSocketBytes(socket).includes(context.marker),
    `${build.buildLabel} tmux redraw marker`,
  );
  return socket;
}

async function attachNMinusOneWeb(apiBuild, build, context) {
  const socket = new FakeSocket();
  const result = await apiBuild.attach(
    socket,
    context.taskId,
    createNMinusOneTerminalAttachFrame(100, 30),
  );
  assert.equal(result.delegated, true);
  await waitFor(
    () => frameOf(socket, 'terminal_attachment_state')?.state === 'ready',
    `${build.buildLabel} N-1 Web ready`,
  );
  await waitFor(
    () => rawSocketBytes(socket).includes(context.marker),
    `${build.buildLabel} N-1 tmux redraw marker`,
  );
  return socket;
}

async function readLinuxStartTicks(pid) {
  if (process.platform !== 'linux') return null;
  const value = await readFile(`/proc/${pid}/stat`, 'utf8');
  const closingParenthesis = value.lastIndexOf(')');
  const fieldsAfterCommand = value.slice(closingParenthesis + 2).trim().split(/\s+/u);
  const startTicks = fieldsAfterCommand[19];
  if (!/^\d+$/.test(startTicks ?? '')) throw new Error(`Invalid /proc start ticks for ${pid}`);
  return startTicks;
}

async function readPlatformStartIdentity(pid) {
  const result = await runProcess('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`Could not read process start identity for ${pid}`);
  }
  return result.stdout.trim();
}

async function readTaskIdentity(context) {
  const display = await runProcess(
    context.tmuxPath,
    ['list-panes', '-t', `=${context.sessionName}:`, '-F', '#{pane_pid}'],
    { env: context.env },
  );
  assert.equal(display.exitCode, 0, display.stderr);
  const panePids = display.stdout.trim().split(/\s+/u).filter(Boolean);
  assert.equal(panePids.length, 1, 'rollback task must own exactly one tmux pane');
  const panePid = Number(panePids[0]);
  const cli = JSON.parse(await readFile(context.identityPath, 'utf8'));
  assert.ok(processAlive(panePid), `pane pid ${panePid} must be alive`);
  assert.ok(processAlive(cli.pid), `CLI pid ${cli.pid} must be alive`);
  const parent = await runProcess('/bin/ps', ['-o', 'ppid=', '-p', String(cli.pid)]);
  assert.equal(parent.exitCode, 0, parent.stderr);
  assert.equal(Number(parent.stdout.trim()), panePid, 'CLI remains the exact tmux pane child');
  return {
    panePid,
    cliPid: cli.pid,
    cliSelfStartTicks: cli.selfStartTicks,
    cliSelfStartTickClock: cli.selfStartTickClock,
    cliKernelStartTicks: await readLinuxStartTicks(cli.pid),
    cliPlatformStartIdentity: await readPlatformStartIdentity(cli.pid),
  };
}

function assertSameTaskIdentity(expected, actual, phase) {
  assert.deepEqual(actual, expected, `${phase} must preserve pane PID and CLI start identity`);
}

async function createDetachedTask(context) {
  const command = [
    '/bin/sh -c',
    shellQuote(
      `${shellQuote(process.execPath)} ${shellQuote(detachedCliPath)} ` +
        `${shellQuote(context.identityPath)} ${shellQuote(context.marker)} & wait`,
    ),
  ].join(' ');
  const result = await runProcess(
    context.tmuxPath,
    [
      'new-session',
      '-d',
      '-s',
      context.sessionName,
      '-x',
      '100',
      '-y',
      '30',
      command,
    ],
    { env: context.env },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  await waitFor(async () => {
    try {
      await access(context.identityPath, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }, 'detached CLI identity file');
}

async function exactTaskCleanup(context) {
  const before = await readTaskIdentity(context).catch(() => null);
  const result = await runProcess(context.tmuxPath, ['kill-server'], { env: context.env });
  if (result.exitCode !== 0 && !/no server running|failed to connect/iu.test(result.stderr)) {
    throw new Error(`Exact isolated tmux cleanup failed: ${result.stderr}`);
  }
  if (before) {
    await waitFor(() => !processAlive(before.cliPid), 'detached CLI exit after exact cleanup');
    await waitFor(() => !processAlive(before.panePid), 'tmux pane exit after exact cleanup');
  }
  const probe = await runProcess(
    context.tmuxPath,
    ['has-session', '-t', `=${context.sessionName}`],
    { env: context.env },
  );
  assert.notEqual(probe.exitCode, 0, 'exact task session must be absent after cleanup');
  const socketPath = join(context.tmuxTmpDir, `tmux-${process.getuid()}`, 'default');
  let staleSocketRemoved = false;
  const staleSocket = await lstat(socketPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (staleSocket) {
    assert.equal(
      staleSocket.isSocket(),
      true,
      'refuse to unlink a non-socket from the private tmux socket path',
    );
    await unlink(socketPath);
    staleSocketRemoved = true;
  }
  const socketExists = await lstat(socketPath).then(() => true, () => false);
  assert.equal(socketExists, false, 'isolated tmux server socket must be absent');
  return {
    cliPidGone: before ? !processAlive(before.cliPid) : true,
    panePidGone: before ? !processAlive(before.panePid) : true,
    sessionAbsent: probe.exitCode !== 0,
    socketAbsent: !socketExists,
    staleSocketRemoved,
  };
}

function assertAttachOnly(build) {
  const buildTransports = build.transportFactory.context.transports.filter((transport) =>
    transport.label.startsWith(build.buildLabel),
  );
  const joined = [
    ...build.commands,
    ...buildTransports.flatMap((transport) => transport.inputs),
  ].join('\n');
  assert.equal(joined.includes('new-session'), false, `${build.buildLabel} cannot launch`);
  assert.ok(
    build.commands.some((command) => command.includes('tmux -u has-session')),
    `${build.buildLabel} must probe the exact detached session`,
  );
  assert.ok(
    buildTransports.some((transport) =>
      transport.inputs.some((input) => input.includes('attach-session')),
    ),
    `${build.buildLabel} must attach to the exact existing session`,
  );
}

function sanitizedEvidence(evidence) {
  const encoded = JSON.stringify(evidence);
  assert.equal(/token|credential|authorization|cookie/iu.test(encoded), false);
  return evidence;
}

export async function runTerminalCoordinatedRollbackCanary(options = {}) {
  if (options.enabled !== true && process.env.CAP_TERMINAL_ROLLBACK_CANARY !== '1') {
    throw new Error('Set CAP_TERMINAL_ROLLBACK_CANARY=1 to run the disposable local harness');
  }
  const tmuxPath = await requireExecutable('tmux');
  const pythonPath = await requireExecutable('python3');
  const shellPath = await requireExecutable('sh');
  // tmux's default socket is nested under <TMUX_TMPDIR>/tmux-<uid>/default.
  // macOS exposes a long per-user TMPDIR path that can exceed sockaddr_un's
  // fixed sun_path bound, so keep this private root explicitly short.
  const temporaryRoot = await mkdtemp('/tmp/captrb-');
  await chmod(temporaryRoot, 0o700);
  const tmuxTmpDir = join(temporaryRoot, 't');
  await mkdir(tmuxTmpDir, { mode: 0o700 });
  const expectedTmuxSocketPath = join(
    tmuxTmpDir,
    `tmux-${process.getuid()}`,
    'default',
  );
  assert.ok(
    Buffer.byteLength(expectedTmuxSocketPath) <= MAX_TMUX_UNIX_SOCKET_PATH_BYTES,
    `Isolated tmux default socket path is too long: ${expectedTmuxSocketPath}`,
  );
  const taskId = randomUUID();
  const context = {
    taskId,
    sessionName: detachedSessionName(taskId),
    marker: `rollback-${randomUUID()}`,
    identityPath: join(temporaryRoot, 'detached-cli-identity.json'),
    tmuxTmpDir,
    tmuxPath,
    pythonPath,
    shellPath,
    env: isolatedTmuxEnvironment(tmuxTmpDir),
    transports: [],
    activeProcessGroups: new Set(),
    diagnostics: [],
  };
  let taskCreated = false;
  let taskCleanup = null;
  const buildCleanups = [];
  try {
    await createDetachedTask(context);
    taskCreated = true;
    const originalIdentity = await readTaskIdentity(context);

    const currentN = await createGatewayBuild(context, 'current-n');
    const currentSocket = await attachCurrentWeb(currentN, context);
    assert.equal(frameOf(currentSocket, 'terminal_attachment_state')?.protocolVersion, TERMINAL_PROTOCOL_VERSION);
    const opensBeforeOldWeb = currentN.transportFactory.openCount;
    const oldWebAgainstCurrent = new FakeSocket();
    await connectGateway(currentN.gateway, oldWebAgainstCurrent, context.taskId);
    sendGatewayFrame(
      currentN.gateway,
      oldWebAgainstCurrent,
      createNMinusOneTerminalAttachFrame(100, 30),
    );
    await settleGateway();
    assertReloadRequired(oldWebAgainstCurrent, 'response_profile_mismatch');
    assert.equal(
      currentN.transportFactory.openCount,
      opensBeforeOldWeb,
      'current API mismatch must precede a viewer PTY open',
    );
    assertSameTaskIdentity(originalIdentity, await readTaskIdentity(context), 'current/old mismatch');
    assertAttachOnly(currentN);
    buildCleanups.push({ buildId: 'current-n', ...(await shutdownGatewayBuild(currentN)) });
    assertSameTaskIdentity(originalIdentity, await readTaskIdentity(context), 'current API shutdown');

    const priorNMinusOne = await createGatewayBuild(context, 'n-minus-one');
    const priorApi = new NMinusOneApiBuild(priorNMinusOne.gateway);
    const opensBeforeCurrentWeb = priorNMinusOne.transportFactory.openCount;
    const currentWebAgainstPrior = new FakeSocket();
    const rejected = await priorApi.attach(
      currentWebAgainstPrior,
      context.taskId,
      createCurrentTerminalAttachFrame(100, 30),
    );
    assert.equal(rejected.delegated, false);
    assertReloadRequired(currentWebAgainstPrior, 'response_profile_mismatch');
    assert.equal(
      priorNMinusOne.transportFactory.openCount,
      opensBeforeCurrentWeb,
      'N-1 API mismatch must precede stable Gateway/provider delegation',
    );
    assertSameTaskIdentity(originalIdentity, await readTaskIdentity(context), 'old/current mismatch');
    const priorSocket = await attachNMinusOneWeb(priorApi, priorNMinusOne, context);
    assert.equal(frameOf(priorSocket, 'terminal_attachment_state')?.state, 'ready');
    assertAttachOnly(priorNMinusOne);
    assertSameTaskIdentity(originalIdentity, await readTaskIdentity(context), 'coordinated N-1 rollback');
    buildCleanups.push({
      buildId: N_MINUS_ONE_TERMINAL_BUILD.buildId,
      ...(await shutdownGatewayBuild(priorNMinusOne)),
    });
    assertSameTaskIdentity(originalIdentity, await readTaskIdentity(context), 'N-1 API shutdown');

    const restoredCurrent = await createGatewayBuild(context, 'current-restored');
    const restoredSocket = await attachCurrentWeb(restoredCurrent, context);
    assert.equal(frameOf(restoredSocket, 'terminal_attachment_state')?.state, 'ready');
    assertAttachOnly(restoredCurrent);
    const restoredIdentity = await readTaskIdentity(context);
    assertSameTaskIdentity(originalIdentity, restoredIdentity, 'current build restore');
    buildCleanups.push({
      buildId: 'current-restored',
      ...(await shutdownGatewayBuild(restoredCurrent)),
    });
    assertSameTaskIdentity(originalIdentity, await readTaskIdentity(context), 'final Gateway cleanup');

    taskCleanup = await exactTaskCleanup(context);
    taskCreated = false;
    const evidence = sanitizedEvidence({
      result: 'passed',
      fixture: {
        buildId: N_MINUS_ONE_TERMINAL_BUILD.buildId,
        provenanceKind: N_MINUS_ONE_TERMINAL_BUILD.provenance.kind,
        historicalReleaseArtifact: false,
        protocolVersion: N_MINUS_ONE_TERMINAL_BUILD.wire.protocolVersion,
        responseProfileId: N_MINUS_ONE_TERMINAL_BUILD.wire.responseProfile.id,
      },
      current: {
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
        responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
      },
      taskIdentity: originalIdentity,
      phases: [
        'current-n-attached',
        'current-api-old-web-reload-required',
        'prior-api-current-web-reload-required',
        'coordinated-n-minus-one-attach-only',
        'current-restored-attach-only',
      ],
      buildCleanups: buildCleanups.map((cleanup) => ({
        buildId: cleanup.buildId,
        kind: cleanup.kind,
        closedClientCount: cleanup.closedClientCount,
        closedSessionCount: cleanup.closedSessionCount,
        confirmedSourceCount: cleanup.confirmedSourceCount,
      })),
      taskCleanup,
    });
    if (options.evidencePath) {
      await writeFile(resolve(options.evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    return evidence;
  } finally {
    for (const transport of context.transports) {
      transport.close();
    }
    await Promise.race([
      Promise.all(context.transports.map((transport) => transport.cleanupDecision)),
      delay(1_500),
    ]).catch(() => undefined);
    for (const pid of [...context.activeProcessGroups]) {
      killExactProcessGroup(pid, 'SIGKILL');
    }
    if (taskCreated) {
      await exactTaskCleanup(context).catch(() => undefined);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseCliArguments(argv) {
  let evidencePath;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--evidence') {
      evidencePath = argv[index + 1];
      if (!evidencePath) throw new Error('--evidence requires a path');
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { evidencePath };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const options = parseCliArguments(process.argv.slice(2));
  runTerminalCoordinatedRollbackCanary(options).then(
    (evidence) => process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`),
    (error) => {
      process.stderr.write(`terminal-coordinated-rollback: ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    },
  );
}
