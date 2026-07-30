import type {
  SandboxCommandExecutor,
  TerminalOpaqueInputCapability,
  TerminalTransport,
  TerminalTransportCleanupSettlement,
  TerminalTransportFactory,
  TerminalTransportFrame,
  TerminalTransportWriteOutcome,
  TerminalViewerAttachment,
  TerminalViewerAttachmentFactory,
  TerminalViewerAttachmentOutcome,
  TerminalViewerDataListener,
} from '@cap-console/sandbox-core';
import {
  buildExactHasSessionCommand,
  buildViewerAttachSessionCommand,
} from './session-commands.js';
import {
  confirmedEmptyTerminalCleanupSettlement,
  indeterminateTerminalCleanupSettlement,
  normalizeTerminalCleanupDecision,
} from './cleanup.js';

const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 3_000;
const DEFAULT_QUIET_MS = 40;
const DEFAULT_MAX_SETTLE_MS = 1_000;
const VIEWER_PROBE_TIMEOUT_MS = 5_000;

export interface TerminalViewerAttachmentPolicy {
  /** Maximum wait for the first tmux redraw byte. */
  readonly firstOutputTimeoutMs?: number;
  /** Output silence used only to decide when the browser may reveal xterm. */
  readonly quietMs?: number;
  /** Hard reveal deadline after the first byte for continuously repainting TUIs. */
  readonly maxSettleMs?: number;
  readonly probeTimeoutMs?: number;
}

export interface SandboxTerminalViewerAttachmentFactoryArgs {
  readonly taskId: string;
  readonly transportFactory: TerminalTransportFactory;
  readonly commandExecutor: SandboxCommandExecutor;
  readonly policy?: TerminalViewerAttachmentPolicy;
}

/**
 * Provider-neutral factory for disposable, attach-only browser PTYs. Every call
 * opens a new provider transport and never shares it with the task owner or a
 * peer viewer.
 */
export class SandboxTerminalViewerAttachmentFactory
  implements TerminalViewerAttachmentFactory
{
  constructor(
    private readonly args: SandboxTerminalViewerAttachmentFactoryArgs,
  ) {}

  open(args: {
    readonly cols: number;
    readonly rows: number;
    readonly signal?: AbortSignal;
  }): TerminalViewerAttachment {
    return new SandboxTerminalViewerAttachment(
      this.args.taskId,
      this.args.transportFactory,
      this.args.commandExecutor,
      args.cols,
      args.rows,
      args.signal,
      this.args.policy,
    );
  }
}

/**
 * One fresh outer PTY joined to an existing exact tmux session. The ready
 * decision is a bounded UI-reveal heuristic, not proof that a continuously
 * repainting terminal emitted an atomic final frame.
 */
