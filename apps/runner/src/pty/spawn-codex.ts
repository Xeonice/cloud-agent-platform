/**
 * @cap/runner — interactive Codex PTY spawn (Track 4, task 4.2).
 *
 * Spawns the INTERACTIVE `codex` CLI as a child process attached to a node-pty
 * pseudo-terminal, with `cwd` set to the task's `workspaces/<id>` and
 * `TERM=xterm-256color` so the TUI renders its ANSI byte stream.
 *
 * Per the terminal-execution spec (D1), we MUST NOT substitute a headless
 * transport for the terminal channel: the spawn arguments never include the
 * `exec --json` or `app-server` subcommands, because only the interactive path
 * emits the byte-identical TUI stream that the browser terminal replays.
 */
import * as pty from 'node-pty';

/** Subcommands that put `codex` into a HEADLESS (non-TUI) mode. */
const HEADLESS_SUBCOMMANDS = ['exec', 'app-server'] as const;

/** Options for spawning the interactive codex PTY. */
export interface SpawnCodexOptions {
  /** Working directory — the task's isolated `workspaces/<id>` path. */
  readonly cwd: string;
  /** Path/name of the interactive `codex` binary. Defaults to `codex`. */
  readonly codexBin?: string;
  /**
   * Extra arguments for the interactive invocation. MUST NOT begin with a
   * headless subcommand (`exec` / `app-server`); this is rejected so the
   * terminal channel can never be silently switched to a headless transport.
   */
  readonly codexArgs?: readonly string[];
  /** Initial PTY columns. Defaults to 80. */
  readonly cols?: number;
  /** Initial PTY rows. Defaults to 24. */
  readonly rows?: number;
  /** Extra environment merged over the base spawn environment. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Raw-byte data handler. */
export type PtyDataHandler = (bytes: string) => void;

/** Exit handler. */
export type PtyExitHandler = (event: { readonly exitCode: number; readonly signal?: number }) => void;

/**
 * A narrow handle over the spawned interactive codex PTY. Kept minimal and
 * transport-agnostic so realtime-terminal (Track 5) and the startup window can
 * consume it without depending on node-pty's surface directly.
 */
export interface CodexPtyHandle {
  /** OS process id of the spawned codex child. */
  readonly pid: number;
  /** Subscribe to raw PTY output bytes (UTF-8 string chunks). */
  onData(handler: PtyDataHandler): void;
  /** Subscribe to process exit. */
  onExit(handler: PtyExitHandler): void;
  /** Write raw bytes to the PTY (operator keystrokes, lock-gated upstream). */
  write(data: string): void;
  /** Resize the PTY to match the consuming terminal geometry. */
  resize(cols: number, rows: number): void;
  /** Pause PTY output (application-layer backpressure, Track 5). */
  pause(): void;
  /** Resume PTY output after draining below the low-water mark. */
  resume(): void;
  /** Kill the spawned child. */
  kill(signal?: string): void;
}

/**
 * Spawn the interactive `codex` CLI under node-pty.
 *
 * @throws if `codexArgs` would invoke a headless subcommand for the terminal
 *         channel — the interactive TUI path is mandatory (D1).
 */
export function spawnCodexPty(options: SpawnCodexOptions): CodexPtyHandle {
  const codexBin = options.codexBin ?? 'codex';
  const codexArgs = options.codexArgs ?? [];

  assertInteractiveArgs(codexArgs);

  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;

  const child = pty.spawn(codexBin, [...codexArgs], {
    name: 'xterm-256color',
    cwd: options.cwd,
    cols,
    rows,
    env: buildPtyEnv(options.env),
  });

  return {
    pid: child.pid,
    onData(handler) {
      child.onData(handler);
    },
    onExit(handler) {
      child.onExit(({ exitCode, signal }) => {
        handler(signal !== undefined ? { exitCode, signal } : { exitCode });
      });
    },
    write(data) {
      child.write(data);
    },
    resize(c, r) {
      child.resize(c, r);
    },
    pause() {
      child.pause();
    },
    resume() {
      child.resume();
    },
    kill(signal) {
      child.kill(signal);
    },
  };
}

/**
 * Build the spawn environment, forcing `TERM=xterm-256color` for TUI rendering
 * (spec: "the child process environment has `TERM` set to `xterm-256color`").
 * Caller-supplied env is merged first, then `TERM` is pinned last so it cannot
 * be overridden.
 */
export function buildPtyEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    TERM: 'xterm-256color',
  };
}

/**
 * Reject argument vectors whose first token is a headless subcommand. Guards
 * the invariant that the terminal channel is always the interactive TUI path.
 */
export function assertInteractiveArgs(args: readonly string[]): void {
  const first = args[0];
  if (first !== undefined && (HEADLESS_SUBCOMMANDS as readonly string[]).includes(first)) {
    throw new Error(
      `refusing to spawn codex with headless subcommand "${first}" on the terminal channel; ` +
        `the interactive TUI path is required (no exec --json / app-server)`,
    );
  }
}
