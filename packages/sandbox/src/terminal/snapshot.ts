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
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type SnapshotFrame,
  type ResizeFrame,
  type TailReplayFrame,
  FRAME_CHANNEL,
  parseAsciicastEvent,
  parseAsciicastHeader,
} from '@cap/contracts';

/** The fixed session-log file name within each task workspace (matches Track 4). */
export const SESSION_LOG_FILENAME = 'session.log';

/**
 * The fixed asciicast-recording file name within each task workspace
 * (session-terminal-replay). Co-located with `session.log` on the durable
 * volume; the terminal-replay timing player streams it back.
 */
export const SESSION_CAST_FILENAME = 'session.cast';

/** Max fresh-reconnect cast output kept in-memory before reconnecting. */
const FRESH_CAST_REPLAY_MAX_BYTES = 24 * 1024 * 1024;

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
 * Legacy byte budget for the pre-snapshot fresh reconnect fallback.
 *
 * Fresh browser reconnects no longer replay this suffix as terminal history:
 * Codex's inline/no-alt-screen stream is still a TUI repaint stream, so raw
 * `session.log` bytes are not a reliable linear transcript. The value is retained
 * only for option compatibility with older callers/tests.
 */
export const DEFAULT_FRESH_RECONNECT_REPLAY_BYTES = 16 * 1024 * 1024;

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
  /**
   * Existing `session.log` byte size when a running task is re-adopted after an
   * API restart. New snapshots must continue from this durable offset.
   */
  initialOffset?: number;
  /**
   * Max bytes replayed from the end of `session.log` for a fresh connection.
   * Defaults to {@link DEFAULT_FRESH_RECONNECT_REPLAY_BYTES}.
   */
  freshReplayBytes?: number;
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
    this.byteOffset = Math.max(0, options.initialOffset ?? 0);
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
   * Build the ordered frames that restore a reconnecting client.
   *
   * Fresh browser loads (`fromSeq=0`) first prefer `session.cast`: it is the only
   * durable source that preserves ordered output plus resize events, so the web
   * client can rebuild scrollback without treating every fullscreen resize as raw
   * line history. If no usable cast exists, they use the latest/current snapshot
   * and deliberately do NOT fall back to replaying `session.log`: for an inline
   * TUI, the log contains cursor-addressed repaint bytes, and treating those bytes
   * as scrollback is exactly what causes duplicated/out-of-order old lines after a
   * hard refresh. Incremental reconnects (`fromSeq>0`) keep the snapshot + tail
   * path for bytes the same browser has already rendered.
   *
   * Size reconciliation: the snapshot frame carries the cols/rows it was captured
   * at; the reconnecting client compares those to its own geometry (optionally
   * passed as `clientCols`/`clientRows`) and reconciles before applying. A client
   * that already holds bytes up to `fromSeq` receives only the bytes after it.
   *
   * If no snapshot or current headless frame is available yet, reconnect returns
   * an empty final tail at the current offset so live streaming can resume without
   * importing stale TUI repaint history.
   */
  async buildReconnectFrames(opts: ReconnectOptions = {}): Promise<WsControlFrame[]> {
    const frames: WsControlFrame[] = [];
    const fromSeq = opts.fromSeq ?? 0;

    if (fromSeq <= 0) {
      const castFrames = await this.buildFreshCastReplayFrames(opts.chunkBytes);
      if (castFrames.length > 0) return castFrames;

      const snapshot = this.latest ?? this.capture();
      frames.push(toSnapshotFrame(snapshot));
      if (snapshot.seq <= 0) {
        frames.push(emptyFinalTail(await this.currentLogSize()));
      } else {
        frames.push(...(await this.readTailFrames(snapshot.seq, opts.chunkBytes)));
      }
      return frames;
    }

    const snapshot = this.latest;

    // 1. Deliver the most recent snapshot first, if one exists. The client must
    //    have at most this snapshot's coverage already to benefit from it.
    let tailFrom: number;
    if (snapshot && fromSeq <= snapshot.seq) {
      frames.push(toSnapshotFrame(snapshot));
      tailFrom = snapshot.seq;
    } else {
      // No usable snapshot (none captured, or the client is already past it):
      // replay raw tail from where the client left off.
      tailFrom = fromSeq;
    }

    // 2. Replay the session.log tail appended after `tailFrom`, reconciling the
    //    snapshot offset against the log's actual current size.
    const tailFrames = await this.readTailFrames(tailFrom, opts.chunkBytes);
    frames.push(...tailFrames);
    return frames;
  }

  private async buildFreshCastReplayFrames(
    chunkBytes = 64 * 1024,
  ): Promise<WsControlFrame[]> {
    const castPath = path.join(path.dirname(this.logPath), SESSION_CAST_FILENAME);
    let text: string;
    try {
      text = await readFile(castPath, 'utf8');
    } catch {
      return [];
    }
    const replay = buildCastReplayOps(text, chunkBytes);
    if (!replay) return [];

    const logSize = await this.currentLogSize();
    if (replay.ops.length === 0 && logSize > 0) return [];
    const frames: WsControlFrame[] = [
      {
        channel: FRAME_CHANNEL.CONTROL,
        type: 'snapshot',
        data: '',
        cols: replay.cols,
        rows: replay.rows,
        seq: 0,
      },
    ];

    let emitted = 0;
    for (const op of replay.ops) {
      if (op.type === 'resize') {
        frames.push({
          channel: FRAME_CHANNEL.CONTROL,
          type: 'resize',
          cols: op.cols,
          rows: op.rows,
        });
        continue;
      }
      const data = Buffer.from(op.data, 'utf8');
      emitted += data.byteLength;
      frames.push({
        channel: FRAME_CHANNEL.CONTROL,
        type: 'tail_replay',
        data: data.toString('base64'),
        seq:
          replay.outputBytes > 0
            ? Math.min(logSize, Math.floor((emitted / replay.outputBytes) * logSize))
            : logSize,
        final: false,
      });
    }

    frames.push(emptyFinalTail(logSize));
    return frames;
  }

  private async currentLogSize(): Promise<number> {
    try {
      return (await stat(this.logPath)).size;
    } catch {
      return Math.max(0, this.byteOffset);
    }
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
        const buf = data as Buffer;
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

    // Mark the last segment final so the client knows replay is complete.
    const last = frames[frames.length - 1] as TailReplayFrame;
    frames[frames.length - 1] = { ...last, final: true };
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
export type WsControlFrame = SnapshotFrame | TailReplayFrame | ResizeFrame;

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

interface CastOutputOp {
  readonly type: 'output';
  readonly data: string;
}

interface CastResizeOp {
  readonly type: 'resize';
  readonly cols: number;
  readonly rows: number;
}

type CastReplayOp = CastOutputOp | CastResizeOp;

interface CastReplay {
  readonly cols: number;
  readonly rows: number;
  readonly ops: CastReplayOp[];
  readonly outputBytes: number;
}

function buildCastReplayOps(text: string, chunkBytes: number): CastReplay | null {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const header = parseAsciicastHeader(lines[0] ?? '');
  if (!header) return null;

  const ops: CastReplayOp[] = [];
  let pending = '';
  const flush = (): void => {
    if (pending.length === 0) return;
    const stripped = stripAltScreen(pending);
    pending = '';
    for (const chunk of splitByUtf8Bytes(stripped, chunkBytes)) {
      if (chunk.length > 0) ops.push({ type: 'output', data: chunk });
    }
  };

  let lastTime = Number.NEGATIVE_INFINITY;
  for (const line of lines.slice(1)) {
    if (parseAsciicastHeader(line)) break;
    const event = parseAsciicastEvent(line);
    if (!event) continue;
    const [time, code, data] = event;
    if (time < lastTime) break;
    lastTime = time;
    if (code === 'o') {
      pending += data;
    } else if (code === 'r') {
      flush();
      const resize = parseResizeData(data);
      if (resize) ops.push({ type: 'resize', ...resize });
    }
  }
  flush();

  const capped = capCastReplayOps(ops, FRESH_CAST_REPLAY_MAX_BYTES);
  const outputBytes = capped.reduce(
    (sum, op) => sum + (op.type === 'output' ? Buffer.byteLength(op.data, 'utf8') : 0),
    0,
  );
  return { cols: header.width, rows: header.height, ops: capped, outputBytes };
}

/** Matches the alternate-screen switch: `ESC [ ? (1049|1047|47) (h|l)`. */
// eslint-disable-next-line no-control-regex
const ALT_SCREEN_RE = /\x1b\[\?(?:1049|1047|47)[hl]/g;
const ALT_SCREEN_EXIT_CLEAR_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[H\x1b\[2J(?=(?:\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[=>]))*\x1b\[\?(?:1049|1047|47)l)/g;

function stripAltScreen(data: string): string {
  return data.replace(ALT_SCREEN_EXIT_CLEAR_RE, '').replace(ALT_SCREEN_RE, '');
}

function parseResizeData(data: string): { cols: number; rows: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(data.trim());
  if (!match) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    return null;
  }
  return { cols, rows };
}

function splitByUtf8Bytes(value: string, maxBytes: number): string[] {
  if (value.length === 0) return [];
  const limit = Math.max(1, maxBytes);
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (current.length > 0 && currentBytes + charBytes > limit) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function capCastReplayOps(
  ops: readonly CastReplayOp[],
  maxOutputBytes: number,
): CastReplayOp[] {
  let total = 0;
  for (const op of ops) {
    if (op.type === 'output') total += Buffer.byteLength(op.data, 'utf8');
  }
  if (total <= maxOutputBytes) return [...ops];

  const keptReversed: CastReplayOp[] = [];
  let acc = 0;
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index];
    if (!op) continue;
    if (op.type === 'output') {
      if (acc >= maxOutputBytes) continue;
      acc += Buffer.byteLength(op.data, 'utf8');
    }
    keptReversed.push(op);
  }
  keptReversed.reverse();
  return [
    { type: 'output', data: '⋯ 较早的终端输出已省略（记录过大）\r\n' },
    ...keptReversed,
  ];
}
