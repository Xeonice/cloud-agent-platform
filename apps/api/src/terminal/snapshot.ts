/**
 * @cap/api — periodic SerializeAddon snapshotting + snapshot/tail-replay
 * reconnect (Track 5, task 5.4).
 *
 * On reconnect the orchestrator restores terminal state in two steps (D5):
 *   1. deliver the most recent headless `SerializeAddon` snapshot — a serialized
 *      reconstruction of the live visible frame that records the cols/rows it was
 *      captured at, so a reconnecting client of a different size can reconcile
 *      geometry before applying it; then
 *   2. replay the tail of `workspaces/<id>/session.log` — the authoritative
 *      append-only byte source (Track 4) — that was appended AFTER the snapshot's
 *      byte offset.
 *
 * The snapshot is produced from a headless xterm.js terminal fed the same raw
 * bytes as `session.log`; this module owns the cadence, the byte-offset
 * bookkeeping that ties a snapshot to its position in `session.log`, and the
 * tail read that fills the gap since the snapshot.
 */
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type SnapshotFrame,
  type TailReplayFrame,
  FRAME_CHANNEL,
} from '@cap/contracts';

/** The fixed session-log file name within each task workspace (matches Track 4). */
export const SESSION_LOG_FILENAME = 'session.log';

/**
 * The fixed asciicast-recording file name within each task workspace
 * (session-terminal-replay). Co-located with `session.log` on the durable
 * volume; the terminal-replay timing player streams it back.
 */
export const SESSION_CAST_FILENAME = 'session.cast';

/** Bytes read from the END of `session.log` when sampling a failure tail. */
const SESSION_LOG_TAIL_BYTES = 4096;
/** Max non-empty lines kept from the sampled tail. */
const SESSION_LOG_TAIL_LINES = 20;
/** Hard cap on the stored tail excerpt (chars), applied after line selection. */
const SESSION_LOG_TAIL_MAX_CHARS = 2000;

/**
 * Strip ANSI/CSI/OSC escape sequences and bare control chars from terminal
 * bytes so a sampled transcript tail is readable plain text. PURE.
 */
