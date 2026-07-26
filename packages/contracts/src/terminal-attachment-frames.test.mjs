import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ControlFrameSchema,
  FRAME_CHANNEL,
  KeystrokeFrameSchema,
  RawFrameSchema,
  TERMINAL_PROTOCOL_VERSION,
  TerminalAttachFrameSchema,
  TerminalAttachmentStateFrameSchema,
  TerminalGeometryFrameSchema,
  TerminalResponseFrameSchema,
  TerminalResponseProfileSchema,
  WsFrameSchema,
  XTERM_5_5_0_RESPONSE_PROFILE,
  XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT,
  XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT_SOURCE,
  XTERM_5_5_0_RESPONSE_PROFILE_ID,
  Xterm550ResponseProfileSchema,
  canonicalBase64DecodedLength,
  classifyTerminalResponseBytes,
  createCurrentTerminalAttachFrame,
  createTerminalResponseBase64Schema,
  decodeCanonicalBase64Bytes,
  negotiateTerminalAttach,
} from '../dist/index.js';

const CONTROL = FRAME_CHANNEL.CONTROL;
const ESC = '\x1b';

function b64(value) {
  return Buffer.from(value, 'latin1').toString('base64');
}

function responseFrame(value) {
  return {
    channel: CONTROL,
    type: 'terminal_response',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    data: b64(value),
  };
}

test('xterm 5.5.0 response profile fingerprint pins the exact wrapper inputs', () => {
  assert.equal(
    createHash('sha256')
      .update(XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT_SOURCE)
      .digest('hex'),
    XTERM_5_5_0_RESPONSE_PROFILE_FINGERPRINT,
  );
  assert.deepEqual(
    Xterm550ResponseProfileSchema.parse(XTERM_5_5_0_RESPONSE_PROFILE),
    XTERM_5_5_0_RESPONSE_PROFILE,
  );
  assert.equal(
    Xterm550ResponseProfileSchema.safeParse({
      ...XTERM_5_5_0_RESPONSE_PROFILE,
      descriptor: {
        ...XTERM_5_5_0_RESPONSE_PROFILE.descriptor,
        termName: 'screen',
      },
    }).success,
    false,
  );
  assert.equal(
    TerminalResponseProfileSchema.safeParse({
      ...XTERM_5_5_0_RESPONSE_PROFILE,
      id: `xterm-response-v1-sha256-${'0'.repeat(64)}`,
    }).success,
    false,
    'id and fingerprint must agree',
  );
});

test('terminal attach negotiation accepts only this protocol/profile before provider open', () => {
  const attach = TerminalAttachFrameSchema.parse({
    channel: CONTROL,
    type: 'terminal_attach',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
    cols: 120,
    rows: 40,
  });
  assert.deepEqual(negotiateTerminalAttach(attach), { ok: true, frame: attach });

  const protocolMismatch = negotiateTerminalAttach({ ...attach, protocolVersion: 2 });
  assert.equal(protocolMismatch.ok, false);
  assert.deepEqual(protocolMismatch.frame, {
    channel: CONTROL,
    type: 'terminal_attachment_state',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    state: 'failed',
    reason: 'protocol_mismatch',
    reloadRequired: true,
    cols: 120,
    rows: 40,
  });

  const profileMismatch = negotiateTerminalAttach({
    ...attach,
    responseProfileId: `xterm-response-v1-sha256-${'0'.repeat(64)}`,
  });
  assert.equal(profileMismatch.ok, false);
  assert.equal(profileMismatch.frame.reason, 'response_profile_mismatch');
  assert.equal(profileMismatch.frame.reloadRequired, true);
});

test('current Web attach builder stays pinned to the production protocol/profile', () => {
  assert.deepEqual(createCurrentTerminalAttachFrame(132, 43), {
    channel: CONTROL,
    type: 'terminal_attach',
    protocolVersion: TERMINAL_PROTOCOL_VERSION,
    responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
    cols: 132,
    rows: 43,
  });
  assert.throws(() => createCurrentTerminalAttachFrame(0, 43));
});

