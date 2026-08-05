import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DOMAIN_EVENT_TYPES,
  type DomainEvent,
  type DomainEventType,
} from '@cap-console/contracts';

import {
  DOMAIN_EVENT_BUS,
  type DomainEventBusLogRecord,
  type DomainEventBusLogger,
  type DomainEventSubscriberRegistration,
} from './domain-event-bus.port';
import { DomainEventBusService } from './domain-event-bus.service';
import {
  DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS,
  domainEventBusBindings,
} from './domain-events.module';

/** dist/domain-events → apps/api/src/domain-events. */
const SOURCE_DIR = path.resolve(__dirname, '..', '..', 'src', 'domain-events');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * Records every call, and separately records any call the bus makes on a channel
 * other than `warn` — that is how "no logging at error level" is asserted rather
 * than assumed.
 */
class RecordingLogger implements DomainEventBusLogger {
  readonly records: DomainEventBusLogRecord[] = [];
  readonly offChannelCalls: string[] = [];

  warn(record: DomainEventBusLogRecord): void {
    this.records.push(record);
  }

  error(): void {
    this.offChannelCalls.push('error');
  }

  log(): void {
    this.offChannelCalls.push('log');
  }
}

function settledEvent(overrides: Record<string, unknown> = {}): DomainEvent {
  return {
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    type: 'task.settled',
    taskId: 'task-1',
    status: 'completed',
    ...overrides,
  } as unknown as DomainEvent;
}

function subscriber(
  name: string,
  handle: (event: DomainEvent) => void,
  eventType: DomainEventSubscriberRegistration['eventType'] = 'task.settled',
): DomainEventSubscriberRegistration {
  return { name, eventType, handle };
}

test('every subscriber runs, in registration order, before publish returns', () => {
  const trace: string[] = [];
  const bus = new DomainEventBusService(
    [
      subscriber('a', () => trace.push('a')),
      subscriber('b', () => trace.push('b')),
      subscriber('c', () => trace.push('c')),
    ],
    new RecordingLogger(),
  );

  bus.publish(settledEvent());
  trace.push('marker-after-publish');

  assert.deepEqual(trace, ['a', 'b', 'c', 'marker-after-publish']);
});

test('publishing with no subscribers is a silent no-op', () => {
  const logger = new RecordingLogger();
  const bus = new DomainEventBusService([], logger);

  assert.doesNotThrow(() => bus.publish(settledEvent()));
  assert.deepEqual(logger.records, []);
  assert.deepEqual(logger.offChannelCalls, []);
});

test('a throwing subscriber does not stop the ones registered after it', () => {
  const calls: string[] = [];
  const logger = new RecordingLogger();
  const bus = new DomainEventBusService(
    [
      subscriber('a', () => calls.push('a')),
      subscriber('b', () => {
        calls.push('b');
        throw new Error('boom');
      }),
      subscriber('c', () => calls.push('c')),
    ],
    logger,
  );

  assert.doesNotThrow(() => bus.publish(settledEvent()));

  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(calls.filter((name) => name === 'a').length, 1);
  assert.equal(calls.filter((name) => name === 'c').length, 1);
  assert.equal(logger.records.length, 1);
});

test('every subscriber failing still returns normally and the next statement runs', () => {
  const invoked: string[] = [];
  const bus = new DomainEventBusService(
    [
      subscriber('a', () => {
        invoked.push('a');
        throw new Error('a failed');
      }),
      subscriber('b', () => {
        invoked.push('b');
        throw new Error('b failed');
      }),
    ],
    new RecordingLogger(),
  );

  let publisherReachedNextStatement = false;
  bus.publish(settledEvent());
  publisherReachedNextStatement = true;

  assert.deepEqual(invoked, ['a', 'b']);
  assert.equal(publisherReachedNextStatement, true);
});

test('a subscriber throwing a non-Error value is isolated the same way', () => {
  for (const thrown of ['a string', undefined, { code: 42 }, null]) {
    const after: string[] = [];
    const logger = new RecordingLogger();
    const bus = new DomainEventBusService(
      [
        subscriber('thrower', () => {
          throw thrown;
        }),
        subscriber('after', () => after.push('after')),
      ],
      logger,
    );

    assert.doesNotThrow(() => bus.publish(settledEvent()));
    assert.deepEqual(after, ['after']);
    assert.equal(logger.records.length, 1);
    assert.equal(typeof logger.records[0]?.error, 'string');
  }
});