export class SandboxTerminalViewerAttachment
  implements TerminalViewerAttachment
{
  readonly attachmentDecision: Promise<TerminalViewerAttachmentOutcome>;
  readonly cleanupDecision: Promise<TerminalTransportCleanupSettlement>;

  private resolveAttachmentDecision!: (
    outcome: TerminalViewerAttachmentOutcome,
  ) => void;
  private resolveCleanupDecision!: (
    settlement: TerminalTransportCleanupSettlement,
  ) => void;
  private decisionSettled = false;
  private cleanupDecisionSettled = false;
  private readonly dataListeners = new Set<TerminalViewerDataListener>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly policy: Required<TerminalViewerAttachmentPolicy>;
  private transport?: TerminalTransport;
  private transportCleanupDecision?: Promise<TerminalTransportCleanupSettlement>;
  private generation = 1;
  private closed = false;
  private closeEmitted = false;
  private providerReady = false;
  private probeOutcome: 'pending' | 'live' = 'pending';
  private attachStarted = false;
  private forwarding = false;
  private sawOutput = false;
  private cols: number;
  private rows: number;
  private firstOutputTimer?: ReturnType<typeof setTimeout>;
  private quietTimer?: ReturnType<typeof setTimeout>;
  private maxSettleTimer?: ReturnType<typeof setTimeout>;
  private abortListener?: () => void;

  constructor(
    private readonly taskId: string,
    transportFactory: TerminalTransportFactory,
    private readonly commandExecutor: SandboxCommandExecutor,
    cols: number,
    rows: number,
    private readonly signal?: AbortSignal,
    policy: TerminalViewerAttachmentPolicy = {},
  ) {
    this.cols = cols;
    this.rows = rows;
    this.policy = normalizePolicy(policy);
    this.attachmentDecision = new Promise((resolve) => {
      this.resolveAttachmentDecision = resolve;
    });
    this.cleanupDecision = new Promise((resolve) => {
      this.resolveCleanupDecision = resolve;
    });

    if (!validGeometry(cols, rows)) {
      this.settle({ kind: 'failed', reason: 'invalid-geometry' });
      this.settleCleanupDecision(confirmedEmptyTerminalCleanupSettlement());
      this.closed = true;
      return;
    }
    if (signal?.aborted) {
      this.settle({ kind: 'failed', reason: 'aborted' });
      this.settleCleanupDecision(confirmedEmptyTerminalCleanupSettlement());
      this.closed = true;
      return;
    }

    try {
      const transport = transportFactory.open();
      this.transport = transport;
      this.transportCleanupDecision = normalizeTerminalCleanupDecision(
        transport.cleanupDecision,
      );
      this.subscriptions.push(
        transport.onFrame((frame) => this.onFrame(transport, frame)),
        transport.onClose(() => this.onTransportClose(transport)),
        transport.onError((error) => this.onTransportError(transport, error)),
      );
    } catch {
      this.settle({ kind: 'failed', reason: 'transport' });
      const transport = this.transport;
      if (transport) {
        try {
          transport.close();
        } catch {
          // The identity-free cleanup decision below remains authoritative.
        }
        this.forwardTransportCleanupDecision();
      } else {
        this.settleCleanupDecision(
          indeterminateTerminalCleanupSettlement('identity-unavailable'),
        );
      }
      this.closed = true;
      return;
    }

    if (signal) {
      this.abortListener = () => this.fail('aborted');
      signal.addEventListener('abort', this.abortListener, { once: true });
    }

    const generation = this.generation;
    void this.probeExistingSession(generation);
  }

  get opaqueInputCapability(): TerminalOpaqueInputCapability {
    return this.transport?.opaqueInputCapability ?? 'unsupported';
  }

  onData(listener: TerminalViewerDataListener): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onClose(listener: () => void): { dispose(): void } {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  onError(listener: (error: Error) => void): { dispose(): void } {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  write(data: Uint8Array): TerminalTransportWriteOutcome {
    if (this.closed || !this.attachStarted || !this.transport) return 'closed';
    return this.transport.sendInputBytes(data);
  }

  writeTerminalResponse(data: Uint8Array): TerminalTransportWriteOutcome {
    if (this.closed || !this.attachStarted || !this.transport) return 'closed';
    return this.transport.sendTerminalResponseBytes(data);
  }

  resize(cols: number, rows: number): void {
    if (this.closed || !validGeometry(cols, rows)) return;
    this.cols = cols;
    this.rows = rows;
    if (this.attachStarted) this.transport?.sendResize(cols, rows);
  }

  pause(): void {
    if (!this.closed) this.transport?.pause();
  }

  resume(): void {
    if (!this.closed) this.transport?.resume();
  }

  close(): void {
    if (this.closed) return;
    if (!this.decisionSettled) {
      this.settle({ kind: 'failed', reason: 'aborted' });
    }
    this.finishClose(true);
  }

  private async probeExistingSession(generation: number): Promise<void> {
    try {
      const result = await this.commandExecutor.exec({
        command: buildExactHasSessionCommand(this.taskId),
        timeoutMs: this.policy.probeTimeoutMs,
        signal: this.signal,
      });
      if (!this.isCurrent(generation)) return;
      if (result.timedOut) {
        this.settleAndClose({ kind: 'indeterminate' });
        return;
      }
      if (result.exitCode === 0) {
        this.probeOutcome = 'live';
        this.maybeAttach(generation);
        return;
      }
      this.settleAndClose(
        result.exitCode === 1 ? { kind: 'absent' } : { kind: 'indeterminate' },
      );
    } catch {
      if (!this.isCurrent(generation)) return;
      this.settleAndClose(
        this.signal?.aborted
          ? { kind: 'failed', reason: 'aborted' }
          : { kind: 'indeterminate' },
      );
    }
  }

  private onFrame(transport: TerminalTransport, frame: TerminalTransportFrame): void {
    if (transport !== this.transport || this.closed) return;
    switch (frame.type) {
      case 'ready':
        this.providerReady = true;
        this.maybeAttach(this.generation);
        return;
      case 'ping':
        if (typeof frame.timestamp === 'number') {
          transport.sendPong(frame.timestamp);
        }
        return;
      case 'output': {
        if (!this.forwarding) return;
        const bytes = terminalFrameBytes(frame);
        if (!bytes) return;
        for (const listener of this.dataListeners) listener(bytes);
        this.observeRedrawOutput();
        return;
      }
      default:
        return;
    }
  }

  private maybeAttach(generation: number): void {
    if (
      !this.isCurrent(generation) ||
      this.attachStarted ||
      !this.providerReady ||
      this.probeOutcome !== 'live' ||
      !this.transport
    ) {
      return;
    }

    if (!this.transport.sendResize(this.cols, this.rows)) {
      this.fail('transport');
      return;
    }

    // Set the fence before sending: a deterministic fake/provider is allowed to
    // emit command echo or redraw bytes synchronously from sendInput().
    this.attachStarted = true;
    this.forwarding = true;
    if (!this.transport.sendInput(`${buildViewerAttachSessionCommand(this.taskId)}\r`)) {
      this.fail('transport');
      return;
    }
    this.firstOutputTimer = setTimeout(() => {
      this.firstOutputTimer = undefined;
      if (!this.sawOutput) this.fail('blank-redraw');
    }, this.policy.firstOutputTimeoutMs);
  }

  private observeRedrawOutput(): void {
    if (!this.sawOutput) {
      this.sawOutput = true;
      if (this.firstOutputTimer) {
        clearTimeout(this.firstOutputTimer);
        this.firstOutputTimer = undefined;
      }
      this.maxSettleTimer = setTimeout(() => {
        this.maxSettleTimer = undefined;
        this.settle({ kind: 'ready' });
      }, this.policy.maxSettleMs);
    }
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined;
      this.settle({ kind: 'ready' });
    }, this.policy.quietMs);
  }

  private onTransportClose(transport: TerminalTransport): void {
    if (transport !== this.transport || this.closed) return;
    if (!this.decisionSettled) {
      this.settle({ kind: 'failed', reason: 'transport' });
    }
    this.finishClose(false);
  }

  private onTransportError(transport: TerminalTransport, error: Error): void {
    if (transport !== this.transport || this.closed) return;
    for (const listener of this.errorListeners) listener(error);
    if (!this.decisionSettled) this.fail('transport');
  }

  private fail(
    reason: Extract<TerminalViewerAttachmentOutcome, { kind: 'failed' }>['reason'],
  ): void {
    if (this.closed) return;
    this.settle({ kind: 'failed', reason });
    this.finishClose(true);
  }

  private settleAndClose(outcome: TerminalViewerAttachmentOutcome): void {
    if (this.closed) return;
    this.settle(outcome);
    this.finishClose(true);
  }

  private settle(outcome: TerminalViewerAttachmentOutcome): void {
    if (this.decisionSettled) return;
    this.decisionSettled = true;
    this.resolveAttachmentDecision(outcome);
    if (outcome.kind === 'ready') this.clearSettleTimers();
  }

  private finishClose(closeTransport: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.clearSettleTimers();
    if (this.abortListener && this.signal) {
      this.signal.removeEventListener('abort', this.abortListener);
      this.abortListener = undefined;
    }
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    if (closeTransport) {
      try {
        this.transport?.close();
      } catch {
        // A provider exception cannot skip the non-rejecting cleanup evidence.
      }
    }
    this.forwardTransportCleanupDecision();
    this.emitClose();
  }

  private forwardTransportCleanupDecision(): void {
    const cleanup = this.transportCleanupDecision;
    if (!cleanup) {
      this.settleCleanupDecision(
        this.transport
          ? indeterminateTerminalCleanupSettlement('cleanup-unsupported')
          : confirmedEmptyTerminalCleanupSettlement(),
      );
      return;
    }
    void cleanup.then((settlement) => {
      this.settleCleanupDecision(settlement);
    });
  }

  private settleCleanupDecision(
    settlement: TerminalTransportCleanupSettlement,
  ): void {
    if (this.cleanupDecisionSettled) return;
    this.cleanupDecisionSettled = true;
    this.resolveCleanupDecision(settlement);
  }

  private clearSettleTimers(): void {
    if (this.firstOutputTimer) clearTimeout(this.firstOutputTimer);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.maxSettleTimer) clearTimeout(this.maxSettleTimer);
    this.firstOutputTimer = undefined;
    this.quietTimer = undefined;
    this.maxSettleTimer = undefined;
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closeListeners) listener();
  }

  private isCurrent(generation: number): boolean {
    return !this.closed && generation === this.generation;
  }
}

