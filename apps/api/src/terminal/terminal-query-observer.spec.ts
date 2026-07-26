import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_PIXEL_DIMENSION,
  XTERM_5_5_0_RESPONSE_PROFILE,
  type TerminalResponseProfile,
} from '@cap/contracts';
import {
  MAX_TERMINAL_QUERY_CAPACITY,
  MAX_TERMINAL_QUERY_CARRY_BYTES,
  MAX_TERMINAL_QUERY_SEQUENCE_BYTES,
  MAX_TERMINAL_QUERY_STRING_BYTES,
  MAX_TERMINAL_QUERY_TTL_MS,
  MAX_TERMINAL_RESPONSE_RATE_LIMIT,
  MAX_TERMINAL_RESPONSE_RATE_WINDOW_MS,
  TerminalQueryObserver,
  TerminalQueryObserverConfigurationError,
  type TerminalQueryExpectation,
} from './terminal-query-observer';

const ESC = '\x1b';
const GEOMETRY = { cols: 80, rows: 24 } as const;

function bytes(value: string): Uint8Array {
  return Buffer.from(value, 'latin1');
}

function join(...parts: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

function enabledWindowProfile(): TerminalResponseProfile {
  const fingerprint = '1'.repeat(64);
  return {
    ...XTERM_5_5_0_RESPONSE_PROFILE,
    fingerprint,
    id: `xterm-response-v1-sha256-${fingerprint}`,
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
}

test('configuration rejects unsafe TTL, capacity, and response-rate values', () => {
  for (const ttlMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, MAX_TERMINAL_QUERY_TTL_MS + 1]) {
    assert.throws(
      () => new TerminalQueryObserver({ ttlMs }),
      TerminalQueryObserverConfigurationError,
    );
  }
  for (const capacity of [0, -1, 1.5, MAX_TERMINAL_QUERY_CAPACITY + 1]) {
    assert.throws(
      () => new TerminalQueryObserver({ capacity }),
      TerminalQueryObserverConfigurationError,
    );
  }
  for (const responseRateLimit of [0, 1.5, MAX_TERMINAL_RESPONSE_RATE_LIMIT + 1]) {
    assert.throws(
      () => new TerminalQueryObserver({ responseRateLimit }),
      TerminalQueryObserverConfigurationError,
    );
  }
  for (const responseRateWindowMs of [0, Number.NaN, MAX_TERMINAL_RESPONSE_RATE_WINDOW_MS + 1]) {
    assert.throws(
      () => new TerminalQueryObserver({ responseRateWindowMs }),
      TerminalQueryObserverConfigurationError,
    );
  }
});

test('complete active-profile query matrix survives every split boundary and bytewise fragmentation', () => {
  type QueryBoundaryCase = {
    readonly label: string;
    readonly query: Uint8Array;
    readonly expected: readonly TerminalQueryExpectation[];
    readonly profile?: TerminalResponseProfile;
  };

  const query = (value: string): Uint8Array => bytes(value);
  const expected = (
    ...queries: readonly TerminalQueryExpectation[]
  ): readonly TerminalQueryExpectation[] => queries;
  const cases: readonly QueryBoundaryCase[] = [
    { label: 'DA1', query: query(`${ESC}[c`), expected: expected({ responseClass: 'da1' }) },
    { label: 'DA2', query: query(`${ESC}[>0c`), expected: expected({ responseClass: 'da2' }) },
    {
      label: 'DSR status',
      query: query(`${ESC}[5n`),
      expected: expected({ responseClass: 'dsr_status' }),
    },
    { label: 'normal CPR', query: query(`${ESC}[6n`), expected: expected({ responseClass: 'cpr' }) },
    {
      label: 'private CPR',
      query: query(`${ESC}[?6n`),
      expected: expected({ responseClass: 'private_cpr' }),
    },
    {
      label: 'ANSI DECRQM',
      query: query(`${ESC}[4$p`),
      expected: expected({ responseClass: 'decrqm_ansi', mode: 4 }),
    },
    {
      label: 'private DECRQM',
      query: query(`${ESC}[?1049$p`),
      expected: expected({ responseClass: 'decrqm_private', mode: 1049 }),
    },
    {
      label: 'DECRQSS SGR',
      query: query(`${ESC}P$qm${ESC}\\`),
      expected: expected({ responseClass: 'decrqss', subtype: 'sgr' }),
    },
    {
      label: 'DECRQSS margins',
      query: query(`${ESC}P$qr${ESC}\\`),
      expected: expected({ responseClass: 'decrqss', subtype: 'margins' }),
    },
    {
      label: 'DECRQSS cursor style',
      query: query(`${ESC}P$q q${ESC}\\`),
      expected: expected({ responseClass: 'decrqss', subtype: 'cursor_style' }),
    },
    {
      label: 'DECRQSS protection',
      query: query(`${ESC}P$q"q${ESC}\\`),
      expected: expected({ responseClass: 'decrqss', subtype: 'protection' }),
    },
    {
      label: 'DECRQSS conformance',
      query: query(`${ESC}P$q"p${ESC}\\`),
      expected: expected({ responseClass: 'decrqss', subtype: 'conformance' }),
    },
    {
      label: 'OSC 4 single boundary index with BEL',
      query: query(`${ESC}]4;255;?\x07`),
      expected: expected({ responseClass: 'osc_4', colorIndex: 255 }),
    },
    {
      label: 'OSC 10 with 7-bit ST',
      query: query(`${ESC}]10;?${ESC}\\`),
      expected: expected({ responseClass: 'osc_10' }),
    },
    {
      label: 'OSC 11 with BEL',
      query: query(`${ESC}]11;?\x07`),
      expected: expected({ responseClass: 'osc_11' }),
    },
    {
      label: 'OSC 12 with 7-bit ST',
      query: query(`${ESC}]12;?${ESC}\\`),
      expected: expected({ responseClass: 'osc_12' }),
    },
    {
      label: 'enabled CSI 14',
      query: query(`${ESC}[14t`),
      expected: expected({ responseClass: 'window_14' }),
      profile: enabledWindowProfile(),
    },
    {
      label: 'enabled CSI 16',
      query: query(`${ESC}[16t`),
      expected: expected({ responseClass: 'window_16' }),
      profile: enabledWindowProfile(),
    },
    {
      label: 'enabled CSI 18',
      query: query(`${ESC}[18t`),
      expected: expected({ responseClass: 'window_18' }),
      profile: enabledWindowProfile(),
    },
    {
      label: 'single-byte C1 CSI introducer',
      query: join(Uint8Array.of(0x9b), query('5n')),
      expected: expected({ responseClass: 'dsr_status' }),
    },
    {
      label: 'UTF-8 C1 CSI introducer',
      query: join(Uint8Array.of(0xc2, 0x9b), query('?6n')),
      expected: expected({ responseClass: 'private_cpr' }),
    },
    {
      label: 'single-byte C1 OSC introducer and ST terminator',
      query: join(Uint8Array.of(0x9d), query('4;7;?'), Uint8Array.of(0x9c)),
      expected: expected({ responseClass: 'osc_4', colorIndex: 7 }),
    },
    {
      label: 'UTF-8 C1 OSC introducer and ST terminator',
      query: join(
        Uint8Array.of(0xc2, 0x9d),
        query('10;?'),
        Uint8Array.of(0xc2, 0x9c),
      ),
      expected: expected({ responseClass: 'osc_10' }),
    },
    {
      label: 'single-byte C1 DCS introducer and ST terminator',
      query: join(Uint8Array.of(0x90), query('$q q'), Uint8Array.of(0x9c)),
      expected: expected({ responseClass: 'decrqss', subtype: 'cursor_style' }),
    },
    {
      label: 'UTF-8 C1 DCS introducer and ST terminator',
      query: join(
        Uint8Array.of(0xc2, 0x90),
        query('$q"p'),
        Uint8Array.of(0xc2, 0x9c),
      ),
      expected: expected({ responseClass: 'decrqss', subtype: 'conformance' }),
    },
    {
      label: 'profile-disabled CSI 14',
      query: query(`${ESC}[14t`),
      expected: expected(),
    },
  ];

  const assertFragmentation = (
    testCase: QueryBoundaryCase,
    chunks: readonly Uint8Array[],
    fragmentation: string,
  ): void => {
    const observer = new TerminalQueryObserver({ profile: testCase.profile });
    const observations = chunks.map((chunk) => observer.observeOutput(chunk));
    const recognized = observations.flatMap((observation) => observation.recognized);
    const enqueued = observations.flatMap((observation) => observation.enqueued);
    const rawObservations = observations.flatMap((observation) => observation.observations);
    const context = `${testCase.label} ${fragmentation}`;

    assert.deepEqual(recognized, testCase.expected, `${context}: recognized queries`);
    assert.deepEqual(
      enqueued.map(({ id: _id, enqueuedAt: _enqueuedAt, expiresAt: _expiresAt, ...item }) => item),
      testCase.expected,
      `${context}: enqueued tokens`,
    );
    assert.equal(observer.pending, testCase.expected.length, `${context}: pending tokens`);
    assert.equal(observer.carryBytes, 0, `${context}: parser carry after complete query`);
    assert.equal(rawObservations.length, testCase.expected.length, `${context}: raw observations`);
    for (const rawObservation of rawObservations) {
      assert.deepEqual(
        Buffer.from(rawObservation.rawBytes),
        Buffer.from(testCase.query),
        `${context}: preserved raw query bytes`,
      );
    }
  };

  for (const testCase of cases) {
    for (let split = 0; split <= testCase.query.length; split += 1) {
      assertFragmentation(
        testCase,
        [testCase.query.subarray(0, split), testCase.query.subarray(split)],
        `split at ${split}`,
      );
    }
    assertFragmentation(
      testCase,
      Array.from(testCase.query, (byte) => Uint8Array.of(byte)),
      'bytewise',
    );
  }
});

test('7-bit, single-byte C1, and UTF-8 C1 CSI/OSC/DCS/ST forms are observed', () => {
  const observer = new TerminalQueryObserver();
  const forms = [
    join(Uint8Array.of(0x9b), bytes('5n')),
    join(Uint8Array.of(0xc2, 0x9b), bytes('6n')),
    join(Uint8Array.of(0x9d), bytes('4;7;?'), Uint8Array.of(0x9c)),
    join(Uint8Array.of(0xc2, 0x9d), bytes('10;?'), Uint8Array.of(0xc2, 0x9c)),
    join(Uint8Array.of(0x90), bytes('$qm'), Uint8Array.of(0x9c)),
    join(Uint8Array.of(0xc2, 0x90), bytes('$qz'), Uint8Array.of(ESC.charCodeAt(0), 0x5c)),
    join(Uint8Array.of(0x9d), bytes('11;?'), Uint8Array.of(0x07)),
  ];
  for (const form of forms) {
    for (const byte of form) observer.observeOutput(Uint8Array.of(byte));
  }
  assert.deepEqual(
    observer.snapshot().map((query) => query.responseClass),
    ['dsr_status', 'cpr', 'osc_4', 'osc_10', 'decrqss', 'decrqss', 'osc_11'],
  );
});

test('observer never mutates or replaces raw provider bytes', () => {
  const observer = new TerminalQueryObserver();
  const source = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x35, 0x6e, 0x80]);
  const before = Buffer.from(source);
  const result = observer.observeOutput(source);
  assert.deepEqual(source, before);
  assert.equal(result.enqueued.length, 1);
  assert.equal(result.observations.length, 1);
  assert.deepEqual(Buffer.from(result.observations[0]?.rawBytes ?? []), bytes(`${ESC}[5n`));
});

