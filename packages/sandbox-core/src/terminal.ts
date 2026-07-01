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

export interface AgentTerminalPty extends PausablePty {
  onData(listener: AgentTerminalDataListener): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close?(): void;
}