test('a swallowed failure produces one named record carrying the event type and message', () => {
  const logger = new RecordingLogger();
  const bus = new DomainEventBusService(
    [
      subscriber('metrics-projection', () => {
        throw new Error('boom');
      }),
    ],
    logger,
  );

  bus.publish(settledEvent());

  assert.equal(logger.records.length, 1);
  const record = logger.records[0];
  assert.equal(record?.event, 'domain_event.subscriber_failed');
  assert.equal(record?.eventType, 'task.settled');
  assert.equal(record?.subscriberName, 'metrics-projection');
  assert.equal(record?.error, 'boom');
  assert.equal(logger.offChannelCalls.length, 0);
});

test('two failing subscribers produce two distinguishable records', () => {
  const logger = new RecordingLogger();
  const bus = new DomainEventBusService(
    [
      subscriber('metrics-projection', () => {
        throw new Error('metrics boom');
      }),
      subscriber('transcript-collector', () => {
        throw new Error('transcript boom');
      }),
    ],
    logger,
  );

  bus.publish(settledEvent());

  assert.equal(logger.records.length, 2);
  assert.deepEqual(
    logger.records.map((record) => record.subscriberName),
    ['metrics-projection', 'transcript-collector'],
  );
  assert.deepEqual(
    logger.records.map((record) => record.error),
    ['metrics boom', 'transcript boom'],
  );
});

test('a registration without a name is rejected at construction, not at failure time', () => {
  for (const name of ['', '   ', undefined]) {
    assert.throws(
      () =>
        new DomainEventBusService(
          [
            {
              name,
              eventType: 'task.settled',
              handle: () => {},
            } as unknown as DomainEventSubscriberRegistration,
          ],
          new RecordingLogger(),
        ),
      /no name/,
    );
  }

  const bus = new DomainEventBusService([], new RecordingLogger());
  assert.throws(
    () => bus.subscribe(() => {}, { name: '', eventType: 'task.settled' }),
    /no name/,
  );
});

test('a handler absent from the subscriber array is never invoked', () => {
  const registered: string[] = [];
  const unregistered = (): void => {
    registered.push('unregistered-handler');
  };
  const bus = new DomainEventBusService(
    [subscriber('registered', () => registered.push('registered'))],
    new RecordingLogger(),
  );
  void unregistered;

  bus.publish(settledEvent());

  assert.deepEqual(registered, ['registered']);
});

test('a subscriber registered for another event type is not invoked', () => {
  const calls: string[] = [];
  const bus = new DomainEventBusService(
    [
      subscriber('settled-watcher', () => calls.push('settled'), 'task.settled'),
      subscriber('admitted-watcher', () => calls.push('admitted'), 'task.admitted'),
    ],
    new RecordingLogger(),
  );

  bus.publish(settledEvent());

  assert.deepEqual(calls, ['settled']);
});

test('this change registers zero subscribers', () => {
  assert.deepEqual([...DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS], []);
});

/**
 * THE declared subscriber set, per event type (adjudicate-audit-event-migration,
 * D7).
 *
 * Two independent forces keep this table honest about the catalog:
 * `Record<DomainEventType, …>` makes a sixth catalog entry a COMPILE error here,
 * and the runtime key-set assertion below repeats the demand for whoever only
 * runs the tests. Neither is a count or a subset check.
 *
 * Every set is empty on this tree. That is the recorded outcome of this change,
 * not an accident: the adjudicated guardrails audit references all resolved to
 * CALL or REMOVED and none to EVENT, so no published event produces any side
 * effect anywhere.
 */
const EXPECTED_SUBSCRIBERS: Record<DomainEventType, readonly string[]> = {
  'task.admitted': [],
  'sandbox.provisioned': [],
  'task.run_started': [],
  'task.settled': [],
  'task.superseded': [],
};

