import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  DOMAIN_EVENT_SCHEMAS,
  DOMAIN_EVENT_TYPES,
  DomainEventEnvelopeSchema,
  DomainEventProviderFamilySchema,
  DomainEventSchema,
  SandboxProvisionedEventSchema,
  TaskAdmittedEventSchema,
  TaskRunStartedEventSchema,
  TaskSettledEventSchema,
  TaskSupersededEventSchema,
} from '../dist/domain-event.js';
import { SANDBOX_PROVIDER_FAMILIES } from '../dist/provider-family.js';

/**
 * One valid event per catalogued type, built the way a publish point builds one:
 * a freshly minted envelope plus that event's own fields.
 */
const buildEvent = {
  'task.admitted': (overrides = {}) => ({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    type: 'task.admitted',
    taskId: 'task-1',
    admissionMode: 'durable',
    outcome: 'running',
    fenceToken: 'transition-token-1',
    ...overrides,
  }),
  'sandbox.provisioned': (overrides = {}) => ({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    type: 'sandbox.provisioned',
    taskId: 'task-1',
    admissionMode: 'durable',
    providerFamily: SANDBOX_PROVIDER_FAMILIES[0],
    sandbox: {
      baseUrl: 'http://sandbox.internal:8080',
      wsUrl: 'ws://sandbox.internal:8080/ws',
      providerId: 'provider-1',
      providerSandboxId: 'sbx-1',
    },
    environment: {
      runtimeId: 'codex',
      executionMode: 'interactive-pty',
      environmentId: 'env-1',
      sourceKind: 'docker-image',
      sourceRef: 'registry/image:tag',
      digest: 'sha256:abc',
      checksum: 'sha256:def',
    },
    ...overrides,
  }),
  'task.run_started': (overrides = {}) => ({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    type: 'task.run_started',
    taskId: 'task-1',
    startPoint: 'durable_arm',
    admissionMode: 'durable',
    ...overrides,
  }),
  'task.settled': (overrides = {}) => ({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    type: 'task.settled',
    taskId: 'task-1',
    status: 'completed',
    ...overrides,
  }),
  'task.superseded': (overrides = {}) => ({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    type: 'task.superseded',
    taskId: 'task-1',
    observationPoint: 'durable_capacity_reservation',
    fenceToken: 'loser-transition-token',
    observedStatus: 'running',
    ...overrides,
  }),
};

test('the catalog declares exactly five unique event types, none of them error', () => {
  assert.equal(DOMAIN_EVENT_TYPES.length, 5);
  assert.equal(new Set(DOMAIN_EVENT_TYPES).size, 5);
  for (const type of DOMAIN_EVENT_TYPES) {
    assert.notEqual(type, 'error');
  }
  // The type→schema map is total over the declaration and adds nothing to it,
  // so no second list of event names can exist behind it.
  assert.deepEqual(Object.keys(DOMAIN_EVENT_SCHEMAS).sort(), [...DOMAIN_EVENT_TYPES].sort());
  assert.deepEqual(Object.keys(buildEvent).sort(), [...DOMAIN_EVENT_TYPES].sort());
});

test('every catalogued type maps to the schema that owns that discriminant', () => {
  for (const type of DOMAIN_EVENT_TYPES) {
    const parsed = DOMAIN_EVENT_SCHEMAS[type].parse(buildEvent[type]());
    assert.equal(parsed.type, type);
    // Parsing through the union routes to the same schema: that is what makes a
    // single `DomainEventSchema.parse()` inside publish "the event's own schema".
    assert.equal(DomainEventSchema.parse(buildEvent[type]()).type, type);
  }
});

test('an event missing an envelope field is rejected', () => {
  for (const type of DOMAIN_EVENT_TYPES) {
    for (const field of ['eventId', 'occurredAt', 'taskId']) {
      const event = buildEvent[type]();
      delete event[field];
      assert.equal(
        DOMAIN_EVENT_SCHEMAS[type].safeParse(event).success,
        false,
        `${type} accepted a payload with no ${field}`,
      );
      assert.equal(DomainEventSchema.safeParse(event).success, false);
    }
  }
});

