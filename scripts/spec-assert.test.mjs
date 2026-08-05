import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPECT_KINDS, parseAssertions, runAssertions } from './spec-assert.mjs';

const REQ_A = 'cap/requirement-a';
const REQ_B = 'cap/requirement-b';

function doc(assertions) {
  return { version: 1, change: 'fixture', assertions };
}

/** A runner that answers from a table keyed by the joined argv. */
function fakeRunner(table) {
  return (argv) => {
    const key = argv.join(' ');
    if (!(key in table)) throw new Error(`fixture has no answer for: ${key}`);
    return table[key];
  };
}

test('a malformed document fails loudly rather than deciding nothing', () => {
  assert.throws(() => parseAssertions('not json'), /not valid JSON/);
  assert.throws(() => parseAssertions('{"version":2,"assertions":[]}'), /unsupported version/);
  assert.throws(() => parseAssertions('{"version":1}'), /"assertions" must be an array/);
});

test('every assertion must name at least one requirement', () => {
  assert.throws(
    () => parseAssertions(JSON.stringify(doc([{ id: 'x', requirements: [], run: ['true'], expect: { exitCode: 0 } }]))),
    /must name at least one requirement id/,
  );
});

test('run must be a non-empty argv array, so no assertion can smuggle in a shell string', () => {
  assert.throws(
    () =>
      parseAssertions(
        JSON.stringify(doc([{ id: 'x', requirements: [REQ_A], run: 'grep -r foo | wc -l', expect: { exitCode: 0 } }])),
      ),
    /needs "run" as a non-empty argv array/,
  );
});

test('exactly one expect kind is allowed — zero or two is a defect', () => {
  for (const expect of [{}, { exitCode: 0, stdoutEquals: '0' }]) {
    assert.throws(
      () => parseAssertions(JSON.stringify(doc([{ id: 'x', requirements: [REQ_A], run: ['true'], expect }]))),
      /must declare exactly one of/,
    );
  }
  assert.equal(EXPECT_KINDS.length, 4);
});

test('duplicate assertion ids are rejected', () => {
  const entry = { id: 'dup', requirements: [REQ_A], run: ['true'], expect: { exitCode: 0 } };
  assert.throws(() => parseAssertions(JSON.stringify(doc([entry, { ...entry }]))), /duplicates id "dup"/);
});

test('each expect kind decides correctly in both directions', () => {
  const parsed = parseAssertions(
    JSON.stringify(
      doc([
        { id: 'code-ok', requirements: [REQ_A], run: ['gate'], expect: { exitCode: 0 } },
        { id: 'code-bad', requirements: [REQ_A], run: ['gate-red'], expect: { exitCode: 0 } },
        { id: 'eq-ok', requirements: [REQ_A], run: ['count'], expect: { stdoutEquals: '5' } },
        { id: 'eq-bad', requirements: [REQ_A], run: ['count'], expect: { stdoutEquals: '6' } },
        { id: 'match-ok', requirements: [REQ_A], run: ['banner'], expect: { stdoutMatches: '^R11 ' } },
        { id: 'absent-ok', requirements: [REQ_A], run: ['grepper-empty'], expect: { stdoutAbsent: 'runnerMinuteIntervals' } },
        { id: 'absent-bad', requirements: [REQ_A], run: ['grepper-hit'], expect: { stdoutAbsent: 'runnerMinuteIntervals' } },
      ]),
    ),
  );
  const report = runAssertions(parsed, {
    runner: fakeRunner({
      gate: { status: 0, stdout: '' },
      'gate-red': { status: 1, stdout: '' },
      count: { status: 0, stdout: '5\n' },
      banner: { status: 0, stdout: 'R11 dependency budget\n' },
      'grepper-empty': { status: 1, stdout: '' },
      'grepper-hit': { status: 0, stdout: 'a.ts:1 runnerMinuteIntervals()\n' },
    }),
  });
  const byId = Object.fromEntries(report.assertions.map((r) => [r.id, r.passed]));
  assert.deepEqual(byId, {
    'code-ok': true,
    'code-bad': false,
    'eq-ok': true,
    'eq-bad': false,
    'match-ok': true,
    'absent-ok': true,
    'absent-bad': false,
  });
});

test('a requirement is decided only when EVERY assertion naming it passes', () => {
  const parsed = parseAssertions(
    JSON.stringify(
      doc([
        { id: 'a1', requirements: [REQ_A, REQ_B], run: ['ok'], expect: { exitCode: 0 } },
        { id: 'a2', requirements: [REQ_A], run: ['red'], expect: { exitCode: 0 } },
      ]),
    ),
  );
  const report = runAssertions(parsed, {
    runner: fakeRunner({ ok: { status: 0, stdout: '' }, red: { status: 1, stdout: '' } }),
  });
  // REQ_A has one green and one red assertion -> NOT decided. REQ_B's only assertion is green -> decided.
  assert.deepEqual(report.decidedRequirements, [REQ_B]);
  assert.deepEqual(report.failed, ['a2']);
  assert.equal(report.passed, false);
});

test('a requirement nobody asserts is never reported as decided', () => {
  const parsed = parseAssertions(
    JSON.stringify(doc([{ id: 'a1', requirements: [REQ_A], run: ['ok'], expect: { exitCode: 0 } }])),
  );
  const report = runAssertions(parsed, { runner: fakeRunner({ ok: { status: 0, stdout: '' } }) });
  assert.deepEqual(report.decidedRequirements, [REQ_A]);
  assert.ok(!report.decidedRequirements.includes(REQ_B));
  // This is the safety property: an unasserted requirement costs LLM budget, never a false green.
});

test('an empty assertion set passes but decides nothing', () => {
  const report = runAssertions(parseAssertions(JSON.stringify(doc([]))), { runner: fakeRunner({}) });
  assert.equal(report.passed, true);
  assert.deepEqual(report.decidedRequirements, []);
});