test('query observations retain exact sequence bytes across fragmentation and stacked responses', () => {
  const observer = new TerminalQueryObserver();
  const source = bytes(`${ESC}]10;?;?;?${ESC}\\`);
  let result = observer.observeOutput(source.subarray(0, 4));
  assert.equal(result.observations.length, 0);
  result = observer.observeOutput(source.subarray(4));

  assert.equal(result.observations.length, 3);
  assert.deepEqual(
    result.observations.map((observation) => observation.query.responseClass),
    ['osc_10', 'osc_11', 'osc_12'],
  );
  for (const observation of result.observations) {
    assert.equal(observation.admitted, true);
    assert.ok(observation.queryId !== null);
    assert.deepEqual(Buffer.from(observation.rawBytes), source);
  }
});

test('nested, malformed, unrelated, and overlong strings never expose internal pseudo queries', () => {
  const observer = new TerminalQueryObserver();

  observer.observeOutput(bytes(`${ESC}]0;title${ESC}[5n\x07`));
  observer.observeOutput(bytes(`${ESC}Pnot-a-query${ESC}[6n${ESC}\\`));
  observer.observeOutput(bytes(`${ESC}P$qm\x07${ESC}[5n${ESC}\\`));
  assert.equal(observer.pending, 0);

  const overlongOsc = join(
    bytes(`${ESC}]4;1;?;`),
    Buffer.alloc(MAX_TERMINAL_QUERY_STRING_BYTES + 1, 0x61),
    bytes(`${ESC}[5n\x07`),
  );
  for (let offset = 0; offset < overlongOsc.length; offset += 17) {
    observer.observeOutput(overlongOsc.subarray(offset, offset + 17));
    assert.ok(observer.carryBytes <= MAX_TERMINAL_QUERY_CARRY_BYTES);
  }
  assert.equal(observer.pending, 0);

  const overlongCsi = join(
    bytes(`${ESC}[`),
    Buffer.alloc(MAX_TERMINAL_QUERY_SEQUENCE_BYTES + 1, 0x31),
    bytes(`${ESC}[5n`),
  );
  observer.observeOutput(overlongCsi);
  assert.equal(observer.pending, 0);

  observer.observeOutput(bytes(`${ESC}[5n`));
  assert.equal(observer.pending, 1, 'parser recovers after the discarded sequence terminates');
});

