import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TaskFailureCode } from '@cap-console/contracts';
import { ClaudeCodeRuntime } from '@/agent-runtime/claude-code-runtime';
import { CodexRuntime } from '@/agent-runtime/codex-runtime';
import type { RuntimeRegistry } from '@/agent-runtime/agent-runtime.integration';
import type { GuardrailsService } from '@/guardrails/guardrails.service';
import type { AgentTerminalOutputMeta } from './agent-terminal-pty';
import { TerminalGateway } from './terminal.gateway';
import { DEFAULT_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES } from '@/session-recording/recording-policy';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

interface OutputHarness {
  onPtyOutput(
    taskId: string,
    chunk: string,
    meta?: AgentTerminalOutputMeta,
  ): void;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not reached');
}

function outputHarness(gateway: TerminalGateway): OutputHarness {
  return gateway as unknown as OutputHarness;
}

test('raw recording off creates no files under long alternate-screen output while lifecycle evidence stays bounded', async () => {
  const envNames = [
    'CAP_TERMINAL_RAW_LOG_RECORDING_ENABLED',
    'CAP_TERMINAL_RAW_CAST_RECORDING_ENABLED',
    'WORKSPACES_DIR',
  ] as const;
  const previous = new Map(envNames.map((name) => [name, process.env[name]]));
  delete process.env.CAP_TERMINAL_RAW_LOG_RECORDING_ENABLED;
  delete process.env.CAP_TERMINAL_RAW_CAST_RECORDING_ENABLED;
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), 'cap-default-raw-off-'),
  );
  process.env.WORKSPACES_DIR = workspaceRoot;
  try {
    const failures: TaskFailureCode[] = [];
    const activity: string[] = [];
    const exits: Array<{ code: number | null; abnormal: boolean }> = [];
    const guardrails = {
      recordActivity(taskId: string) {
        activity.push(taskId);
      },
      recordExit(_taskId: string, status: { code: number | null; abnormal: boolean }) {
        exits.push(status);
      },
      async failRuntime(_taskId: string, code: TaskFailureCode) {
        failures.push(code);
        return true;
      },
    } as unknown as GuardrailsService;
    const registry = {
      async resolveForTask() {
        return new CodexRuntime();
      },
    } as unknown as RuntimeRegistry;
    const gateway = new TerminalGateway(
      undefined,
      guardrails,
      undefined,
      registry,
    );
    const internal = gateway as unknown as {
      onPtyOutput(taskId: string, chunk: string, meta?: AgentTerminalOutputMeta): void;
      onSessionExit(
        taskId: string,
        status: { code: number | null; abnormal: boolean },
      ): void;
      applyAuthoritativeGeometry(
        taskId: string,
        geometry: { cols: number; rows: number },
      ): void;
      sessions: Map<string, unknown>;
      sessionLogs: Map<string, unknown>;
      sessionCasts: Map<string, unknown>;
      pendingCastResizeEvents: Map<string, unknown>;
      runtimeFailureBuffers: Map<string, string>;
    };

    internal.sessions.set(TASK_ID, {
      taskId: TASK_ID,
      ownerPty: { resize() {}, close() {} },
      viewerFactory: {},
      geometry: { cols: 80, rows: 24 },
      launchDecision: Promise.resolve({ kind: 'attached' }),
    });
    const alternateScreenLongOutput =
      '\u001b[?1049h\u001b[2J\u001b[1;1H\u001b[38;5;45m' +
      '原生终端 styled frame\r\n'.repeat(64_000) +
      '\u001b[0m\u001b[?1049l';
    internal.onPtyOutput(
      TASK_ID,
      `${alternateScreenLongOutput}HTTP 401 Unauthorized\n` +
        '{"error":{"message":"Provided authentication token is expired. Please try signing in again.","type":"invalid_request_error"}}\n',
      { recordable: true, source: 'agent' },
    );
    await waitFor(() => failures.length === 1);

    assert.deepEqual(failures, ['runtime_auth_expired']);
    assert.deepEqual(activity, [TASK_ID]);
    internal.applyAuthoritativeGeometry(TASK_ID, { cols: 100, rows: 30 });
    assert.equal(internal.sessionLogs.size, 0);
    assert.equal(internal.sessionCasts.size, 0);
    assert.equal(internal.pendingCastResizeEvents.size, 0);
    assert.equal(
      existsSync(path.join(workspaceRoot, TASK_ID, 'session.log')),
      false,
    );
    assert.equal(
      existsSync(path.join(workspaceRoot, TASK_ID, 'session.cast')),
      false,
    );
    assert.ok(
      Buffer.byteLength(internal.runtimeFailureBuffers.get(TASK_ID) ?? '') <=
        DEFAULT_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES,
    );
    const evidence = await gateway.readSessionLogTail(TASK_ID);
    assert.match(evidence, /Provided authentication token is expired/);

    internal.onSessionExit(TASK_ID, { code: 7, abnormal: false });
    assert.deepEqual(exits, [{ code: 7, abnormal: false }]);
    gateway.unregisterSession(TASK_ID);
    assert.equal(internal.runtimeFailureBuffers.size, 0);
  } finally {
    for (const name of envNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('re-checks Claude auth output that completes while classification is in flight', async () => {
  let releaseFirstResolve: (() => void) | undefined;
  const firstResolveGate = new Promise<void>((resolve) => {
    releaseFirstResolve = resolve;
  });
  let resolves = 0;
  const runtime = new ClaudeCodeRuntime();
  const registry = {
    async resolveForTask() {
      resolves += 1;
      if (resolves === 1) await firstResolveGate;
      return runtime;
    },
  } as unknown as RuntimeRegistry;
  const failures: TaskFailureCode[] = [];
  const guardrails = {
    recordActivity() {},
    async failRuntime(_taskId: string, code: TaskFailureCode) {
      failures.push(code);
      return true;
    },
  } as unknown as GuardrailsService;
  const gateway = new TerminalGateway(undefined, guardrails, undefined, registry);
  const output = outputHarness(gateway);

  output.onPtyOutput(TASK_ID, 'Session expired.', {
    recordable: true,
    source: 'agent',
  });
  assert.equal(resolves, 1);

  output.onPtyOutput(TASK_ID, ' Please run /login to sign in again.\n', {
    recordable: true,
    source: 'agent',
  });
  releaseFirstResolve?.();

  await waitFor(() => failures.length === 1);
  assert.deepEqual(failures, ['runtime_auth_expired']);
  assert.equal(resolves, 1, 'the selected runtime is cached across the re-check');

  output.onPtyOutput(
    TASK_ID,
    'Session expired. Please run /login to sign in again.\n',
    { recordable: true, source: 'agent' },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(failures.length, 1, 'a classified task is failed exactly once');
});

test('ignores attach/bootstrap text but classifies recordable Codex output', async () => {
  const runtime = new CodexRuntime();
  const registry = {
    async resolveForTask() {
      return runtime;
    },
  } as unknown as RuntimeRegistry;
  const failures: TaskFailureCode[] = [];
  const guardrails = {
    recordActivity() {},
    async failRuntime(_taskId: string, code: TaskFailureCode) {
      failures.push(code);
      return true;
    },
  } as unknown as GuardrailsService;
  const gateway = new TerminalGateway(undefined, guardrails, undefined, registry);
  const output = outputHarness(gateway);
  const expired =
    'HTTP 401 Unauthorized\n' +
    '{"error":{"message":"Provided authentication token is expired. Please try signing in again.","type":"invalid_request_error"}}\n';

  output.onPtyOutput(TASK_ID, expired, {
    recordable: false,
    source: 'attach-bootstrap',
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(failures, []);

  output.onPtyOutput(TASK_ID, expired, {
    recordable: true,
    source: 'agent',
  });
  await waitFor(() => failures.length === 1);
  assert.deepEqual(failures, ['runtime_auth_expired']);
});

test('caches the selected runtime for ordinary auth-related output', async () => {
  let resolves = 0;
  const registry = {
    async resolveForTask() {
      resolves += 1;
      return new CodexRuntime();
    },
  } as unknown as RuntimeRegistry;
  const failures: TaskFailureCode[] = [];
  const guardrails = {
    recordActivity() {},
    async failRuntime(_taskId: string, code: TaskFailureCode) {
      failures.push(code);
      return true;
    },
  } as unknown as GuardrailsService;
  const gateway = new TerminalGateway(undefined, guardrails, undefined, registry);
  const output = outputHarness(gateway);

  output.onPtyOutput(TASK_ID, 'Document how token rotation works.\n');
  await waitFor(() => resolves === 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  output.onPtyOutput(TASK_ID, 'Authentication is handled by the platform.\n');
  output.onPtyOutput(TASK_ID, 'No provider error occurred.\n');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(resolves, 1, 'PTY chunks do not cause task-level database lookups');
  assert.deepEqual(failures, []);
});

test('does not revive runtime classifier state after terminal unregister', async () => {
  let releaseResolve: (() => void) | undefined;
  const resolveGate = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const registry = {
    async resolveForTask() {
      await resolveGate;
      return new ClaudeCodeRuntime();
    },
  } as unknown as RuntimeRegistry;
  const failures: TaskFailureCode[] = [];
  const guardrails = {
    recordActivity() {},
    async failRuntime(_taskId: string, code: TaskFailureCode) {
      failures.push(code);
      return true;
    },
  } as unknown as GuardrailsService;
  const gateway = new TerminalGateway(undefined, guardrails, undefined, registry);
  const output = outputHarness(gateway);

  output.onPtyOutput(
    TASK_ID,
    'Session expired. Please run /login to sign in again.\n',
  );
  gateway.unregisterSession(TASK_ID);
  releaseResolve?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(failures, []);
  const state = gateway as unknown as {
    runtimeFailureRuntimes: Map<string, unknown>;
    runtimeFailuresReported: Set<string>;
  };
  assert.equal(state.runtimeFailureRuntimes.size, 0);
  assert.equal(state.runtimeFailuresReported.size, 0);
});
