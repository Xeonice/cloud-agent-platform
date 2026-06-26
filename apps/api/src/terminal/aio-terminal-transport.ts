import { Logger } from '@nestjs/common';
import WebSocket from 'ws';
import type {
  TerminalTransport,
  TerminalTransportFrame,
  TerminalTransportReadyState,
} from './agent-terminal-pty';

export class AioTerminalTransport implements TerminalTransport {
  private readonly logger = new Logger(AioTerminalTransport.name);
  private readonly frameListeners = new Set<
    (frame: TerminalTransportFrame) => void
  >();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly socket: WebSocket;

  constructor(
    private readonly taskId: string,
    private readonly wsUrl: string,
  ) {
    this.socket = new WebSocket(wsUrl);
    this.socket.on('message', (raw) => {
      const frame = parseAioFrame(raw);
      if (!frame) return;
      for (const listener of this.frameListeners) listener(frame);
    });
    this.socket.on('close', () => {
      for (const listener of this.closeListeners) listener();
    });
    this.socket.on('error', (error) => {
      this.logger.warn(
        `task ${this.taskId}: sandbox terminal WS error: ${error.message}`,
      );
      for (const listener of this.errorListeners) listener(error);
    });
  }

  get readyState(): TerminalTransportReadyState {
    switch (this.socket.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting';
      case WebSocket.OPEN:
        return 'open';
      case WebSocket.CLOSING:
        return 'closing';
      default:
        return 'closed';
    }
  }

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
    return this.sendJson({ type: 'input', data });
  }

  sendResize(cols: number, rows: number): boolean {
    return this.sendJson({ type: 'resize', data: { cols, rows } });
  }

  sendPong(timestamp: number): boolean {
    return this.sendJson({ type: 'pong', timestamp });
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Best-effort; closed sockets may throw on close.
    }
  }

  private sendJson(frame: Record<string, unknown>): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }
}

function parseAioFrame(raw: WebSocket.RawData): TerminalTransportFrame | null {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf8');
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw).toString('utf8');
  } else {
    text = Buffer.from(raw as ArrayBuffer).toString('utf8');
  }

  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof obj !== 'object' ||
    obj === null ||
    typeof (obj as { type?: unknown }).type !== 'string'
  ) {
    return null;
  }
  return obj as TerminalTransportFrame;
}