test('clear discards partial parser carry and close permanently clears all authorization', () => {
  const observer = new TerminalQueryObserver();
  observer.observeOutput(bytes(`${ESC}[`));
  assert.ok(observer.carryBytes > 0);
  observer.clear();
  assert.equal(observer.carryBytes, 0);
  observer.observeOutput(bytes('5n'));
  assert.equal(observer.pending, 0);

  observer.observeOutput(bytes(`${ESC}[5n`));
  assert.equal(observer.pending, 1);
  observer.close();
  observer.close();
  assert.equal(observer.pending, 0);
  assert.equal(observer.isClosed, true);
  assert.deepEqual(observer.observeOutput(bytes(`${ESC}[5n`)).recognized, []);
  assert.deepEqual(observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY), {
    accepted: false,
    reason: 'closed',
  });
});

test('TTL is live only while now < expiresAt and expired tokens free capacity first', () => {
  let now = 100;
  const beforeBoundary = new TerminalQueryObserver({ ttlMs: 50, now: () => now });
  beforeBoundary.observeOutput(bytes(`${ESC}[5n`));
  now = 149.999;
  assert.equal(beforeBoundary.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, true);

  now = 200;
  const atBoundary = new TerminalQueryObserver({ ttlMs: 50, capacity: 1, now: () => now });
  atBoundary.observeOutput(bytes(`${ESC}[5n`));
  now = 250;
  assert.equal(atBoundary.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, false);
  assert.equal(atBoundary.pending, 0);
  const replacement = atBoundary.observeOutput(bytes(`${ESC}[c`));
  assert.equal(replacement.enqueued.length, 1, 'expiry is pruned before the capacity check');
});

