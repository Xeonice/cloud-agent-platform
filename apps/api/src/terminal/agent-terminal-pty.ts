import type { PausablePty } from './backpressure';

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

export interface TerminalCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface TerminalCommandResult {
  readonly exitCode: number;
  readonly output: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
}

export interface SandboxCommandExecutor {
  exec(
    command: string,
    options?: TerminalCommandOptions,
  ): Promise<TerminalCommandResult>;
}

export interface TerminalExitStatus {
  readonly code: number | null;
  readonly abnormal: boolean;
}

export interface DetachedSessionDriver {
  readonly sessionName: string;
  attachInput(): string;
  probeLiveness(): Promise<boolean | null>;
  resolveExitStatus(): Promise<TerminalExitStatus>;
}

export interface AgentTerminalPty extends PausablePty {
  onData(listener: (chunk: string) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close?(): void;
}
