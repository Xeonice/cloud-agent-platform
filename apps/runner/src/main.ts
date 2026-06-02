/**
 * @cap/runner — composition root (VR.14).
 *
 * This module is the real executable entry point for the runner image.
 * It wires together:
 *   - `startTask` (terminal-execution, Track 4) — spawns the interactive codex PTY
 *   - `DialBackClient` (runner-dialback, Track 8) — dials the orchestrator WS
 *   - The `onControl` resize callback that forwards inbound `resize` control frames
 *     from the orchestrator to `CodexPtyHandle.resize(cols, rows)` (VR.14 last hop).
 *
 * Design D8/D10: the runner never binds an inbound port; it dials OUT to the
 * orchestrator WS URL injected via the `ORCHESTRATOR_WS_URL` env var at
 * provisioning time.
 */
import { fileURLToPath } from 'node:url';

import { WebSocket, type RawData } from 'ws';

import { DialBackClient, type OutboundSocket, type OutboundSocketFactory } from './dialback/dialback-client.js';
import { startTask, type OrchestratorReporter, type RunningTask, type TaskConfig } from './task-entry.js';

// ---------------------------------------------------------------------------
// WsOutboundSocket — wraps `ws` WebSocket to implement OutboundSocket
// ---------------------------------------------------------------------------

/**
 * Thin adapter that satisfies the `OutboundSocket` interface using the `ws`
 * library's `WebSocket`. The only non-trivial mapping is the `close` event
 * overload: `ws` passes `(code: number, reason: Buffer)` but `OutboundSocket`
 * expects `(code: number, reason?: string)`.
 */
class WsOutboundSocket implements OutboundSocket {
  constructor(private readonly ws: WebSocket) {}

  on(event: 'open', listener: () => void): void;
  on(event: 'close', listener: (code: number, reason?: string) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(
    event: 'open' | 'close' | 'error' | 'message',
    listener: ((code: number, reason?: string) => void) | ((err: Error) => void) | ((data: unknown) => void) | (() => void),
  ): void {
    if (event === 'open') {
      this.ws.on('open', listener as () => void);
    } else if (event === 'close') {
      const closeListener = listener as (code: number, reason?: string) => void;
      this.ws.on('close', (code: number, reason: Buffer) => {
        closeListener(code, reason.toString());
      });
    } else if (event === 'error') {
      this.ws.on('error', listener as (err: Error) => void);
    } else {
      // message
      this.ws.on('message', (data: RawData) => {
        (listener as (data: unknown) => void)(data);
      });
    }
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}

/** Production `OutboundSocketFactory` backed by the `ws` library. */
export const wsSocketFactory: OutboundSocketFactory = (url: string) =>
  new WsOutboundSocket(new WebSocket(url));

// ---------------------------------------------------------------------------
// composeRunnerTask — injectable composition root (testable)
// ---------------------------------------------------------------------------

/** Handle returned by {@link composeRunnerTask}. */
export interface RunnerTaskHandle {
  running: RunningTask;
  dialback: DialBackClient;
  stop(): Promise<void>;
}

/**
 * Composes a fully-wired running task:
 *   1. Calls `startTask` to spawn the PTY and arm the startup window.
 *   2. Constructs `DialBackClient` with an `onControl` callback that forwards
 *      inbound `resize` frames to `CodexPtyHandle.resize(cols, rows)` — the
 *      VR.14 last hop that was previously dead code.
 *   3. Calls `dialback.connect()` to dial out to the orchestrator.
 *
 * All I/O dependencies (`socketFactory`, `orchestratorUrl`) are injected so
 * this function is testable without a real WebSocket.
 */
export async function composeRunnerTask(
  config: TaskConfig,
  deps: {
    socketFactory: OutboundSocketFactory;
    orchestratorUrl: string;
    reporter?: OrchestratorReporter;
    log?: (m: string) => void;
  },
): Promise<RunnerTaskHandle> {
  const log = deps.log ?? (() => undefined);

  const defaultReporter: OrchestratorReporter = {
    reportAgentFailedToStart(detail) {
      log(`[runner] agent-failed-to-start: ${detail.message}`);
    },
    reportStarted(detail) {
      log(`[runner] started: ${detail.taskId}`);
    },
    reportExited(detail) {
      log(`[runner] exited: ${detail.taskId} code=${detail.exitCode}`);
    },
  };

  const reporter = deps.reporter ?? defaultReporter;

  // 4.x — spawn the PTY and arm the startup window.
  const running = await startTask(config, reporter);

  // VR.14 — wire the resize callback: orchestrator sends resize → PTY gets it.
  const dialback = new DialBackClient({
    orchestratorUrl: deps.orchestratorUrl,
    socketFactory: deps.socketFactory,
    // handshake defaults to handshakeInputFromEnv() (reads TASK_ID/TASK_TOKEN).
    log,
    onControl: (frame) => {
      if (frame.type === 'resize') {
        running.pty.resize(frame.cols, frame.rows);
      }
    },
  });

  // 8.1 — dial out to the orchestrator (sends the handshake first).
  await dialback.connect();

  async function stop(): Promise<void> {
    dialback.close();
    await running.stop();
  }

  return { running, dialback, stop };
}

// ---------------------------------------------------------------------------
// main — reads env, builds config, starts the task
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const log = (m: string): void => {
    process.stderr.write(`${m}\n`);
  };

  const orchestratorUrl = process.env['ORCHESTRATOR_WS_URL'];
  if (!orchestratorUrl) {
    throw new Error('ORCHESTRATOR_WS_URL env var is required but was not set');
  }

  const taskId = process.env['TASK_ID'];
  if (!taskId) {
    throw new Error('TASK_ID env var is required but was not set');
  }

  const config: TaskConfig = {
    taskId,
    workspacesRoot: process.env['WORKSPACES_DIR'] ?? process.env['WORKSPACES_ROOT'],
  };

  log(`[runner] starting task ${taskId}`);
  const handle = await composeRunnerTask(config, {
    socketFactory: wsSocketFactory,
    orchestratorUrl,
    log,
  });

  log(`[runner] task ${taskId} running; dialback connected`);

  // Wait for the startup window to settle (started or failed).
  const outcome = await handle.running.startup;
  if (!outcome.ok) {
    log(`[runner] startup failed: ${outcome.reason}`);
    await handle.stop();
    process.exitCode = 1;
    return;
  }

  log(`[runner] task ${taskId} interactive`);
}

// Guard: only run when executed directly, not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((e: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`[runner] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  });
}