test('a full queue refuses the entire new batch without evicting live tokens', () => {
  const fullEvents: unknown[] = [];
  const observer = new TerminalQueryObserver({
    capacity: 1,
    onQueueFull: (event) => fullEvents.push(event),
  });
  observer.observeOutput(bytes(`${ESC}[c`));
  const refused = observer.observeOutput(bytes(`${ESC}]10;?;?${ESC}\\`));
  assert.equal(refused.enqueued.length, 0);
  assert.equal(refused.refused.length, 2);
  assert.equal(observer.pending, 1);
  assert.equal(fullEvents.length, 1);
  assert.equal(observer.consumeResponse(bytes(`${ESC}[>0;276;0c`), GEOMETRY).accepted, false);
  assert.equal(observer.consumeResponse(bytes(`${ESC}[?1;2c`), GEOMETRY).accepted, true);
});

test('cross-class FIFO matching consumes the oldest matching query, not queue head', () => {
  const observer = new TerminalQueryObserver();
  observer.observeOutput(bytes(`${ESC}[c${ESC}[5n${ESC}[c`));
  const firstDa = observer.consumeResponse(bytes(`${ESC}[?1;2c`), GEOMETRY);
  const status = observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY);
  const secondDa = observer.consumeResponse(bytes(`${ESC}[?1;2c`), GEOMETRY);
  assert.equal(firstDa.accepted && firstDa.query.id, 1);
  assert.equal(status.accepted && status.query.id, 2);
  assert.equal(secondDa.accepted && secondDa.query.id, 3);
});