function terminalFrameBytes(frame: TerminalTransportFrame): Uint8Array | null {
  if (frame.bytes instanceof Uint8Array) {
    if (frame.bytes.byteLength === 0) return null;
    return new Uint8Array(
      frame.bytes.buffer,
      frame.bytes.byteOffset,
      frame.bytes.byteLength,
    );
  }
  const data = frame.data;
  if (typeof data === 'string') {
    if (data.length === 0) return null;
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    if (data.byteLength === 0) return null;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function validGeometry(cols: number, rows: number): boolean {
  return (
    Number.isSafeInteger(cols) &&
    Number.isSafeInteger(rows) &&
    cols > 0 &&
    rows > 0 &&
    cols <= 1_000 &&
    rows <= 1_000
  );
}

function normalizePolicy(
  policy: TerminalViewerAttachmentPolicy,
): Required<TerminalViewerAttachmentPolicy> {
  return {
    firstOutputTimeoutMs: positiveDuration(
      policy.firstOutputTimeoutMs,
      DEFAULT_FIRST_OUTPUT_TIMEOUT_MS,
    ),
    quietMs: positiveDuration(policy.quietMs, DEFAULT_QUIET_MS),
    maxSettleMs: positiveDuration(
      policy.maxSettleMs,
      DEFAULT_MAX_SETTLE_MS,
    ),
    probeTimeoutMs: positiveDuration(
      policy.probeTimeoutMs,
      VIEWER_PROBE_TIMEOUT_MS,
    ),
  };
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}
