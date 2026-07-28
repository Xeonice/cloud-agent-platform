import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import {
  SandboxTerminalSession,
  type SandboxTerminalOwnerRecoveryEvent,
  type SandboxCommandExecutionRequest,
  type SandboxCommandExecutionResult,
  type SandboxCommandExecutor,
  type SandboxTerminalExitStatus,
  type TerminalTransportCleanupSettlement,
  type TerminalTransport,
  type TerminalTransportFactory,
  type TerminalTransportFrame,
  type TerminalTransportWriteOutcome,
  type TerminalViewerAttachmentFactory,
} from '@cap/sandbox';
import type { SessionCredentialsService } from '@/creds/session-credentials.service';
import type { AuditRecorderPort } from '@/audit/audit-recorder.port';
import type { ProvisionLookup } from '@/provision-lookup/provision-lookup.port';
import {
  GuardrailsService,
  type ExitStatus,
  type GuardrailsConfig,
} from '@/guardrails/guardrails.service';
import {
  TerminalGateway,
  type TerminalSession,
} from './terminal.gateway';

const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
  diagnosticWriteTimeoutMs: 10,
};

const PROVISION_LOOKUP: ProvisionLookup = {
  async getTaskLaunchContext() {
    return {
      modelIntent: { kind: 'runtime-default' },
      ownerUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      runtimeId: 'codex',
      executionMode: 'interactive-pty',
      workspaceMaterializationDeadlineMs: 900_000,
    };
  },
  async getCloneSpec() {
    return null;
  },
  async getTaskPrompt() {
    return null;
  },
  async getTaskSkills() {
    return [];
  },
  async getTaskRuntime() {
    return 'codex';
  },
  async getTaskExecutionMode() {
    return 'interactive-pty';
  },
};