test('the envelope pins uuid event ids and UTC ISO-8601 timestamps', () => {
  assert.equal(
    DomainEventEnvelopeSchema.safeParse({
      eventId: 'not-a-uuid',
      occurredAt: new Date().toISOString(),
      type: 'task.settled',
      taskId: 'task-1',
    }).success,
    false,
  );
  assert.equal(
    DomainEventEnvelopeSchema.safeParse({
      eventId: randomUUID(),
      occurredAt: '2026-07-31T10:00:00+08:00',
      type: 'task.settled',
      taskId: 'task-1',
    }).success,
    false,
    'a non-UTC offset timestamp was accepted',
  );
  assert.equal(
    DomainEventEnvelopeSchema.safeParse({
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      type: 'task.exploded',
      taskId: 'task-1',
    }).success,
    false,
    'an uncatalogued event type was accepted',
  );
});

test('two publishes from one publish point differ in event id and share the type', () => {
  const first = TaskSettledEventSchema.parse(buildEvent['task.settled']());
  const second = TaskSettledEventSchema.parse(buildEvent['task.settled']());
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(first.type, second.type);
  assert.equal(first.taskId, second.taskId);
});

test('unknown fields are tolerated: no schema in the catalog is strict', () => {
  for (const type of DOMAIN_EVENT_TYPES) {
    const result = DOMAIN_EVENT_SCHEMAS[type].safeParse(
      buildEvent[type]({ fieldFromAFutureProducer: 'ignored' }),
    );
    assert.equal(result.success, true, `${type} rejected an unknown field`);
  }
});

test('provider family derives from the single declaration', () => {
  // The accepted members are computed FROM `SANDBOX_PROVIDER_FAMILIES`, so a
  // member appended there is accepted with zero edits to the event schema.
  assert.deepEqual(
    DomainEventProviderFamilySchema.options,
    [...SANDBOX_PROVIDER_FAMILIES, 'unknown'],
  );
  for (const family of SANDBOX_PROVIDER_FAMILIES) {
    assert.equal(
      SandboxProvisionedEventSchema.safeParse(
        buildEvent['sandbox.provisioned']({ providerFamily: family }),
      ).success,
      true,
      `provider family ${family} was rejected`,
    );
  }
  assert.equal(
    SandboxProvisionedEventSchema.safeParse(
      buildEvent['sandbox.provisioned']({ providerFamily: 'not-a-family' }),
    ).success,
    false,
  );
});

test('a live reference in place of a declared primitive is rejected', () => {
  class FakeConnection {
    constructor() {
      this.socket = { write() {} };
    }
  }

  const liveValues = [
    () => 'a callback',
    new FakeConnection(),
    { write() {} },
  ];

  for (const live of liveValues) {
    assert.equal(
      TaskSettledEventSchema.safeParse(buildEvent['task.settled']({ taskId: live })).success,
      false,
      'a live reference was accepted as taskId',
    );
    assert.equal(
      SandboxProvisionedEventSchema.safeParse(
        buildEvent['sandbox.provisioned']({
          sandbox: {
            baseUrl: live,
            wsUrl: 'ws://sandbox.internal:8080/ws',
          },
        }),
      ).success,
      false,
      'a live reference was accepted as a sandbox reference field',
    );
    assert.equal(
      TaskAdmittedEventSchema.safeParse(
        buildEvent['task.admitted']({ fenceToken: live }),
      ).success,
      false,
      'a live reference was accepted as a fence token',
    );
  }
});

test('SandboxProvisioned carries enough to record provisioning without a call back', () => {
  const parsed = SandboxProvisionedEventSchema.parse(buildEvent['sandbox.provisioned']());
  assert.equal(parsed.taskId, 'task-1');
  assert.equal(parsed.sandbox.baseUrl, 'http://sandbox.internal:8080');
  assert.equal(parsed.sandbox.wsUrl, 'ws://sandbox.internal:8080/ws');
  assert.equal(parsed.sandbox.providerId, 'provider-1');
  assert.equal(parsed.providerFamily, SANDBOX_PROVIDER_FAMILIES[0]);
  assert.equal(parsed.environment.runtimeId, 'codex');
  assert.equal(parsed.environment.executionMode, 'interactive-pty');
  assert.equal(parsed.environment.environmentId, 'env-1');
  // Every value it carries is a primitive or a plain object of primitives.
  for (const value of [parsed.sandbox, parsed.environment]) {
    for (const field of Object.values(value)) {
      assert.equal(typeof field, 'string');
    }
  }
});

