/**
 * Guards the R11 guardrails dependency-budget ratchet.
 *
 * Both red paths are proven by INJECTION PROBES against a throwaway copy of the
 * real `guardrails.service.ts` in a temp dir — the committed baseline
 * (`scripts/ratchets/r11.json`) and the real source are never written to, so a
 * probe can never become the tree's verdict:
 *
 *   - one extra call to a budgeted collaborator injected → red, NAMING the
 *     collaborator whose count rose;
 *   - one call site removed WITHOUT the baseline shrinking in the same commit →
 *     equally red, as a stale entry (this is the direction a "current count"
 *     report would let through, and it is how a fixed violation regrows).
 *
 * Plus the endgame invariant a burned-down ratchet lives or dies by: an entry
 * deleted from the baseline is STILL measured, so a re-introduced call site is
 * red rather than unmeasured.
 *
 * Run: node --test scripts/ratchets/r11-dependency-budget.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_REL,
  COLLABORATORS,
  KEY_PREFIX,
  SOURCE_REL,
  entryKey,
  measureSource,
  runGate,
} from './r11-dependency-budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

const REAL_SOURCE = readFileSync(join(REPO_ROOT, SOURCE_REL), 'utf8');
const REAL_BASELINE = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_REL), 'utf8'));

/**
 * Materialises a fixture tree holding the given source text at the governed
 * path plus a baseline file, and runs the real gate over it.
 */