test('every native attachment control variant round-trips with bounded geometry', () => {
  const frames = [
    {
      channel: CONTROL,
      type: 'terminal_attach',
      protocolVersion: 1,
      responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
      cols: 80,
      rows: 24,
    },
    {
      channel: CONTROL,
      type: 'terminal_attachment_state',
      protocolVersion: 1,
      state: 'attaching',
      cols: 80,
      rows: 24,
    },
    {
      channel: CONTROL,
      type: 'terminal_attachment_state',
      protocolVersion: 1,
      state: 'ready',
      cols: 80,
      rows: 24,
    },
    {
      channel: CONTROL,
      type: 'terminal_attachment_state',
      protocolVersion: 1,
      state: 'unavailable',
      reason: 'session_absent',
      reloadRequired: false,
      cols: 80,
      rows: 24,
    },
    {
      channel: CONTROL,
      type: 'terminal_attachment_state',
      protocolVersion: 1,
      state: 'failed',
      reason: 'response_profile_mismatch',
      reloadRequired: true,
      cols: 80,
      rows: 24,
    },
    {
      channel: CONTROL,
      type: 'terminal_attachment_state',
      protocolVersion: 1,
      state: 'failed',
      reason: 'transport_closed',
      reloadRequired: false,
      cols: 80,
      rows: 24,
    },
    {
      channel: CONTROL,
      type: 'terminal_geometry',
      protocolVersion: 1,
      cols: 80,
      rows: 24,
    },
    responseFrame(`${ESC}[?1;2c`),
  ];

  for (const frame of frames) {
    assert.deepEqual(ControlFrameSchema.parse(frame), frame);
    assert.deepEqual(WsFrameSchema.parse(frame), frame);
  }

  for (const invalidGeometry of [
    { cols: 0, rows: 24 },
    { cols: 80, rows: 0 },
    { cols: 1_001, rows: 24 },
    { cols: 80, rows: 1_001 },
    { cols: Number.POSITIVE_INFINITY, rows: 24 },
  ]) {
    assert.equal(
      TerminalGeometryFrameSchema.safeParse({
        channel: CONTROL,
        type: 'terminal_geometry',
        protocolVersion: 1,
        ...invalidGeometry,
      }).success,
      false,
    );
  }
});

test('attachment states enforce outcome/reason/reload-required combinations', () => {
  const common = {
    channel: CONTROL,
    type: 'terminal_attachment_state',
    protocolVersion: 1,
    cols: 80,
    rows: 24,
  };
  for (const invalid of [
    { ...common, state: 'attaching', reason: 'session_absent' },
    { ...common, state: 'ready', reloadRequired: false },
    { ...common, state: 'unavailable', reason: 'session_absent', reloadRequired: true },
    { ...common, state: 'failed', reason: 'protocol_mismatch', reloadRequired: false },
    { ...common, state: 'failed', reason: 'transport_closed', reloadRequired: true },
    { ...common, state: 'blank' },
  ]) {
    assert.equal(TerminalAttachmentStateFrameSchema.safeParse(invalid).success, false);
  }
});

test('removed live snapshot, tail replay, and offset reconnect frames are rejected', () => {
  for (const removed of [
    { channel: CONTROL, type: 'snapshot', data: 'frame', cols: 80, rows: 24, seq: 1 },
    { channel: CONTROL, type: 'tail_replay', data: b64('tail'), seq: 4, final: true },
    { channel: CONTROL, type: 'reconnect', lastSeq: 4, cols: 80, rows: 24 },
  ]) {
    assert.equal(ControlFrameSchema.safeParse(removed).success, false);
    assert.equal(WsFrameSchema.safeParse(removed).success, false);
  }
});

test('new attachment-local frames reject retarget fields and second payloads', () => {
  const attach = {
    channel: CONTROL,
    type: 'terminal_attach',
    protocolVersion: 1,
    responseProfileId: XTERM_5_5_0_RESPONSE_PROFILE_ID,
    cols: 80,
    rows: 24,
  };
  assert.equal(TerminalAttachFrameSchema.safeParse({ ...attach, taskId: 'task-b' }).success, false);

  const response = responseFrame(`${ESC}[0n`);
  for (const retargeted of [
    { ...response, taskId: 'task-b' },
    { ...response, sessionId: 'task-b' },
    { ...response, attachmentId: 'other-viewer' },
    { ...response, responses: [response.data, response.data] },
  ]) {
    assert.equal(TerminalResponseFrameSchema.safeParse(retargeted).success, false);
  }
});

test('canonical base64 preserves opaque bytes and rejects aliases, whitespace, and oversize input', () => {
  const opaque = Uint8Array.from([0x00, 0x1b, 0x7f, 0x80, 0xff]);
  const encoded = Buffer.from(opaque).toString('base64');
  const frame = KeystrokeFrameSchema.parse({
    channel: CONTROL,
    type: 'keystroke',
    sessionId: 'task-a',
    data: encoded,
  });
  assert.deepEqual([...decodeCanonicalBase64Bytes(frame.data)], [...opaque]);
  assert.equal(canonicalBase64DecodedLength(encoded), opaque.length);

  for (const malformed of ['AA', 'AB==', 'AAF=', 'AA_-', 'AA==\n', '', '====']) {
    assert.doesNotThrow(() => {
      assert.equal(
        KeystrokeFrameSchema.safeParse({
          channel: CONTROL,
          type: 'keystroke',
          sessionId: 'task-a',
          data: malformed,
        }).success,
        false,
      );
    });
  }

  assert.equal(
    KeystrokeFrameSchema.safeParse({
      channel: CONTROL,
      type: 'keystroke',
      sessionId: 'task-a',
      data: Buffer.alloc(64 * 1024 + 1).toString('base64'),
    }).success,
    false,
  );
});