test('admission events carry the transition token and an explicit admission mode', () => {
  const parsed = TaskAdmittedEventSchema.parse(
    buildEvent['task.admitted']({ admissionMode: 'durable' }),
  );
  assert.equal(parsed.admissionMode, 'durable');
  assert.equal(parsed.fenceToken, 'transition-token-1');
  // The retired admission path is rejected, not silently accepted: this catalog
  // derives from the narrowed diagnostics vocabulary, so a subscriber can never
  // be handed a mode the read path would refuse.
  assert.equal(
    TaskAdmittedEventSchema.safeParse(
      buildEvent['task.admitted']({ admissionMode: 'legacy' }),
    ).success,
    false,
  );
  // The discriminant is required: a subscriber never infers the path from the
  // token's shape.
  const withoutMode = buildEvent['task.admitted']();
  delete withoutMode.admissionMode;
  assert.equal(TaskAdmittedEventSchema.safeParse(withoutMode).success, false);
  // Admission outcomes narrow to the two committed ones.
  assert.equal(
    TaskAdmittedEventSchema.safeParse(buildEvent['task.admitted']({ outcome: 'queued' })).success,
    true,
  );
  for (const outcome of ['superseded', 'completed', 'pending']) {
    assert.equal(
      TaskAdmittedEventSchema.safeParse(buildEvent['task.admitted']({ outcome })).success,
      false,
      `admission outcome ${outcome} was accepted`,
    );
  }
});

test('TaskRunStarted names its start point and leaves admission mode optional', () => {
  const readopted = buildEvent['task.run_started']({ startPoint: 'readoption' });
  delete readopted.admissionMode;
  assert.equal(TaskRunStartedEventSchema.parse(readopted).startPoint, 'readoption');
  for (const startPoint of ['legacy_capacity', 'durable_arm']) {
    assert.equal(
      TaskRunStartedEventSchema.safeParse(
        buildEvent['task.run_started']({ startPoint }),
      ).success,
      true,
    );
  }
  const withoutStartPoint = buildEvent['task.run_started']();
  delete withoutStartPoint.startPoint;
  assert.equal(TaskRunStartedEventSchema.safeParse(withoutStartPoint).success, false);
});

test('TaskSettled carries a terminal status and rejects a non-terminal one', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'agent_failed_to_start']) {
    assert.equal(
      TaskSettledEventSchema.parse(buildEvent['task.settled']({ status })).status,
      status,
    );
  }
  for (const status of ['running', 'queued', 'pending', 'awaiting_input']) {
    assert.equal(
      TaskSettledEventSchema.safeParse(buildEvent['task.settled']({ status })).success,
      false,
      `non-terminal status ${status} was accepted as a settlement`,
    );
  }
});

test('TaskSuperseded reports only what the observer holds, and no superseder', () => {
  const fields = Object.keys(TaskSupersededEventSchema.shape);
  for (const field of fields) {
    assert.equal(
      /superseded_?by|supersededBy|superseder|winner|victor|replaced_?by/iu.test(field),
      false,
      `TaskSuperseded declares a superseder-identity field: ${field}`,
    );
  }
  assert.deepEqual(
    fields.sort(),
    [
      'eventId',
      'fenceToken',
      'observationPoint',
      'observedStatus',
      'occurredAt',
      'taskId',
      'type',
    ].sort(),
  );

  // It parses with nothing but the observer's own facts.
  const minimal = buildEvent['task.superseded']();
  delete minimal.fenceToken;
  delete minimal.observedStatus;
  const parsed = TaskSupersededEventSchema.parse(minimal);
  assert.equal(parsed.taskId, 'task-1');
  assert.equal(parsed.observationPoint, 'durable_capacity_reservation');

  const withToken = TaskSupersededEventSchema.parse(buildEvent['task.superseded']());
  assert.equal(withToken.fenceToken, 'loser-transition-token');
  assert.equal(withToken.observedStatus, 'running');

  const withoutObservationPoint = buildEvent['task.superseded']();
  delete withoutObservationPoint.observationPoint;
  assert.equal(
    TaskSupersededEventSchema.safeParse(withoutObservationPoint).success,
    false,
  );
});