function gate(source, baseline) {
  const root = mkdtempSync(join(tmpdir(), 'r11-dependency-budget-'));
  try {
    const abs = join(root, SOURCE_REL);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
    let baselinePath = join(root, 'no-such-baseline.json');
    if (baseline !== undefined) {
      baselinePath = join(root, 'fixture-baseline.json');
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
    }
    return runGate({ root, baselinePath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- the live seed
test('the committed baseline equals a live re-count of the real tree', () => {
  const result = runGate({});
  assert.deepEqual(result.problems, []);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.measured, {
    [entryKey('this.audit')]: 9,
    // Two decreases, each of them a real deletion. extract-runner-minutes-ledger
    // took 6 → 5 by deleting the read face (`runnerMinuteIntervals()`); the
    // legacy-admission retirement took 5 → 4 by deleting the `recordStart` that
    // lived inside the retired running continuation. The four surviving write
    // references sit on the durable-admission, terminal and re-adoption seams and
    // are retained by design, so 0 is not available.
    [entryKey('this.runnerMinutes')]: 4,
    // collapse-three-collaborator-groups: three floors, three causes. The two
    // diagnostics entries stop at 2 apiece because the constructor parameter and
    // the orchestrator's SINGLE read of the pair both survive. That read once fed
    // two consumers; the retirement removed one of them and the read stayed with
    // the durable diagnostics owner, so this floor is UNMOVED at 2 apiece rather
    // than falling — the prediction that it would fall was wrong and is corrected
    // by this measurement. Transcripts stops at 1 because the surviving reference
    // is the AWAITED capture that carries a happens-before, not a call anyone may
    // delete. Only metrics-projection did NOT reach zero: the port extraction
    // renamed its symbol (`SemaphoreProjectionSource` -> `CapacityProjectionPort`)
    // while the orchestrator kept naming it twice, so the entry follows the
    // collaborator rather than the string and stays at 2.
    [entryKey('provisioningDiagnosticRecorder')]: 2,
    [entryKey('provisioningDiagnosticWriteGate')]: 2,
    [entryKey('this.transcripts')]: 1,
    [entryKey('metrics-projection')]: 2,
  });
});

test('the baseline seeds exactly the six declared collaborators, and every key carries the counting convention', () => {
  assert.equal(COLLABORATORS.length, 6);
  assert.deepEqual(
    Object.keys(REAL_BASELINE).sort(),
    COLLABORATORS.map((c) => entryKey(c.collaborator)).sort(),
  );
  for (const key of Object.keys(REAL_BASELINE)) {
    assert.ok(
      key.startsWith(`${KEY_PREFIX}:`),
      `${key} must carry the counting convention in its key — a reader of the baseline alone must not read it as a call-site count`,
    );
    assert.match(REAL_BASELINE[key].change, /阶段 4/);
  }
});

// --------------------------------------------------------- injection probe 1
test('probe: one extra call to a budgeted collaborator turns the ratchet red and names it', () => {
  const injected = `${REAL_SOURCE}
class R11ProbeExtraAuditCall {
  private readonly audit?: { recordExited(id: string): void };
  probe(taskId: string) {
    this.audit?.recordExited(taskId);
  }
}
`;
  const before = measureSource(REAL_SOURCE)?.measured[entryKey('this.audit')];
  const after = measureSource(injected)?.measured[entryKey('this.audit')];
  assert.equal(after, before + 1, 'the probe must inject exactly one extra reference');

  const red = gate(injected, REAL_BASELINE);
  assert.equal(red.exitCode, 1);
  const said = red.problems.join('\n');
  assert.match(said, new RegExp(`${KEY_PREFIX}:this\\.audit`));
  assert.match(said, new RegExp(`measured ${after} exceeds the baselined ${before}`));
  // Only the collaborator that rose is named — the other four stay quiet.
  assert.equal(said.includes('this.transcripts'), false);
});

// --------------------------------------------------------- injection probe 2
test('probe: removing a call site without shrinking the baseline in the same commit is red', () => {
  // The old anchor was the presence guard beside the capture call, which
  // collapse-three-collaborator-groups deleted — that removal is exactly what
  // took this entry from 2 to 1. The anchor is re-derived onto the reference
  // that SURVIVED, so the probe keeps removing a real one.
  const anchor = 'await this.transcripts.capture(taskId);';
  assert.ok(REAL_SOURCE.includes(anchor), 'probe anchor drifted — re-derive it before trusting this test');
  const shrunk = REAL_SOURCE.replace(anchor, 'await Promise.resolve();');
  const before = measureSource(REAL_SOURCE).measured[entryKey('this.transcripts')];
  const after = measureSource(shrunk).measured[entryKey('this.transcripts')];
  assert.equal(after, before - 1, 'the probe must remove exactly one reference');

  const red = gate(shrunk, REAL_BASELINE);
  assert.equal(red.exitCode, 1);
  const said = red.problems.join('\n');
  assert.match(said, new RegExp(`${KEY_PREFIX}:this\\.transcripts`));
  assert.match(said, /stale entry/);
  // At a floor of 1 the removal empties the entry, so the comparator asks for
  // the ENTRY to be deleted rather than for a smaller count. Both wordings are
  // the same verdict: a removal that does not travel with its baseline edit.
  assert.equal(after, 0);
  assert.match(said, /delete the entry in the same PR as the fix/);
});

// ---------------------------------------------------------------- the endgame
test('a collaborator burned to zero keeps being measured after its entry is deleted', () => {
  const withoutTranscripts = { ...REAL_BASELINE };
  delete withoutTranscripts[entryKey('this.transcripts')];

  // Entry gone AND the references gone: green, which is what "burned down"
  // means — the entry is deleted in the same commit as the removal.
  const burned = REAL_SOURCE.replaceAll('this.transcripts', 'this.transcriptsRemoved');
  const green = gate(burned, withoutTranscripts);
  assert.deepEqual(green.problems, []);
  assert.equal(green.exitCode, 0);

  // Entry gone but the references BACK: red, not silently unmeasured.
  const regrown = gate(REAL_SOURCE, withoutTranscripts);
  assert.equal(regrown.exitCode, 1);
  assert.match(
    regrown.problems.join('\n'),
    new RegExp(`${KEY_PREFIX}:this\\.transcripts: 1 measured violation\\(s\\) with no baseline entry`),
  );
});

// ------------------------------------------------------------- fail-closed
test('a missing governed source is a failure, never a zero budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'r11-missing-'));
  try {
    const result = runGate({ root, baselinePath: join(root, 'nope.json') });
    assert.equal(result.exitCode, 1);
    assert.match(result.problems.join('\n'), /the governed source is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty governed source is a failure too — an empty measurement is not zero debt', () => {
  const result = gate('   \n', REAL_BASELINE);
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join('\n'), /the governed source is empty/);
});

test('references with no baseline file at all are red', () => {
  const result = gate(REAL_SOURCE);
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join('\n'), /no baseline file/);
});

test("an entry's symbol documentation may not drift from the gate's declaration", () => {
  const drifted = JSON.parse(JSON.stringify(REAL_BASELINE));
  drifted[entryKey('provisioningDiagnosticRecorder')].symbol = 'SomethingElse';
  const result = gate(REAL_SOURCE, drifted);
  assert.equal(result.exitCode, 1);
  assert.match(result.problems.join('\n'), /must not drift from the declaration/);
});

// ------------------------------------------------ single declaration & seams
test('baseline handling is the shared comparator, imported, with no second implementation', () => {
  const source = readFileSync(join(HERE, 'r11-dependency-budget.mjs'), 'utf8');
  assert.match(source, /import \{[^}]*compareToBaseline[^}]*\} from '\.\/comparator\.mjs'/);
  assert.equal(
    /function\s+\w*[Cc]ompareToBaseline/.test(source),
    false,
    'the comparison semantics have one implementation — scripts/ratchets/comparator.mjs',
  );
});

test('the committed baseline this gate owns is named, and fixtures never touch it', () => {
  assert.equal(BASELINE_REL, 'scripts/ratchets/r11.json');
  assert.equal(SOURCE_REL, 'apps/api/src/guardrails/guardrails.service.ts');
  const baselineBefore = readFileSync(join(REPO_ROOT, BASELINE_REL), 'utf8');
  const sourceBefore = readFileSync(join(REPO_ROOT, SOURCE_REL), 'utf8');
  gate(`${REAL_SOURCE}\n// this.audit\n`, REAL_BASELINE);
  assert.equal(readFileSync(join(REPO_ROOT, BASELINE_REL), 'utf8'), baselineBefore);
  assert.equal(readFileSync(join(REPO_ROOT, SOURCE_REL), 'utf8'), sourceBefore);
});

test('the gate is mounted: a root script runs it paired with this self-test', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const script = Object.values(pkg.scripts).find((value) =>
    value.includes('scripts/ratchets/r11-dependency-budget.mjs'),
  );
  assert.ok(script, 'no root script runs the R11 checker — an unrun ratchet ratchets nothing');
  assert.match(script, /r11-dependency-budget\.test\.mjs/);
  const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /pnpm test:dependency-budget/);
});