test('DA, DSR, normal/private CPR, and dynamic bounds map exactly', () => {
  const cases = [
    [`${ESC}[00:7;999c`, `${ESC}[?1;2c`, 'da1'],
    [`${ESC}[>00;999c`, `${ESC}[>0;276;0c`, 'da2'],
    [`${ESC}[005:1;99n`, `${ESC}[0n`, 'dsr_status'],
    [`${ESC}[006n`, `${ESC}[1;1R`, 'cpr'],
    [`${ESC}[?006:1n`, `${ESC}[?24;80R`, 'private_cpr'],
  ] as const;
  for (const [query, response, responseClass] of cases) {
    const observer = new TerminalQueryObserver();
    observer.observeOutput(bytes(query));
    const consumed = observer.consumeResponse(bytes(response), GEOMETRY);
    assert.equal(consumed.accepted, true, responseClass);
    if (consumed.accepted) assert.equal(consumed.classification.responseClass, responseClass);
  }

  const normal = new TerminalQueryObserver();
  normal.observeOutput(bytes(`${ESC}[6n`));
  assert.equal(normal.consumeResponse(bytes(`${ESC}[?1;1R`), GEOMETRY).accepted, false);
  assert.equal(normal.consumeResponse(bytes(`${ESC}[25;1R`), GEOMETRY).accepted, false);
  assert.equal(normal.consumeResponse(bytes(`${ESC}[24;81R`), GEOMETRY).accepted, false);
  assert.equal(normal.consumeResponse(bytes(`${ESC}[24;80R`), GEOMETRY).accepted, true);
});

test('ANSI/private DECRQM preserves prefix and requested boundary mode', () => {
  for (const [query, response] of [
    [`${ESC}[0$p`, `${ESC}[0;0$y`],
    [`${ESC}[0999999$p`, `${ESC}[999999;4$y`],
    [`${ESC}[?001049:7;42$p`, `${ESC}[?1049;2$y`],
  ] as const) {
    const observer = new TerminalQueryObserver();
    observer.observeOutput(bytes(query));
    assert.equal(observer.consumeResponse(bytes(response), GEOMETRY).accepted, true);
  }

  const observer = new TerminalQueryObserver();
  observer.observeOutput(bytes(`${ESC}[4$p`));
  assert.equal(observer.consumeResponse(bytes(`${ESC}[?4;1$y`), GEOMETRY).accepted, false);
  assert.equal(observer.consumeResponse(bytes(`${ESC}[5;1$y`), GEOMETRY).accepted, false);
  assert.equal(observer.consumeResponse(bytes(`${ESC}[4;1$y`), GEOMETRY).accepted, true);
  observer.observeOutput(bytes(`${ESC}[1000000$p`));
  assert.equal(observer.pending, 0);
});

test('all five known DECRQSS subtypes and bounded unknown negative responses correlate', () => {
  const cases = [
    ['m', `${ESC}P1$r0m${ESC}\\`],
    ['r', `${ESC}P1$r1;24r${ESC}\\`],
    [' q', `${ESC}P1$r2 q${ESC}\\`],
    ['"q', `${ESC}P1$r0"q${ESC}\\`],
    ['"p', `${ESC}P1$r61;1"p${ESC}\\`],
    ['not-supported', `${ESC}P0$r${ESC}\\`],
  ] as const;
  for (const [request, response] of cases) {
    const observer = new TerminalQueryObserver();
    observer.observeOutput(bytes(`${ESC}P1:7;2$q${request}${ESC}\\`));
    assert.equal(observer.consumeResponse(bytes(response), GEOMETRY).accepted, true, request);
  }

  const known = new TerminalQueryObserver();
  known.observeOutput(bytes(`${ESC}P$qm${ESC}\\`));
  assert.equal(known.consumeResponse(bytes(`${ESC}P0$r${ESC}\\`), GEOMETRY).accepted, false);
  assert.equal(known.consumeResponse(bytes(`${ESC}P1$r0m${ESC}\\`), GEOMETRY).accepted, true);
});