export function stripAnsi(input: string): string {
  /* eslint-disable no-control-regex -- ANSI/control stripping must match the
     ESC (\x1b) + C0 control bytes by definition. */
  return (
    input
      // CSI sequences (SGR colors, cursor moves, …): ESC [ … final-byte
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // OSC sequences (titles, …): ESC ] … (BEL | ESC \)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // other 2-char ESC sequences
      .replace(/\x1b[@-Z\\-_]/g, '')
      // remaining control chars except tab (\x09) and newline (\x0a)
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
  /* eslint-enable no-control-regex */
}

/**
 * Sample the tail of a task's `session.log` for the failure-detail audit
 * (record-task-failure-reason): read the last ~4 KB, strip ANSI, return the last
 * ~20 non-empty lines capped to a stored budget. Returns `''` when the log is
 * absent/empty (e.g. a task that failed before any PTY output). A pure fs read
 * of the API-side log, so it works even after the sandbox is torn down — and
 * never throws (a read error degrades to `''`).
 */
export async function readSessionLogTail(workspaceDir: string): Promise<string> {
  const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
  try {
    const { size } = await stat(logPath);
    if (size === 0) return '';
    const start = Math.max(0, size - SESSION_LOG_TAIL_BYTES);
    const length = size - start;
    const fh = await open(logPath, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      const lines = stripAnsi(buf.toString('utf8'))
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
      const tail = lines.slice(-SESSION_LOG_TAIL_LINES).join('\n');
      return tail.length > SESSION_LOG_TAIL_MAX_CHARS
        ? tail.slice(-SESSION_LOG_TAIL_MAX_CHARS)
        : tail;
    } finally {
      await fh.close();
    }
  } catch {
    // Absent log / read error: degrade to empty so capture is best-effort.
    return '';
  }
}

/** Default cadence for capturing a fresh SerializeAddon snapshot, in ms. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 2_000;

/**
 * The minimal headless terminal surface this module snapshots. A real
 * `@xterm/headless` `Terminal` with the `SerializeAddon` and `FitAddon` loaded
 * satisfies it: `write` feeds it the raw PTY bytes, `serialize` returns the
 * serialized visible frame, and `cols`/`rows` report current geometry.
 */
export interface HeadlessTerminal {
  cols: number;
  rows: number;
  write(data: string | Uint8Array): void;
  /** SerializeAddon: serialize the current visible frame to a replayable string. */
  serialize(): string;
}

/** A captured snapshot together with the `session.log` byte offset it covers. */
export interface CapturedSnapshot {
  /** Serialized SerializeAddon frame content. */
  data: string;
  /** Terminal columns at capture time (for size reconciliation). */
  cols: number;
  /** Terminal rows at capture time. */
  rows: number;
  /** `session.log` byte offset this snapshot corresponds to. */
  seq: number;
  /** Epoch ms the snapshot was captured at. */
  capturedAt: number;
}

/** Tunables for the snapshot manager. */
export interface SnapshotManagerOptions {
  /** Snapshot cadence in ms (defaults to {@link DEFAULT_SNAPSHOT_INTERVAL_MS}). */
  intervalMs?: number;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
}

/**
 * Per-session snapshot manager.
 *
 * Owns a headless terminal mirroring the live PTY, captures periodic snapshots
 * tagged with the `session.log` byte offset they cover, and produces the ordered
 * frame sequence a reconnecting client needs: the latest snapshot followed by the
 * tail of `session.log` appended after it.
 *
 * The gateway feeds raw PTY bytes here via {@link feed} (tracking the cumulative
 * byte offset so a snapshot's `seq` lines up with `session.log`), starts/stops
 * the cadence with {@link start}/{@link stop}, and serves reconnects with
 * {@link buildReconnectFrames}.
 */
export class SnapshotManager {
  private readonly terminal: HeadlessTerminal;
  private readonly logPath: string;
  private readonly intervalMs: number;
  private readonly now: () => number;

  /** Cumulative count of raw bytes fed to the headless terminal == log offset. */
  private byteOffset = 0;
  /** The most recent captured snapshot, or null before the first capture. */
  private latest: CapturedSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param terminal     A headless xterm terminal with SerializeAddon loaded.
   * @param workspaceDir Absolute path to this task's `workspaces/<id>` directory.
   */
  constructor(
    terminal: HeadlessTerminal,
    workspaceDir: string,
    options: SnapshotManagerOptions = {},
  ) {
    this.terminal = terminal;
    this.logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    this.intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** The byte offset the headless terminal has been fed up to. */
  get currentOffset(): number {
    return this.byteOffset;
  }

  /** The most recent snapshot, or null before any capture. */
  get latestSnapshot(): CapturedSnapshot | null {
    return this.latest;
  }

  /** Columns the headless terminal is currently sized to (session-terminal-replay). */
  get cols(): number {
    return this.terminal.cols;
  }

  /** Rows the headless terminal is currently sized to (session-terminal-replay). */
  get rows(): number {
    return this.terminal.rows;
  }

  /**
   * Feed raw PTY bytes to the headless terminal and advance the cumulative byte
   * offset. The offset must mirror what is appended to `session.log` so a
   * snapshot taken now and the tail replayed after it reconcile exactly.
   *
   * @param chunk    The raw bytes appended to `session.log` for this delta.
   * @param byteLen  The chunk's length in bytes; supply explicitly when `chunk`
   *                 is a string whose byte length differs from its char length.
   */
  feed(chunk: string | Uint8Array, byteLen?: number): void {
    this.terminal.write(chunk);
    const len =
      byteLen ??
      (typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength);
    this.byteOffset += len;
  }

  /**
   * Capture a snapshot of the current headless frame, tagged with the current
   * byte offset and geometry, and store it as the latest. Returns it.
   */
  capture(): CapturedSnapshot {
    const snapshot: CapturedSnapshot = {
      data: this.terminal.serialize(),
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      seq: this.byteOffset,
      capturedAt: this.now(),
    };
    this.latest = snapshot;
    return snapshot;
  }

  /**
   * Update the headless terminal's geometry so subsequent snapshots record the
   * correct cols/rows. Called when the browser terminal resizes (VR.8).
   * No-op if the headless terminal does not support resize (e.g. a stub).
   */
  resizeHeadless(cols: number, rows: number): void {
    this.terminal.cols = cols;
    this.terminal.rows = rows;
  }

  /** Begin periodic snapshotting at the configured cadence. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.capture(), this.intervalMs);
    // Do not keep the process alive solely for snapshotting.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop periodic snapshotting. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Build the ordered frames that restore a reconnecting client: the latest
   * snapshot (as a contracts `SnapshotFrame`) followed by `tail_replay` frames
   * carrying the `session.log` bytes appended after the snapshot's offset.
   *
   * Size reconciliation: the snapshot frame carries the cols/rows it was captured
   * at; the reconnecting client compares those to its own geometry (optionally
   * passed as `clientCols`/`clientRows`) and reconciles before applying. A client
   * that already holds bytes up to `fromSeq` receives only the bytes after it.
   *
   * If no snapshot has been captured yet, the whole of `session.log` is replayed
   * from `fromSeq` with no preceding snapshot frame.
   */
  async buildReconnectFrames(opts: ReconnectOptions = {}): Promise<WsControlFrame[]> {
    const frames: WsControlFrame[] = [];
    const snapshot = this.latest;

    // 1. Deliver the most recent snapshot first, if one exists. The client must
    //    have at most this snapshot's coverage already to benefit from it.
    let tailFrom: number;
    if (snapshot && (opts.fromSeq ?? 0) <= snapshot.seq) {
      frames.push(toSnapshotFrame(snapshot));
      tailFrom = snapshot.seq;
    } else {
      // No usable snapshot (none captured, or the client is already past it):
      // replay raw tail from where the client left off.
      tailFrom = opts.fromSeq ?? 0;
    }

    // 2. Replay the session.log tail appended after `tailFrom`, reconciling the
    //    snapshot offset against the log's actual current size.
    const tailFrames = await this.readTailFrames(tailFrom, opts.chunkBytes);
    frames.push(...tailFrames);
    return frames;
  }

  /**
   * Read `session.log` from byte offset `fromSeq` to EOF and chunk it into
   * `tail_replay` frames, each tagged with the cumulative end offset of its
   * bytes; the last frame is marked `final`. Returns a single `final` empty
   * frame when there is nothing to replay so the client always learns replay is
   * complete and live streaming may resume.
   *
   * The starting offset is clamped to the log's current size, reconciling the
   * case where a snapshot's recorded offset momentarily exceeds the bytes
   * already flushed to `session.log`.
   */
  async readTailFrames(
    fromSeq: number,
    chunkBytes = 64 * 1024,
  ): Promise<TailReplayFrame[]> {
    let size: number;
    try {
      size = (await stat(this.logPath)).size;
    } catch {
      // No log yet — nothing to replay.
      return [emptyFinalTail(Math.max(0, fromSeq))];
    }

    const start = Math.min(Math.max(0, fromSeq), size);
    if (start >= size) {
      return [emptyFinalTail(start)];
    }

    const frames: TailReplayFrame[] = [];
    let offset = start;
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(this.logPath, {
        start,
        end: size - 1,
        highWaterMark: chunkBytes,
      });
      stream.on('data', (data: string | Buffer) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        offset += buf.byteLength;
        frames.push({
          channel: FRAME_CHANNEL.CONTROL,
          type: 'tail_replay',
          data: buf.toString('base64'),
          seq: offset,
          final: false,
        });
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });

    if (frames.length === 0) {
      return [emptyFinalTail(start)];
    }
    // Mark the last segment final so the client knows replay is complete.
    frames[frames.length - 1] = { ...frames[frames.length - 1], final: true };
    return frames;
  }
}

/** Options for {@link SnapshotManager.buildReconnectFrames}. */
export interface ReconnectOptions {
  /** Highest `session.log` byte offset the reconnecting client already holds. */
  fromSeq?: number;
  /** Reconnecting client's columns (for caller-side size reconciliation). */
  clientCols?: number;
  /** Reconnecting client's rows. */
  clientRows?: number;
  /** Tail read chunk size in bytes. */
  chunkBytes?: number;
}

/** The control frames this module emits on reconnect. */
export type WsControlFrame = SnapshotFrame | TailReplayFrame;

/** Convert a captured snapshot into the contracts `SnapshotFrame`. */
export function toSnapshotFrame(snapshot: CapturedSnapshot): SnapshotFrame {
  return {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'snapshot',
    data: snapshot.data,
    cols: snapshot.cols,
    rows: snapshot.rows,
    seq: snapshot.seq,
  };
}

/** An empty terminal `tail_replay` marking replay complete at offset `seq`. */
function emptyFinalTail(seq: number): TailReplayFrame {
  return {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'tail_replay',
    data: '',
    seq,
    final: true,
  };
}
