/**
 * Provider-neutral settle plan for an admitted sandbox task.
 *
 * The caller still owns side effects (capture transcript, deliver, teardown,
 * unregister terminal session, release semaphore). This plan centralizes the
 * lifecycle order so normal terminal exits and guardrail failures do not drift.
 */
export interface SandboxSettlePlan {
  readonly sessionReason: 'completed' | 'failed';
  readonly captureTranscript: true;
  readonly deliverWorkspace: boolean;
  readonly teardownSandbox: true;
  readonly teardownSession: true;
  readonly releaseSlot: true;
}

export function buildSandboxSettlePlan(args: {
  readonly sessionReason: 'completed' | 'failed';
  readonly deliverWorkspace: boolean;
}): SandboxSettlePlan {
  return {
    sessionReason: args.sessionReason,
    captureTranscript: true,
    deliverWorkspace: args.deliverWorkspace,
    teardownSandbox: true,
    teardownSession: true,
    releaseSlot: true,
  };
}

export function terminalSettlePlan(): SandboxSettlePlan {
  return buildSandboxSettlePlan({
    sessionReason: 'completed',
    deliverWorkspace: true,
  });
}

export function forceFailSettlePlan(args: {
  readonly terminal: 'completed' | 'failed';
}): SandboxSettlePlan {
  return buildSandboxSettlePlan({
    sessionReason: args.terminal,
    deliverWorkspace: false,
  });
}