test('OSC 4 multiple indexes and OSC 10/11/12 stacked slots enqueue independently', () => {
  const indexed = new TerminalQueryObserver();
  const observation = indexed.observeOutput(
    bytes(`${ESC}]004;000;?;999;?;0255;?;trailing\x07`),
  );
  assert.equal(observation.enqueued.length, 2);
  assert.equal(
    indexed.consumeResponse(bytes(`${ESC}]4;255;rgb:ffff/0000/abcd${ESC}\\`), GEOMETRY)
      .accepted,
    true,
  );
  assert.equal(
    indexed.consumeResponse(bytes(`${ESC}]4;0;rgb:0000/0000/0000${ESC}\\`), GEOMETRY)
      .accepted,
    true,
  );

  const stacked = new TerminalQueryObserver();
  const stackedObservation = stacked.observeOutput(
    bytes(`${ESC}]10;?;?;?${ESC}\\`),
  );
  assert.deepEqual(
    stackedObservation.enqueued.map((query) => query.responseClass),
    ['osc_10', 'osc_11', 'osc_12'],
    'one stacked OSC query creates three independently consumable slot tokens',
  );
  for (const [command, color] of [
    [12, '1234/5678/9abc'],
    [10, 'ffff/ffff/ffff'],
    [11, '0000/0000/0000'],
  ] as const) {
    assert.equal(
      stacked.consumeResponse(bytes(`${ESC}]${command};rgb:${color}${ESC}\\`), GEOMETRY)
        .accepted,
      true,
    );
  }
  assert.equal(stacked.pending, 0);
});

test('OSC and DECRQM reject malformed dynamic query parameters without tokens', () => {
  const observer = new TerminalQueryObserver();
  for (const invalid of [
    `${ESC}]4;256;?\x07`,
    `${ESC}]4;1;not-query;2\x07`,
    `${ESC}]10;red;blue;green;?${ESC}\\`,
    `${ESC}]12;red;?${ESC}\\`,
    `${ESC}[1000000$p`,
    `${ESC}[?1000000;2$p`,
  ]) {
    observer.observeOutput(bytes(invalid));
  }
  assert.equal(observer.pending, 0);
});

test('window reports are profile-gated and validate geometry or bounded local pixels', () => {
  const disabled = new TerminalQueryObserver();
  disabled.observeOutput(bytes(`${ESC}[14t${ESC}[16t${ESC}[18t`));
  assert.equal(disabled.pending, 0);

  const enabled = new TerminalQueryObserver({ profile: enabledWindowProfile() });
  enabled.observeOutput(bytes(`${ESC}[014;2t${ESC}[014t${ESC}[0016;9t${ESC}[00018;9t`));
  assert.equal(enabled.pending, 3);
  assert.equal(
    enabled.consumeResponse(
      bytes(`${ESC}[4;${MAX_TERMINAL_PIXEL_DIMENSION};1t`),
      GEOMETRY,
    ).accepted,
    true,
  );
  assert.equal(enabled.consumeResponse(bytes(`${ESC}[6;1;1t`), GEOMETRY).accepted, true);
  assert.equal(enabled.consumeResponse(bytes(`${ESC}[8;23;80t`), GEOMETRY).accepted, false);
  assert.equal(enabled.consumeResponse(bytes(`${ESC}[8;24;80t`), GEOMETRY).accepted, true);
});

test('dynamic and cross-class mismatches do not consume a valid token', () => {
  const observer = new TerminalQueryObserver();
  observer.observeOutput(bytes(`${ESC}]4;7;?\x07${ESC}[5n`));
  assert.equal(observer.consumeResponse(bytes(`${ESC}[?1;2c`), GEOMETRY).accepted, false);
  assert.equal(
    observer.consumeResponse(bytes(`${ESC}]4;8;rgb:ffff/ffff/ffff${ESC}\\`), GEOMETRY)
      .accepted,
    false,
  );
  assert.equal(observer.pending, 2);
  assert.equal(observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, true);
  assert.equal(
    observer.consumeResponse(bytes(`${ESC}]4;7;rgb:ffff/ffff/ffff${ESC}\\`), GEOMETRY)
      .accepted,
    true,
  );
});