function commandResult(output: string): SandboxCommandExecutionResult {
  return {
    exitCode: 0,
    output,
    stdout: output,
    stderr: '',
    timedOut: false,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('condition was not reached');
}

class FakeTerminalTransport implements TerminalTransport {
  readonly opaqueInputCapability = 'byte-preserving' as const;
  readonly cleanupDecision: Promise<TerminalTransportCleanupSettlement> =
    Promise.resolve({
      kind: 'confirmed',
      expectedIdentities: 1,
      observedIdentities: 1,
      confirmedIdentities: 1,
      deletedIdentities: 1,
      alreadyAbsentIdentities: 0,
      cause: null,
    });
  readonly inputs: string[] = [];
  readonly frameListeners = new Set<(frame: TerminalTransportFrame) => void>();
  readonly closeListeners = new Set<() => void>();
  readonly errorListeners = new Set<(error: Error) => void>();
  readyState = 'open' as const;
  closeCount = 0;

  onFrame(listener: (frame: TerminalTransportFrame) => void): { dispose(): void } {
    this.frameListeners.add(listener);
    return { dispose: () => this.frameListeners.delete(listener) };
  }

  onClose(listener: () => void): { dispose(): void } {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  onError(listener: (error: Error) => void): { dispose(): void } {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  sendInput(data: string): boolean {
    this.inputs.push(data);
    return true;
  }

  sendInputBytes(): TerminalTransportWriteOutcome {
    return 'written';
  }

  sendTerminalResponseBytes(): TerminalTransportWriteOutcome {
    return 'written';
  }

  sendResize(): boolean {
    return true;
  }

  sendPong(): boolean {
    return true;
  }

  pause(): void {}
  resume(): void {}

  close(): void {
    this.closeCount += 1;
  }

  emit(frame: TerminalTransportFrame): void {
    for (const listener of this.frameListeners) listener(frame);
  }

  emitClose(): void {
    for (const listener of this.closeListeners) listener();
  }
}

class FakeTerminalTransportFactory implements TerminalTransportFactory {
  readonly transports: FakeTerminalTransport[] = [];

  open(): FakeTerminalTransport {
    const transport = new FakeTerminalTransport();
    this.transports.push(transport);
    return transport;
  }
}

class ObservedGuardrailsService extends GuardrailsService {
  readonly exitStatuses: ExitStatus[] = [];

  override recordExit(taskId: string, status: ExitStatus): void {
    this.exitStatuses.push(status);
    super.recordExit(taskId, status);
  }
}

class OwnerExitGateway extends TerminalGateway {
  readonly unregisteredTasks: string[] = [];

  acceptOwnerExit(taskId: string, status: SandboxTerminalExitStatus): void {
    this.onSessionExit(taskId, status);
  }

  override unregisterSession(taskId: string): void {
    this.unregisteredTasks.push(taskId);
    super.unregisterSession(taskId);
  }
}

test('attach-only readoption owner redials alive through Gateway without relaunch or false continuity', async () => {
  const commands: SandboxCommandExecutionRequest[] = [];
  const executor: SandboxCommandExecutor = {
    async exec(request) {
      commands.push(request);
      return commandResult('__cap_has__0\n');
    },
  };
  const transportFactory = new FakeTerminalTransportFactory();
  const recoveryEvents: SandboxTerminalOwnerRecoveryEvent[] = [];
  const exitStatuses: SandboxTerminalExitStatus[] = [];
  const gateway = new OwnerExitGateway();
  const owner = new SandboxTerminalSession(
    TASK_ID,
    'ws://unused.test/terminal',
    'http://unused.test',
    (status) => {
      exitStatuses.push(status);
      gateway.acceptOwnerExit(TASK_ID, status);
    },
    'attach-only',
    undefined,
    transportFactory,
    executor,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      readyTimeoutMs: 20,
      cleanupTimeoutMs: 20,
      jitterRatio: 0,
      onEvent: (event) => recoveryEvents.push(event),
    },
  );
  let viewerOpens = 0;
  gateway.registerSession({
    taskId: TASK_ID,
    ownerPty: owner,
    viewerFactory: {
      open() {
        viewerOpens += 1;
        throw new Error('owner readoption/redial must not manufacture a viewer');
      },
    },
    geometry: { cols: 80, rows: 24 },
    launchDecision: owner.launchDecision,
  });

  const initial = transportFactory.transports[0];
  assert.ok(initial);
  initial.emit({ type: 'session_id', data: 'owner-readoption-initial' });
  initial.emit({ type: 'ready' });
  assert.deepEqual(await owner.launchDecision, { kind: 'attached' });
  assert.equal(initial.inputs.some((input) => input.includes('attach')), true);
  assert.equal(initial.inputs.some((input) => input.includes('new-session')), false);

  initial.emitClose();
  await waitFor(() => transportFactory.transports.length === 2);
  const replacement = transportFactory.transports[1];
  assert.ok(replacement);
  replacement.emit({ type: 'session_id', data: 'owner-readoption-redial' });
  replacement.emit({ type: 'ready' });
  await waitFor(() => replacement.inputs.some((input) => input.includes('attach')));

  assert.deepEqual(
    recoveryEvents.map((event) => event.kind),
    ['outage', 'retry', 'restored'],
  );
  assert.equal(recoveryEvents.at(-1)?.durationMs !== undefined, true);
  assert.equal(
    recoveryEvents.some((event) => 'missingBytes' in event),
    false,
    'the owner outage reports duration but does not invent a missing-byte count',
  );
  assert.deepEqual(exitStatuses, []);
  assert.deepEqual(gateway.unregisteredTasks, []);
  assert.deepEqual(gateway.getProviderTerminalStoryResourceState(TASK_ID), {
    ownerRegistered: true,
    activeViewerCount: 0,
  });
  assert.equal(viewerOpens, 0);
  assert.equal(
    [...initial.inputs, ...replacement.inputs].some((input) =>
      input.includes('new-session'),
    ),
    false,
  );
  assert.equal(
    commands.length >= 2 &&
      commands.every(({ command }) => command.includes('tmux -u has-session')),
    true,
  );

  gateway.unregisterSession(TASK_ID);
});

test('attach-only owner recovery absence crosses Gateway and Guardrails exactly once without false continuity or relaunch', async () => {
  const destroyedCredentials: Array<{ taskId: string; reason: string }> = [];
  const teardownTasks: string[] = [];
  const abnormalAudits: Array<{ taskId: string; cause: string }> = [];
  const exitAudits: Array<{
    taskId: string;
    code: number | null;
    abnormal: boolean;
  }> = [];
  const transitions: string[] = [];
  let viewerOpens = 0;

  const guardrails = new ObservedGuardrailsService(
    {} as ModuleRef,
    {
      destroyForSession(taskId: string, reason: string) {
        destroyedCredentials.push({ taskId, reason });
      },
    } as unknown as SessionCredentialsService,
    {
      async teardownSandbox(taskId: string) {
        teardownTasks.push(taskId);
      },
    } as never,
    CONFIG,
    PROVISION_LOOKUP,
    {
      async recordExited(
        taskId: string,
        code: number | null,
        abnormal: boolean,
      ) {
        exitAudits.push({ taskId, code, abnormal });
      },
      async recordForceFailed(taskId: string, cause: string) {
        abnormalAudits.push({ taskId, cause });
      },
    } as unknown as AuditRecorderPort,
  );
  const gateway = new OwnerExitGateway(undefined, guardrails);
  Object.assign(guardrails, { gateway });
  Object.assign(guardrails, {
    tasks: {
      async classifyRuntimeOutputFailure() {
        return null;
      },
      async transition(taskId: string, status: string) {
        transitions.push(status);
        guardrails.fenceTerminal(taskId, status as 'failed');
        await guardrails.onTerminal(taskId, status as 'failed');
      },
    },
  });

  const commands: SandboxCommandExecutionRequest[] = [];
  let sessionProbe = 0;
  const executor: SandboxCommandExecutor = {
    async exec(request) {
      commands.push(request);
      sessionProbe += 1;
      return commandResult(
        sessionProbe === 1 ? '__cap_has__0\n' : '__cap_has__1\n',
      );
    },
  };
  const transportFactory = new FakeTerminalTransportFactory();
  const owner = new SandboxTerminalSession(
    TASK_ID,
    'ws://unused.test/terminal',
    'http://unused.test',
    (status) => gateway.acceptOwnerExit(TASK_ID, status),
    'attach-only',
    undefined,
    transportFactory,
    executor,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      readyTimeoutMs: 10,
      jitterRatio: 0,
    },
  );
  const viewerFactory: TerminalViewerAttachmentFactory = {
    open() {
      viewerOpens += 1;
      throw new Error('an absent owner must not open a viewer');
    },
  };
  const terminalSession: TerminalSession = {
    taskId: TASK_ID,
    ownerPty: owner,
    viewerFactory,
    geometry: { cols: 80, rows: 24 },
    launchDecision: owner.launchDecision,
  };
  gateway.registerSession(terminalSession);

  const initialTransport = transportFactory.transports[0];
  assert.ok(initialTransport);
  initialTransport.emit({ type: 'session_id', data: 'owner-initial' });
  initialTransport.emit({ type: 'ready' });
  assert.deepEqual(await owner.launchDecision, { kind: 'attached' });
  assert.equal(initialTransport.inputs.some((input) => input.includes('attach')), true);
  assert.equal(initialTransport.inputs.some((input) => input.includes('new-session')), false);
  const initialInputs = [...initialTransport.inputs];

  // The established owner disappears and the exact-session recovery probe now
  // proves absence. This is an unobserved exit, never a fresh-launch decision.
  initialTransport.emitClose();
  await waitFor(
    () =>
      transitions.length === 1 &&
      teardownTasks.length === 1 &&
      gateway.unregisteredTasks.length === 1,
  );

  assert.deepEqual(guardrails.exitStatuses, [{ code: null, abnormal: true }]);
  assert.deepEqual(transitions, ['failed']);
  assert.deepEqual(abnormalAudits, [
    { taskId: TASK_ID, cause: 'abnormal_exit' },
  ]);
  assert.deepEqual(exitAudits, [
    { taskId: TASK_ID, code: null, abnormal: true },
  ]);
  assert.deepEqual(teardownTasks, [TASK_ID]);
  assert.deepEqual(destroyedCredentials, [
    { taskId: TASK_ID, reason: 'failed' },
  ]);
  assert.deepEqual(gateway.unregisteredTasks, [TASK_ID]);
  assert.deepEqual(gateway.getProviderTerminalStoryResourceState(TASK_ID), {
    ownerRegistered: false,
    activeViewerCount: 0,
  });
  assert.equal(viewerOpens, 0);
  assert.equal(transportFactory.transports.length, 1);
  assert.deepEqual(initialTransport.inputs, initialInputs);
  assert.equal(
    commands.every(({ command }) => command.includes('tmux -u has-session')),
    true,
  );
  assert.equal(commands.some(({ command }) => command.includes('new-session')), false);
  assert.equal(
    (
      guardrails as unknown as {
        breaker: { consecutiveFailures(taskId: string): number };
      }
    ).breaker.consecutiveFailures(TASK_ID),
    1,
  );

  // A late duplicate close from the retired generation cannot manufacture a
  // second failure, a success, or a replacement owner/viewer.
  initialTransport.emitClose();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(guardrails.exitStatuses.length, 1);
  assert.equal(exitAudits.length, 1);
  assert.equal(abnormalAudits.length, 1);
  assert.deepEqual(transitions, ['failed']);
  assert.equal(transportFactory.transports.length, 1);
  assert.equal(viewerOpens, 0);
});