test('the expectation table has exactly one row per catalog event type', () => {
  const declared = Object.keys(EXPECTED_SUBSCRIBERS);
  const catalog: readonly string[] = DOMAIN_EVENT_TYPES;

  const withoutRow = catalog.filter((type) => !declared.includes(type)).sort();
  const strayRows = declared.filter((type) => !catalog.includes(type)).sort();

  assert.deepEqual(
    withoutRow,
    [],
    `event type(s) with no expected-subscriber row: ${withoutRow.join(', ')}`,
  );
  assert.deepEqual(
    strayRows,
    [],
    `expected-subscriber row(s) for unknown event type(s): ${strayRows.join(', ')}`,
  );
  assert.deepEqual([...declared].sort(), [...catalog].sort());
});

test('each event type registers exactly the declared subscriber set', () => {
  const catalog: readonly string[] = DOMAIN_EVENT_TYPES;

  // A registration carrying an off-catalog event type would otherwise be
  // invisible to the per-type comparison below, which only ever sees what the
  // filter lets through.
  const offCatalog = DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS.filter(
    (registration) => !catalog.includes(registration.eventType),
  )
    .map((registration) => `${registration.name}@${registration.eventType}`)
    .sort();
  assert.deepEqual(
    offCatalog,
    [],
    `registration(s) for unknown event type(s): ${offCatalog.join(', ')}`,
  );

  for (const eventType of DOMAIN_EVENT_TYPES) {
    const expected = new Set(EXPECTED_SUBSCRIBERS[eventType]);
    const observed = new Set(
      DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS.filter(
        (registration) => registration.eventType === eventType,
      ).map((registration) => registration.name),
    );

    const unexpected = [...observed].filter((name) => !expected.has(name)).sort();
    const missing = [...expected].filter((name) => !observed.has(name)).sort();

    assert.deepEqual(
      unexpected,
      [],
      `${eventType}: unexpected registered subscriber(s): ${unexpected.join(', ')}`,
    );
    assert.deepEqual(
      missing,
      [],
      `${eventType}: missing registered subscriber(s): ${missing.join(', ')}`,
    );
    // Set equality — an unlisted registration and a silently dropped one both
    // turn this red; a superset check would let the second one through.
    assert.deepEqual(
      [...observed].sort(),
      [...expected].sort(),
      `${eventType}: registered subscriber set mismatch`,
    );
  }
});

test('no catalog entry is named error', () => {
  assert.equal(
    DOMAIN_EVENT_TYPES.some((type) => type === ('error' as never)),
    false,
  );
  assert.equal(
    new Set(DOMAIN_EVENT_TYPES).size,
    DOMAIN_EVENT_TYPES.length,
  );
});

