/**
 * Minimal test: "Snapshot plus tail-replay reconnect" requirement.
 *
 * Requirement (realtime-terminal spec, D5):
 *   On client reconnect the orchestrator SHALL restore terminal state by:
 *     1. First writing a periodic headless SerializeAddon snapshot that records
 *        the cols and rows it was taken at.
 *     2. Then replaying the tail of `session.log` appended after the snapshot,
 *        reconciling any size difference between the snapshot and the current
 *        terminal.
 *
 * Scenarios exercised:
 *   A. "Reconnect restores from snapshot then tail"
 *      WHEN a client reconnects to an active task
 *      THEN the orchestrator first delivers the most recent SerializeAddon snapshot
 *      AND  then replays the `session.log` bytes appended after that snapshot
 *
 *   B. "Snapshot records its dimensions for size reconciliation"
 *      WHEN a SerializeAddon snapshot is produced
 *      THEN it records the cols and rows it was captured at
 *
 * Implementation under test (mirrored inline from
 * apps/api/src/terminal/snapshot.ts + packages/contracts/src/snapshot-frames.ts):
 *   - SnapshotManager.capture()       — captures a snapshot tagged with offset+geometry
 *   - SnapshotManager.feed()          — advances the byte-offset counter
 *   - SnapshotManager.buildReconnectFrames() — emits snapshot then tail frames
 *   - SnapshotFrameSchema             — contracts schema for snapshot frame
 *   - TailReplayFrameSchema           — contracts schema for tail_replay frame
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Import contracts schemas (ESM dist is directly importable)
// ---------------------------------------------------------------------------
import {
  SnapshotFrameSchema,
  TailReplayFrameSchema,
  FRAME_CHANNEL,
} from './packages/contracts/dist/index.js';

// ---------------------------------------------------------------------------
// Inline SnapshotManager
// (mirrors apps/api/src/terminal/snapshot.ts — inlined so there is no
//  dependency on the CJS dist that requires workspace: resolution)
// ---------------------------------------------------------------------------
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const SESSION_LOG_FILENAME = 'session.log';

class SnapshotManager {
  constructor(terminal, workspaceDir, options = {}) {
    this._terminal = terminal;
    this._logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    this._intervalMs = options.intervalMs ?? 2_000;
    this._now = options.now ?? Date.now;
    this._byteOffset = 0;
    this._latest = null;
    this._timer = null;
  }

  get currentOffset() { return this._byteOffset; }
  get latestSnapshot() { return this._latest; }

  feed(chunk, byteLen) {
    this._terminal.write(chunk);
    const len =
      byteLen != null
        ? byteLen
        : typeof chunk === 'string'
          ? Buffer.byteLength(chunk)
          : chunk.byteLength;
    this._byteOffset += len;
  }

  capture() {
    const snapshot = {
      data: this._terminal.serialize(),
      cols: this._terminal.cols,
      rows: this._terminal.rows,
      seq: this._byteOffset,
      capturedAt: this._now(),
    };
    this._latest = snapshot;
    return snapshot;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.capture(), this._intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async buildReconnectFrames(opts = {}) {
    const frames = [];
    const snapshot = this._latest;

    let tailFrom;
    if (snapshot && (opts.fromSeq ?? 0) <= snapshot.seq) {
      // Step 1: deliver snapshot first
      frames.push(toSnapshotFrame(snapshot));
      tailFrom = snapshot.seq;
    } else {
      tailFrom = opts.fromSeq ?? 0;
    }

    // Step 2: replay tail appended after snapshot
    const tailFrames = await this._readTailFrames(tailFrom, opts.chunkBytes);
    frames.push(...tailFrames);
    return frames;
  }

  async _readTailFrames(fromSeq, chunkBytes = 64 * 1024) {
    let size;
    try {
      size = (await stat(this._logPath)).size;
    } catch {
      return [emptyFinalTail(Math.max(0, fromSeq))];
    }

    const start = Math.min(Math.max(0, fromSeq), size);
    if (start >= size) return [emptyFinalTail(start)];

    const frames = [];
    let offset = start;
    await new Promise((resolve, reject) => {
      const stream = createReadStream(this._logPath, {
        start,
        end: size - 1,
        highWaterMark: chunkBytes,
      });
      stream.on('data', (data) => {
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

    if (frames.length === 0) return [emptyFinalTail(start)];
    frames[frames.length - 1] = { ...frames[frames.length - 1], final: true };
    return frames;
  }
}

function toSnapshotFrame(snapshot) {
  return {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'snapshot',
    data: snapshot.data,
    cols: snapshot.cols,
    rows: snapshot.rows,
    seq: snapshot.seq,
  };
}

function emptyFinalTail(seq) {
  return {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'tail_replay',
    data: '',
    seq,
    final: true,
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fake headless terminal (substitutes for @xterm/headless + SerializeAddon)
// ---------------------------------------------------------------------------
function makeFakeTerminal(opts = {}) {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const written = [];
  return {
    cols,
    rows,
    write(chunk) { written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); },
    serialize() { return `SERIALIZED[${written.join('')}]`; },
    get writtenChunks() { return written; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const workspaceDir = path.join(tmpdir(), `cap-snapshot-test-${Date.now()}`);
await mkdir(workspaceDir, { recursive: true });

try {

  // ── Test group 1: contracts schema validation ──────────────────────────────
  console.log('\n=== 1. SnapshotFrame schema validation ===');

  {
    // A valid snapshot frame must carry channel, type, data, cols, rows, seq.
    const valid = {
      channel: 'control',
      type: 'snapshot',
      data: 'SERIALIZED[hello]',
      cols: 80,
      rows: 24,
      seq: 500,
    };
    const r = SnapshotFrameSchema.safeParse(valid);
    assert(r.success, 'SnapshotFrameSchema: valid frame parses');
    assert(r.data?.cols === 80,  'SnapshotFrameSchema: cols is preserved');
    assert(r.data?.rows === 24,  'SnapshotFrameSchema: rows is preserved');
    assert(r.data?.seq  === 500, 'SnapshotFrameSchema: seq is preserved');
  }

  {
    // Missing cols/rows means we cannot do size reconciliation — must be rejected.
    const missingDims = { channel: 'control', type: 'snapshot', data: 'x', seq: 0 };
    const r = SnapshotFrameSchema.safeParse(missingDims);
    assert(!r.success, 'SnapshotFrameSchema: frame without cols/rows is rejected');
  }

  {
    // seq must be nonnegative integer.
    const negSeq = { channel: 'control', type: 'snapshot', data: 'x', cols: 80, rows: 24, seq: -1 };
    const r = SnapshotFrameSchema.safeParse(negSeq);
    assert(!r.success, 'SnapshotFrameSchema: negative seq is rejected');
  }

  console.log('\n=== 2. TailReplayFrame schema validation ===');

  {
    const valid = {
      channel: 'control',
      type: 'tail_replay',
      data: Buffer.from('some bytes').toString('base64'),
      seq: 600,
      final: true,
    };
    const r = TailReplayFrameSchema.safeParse(valid);
    assert(r.success, 'TailReplayFrameSchema: valid frame parses');
    assert(r.data?.final === true, 'TailReplayFrameSchema: final flag is preserved');
  }

  {
    // Missing `final` is invalid (boolean is required).
    const noFinal = {
      channel: 'control', type: 'tail_replay', data: 'abc=', seq: 10,
    };
    const r = TailReplayFrameSchema.safeParse(noFinal);
    assert(!r.success, 'TailReplayFrameSchema: frame without final flag is rejected');
  }

  // ── Test group 2: Snapshot captures dimensions (Scenario B) ───────────────
  console.log('\n=== 3. Snapshot records its dimensions for size reconciliation ===');

  {
    const terminal = makeFakeTerminal({ cols: 120, rows: 40 });
    const mgr = new SnapshotManager(terminal, workspaceDir);

    // Feed some bytes so the offset advances.
    const chunk1 = 'hello world\n';
    mgr.feed(chunk1);

    const snap = mgr.capture();

    // The snapshot must carry the geometry at capture time.
    assert(snap.cols === 120, 'capture(): snapshot.cols matches terminal cols');
    assert(snap.rows === 40,  'capture(): snapshot.rows matches terminal rows');
    assert(snap.seq  === Buffer.byteLength(chunk1),
           'capture(): snapshot.seq equals cumulative bytes fed');

    // Convert to a contracts SnapshotFrame and validate it.
    const frame = toSnapshotFrame(snap);
    const r = SnapshotFrameSchema.safeParse(frame);
    assert(r.success, 'toSnapshotFrame(): resulting frame validates against SnapshotFrameSchema');
    assert(r.data?.cols === 120, 'SnapshotFrame.cols matches terminal cols at capture time');
    assert(r.data?.rows === 40,  'SnapshotFrame.rows matches terminal rows at capture time');
  }

  // ── Test group 3: buildReconnectFrames — snapshot then tail (Scenario A) ──
  console.log('\n=== 4. Reconnect restores from snapshot then tail ===');

  {
    // Write a session.log with two chunks: CHUNK_A then CHUNK_B.
    // A snapshot is taken after CHUNK_A is fed to the headless terminal.
    // The reconnecting client sends fromSeq=0 (it has nothing).
    // Expected:
    //   frames[0]: snapshot covering CHUNK_A (seq = byte length of CHUNK_A)
    //   frames[1..]: tail_replay of CHUNK_B (appended after snapshot)
    //   last frame: final === true

    const CHUNK_A = 'CHUNK_A_content\n';
    const CHUNK_B = 'CHUNK_B_appended_after_snapshot\n';
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);

    // Write the full session log to disk (both chunks already appended).
    await writeFile(logPath, CHUNK_A + CHUNK_B, 'utf8');

    const terminal = makeFakeTerminal({ cols: 80, rows: 24 });
    const mgr = new SnapshotManager(terminal, workspaceDir);

    // Feed only CHUNK_A — this is what the headless terminal has seen up to the
    // snapshot point; CHUNK_B has been appended to session.log since then.
    mgr.feed(CHUNK_A);

    // Capture snapshot at this offset.
    const snap = mgr.capture();
    const snapSeq = Buffer.byteLength(CHUNK_A);
    assert(snap.seq === snapSeq,
           `snapshot.seq (${snap.seq}) matches byte length of CHUNK_A (${snapSeq})`);

    // Feed CHUNK_B too (the headless terminal stays current, but the snapshot's
    // seq is still snapSeq — that's the tail start for replay).
    mgr.feed(CHUNK_B);

    // Simulate a client reconnect from seq=0 (no prior data).
    const frames = await mgr.buildReconnectFrames({ fromSeq: 0 });

    assert(frames.length >= 2,
           `buildReconnectFrames() returns at least 2 frames (got ${frames.length})`);

    // Frame 0: snapshot.
    const firstFrame = frames[0];
    assert(firstFrame?.type === 'snapshot',
           'first reconnect frame is a snapshot');
    assert(firstFrame?.channel === FRAME_CHANNEL.CONTROL,
           'snapshot frame is on control channel');
    const snapParsed = SnapshotFrameSchema.safeParse(firstFrame);
    assert(snapParsed.success,
           'first reconnect frame validates against SnapshotFrameSchema');
    assert(snapParsed.data?.cols === 80,
           'snapshot frame records cols for size reconciliation');
    assert(snapParsed.data?.rows === 24,
           'snapshot frame records rows for size reconciliation');
    assert(snapParsed.data?.seq === snapSeq,
           `snapshot frame seq (${snapParsed.data?.seq}) == CHUNK_A byte length (${snapSeq})`);

    // Remaining frames: tail_replay for CHUNK_B.
    const tailFrames = frames.slice(1);
    assert(tailFrames.length >= 1,
           `at least one tail_replay frame follows the snapshot (got ${tailFrames.length})`);

    for (const tf of tailFrames) {
      assert(tf.type === 'tail_replay',
             `tail frame has type "tail_replay" (got "${tf.type}")`);
      assert(tf.channel === FRAME_CHANNEL.CONTROL,
             'tail frame is on control channel');
      const tr = TailReplayFrameSchema.safeParse(tf);
      assert(tr.success, 'tail frame validates against TailReplayFrameSchema');
    }

    // Last frame must be marked final so the client knows replay is complete.
    const lastFrame = frames[frames.length - 1];
    assert(lastFrame?.final === true,
           'last reconnect frame has final=true (signals live streaming may resume)');

    // The tail content must decode to exactly CHUNK_B.
    const tailBytes = tailFrames
      .map((f) => Buffer.from(f.data, 'base64'))
      .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
    assert(tailBytes.toString('utf8') === CHUNK_B,
           `tail content decodes to CHUNK_B ("${tailBytes.toString('utf8').trim()}")`);
  }

  // ── Test group 4: no snapshot yet — full log is replayed ──────────────────
  console.log('\n=== 5. No snapshot yet — full session.log is replayed ===');

  {
    const subDir = path.join(workspaceDir, 'no-snap');
    await mkdir(subDir, { recursive: true });
    const FULL_LOG = 'full log content before any snapshot\n';
    await writeFile(path.join(subDir, SESSION_LOG_FILENAME), FULL_LOG, 'utf8');

    const terminal = makeFakeTerminal({ cols: 80, rows: 24 });
    const mgr = new SnapshotManager(terminal, subDir);

    // No capture() called — latestSnapshot is null.
    assert(mgr.latestSnapshot === null, 'latestSnapshot is null before first capture');

    const frames = await mgr.buildReconnectFrames({ fromSeq: 0 });

    // With no snapshot, the first frame must NOT be a snapshot frame.
    assert(frames[0]?.type !== 'snapshot',
           'no snapshot frame emitted when no snapshot has been captured yet');

    // All frames should be tail_replay.
    assert(frames.every((f) => f.type === 'tail_replay'),
           'all frames are tail_replay when no snapshot exists');

    // The decoded bytes should match the full log.
    const decoded = frames
      .map((f) => Buffer.from(f.data, 'base64'))
      .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
    assert(decoded.toString('utf8') === FULL_LOG,
           'tail bytes reconstruct the full session.log when no snapshot exists');

    // Last frame must be final.
    assert(frames[frames.length - 1]?.final === true,
           'last frame is final even with no snapshot');
  }

  // ── Test group 5: reconnect with fromSeq strictly past snapshot — skip snapshot ──
  console.log('\n=== 6. Client strictly past snapshot seq — snapshot skipped ===');

  {
    // The implementation condition is: deliver snapshot iff fromSeq <= snapshot.seq.
    // When fromSeq > snapshot.seq the client is already past the snapshot's coverage,
    // so the snapshot frame is skipped and only the tail from fromSeq is replayed.

    const subDir = path.join(workspaceDir, 'past-snap');
    await mkdir(subDir, { recursive: true });

    const PART1 = 'part one\n';
    const PART2 = 'part two\n';
    const PART3 = 'part three\n';
    const fullLog = PART1 + PART2 + PART3;
    await writeFile(path.join(subDir, SESSION_LOG_FILENAME), fullLog, 'utf8');

    const terminal = makeFakeTerminal({ cols: 80, rows: 24 });
    const mgr = new SnapshotManager(terminal, subDir);

    // Snapshot is taken after PART1.
    mgr.feed(PART1);
    mgr.capture(); // snapshot.seq = len(PART1)
    const snapSeq = Buffer.byteLength(PART1);

    // Client holds bytes up to end of PART2 — strictly past the snapshot.
    const clientSeq = Buffer.byteLength(PART1) + Buffer.byteLength(PART2);
    assert(clientSeq > snapSeq,
           `test pre-condition: clientSeq (${clientSeq}) > snapSeq (${snapSeq})`);

    const frames = await mgr.buildReconnectFrames({ fromSeq: clientSeq });

    // No snapshot frame should be delivered (client is strictly past snapshot.seq).
    assert(frames[0]?.type !== 'snapshot',
           'snapshot skipped when client fromSeq > snapshot.seq');

    // Should only replay PART3 (bytes after clientSeq).
    const tailBytes = frames
      .filter((f) => f.type === 'tail_replay' && f.data.length > 0)
      .map((f) => Buffer.from(f.data, 'base64'))
      .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
    assert(tailBytes.toString('utf8') === PART3,
           `only PART3 is replayed when client is strictly past snapshot seq`);
  }

} finally {
  await rm(workspaceDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
