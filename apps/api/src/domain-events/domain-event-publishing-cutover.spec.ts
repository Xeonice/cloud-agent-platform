import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DOMAIN_EVENT_PUBLISHING_ENABLED_ENV,
  DOMAIN_EVENT_PUBLISHING_ESCAPE_HATCH_VALUES,
  EnvironmentDomainEventPublishingCutover,
  evaluateDomainEventPublishing,
  type DomainEventPublishingCutoverPort,
} from './domain-event-publishing-cutover.port';

/** dist/domain-events → apps/api/src/domain-events. */
const SOURCE_FILE = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'domain-events',
  'domain-event-publishing-cutover.port.ts',
);

function withCutoverEnvironment<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[DOMAIN_EVENT_PUBLISHING_ENABLED_ENV];
  try {
    if (value === undefined) {
      delete process.env[DOMAIN_EVENT_PUBLISHING_ENABLED_ENV];
    } else {
      process.env[DOMAIN_EVENT_PUBLISHING_ENABLED_ENV] = value;
    }
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[DOMAIN_EVENT_PUBLISHING_ENABLED_ENV];
    } else {
      process.env[DOMAIN_EVENT_PUBLISHING_ENABLED_ENV] = previous;
    }
  }
}

test('the decision is frozen at construction and never re-read', () => {
  withCutoverEnvironment('false', () => {
    const cutover: DomainEventPublishingCutoverPort =
      new EnvironmentDomainEventPublishingCutover();
    assert.equal(cutover.evaluate().enabled, false);

    process.env[DOMAIN_EVENT_PUBLISHING_ENABLED_ENV] = 'true';
    assert.equal(cutover.evaluate().enabled, false);
    assert.equal(cutover.evaluate().reason, 'escape-hatch');

    // The snapshot keeps no raw configuration to leak or to re-read.
    assert.deepEqual(Object.keys(cutover), []);
    assert.equal(JSON.stringify(cutover), '{}');
  });

  withCutoverEnvironment(undefined, () => {
    const cutover = new EnvironmentDomainEventPublishingCutover();
    process.env[DOMAIN_EVENT_PUBLISHING_ENABLED_ENV] = 'false';
    assert.equal(cutover.evaluate().enabled, true);
  });
});

test('an unset environment means publishing is on, by default', () => {
  const decision = evaluateDomainEventPublishing({});

  assert.equal(decision.enabled, true);
  assert.equal(decision.reason, 'default');
  assert.equal(decision.source, 'unset');

  withCutoverEnvironment(undefined, () => {
    assert.equal(new EnvironmentDomainEventPublishingCutover().evaluate().enabled, true);
  });
});

test('an unrecognised value cannot close a default-on toggle', () => {
  for (const value of ['', 'yes', 'no-thanks', 'disabled', '2']) {
    const decision = evaluateDomainEventPublishing({
      [DOMAIN_EVENT_PUBLISHING_ENABLED_ENV]: value,
    });
    assert.equal(decision.enabled, true, `value ${JSON.stringify(value)}`);
    assert.equal(decision.reason, 'default');
    assert.equal(decision.source, 'unrecognised-value');
  }
});

test('each escape-hatch value closes publishing and reports why it closed', () => {
  for (const declared of DOMAIN_EVENT_PUBLISHING_ESCAPE_HATCH_VALUES) {
    for (const value of [declared, declared.toUpperCase(), ` ${declared} `]) {
      const decision = evaluateDomainEventPublishing({
        [DOMAIN_EVENT_PUBLISHING_ENABLED_ENV]: value,
      });
      assert.equal(decision.enabled, false, `value ${JSON.stringify(value)}`);
      assert.equal(decision.reason, 'escape-hatch');
      assert.equal(decision.source, 'environment');
    }
  }
});

test('an explicit opt-in is recorded as such rather than as the default', () => {
  const decision = evaluateDomainEventPublishing({
    [DOMAIN_EVENT_PUBLISHING_ENABLED_ENV]: 'true',
  });

  assert.equal(decision.enabled, true);
  assert.equal(decision.reason, 'explicitly-enabled');
  assert.equal(decision.source, 'environment');
});

test('the decision is a full object, never a bare boolean', () => {
  const decision = evaluateDomainEventPublishing({
    [DOMAIN_EVENT_PUBLISHING_ENABLED_ENV]: '0',
  });

  assert.equal(typeof decision, 'object');
  assert.deepEqual(Object.keys(decision).sort(), ['enabled', 'reason', 'source']);
  assert.equal(typeof decision.reason, 'string');
  assert.equal(typeof decision.source, 'string');
});

test('the toggle consults no attestation, build identity, or signature', () => {
  const source = readFileSync(SOURCE_FILE, 'utf8');
  // The prose EXPLAINS why none of this is consulted (the task-model-selection
  // precedent), so the assertion is about code, not about the file's words.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '');

  for (const token of [
    'attestation',
    'Attestation',
    'buildIdentity',
    'BuildIdentity',
    'signature',
    'Signature',
    'GIT_SHA',
    'CAP_VERSION',
    'capability',
    'Capability',
  ]) {
    assert.equal(code.includes(token), false, `implementation references ${token}`);
  }

  // The only environment variable it reads is its own.
  const envReads = [...code.matchAll(/env\[([^\]]+)\]/gu)].map((match) => match[1]);
  assert.deepEqual(new Set(envReads), new Set(['DOMAIN_EVENT_PUBLISHING_ENABLED_ENV']));

  // An absent or expired attestation cannot leave it closed: an environment with
  // nothing in it at all still evaluates open.
  assert.equal(evaluateDomainEventPublishing({}).enabled, true);
});