test('static grammar, status, slot, and pixel-boundary mismatches fail without consuming', () => {
  const staticResponses = new TerminalQueryObserver();
  staticResponses.observeOutput(bytes(`${ESC}[c${ESC}[5n`));
  assert.equal(staticResponses.consumeResponse(bytes(`${ESC}[?6c`), GEOMETRY).accepted, false);
  assert.equal(staticResponses.consumeResponse(bytes(`${ESC}[1n`), GEOMETRY).accepted, false);
  assert.equal(staticResponses.pending, 2);
  assert.equal(staticResponses.consumeResponse(bytes(`${ESC}[?1;2c`), GEOMETRY).accepted, true);
  assert.equal(staticResponses.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, true);

  const mode = new TerminalQueryObserver();
  mode.observeOutput(bytes(`${ESC}[4$p`));
  assert.equal(mode.consumeResponse(bytes(`${ESC}[4;5$y`), GEOMETRY).accepted, false);
  assert.equal(mode.pending, 1);
  assert.equal(mode.consumeResponse(bytes(`${ESC}[4;0$y`), GEOMETRY).accepted, true);

  const slot = new TerminalQueryObserver();
  slot.observeOutput(bytes(`${ESC}]10;?${ESC}\\`));
  assert.equal(
    slot.consumeResponse(bytes(`${ESC}]11;rgb:0000/0000/0000${ESC}\\`), GEOMETRY)
      .accepted,
    false,
  );
  assert.equal(slot.pending, 1);
  assert.equal(
    slot.consumeResponse(bytes(`${ESC}]10;rgb:0000/0000/0000${ESC}\\`), GEOMETRY)
      .accepted,
    true,
  );

  const pixels = new TerminalQueryObserver({ profile: enabledWindowProfile() });
  pixels.observeOutput(bytes(`${ESC}[14t`));
  assert.equal(pixels.consumeResponse(bytes(`${ESC}[4;0;1t`), GEOMETRY).accepted, false);
  assert.equal(
    pixels.consumeResponse(
      bytes(`${ESC}[4;${MAX_TERMINAL_PIXEL_DIMENSION + 1};1t`),
      GEOMETRY,
    ).accepted,
    false,
  );
  assert.equal(pixels.pending, 1);
  assert.equal(pixels.consumeResponse(bytes(`${ESC}[4;1;1t`), GEOMETRY).accepted, true);
});

test('query authorization exists before caller can deliver the trigger byte', () => {
  const observer = new TerminalQueryObserver();
  const query = bytes(`${ESC}[5n`);
  observer.observeOutput(query);
  // A same-call-stack xterm response can be consumed immediately after observation;
  // the caller has not yet made `query` eligible for WebSocket delivery here.
  assert.equal(observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, true);
});

test('response attempts are rate-limited with an inclusive window boundary', () => {
  let now = 0;
  const events: unknown[] = [];
  const observer = new TerminalQueryObserver({
    now: () => now,
    responseRateLimit: 2,
    responseRateWindowMs: 100,
    onResponseRateLimited: (event) => events.push(event),
  });
  observer.observeOutput(bytes(`${ESC}[5n${ESC}[5n${ESC}[5n`));
  assert.equal(observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, true);
  assert.equal(observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, true);
  const limited = observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY);
  assert.deepEqual(limited, { accepted: false, reason: 'rate_limited' });
  assert.equal(observer.pending, 1);
  assert.equal(events.length, 1);
  now = 100;
  assert.equal(observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, true);
});

test('concurrent responses consume once and write failure never restores the token', async () => {
  const observer = new TerminalQueryObserver();
  observer.observeOutput(bytes(`${ESC}[5n`));

  let releaseWrite: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let writes = 0;
  const first = observer.consumeAndWriteResponse(bytes(`${ESC}[0n`), GEOMETRY, async () => {
    writes += 1;
    await blocked;
  });
  const second = await observer.consumeAndWriteResponse(bytes(`${ESC}[0n`), GEOMETRY, () => {
    writes += 1;
  });
  assert.equal(second.accepted, false);
  assert.equal(writes, 1);
  releaseWrite?.();
  assert.equal((await first).accepted, true);

  observer.observeOutput(bytes(`${ESC}[5n`));
  const failed = await observer.consumeAndWriteResponse(bytes(`${ESC}[0n`), GEOMETRY, () => {
    throw new Error('provider write failed');
  });
  assert.equal(failed.accepted, false);
  if (failed.accepted) assert.fail('expected write failure');
  assert.equal(failed.reason, 'write_failed');
  assert.equal(failed.consumed, true);
  assert.equal(observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, false);
});

test('writer accounting consumes a token but never invokes or grants a write', () => {
  const observer = new TerminalQueryObserver({ responseRateLimit: 1 });
  observer.observeOutput(bytes(`${ESC}[5n`));
  assert.equal(observer.accountForWriterResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, true);
  assert.equal(observer.pending, 0);
  assert.equal(observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY).accepted, false);
});