test('the pinned response profile accepts each finite response class and exactly one response', () => {
  const valid = [
    `${ESC}[?1;2c`,
    `${ESC}[>0;276;0c`,
    `${ESC}[0n`,
    `${ESC}[24;80R`,
    `${ESC}[?24;80R`,
    `${ESC}[4;1$y`,
    `${ESC}[?1049;2$y`,
    `${ESC}P1$r0m${ESC}\\`,
    `${ESC}P1$r1;24r${ESC}\\`,
    `${ESC}P1$r2 q${ESC}\\`,
    `${ESC}P1$r0"q${ESC}\\`,
    `${ESC}P1$r61;1"p${ESC}\\`,
    `${ESC}P0$r${ESC}\\`,
    `${ESC}]4;255;rgb:ffff/0000/abcd${ESC}\\`,
    `${ESC}]10;rgb:ffff/ffff/ffff${ESC}\\`,
    `${ESC}]11;rgb:0000/0000/0000${ESC}\\`,
    `${ESC}]12;rgb:1234/5678/9abc${ESC}\\`,
  ];
  for (const value of valid) {
    assert.notEqual(classifyTerminalResponseBytes(Buffer.from(value, 'latin1')), null, value);
    assert.deepEqual(TerminalResponseFrameSchema.parse(responseFrame(value)), responseFrame(value));
  }

  const invalid = [
    `${ESC}[0n${ESC}[0n`,
    `x${ESC}[0n`,
    `${ESC}[0nX`,
    `${ESC}[0`,
    `${ESC}[0;0R`,
    `${ESC}[1001;1R`,
    `${ESC}[4;5$y`,
    `${ESC}[000004;1$y`,
    `${ESC}]4;256;rgb:ffff/ffff/ffff${ESC}\\`,
    `${ESC}]4;001;rgb:ffff/ffff/ffff${ESC}\\`,
    `${ESC}]10;rgb:fff/ffff/ffff${ESC}\\`,
    `${ESC}P1$r7 q${ESC}\\`,
  ];
  for (const value of invalid) {
    assert.equal(TerminalResponseFrameSchema.safeParse(responseFrame(value)).success, false, value);
  }

  const malformedBase64Frame = { ...responseFrame(`${ESC}[0n`), data: 'AB==' };
  assert.doesNotThrow(() => {
    assert.equal(TerminalResponseFrameSchema.safeParse(malformedBase64Frame).success, false);
  });
  assert.equal(
    TerminalResponseFrameSchema.safeParse({
      ...responseFrame(`${ESC}[0n`),
      data: Buffer.alloc(4 * 1024 + 1, 0x41).toString('base64'),
    }).success,
    false,
  );
});

test('window reports are profile-conditional and bounded', () => {
  const reports = [
    `${ESC}[4;1080;1920t`,
    `${ESC}[6;20;10t`,
    `${ESC}[8;24;80t`,
  ];
  for (const report of reports) {
    assert.notEqual(classifyTerminalResponseBytes(Buffer.from(report, 'latin1')), null);
    assert.equal(
      TerminalResponseFrameSchema.safeParse(responseFrame(report)).success,
      false,
      'default windowOptions disable the response',
    );
  }

  const enabledProfile = {
    ...XTERM_5_5_0_RESPONSE_PROFILE,
    fingerprint: '1'.repeat(64),
    id: `xterm-response-v1-sha256-${'1'.repeat(64)}`,
    descriptor: {
      ...XTERM_5_5_0_RESPONSE_PROFILE.descriptor,
      windowOptions: {
        getWinSizePixels: true,
        getCellSizePixels: true,
        getWinSizeChars: true,
      },
      responseClasses: [
        ...XTERM_5_5_0_RESPONSE_PROFILE.descriptor.responseClasses,
        'window_14',
        'window_16',
        'window_18',
      ],
    },
  };
  const enabledSchema = createTerminalResponseBase64Schema(enabledProfile);
  for (const report of reports) assert.equal(enabledSchema.safeParse(b64(report)).success, true);
  assert.equal(enabledSchema.safeParse(b64(`${ESC}[4;0;1920t`)).success, false);
  assert.equal(enabledSchema.safeParse(b64(`${ESC}[8;1001;80t`)).success, false);
  assert.throws(() =>
    createTerminalResponseBase64Schema({
      ...enabledProfile,
      descriptor: {
        ...enabledProfile.descriptor,
        responseClasses: XTERM_5_5_0_RESPONSE_PROFILE.descriptor.responseClasses,
      },
    }),
  );
});

test('raw/control channel discrimination remains strict and seq is connection-safe', () => {
  const raw = {
    channel: FRAME_CHANNEL.RAW,
    data: Buffer.from([0x00, 0xff]).toString('base64'),
    seq: 2,
  };
  assert.deepEqual(RawFrameSchema.parse(raw), raw);
  assert.deepEqual(WsFrameSchema.parse(raw), raw);
  assert.equal(ControlFrameSchema.safeParse(raw).success, false);
  assert.equal(
    RawFrameSchema.safeParse({ ...raw, channel: CONTROL, type: 'terminal_response' }).success,
    false,
  );
  assert.equal(RawFrameSchema.safeParse({ ...raw, seq: Number.MAX_SAFE_INTEGER + 1 }).success, false);
});