test('a failing publish triggers no process-level handler', async () => {
  const escaped: string[] = [];
  const onUncaught = (): void => {
    escaped.push('uncaughtException');
  };
  const onUnhandled = (): void => {
    escaped.push('unhandledRejection');
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  try {
    const bus = new DomainEventBusService(
      [
        subscriber('thrower', () => {
          throw new Error('boom');
        }),
      ],
      new RecordingLogger(),
    );
    bus.publish(settledEvent());
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(escaped, []);
});

test('an invalid payload is dropped before dispatch, logged once, and not thrown', () => {
  const invoked: string[] = [];
  const logger = new RecordingLogger();
  const bus = new DomainEventBusService(
    [subscriber('watcher', () => invoked.push('watcher'))],
    logger,
  );

  const withoutTaskId = settledEvent() as unknown as Record<string, unknown>;
  delete withoutTaskId.taskId;

  assert.doesNotThrow(() => bus.publish(withoutTaskId as unknown as DomainEvent));

  assert.deepEqual(invoked, []);
  assert.equal(logger.records.length, 1);
  assert.equal(logger.records[0]?.event, 'domain_event.invalid_payload');
  assert.equal(logger.records[0]?.eventType, 'task.settled');
  assert.equal(logger.offChannelCalls.length, 0);
});

test('an unknown event type is dropped rather than dispatched', () => {
  const invoked: string[] = [];
  const logger = new RecordingLogger();
  const bus = new DomainEventBusService(
    [subscriber('watcher', () => invoked.push('watcher'))],
    logger,
  );

  bus.publish(settledEvent({ type: 'task.invented' }));

  assert.deepEqual(invoked, []);
  assert.equal(logger.records.length, 1);
  assert.equal(logger.records[0]?.event, 'domain_event.invalid_payload');
});

test('a valid payload reaches its subscriber unchanged', () => {
  const seen: DomainEvent[] = [];
  const bus = new DomainEventBusService(
    [subscriber('watcher', (event) => seen.push(event))],
    new RecordingLogger(),
  );
  const event = settledEvent();

  bus.publish(event);

  assert.equal(seen.length, 1);
  assert.equal(seen[0], event);
});

test('the closed cutover decision leaves the bus provider unbound', () => {
  const open = domainEventBusBindings({
    enabled: true,
    reason: 'default',
    source: 'unset',
  });
  const closed = domainEventBusBindings({
    enabled: false,
    reason: 'escape-hatch',
    source: 'environment',
  });

  const provides = (bindings: { providers: unknown[] }): unknown[] =>
    bindings.providers.map((provider) =>
      provider !== null && typeof provider === 'object' && 'provide' in provider
        ? (provider as { provide: unknown }).provide
        : provider,
    );

  assert.equal(provides(open).includes(DOMAIN_EVENT_BUS), true);
  assert.equal(open.providers.includes(DomainEventBusService), true);
  assert.equal(open.exports.includes(DOMAIN_EVENT_BUS), true);

  assert.equal(provides(closed).includes(DOMAIN_EVENT_BUS), false);
  assert.equal(closed.providers.includes(DomainEventBusService), false);
  assert.equal(closed.exports.includes(DOMAIN_EVENT_BUS), false);
});

test('the bus introduces no runtime subscriber discovery and no event framework', () => {
  const forbidden = [
    'DiscoveryService',
    'MetadataScanner',
    '@nestjs/cqrs',
    '@nestjs/event-emitter',
    'EventEmitter',
  ];
  const implementationFiles = [
    'domain-event-bus.port.ts',
    'domain-event-bus.service.ts',
    'domain-event-publishing-cutover.port.ts',
    'domain-events.module.ts',
  ];

  // (1) No TypeScript file this change adds — implementation, spec or fixture —
  //     imports any of them. Markdown is excluded on purpose: the directory's
  //     declaration has to be able to NAME the mechanisms it rejects.
  for (const file of readdirSync(SOURCE_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(SOURCE_DIR, file), 'utf8');
    const imports = [
      ...source.matchAll(/(?:^|\n)\s*import[^'";]*from\s*'([^']+)'/gu),
      ...source.matchAll(/require\(\s*'([^']+)'/gu),
    ].map((match) => match[1]);

    for (const specifier of imports) {
      assert.equal(
        specifier === '@nestjs/cqrs' || specifier === '@nestjs/event-emitter',
        false,
        `${file} imports ${specifier}`,
      );
    }
    for (const symbol of ['DiscoveryService', 'MetadataScanner']) {
      const importedSymbol = new RegExp(
        `import[^'";]*\\b${symbol}\\b[^'";]*from`,
        'u',
      );
      assert.equal(importedSymbol.test(source), false, `${file} imports ${symbol}`);
    }
  }

  // (2) The implementation files do not so much as mention them in code. The
  //     port and README explain WHY `EventEmitter` is not used, so comments are
  //     stripped before this stronger check.
  for (const file of implementationFiles) {
    const source = readFileSync(path.join(SOURCE_DIR, file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
    for (const token of forbidden) {
      assert.equal(
        code.includes(token),
        false,
        `${file} must not reference ${token}`,
      );
    }
  }

  // (3) Neither package is a dependency anywhere.
  for (const manifest of ['package.json', path.join('apps', 'api', 'package.json')]) {
    const source = readFileSync(path.join(REPO_ROOT, manifest), 'utf8');
    assert.equal(source.includes('@nestjs/cqrs'), false, `${manifest}`);
    assert.equal(source.includes('@nestjs/event-emitter'), false, `${manifest}`);
  }
});

test('the bus implementation reaches nothing but Nest, the catalog, and its own port', () => {
  const source = readFileSync(
    path.join(SOURCE_DIR, 'domain-event-bus.service.ts'),
    'utf8',
  );
  const specifiers = [
    ...source.matchAll(/(?:^|\n)\s*import[^'";]*from\s*'([^']+)'/gu),
  ].map((match) => match[1]);

  assert.deepEqual(new Set(specifiers), new Set([
    '@nestjs/common',
    '@cap-console/contracts',
    './domain-event-bus.port',
  ]));
});
