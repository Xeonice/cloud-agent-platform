import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskFailureCode } from '@cap/contracts';
import { ClaudeCodeRuntime } from '../agent-runtime/claude-code-runtime';
import { CodexRuntime } from '../agent-runtime/codex-runtime';
import type { RuntimeRegistry } from '../agent-runtime/agent-runtime.integration';
import type { GuardrailsService } from '../guardrails/guardrails.service';
import type { AgentTerminalOutputMeta } from './agent-terminal-pty';
import { TerminalGateway } from './terminal.gateway';

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
