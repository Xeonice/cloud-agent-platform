import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SESSION_LOG_FILENAME,
  readSessionLogTail,
  stripAnsi,
} from './snapshot';
import {
  DEFAULT_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES,
  DEFAULT_TERMINAL_RAW_ARTIFACT_MAX_BYTES,
  DEFAULT_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES,
  readTerminalRecordingPolicy,
} from './terminal-recording-policy';

test('raw terminal artifacts are default-off while failure evidence stays bounded', () => {
  const policy = readTerminalRecordingPolicy({});
  assert.deepEqual(policy, {
    sessionLog: {
      enabled: false,
      maxBytes: DEFAULT_TERMINAL_RAW_ARTIFACT_MAX_BYTES,
    },
    sessionCast: {
      enabled: false,
      maxBytes: DEFAULT_TERMINAL_RAW_ARTIFACT_MAX_BYTES,
    },
    failureEvidenceMaxBytes: DEFAULT_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES,
    maxPendingWrites: DEFAULT_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES,
  });
});

test('raw log and cast opt-ins are independent and strictly budgeted', () => {
  const policy = readTerminalRecordingPolicy({
    CAP_TERMINAL_RAW_LOG_RECORDING_ENABLED: 'true',
    CAP_TERMINAL_RAW_CAST_RECORDING_ENABLED: 'false',
    CAP_TERMINAL_RAW_LOG_MAX_BYTES: '4096',
    CAP_TERMINAL_RAW_CAST_MAX_BYTES: '8192',
    CAP_TERMINAL_FAILURE_EVIDENCE_MAX_BYTES: '2048',
    CAP_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES: '32',
  });
  assert.equal(policy.sessionLog.enabled, true);
  assert.equal(policy.sessionCast.enabled, false);
  assert.equal(policy.sessionLog.maxBytes, 4096);
  assert.equal(policy.sessionCast.maxBytes, 8192);
  assert.equal(policy.failureEvidenceMaxBytes, 2048);
  assert.equal(policy.maxPendingWrites, 32);

  assert.throws(
    () =>
      readTerminalRecordingPolicy({
        CAP_TERMINAL_RAW_CAST_RECORDING_ENABLED: 'yes',
      }),
    /CAP_TERMINAL_RAW_CAST_RECORDING_ENABLED/,
  );
  assert.throws(
    () =>
      readTerminalRecordingPolicy({
        CAP_TERMINAL_RAW_LOG_MAX_BYTES: '1023',
      }),
    /CAP_TERMINAL_RAW_LOG_MAX_BYTES/,
  );
});

test('finished-session audit helpers remain available without live replay frames', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-terminal-recording-'));
  try {
    assert.equal(await readSessionLogTail(workspaceDir), '');

    const lines = Array.from(
      { length: 25 },
      (_, index) => `line-${String(index + 1).padStart(2, '0')}`,
    );
    await writeFile(
      path.join(workspaceDir, SESSION_LOG_FILENAME),
      [
        '\u001b]0;secret title\u0007',
        '\u001b[31mred\u001b[0m\u0000',
        ...lines,
        '',
      ].join('\n'),
      'utf8',
    );

    const tail = await readSessionLogTail(workspaceDir);
    assert.deepEqual(tail.split('\n'), lines.slice(-20));
    assert.equal(tail.includes('\u001b'), false);
    assert.doesNotMatch(tail, /secret title|red/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('stripAnsi removes terminal control sequences from audit excerpts', () => {
  assert.equal(
    stripAnsi('\u001b[2Jvisible\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\u0000'),
    'visiblelink',
  );
});