test('writer mixed-burst accounting consumes prefix, suffix, and interstitial responses in order', () => {
  const observer = new TerminalQueryObserver({ responseRateLimit: 1 });
  observer.observeOutput(
    bytes(`${ESC}[5n${ESC}[>c${ESC}]10;?${ESC}\\${ESC}P$qm${ESC}\\`),
  );
  const status = bytes(`${ESC}[0n`);
  const secondary = bytes(`${ESC}[>0;276;0c`);
  const color = bytes(`${ESC}]10;rgb:ffff/ffff/ffff${ESC}\\`);
  const statusString = bytes(`${ESC}P1$r0m${ESC}\\`);
  const burst = join(
    bytes('human-prefix:'),
    status,
    bytes(':human-interstitial:'),
    secondary,
    bytes(':more-human:'),
    color,
    bytes(':dcs:'),
    statusString,
    bytes(':human-suffix'),
  );
  const original = Buffer.from(burst);

  const result = observer.accountForWriterBurst(burst, GEOMETRY);
  assert.equal(result.inspected, true);
  if (!result.inspected) assert.fail('expected the bounded burst to be inspected');
  assert.equal(result.candidateCount, 4);
  assert.deepEqual(
    result.consumed.map((entry) => entry.classification.responseClass),
    ['dsr_status', 'da2', 'osc_10', 'decrqss'],
  );
  assert.deepEqual(
    result.consumed.map((entry) => entry.byteOffset),
    [
      original.indexOf(status),
      original.indexOf(secondary),
      original.indexOf(color),
      original.indexOf(statusString),
    ],
  );
  assert.deepEqual(Buffer.from(burst), original, 'accounting never rewrites the original burst');
  assert.equal(observer.pending, 0);
});

test('writer mixed-burst accounting ignores pasted, nested, and incomplete pseudo responses', () => {
  const observer = new TerminalQueryObserver();
  observer.observeOutput(bytes(`${ESC}[5n${ESC}[5n`));
  const response = `${ESC}[0n`;

  for (const ambiguous of [
    `${ESC}[200~pasted-${response}-text${ESC}[201~`,
    `${ESC}]0;title-${response}\x07`,
    `${ESC}Pnot-a-response-${response}${ESC}\\`,
    `${ESC}[0${response}`,
    `${ESC}[0`,
  ]) {
    const result = observer.accountForWriterBurst(bytes(ambiguous), GEOMETRY);
    assert.equal(result.inspected, true);
    if (!result.inspected) assert.fail('expected the bounded burst to be inspected');
    assert.equal(result.candidateCount, 0, JSON.stringify(ambiguous));
    assert.equal(result.consumed.length, 0, JSON.stringify(ambiguous));
  }
  assert.equal(observer.pending, 2);

  const duplicateBurst = bytes(`a${response}b${response}c${response}`);
  const accounted = observer.accountForWriterBurst(duplicateBurst, GEOMETRY);
  assert.equal(accounted.inspected, true);
  if (!accounted.inspected) assert.fail('expected the bounded burst to be inspected');
  assert.equal(accounted.candidateCount, 3);
  assert.equal(accounted.consumed.length, 2, 'one live token is consumed per response at most');
  assert.equal(observer.pending, 0);
});

test('writer mixed-burst accounting is hard-bounded and cannot consume on refusal', () => {
  const observer = new TerminalQueryObserver();
  observer.observeOutput(bytes(`${ESC}[5n`));
  const oversized = Buffer.alloc(MAX_TERMINAL_INPUT_BYTES + 1, 0x61);
  const result = observer.accountForWriterBurst(oversized, GEOMETRY);
  assert.deepEqual(result, {
    inspected: false,
    reason: 'burst_too_large',
    candidateCount: 0,
    consumed: [],
  });
  assert.equal(observer.pending, 1);
});

test('a non-monotonic or non-finite clock closes the authorization state', () => {
  let now = 10;
  const observer = new TerminalQueryObserver({ now: () => now });
  observer.observeOutput(bytes(`${ESC}[5n`));
  now = 9;
  assert.deepEqual(observer.consumeResponse(bytes(`${ESC}[0n`), GEOMETRY), {
    accepted: false,
    reason: 'clock_invalid',
  });
  assert.equal(observer.isClosed, true);
  assert.equal(observer.pending, 0);

  const nonFinite = new TerminalQueryObserver({ now: () => Number.NaN });
  const observation = nonFinite.observeOutput(bytes(`${ESC}[5n`));
  assert.equal(observation.enqueued.length, 0);
  assert.equal(nonFinite.isClosed, true);

  const throwing = new TerminalQueryObserver({
    now: () => {
      throw new Error('clock unavailable');
    },
  });
  assert.doesNotThrow(() => throwing.observeOutput(bytes(`${ESC}[5n`)));
  assert.equal(throwing.isClosed, true);
});
