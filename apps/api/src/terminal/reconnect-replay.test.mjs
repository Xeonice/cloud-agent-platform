/**
 * Reconnect-replay verification (harden-aio-execution, reconnect-restore 3.3).
 *
 * Proves the realtime-terminal requirement "Reconnect replays prior output under
 * connect-in" against the REAL pieces my track changed:
 *
 *   - 3.2: the SnapshotManager is backed by a REAL `@xterm/headless` terminal with
 *          a `SerializeAddon`, so a captured snapshot is NON-EMPTY (the prior
 *          `NullHeadlessTerminal.serialize()` was always '').
 *   - 3.1: raw PTY output is appended to `workspaces/<id>/session.log` in lockstep
 *          with the byte-offset fed to `snapshots.feed`, so the snapshot boundary
 *          (`seq`) and the replayed tail align.
 *   - reconnect: fresh browser loads use the current-frame snapshot once it
 *          exists, then replay only bytes appended AFTER the snapshot. The
 *          snapshot intentionally excludes xterm scrollback because Codex's
 *          inline TUI stream contains physical repaint history, not a clean
 *          semantic transcript.
 *
 * The test drives the compiled `SnapshotManager` from `dist/terminal/snapshot.js`
 * (build with `pnpm --filter @cap/api build` first) plus a real headless xterm
 * constructed exactly as the gateway's `XtermHeadlessTerminal` does, and writes a
 * temp `session.log` the same way the gateway's single-code-path append does.
 *
 * Run: node --test src/terminal/reconnect-replay.test.mjs   (after build)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from '@xterm/headless';
import serPkg from '@xterm/addon-serialize';

const { Terminal } = pkg;
const { SerializeAddon } = serPkg;

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist/terminal');
const { SnapshotManager, SESSION_LOG_FILENAME } = await import(
  path.join(dist, 'snapshot.js')
);

/**
 * A real headless terminal mirroring the gateway's `XtermHeadlessTerminal`: it
 * feeds raw bytes to `@xterm/headless` and `serialize()`s the actual visible
 * frame via SerializeAddon, recording cols/rows.
 */
function makeHeadless(cols = 80, rows = 24) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write(data) {
      term.write(data);
    },
    drain() {
      return new Promise((resolve) => term.write('', resolve));
    },
    serialize() {
      return serializer.serialize({ scrollback: 0 });
    },
    resize(c, r) {
      term.resize(c, r);
    },
  };
}

/** Wait for xterm's parser callback so serialize() deterministically sees every write. */
function flush(headless) {
  return headless.drain();
}

