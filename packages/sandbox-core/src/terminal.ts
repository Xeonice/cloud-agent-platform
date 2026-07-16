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

export interface PausablePty {
  pause(): void;
  resume(): void;
}

export interface AgentTerminalOutputMeta {
  /**
   * Whether this chunk should be written to durable history (`session.log` /
   * `session.cast`) and advance snapshot byte offsets. Defaults to true.
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
  onFrame(listener: (frame: TerminalTransportFrame) => void): { dispose(): void };
  onClose(listener: () => void): { dispose(): void };
  onError(listener: (error: Error) => void): { dispose(): void };
  sendInput(data: string): boolean;
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
  onData(listener: AgentTerminalDataListener): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close?(): void;
}
