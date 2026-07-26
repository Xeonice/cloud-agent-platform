export type TerminalTransportReadyState =
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed';

export interface TerminalTransportFrame {
  readonly type: string;
  readonly data?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Whether a provider terminal can carry an arbitrary byte sequence from the
 * browser to the outer PTY without a text encoding round trip.
 */
export type TerminalOpaqueInputCapability =
  | 'byte-preserving'
  | 'unsupported';

/**
 * A transport write is intentionally three-state. `unsupported` is not folded
 * into `closed`: doing so would let a text-only provider appear to support
 * native mouse/protocol bytes until they were silently rewritten.
 */
export type TerminalTransportWriteOutcome =
  | 'written'
  | 'closed'
  | 'unsupported';

/**
 * Non-rejecting, secret-free settlement for provider-side terminal cleanup.
 * Counts are used instead of provider identities so an API shutdown boundary
 * can prove what was removed without exposing native handles or endpoints.
 */
export type TerminalTransportCleanupSettlement =
  | {
      readonly kind: 'confirmed';
      readonly expectedIdentities: number;
      readonly observedIdentities: number;
      readonly confirmedIdentities: number;
      readonly deletedIdentities: number;
      readonly alreadyAbsentIdentities: number;
      readonly cause: null;
    }
  | {
      readonly kind: 'indeterminate';
      readonly expectedIdentities: number;
      readonly observedIdentities: number;
      readonly confirmedIdentities: number;
      readonly deletedIdentities: number;
      readonly alreadyAbsentIdentities: number;
      readonly cause:
        | 'identity-unavailable'
        | 'cleanup-unsupported'
        | 'cleanup-unconfirmed';
    };

export interface PausablePty {
  pause(): void;
  resume(): void;
}

export interface AgentTerminalOutputMeta {
  /**
   * Whether this is eligible owner-agent output rather than attach/resize
   * bootstrap repaint. Defaults to true. Durable raw-artifact policy is a
   * separate API concern; disabling it must not disable runtime classification.
   */
  readonly recordable?: boolean;
  /** Human-readable producer provenance for diagnostics and tests. */
  readonly source?: 'agent' | 'attach-bootstrap';
}

export type AgentTerminalDataListener = (
  chunk: string,
  meta?: AgentTerminalOutputMeta,
) => void;

export interface TerminalTransport extends PausablePty {
  readonly readyState: TerminalTransportReadyState;
  readonly opaqueInputCapability: TerminalOpaqueInputCapability;
  /**
   * Settles after `close()` has completed its bounded provider cleanup. An
   * adapter without this optional seam supplies no cleanup proof; callers must
   * treat absence as indeterminate rather than inferring success from close.
   */
  readonly cleanupDecision?: Promise<TerminalTransportCleanupSettlement>;
  onFrame(listener: (frame: TerminalTransportFrame) => void): { dispose(): void };
  onClose(listener: () => void): { dispose(): void };
  onError(listener: (error: Error) => void): { dispose(): void };
  sendInput(data: string): boolean;
  sendInputBytes(data: Uint8Array): TerminalTransportWriteOutcome;
  /**
   * Writes a correlated terminal-query response back to this transport's
   * outer PTY. Providers may use a narrower native path than arbitrary
   * operator bytes, but must reject bytes that path cannot preserve exactly.
   */
  sendTerminalResponseBytes(
    data: Uint8Array,
  ): TerminalTransportWriteOutcome;
  sendResize(cols: number, rows: number): boolean;
  sendPong(timestamp: number): boolean;
  close(): void;
}

export interface TerminalTransportFactory {
  open(): TerminalTransport;
}

export interface TerminalExitStatus {
  readonly code: number | null;
  readonly abnormal: boolean;
}

/**
 * Non-rejecting settlement of the terminal's one launch-or-attach decision.
 * Consumers may safely ignore the promise, while durable admission can await it
 * before releasing the lease that authorizes a fresh agent launch.
 */
export type AgentTerminalLaunchOutcome =
  | { readonly kind: 'launched' }
  | { readonly kind: 'attached' }
  /** Attach-only probe definitively established that the named session is gone. */
  | { readonly kind: 'absent' }
  /** Attach-only probe could not establish whether the named session is live. */
  | { readonly kind: 'indeterminate' }
  | { readonly kind: 'fenced' }
  | { readonly kind: 'failed' };

export interface AgentTerminalPty extends PausablePty {
  readonly launchDecision: Promise<AgentTerminalLaunchOutcome>;
  /**
   * Settles after every provider terminal transport owned by this task-owner
   * bridge has completed its bounded cleanup. The optional seam is deliberately
   * identity-free; absence is indeterminate and must never be promoted to
   * confirmed cleanup by callers.
   */
  readonly cleanupDecision?: Promise<TerminalTransportCleanupSettlement>;
  onData(listener: AgentTerminalDataListener): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close?(): void;
}

export interface TerminalViewerGeometry {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Settlement of the one attach-existing decision made by a disposable viewer.
 * It never contains provider URLs, credentials, or launch authority.
 */
export type TerminalViewerAttachmentOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'indeterminate' }
  | {
      readonly kind: 'failed';
      readonly reason:
        | 'aborted'
        | 'invalid-geometry'
        | 'transport'
        | 'blank-redraw';
    };

export type TerminalViewerDataListener = (chunk: Uint8Array) => void;

/**
 * One browser-local outer PTY attached to an already-live detached task.
 * Unlike {@link AgentTerminalPty}, it cannot launch, supervise, record, or tear
 * down the sandbox/task owner.
 */
export interface TerminalViewerAttachment extends PausablePty {
  readonly attachmentDecision: Promise<TerminalViewerAttachmentOutcome>;
  readonly opaqueInputCapability: TerminalOpaqueInputCapability;
  /**
   * Provider-side cleanup settlement for this disposable outer PTY. No native
   * handle, endpoint, or credential crosses this provider-neutral boundary.
   * Missing implementations remain indeterminate at the shutdown coordinator.
   */
  readonly cleanupDecision?: Promise<TerminalTransportCleanupSettlement>;
  onData(listener: TerminalViewerDataListener): { dispose(): void };
  onClose(listener: () => void): { dispose(): void };
  onError(listener: (error: Error) => void): { dispose(): void };
  write(data: Uint8Array): TerminalTransportWriteOutcome;
  writeTerminalResponse(data: Uint8Array): TerminalTransportWriteOutcome;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface OpenTerminalViewerAttachmentArgs extends TerminalViewerGeometry {
  readonly signal?: AbortSignal;
}

export interface TerminalViewerAttachmentFactory {
  open(args: OpenTerminalViewerAttachmentArgs): TerminalViewerAttachment;
}