test('reconnect uses snapshot plus tail once a snapshot exists (3.1/3.2/3.3)', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-reconnect-'));
  try {
    const headless = makeHeadless();
    const mgr = new SnapshotManager(headless, workspaceDir);
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);

    // --- single-code-path lockstep: every chunk is BOTH appended to session.log
    //     AND fed to snapshots.feed with the same byte length (exactly what the
    //     gateway's onPtyOutput does). ---
    async function emit(chunk) {
      const payload = Buffer.from(chunk, 'utf8');
      await appendFile(logPath, payload);
      mgr.feed(chunk, payload.byteLength);
    }

    // Output produced BEFORE the snapshot boundary (lands in the visible frame).
    await emit('hello from the agent\r\n');
    await emit('building project...\r\n');
    await flush(headless);

    // Capture the periodic snapshot at the current offset.
    const snap = mgr.capture();

    // 3.2 — the snapshot is NON-EMPTY and records geometry.
    assert.ok(snap.data.length > 0, 'snapshot data must be non-empty (real serialize)');
    assert.ok(
      snap.data.includes('hello from the agent') ||
        snap.data.includes('building project'),
      'snapshot must contain the visible frame text',
    );
    assert.equal(snap.cols, 80, 'snapshot records cols');
    assert.equal(snap.rows, 24, 'snapshot records rows');
    assert.equal(snap.seq, mgr.currentOffset, 'snapshot seq tracks the fed offset');

    const snapshotOffset = snap.seq;

    // Output produced AFTER the snapshot — this is what the tail must replay.
    await emit('TAIL-AFTER-SNAPSHOT-LINE\r\n');
    await flush(headless);

    // A fresh client (fromSeq 0) uses the visible-frame snapshot once available.
    // Replaying the whole TUI byte log would expand historical full-screen redraws
    // into duplicated/out-of-order scrollback after a hard refresh.
    const freshFrames = await mgr.buildReconnectFrames({ fromSeq: 0, clientCols: 80, clientRows: 24 });
    assert.ok(freshFrames.length >= 2, 'fresh reconnect returns snapshot + tail');
    const freshSnapshotFrame = freshFrames[0];
    assert.equal(freshSnapshotFrame.type, 'snapshot', 'fresh first frame is the snapshot');
    assert.ok(freshSnapshotFrame.data.length > 0, 'fresh snapshot frame is non-empty');
    assert.equal(freshSnapshotFrame.cols, 80);
    assert.equal(freshSnapshotFrame.rows, 24);
    assert.equal(freshSnapshotFrame.seq, snapshotOffset, 'fresh snapshot frame seq == capture offset');
    const freshTail = freshFrames.slice(1);
    for (const f of freshTail) assert.equal(f.type, 'tail_replay');
    assert.equal(freshTail[freshTail.length - 1].final, true, 'fresh replay final frame is marked final');
    const freshText = freshTail
      .map((f) => Buffer.from(f.data, 'base64').toString('utf8'))
      .join('');
    assert.ok(
      freshText.includes('TAIL-AFTER-SNAPSHOT-LINE'),
      'fresh reconnect replays bytes appended after the snapshot',
    );
    assert.ok(
      !freshText.includes('hello from the agent'),
      'fresh reconnect does NOT replay bytes already covered by the snapshot offset',
    );
    assert.equal(
      freshTail[freshTail.length - 1].seq,
      mgr.currentOffset,
      'fresh replay end offset == total fed offset (file/offset lockstep)',
    );
    assert.ok(
      freshText.length > 0,
      'fresh reconnect delivers prior output, not an empty replay',
    );

    // An incremental reconnect uses the faster snapshot + tail path.
    const incrementalFrames = await mgr.buildReconnectFrames({
      fromSeq: 1,
      clientCols: 80,
      clientRows: 24,
    });
    assert.ok(incrementalFrames.length >= 2, 'incremental reconnect returns snapshot + tail');
    const snapshotFrame = incrementalFrames[0];
    assert.equal(snapshotFrame.type, 'snapshot', 'incremental first frame is the snapshot');
    assert.ok(snapshotFrame.data.length > 0, 'incremental snapshot frame is non-empty');
    assert.equal(snapshotFrame.cols, 80);
    assert.equal(snapshotFrame.rows, 24);
    assert.equal(snapshotFrame.seq, snapshotOffset, 'snapshot frame seq == capture offset');

    const tail = incrementalFrames.slice(1);
    assert.ok(tail.length >= 1, 'incremental reconnect has at least one tail frame');
    for (const f of tail) assert.equal(f.type, 'tail_replay');
    assert.equal(tail[tail.length - 1].final, true, 'incremental last tail frame is marked final');

    const tailText = tail
      .map((f) => Buffer.from(f.data, 'base64').toString('utf8'))
      .join('');
    assert.ok(
      tailText.includes('TAIL-AFTER-SNAPSHOT-LINE'),
      'incremental tail replays bytes appended after the snapshot',
    );
    assert.ok(
      !tailText.includes('hello from the agent'),
      'incremental tail does NOT re-replay bytes already covered by the snapshot offset',
    );
    assert.equal(
      tail[tail.length - 1].seq,
      mgr.currentOffset,
      'incremental tail end offset == total fed offset (file/offset lockstep)',
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('a NullHeadlessTerminal regression would serialize empty — guard the real one', async () => {
  // Direct guard on 3.2: the real headless terminal must serialize non-empty
  // after being fed visible output (the prior Null impl returned '').
  const headless = makeHeadless();
  headless.write('visible output line');
  await flush(headless);
  assert.ok(
    headless.serialize().length > 0,
    'the real headless terminal serializes a non-empty frame',
  );
});

test('headless snapshot excludes scrollback; history comes from rollout transcript', async () => {
  const headless = makeHeadless(40, 4);
  for (let i = 1; i <= 8; i++) {
    headless.write(`LINE-${String(i).padStart(3, '0')}\r\n`);
  }
  await flush(headless);

  const serialized = headless.serialize();

  assert.ok(
    serialized.includes('LINE-008'),
    'snapshot keeps the current visible frame',
  );
  assert.ok(
    !serialized.includes('LINE-001'),
    'snapshot must not carry old xterm scrollback repaint history',
  );
});
