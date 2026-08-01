/**
 * Transcript family — assertions PORTED from the existing parser tests and the
 * transcript-declaration tests, not invented:
 *
 *   - `apps/api/src/sandbox/claude-transcript-parser.test.mjs` and
 *     `apps/api/src/sandbox/rollout-parser.test.mjs` (fixture JSONL → ordered
 *     turn kinds, final-answer marker, malformed-line tolerance);
 *   - `apps/api/src/agent-runtime/headless-execution.spec.ts`
 *     (`transcriptArtifact` dir/glob declarations per runtime).
 *
 * The runtime's harness contributes only its declared expectations, the seed
 * fixture bytes, and the parse handle from the seed bridge.
 */
import assert from 'node:assert/strict';

import type { RuntimeHarness } from '../harness.js';

export async function runTranscriptFamily(harness: RuntimeHarness): Promise<void> {
  const { runtime, hooks } = harness;
  const t = hooks.transcript;

  // ---- declarations: format, read strategy, artifact location -------------
  assert.equal(
    runtime.transcriptFormat,
    t.format,
    `${runtime.id}: declares the expected transcript format`,
  );
  assert.equal(
    runtime.readTranscriptSource.kind,
    t.strategyKind,
    `${runtime.id}: declares the expected transcript read strategy`,
  );

  const artifact = runtime.transcriptArtifact(t.context);
  assert.equal(
    artifact.dir,
    t.artifactDir,
    `${runtime.id}: transcript artifact dir matches the declaration`,
  );
  assert.ok(
    artifact.filenameGlob.test(t.matchingFilename),
    `${runtime.id}: artifact glob accepts ${JSON.stringify(t.matchingFilename)}`,
  );
  assert.ok(
    !artifact.filenameGlob.test(t.nonMatchingFilename),
    `${runtime.id}: artifact glob rejects ${JSON.stringify(t.nonMatchingFilename)}`,
  );

  // ---- parse: fixture JSONL → the shared render contract ------------------
  const parsed = t.parse(t.fixtureJsonl);
  assert.deepEqual(
    parsed.turns.map((turn) => turn.kind),
    [...t.expectedTurnKinds],
    `${runtime.id}: fixture parses into the expected ordered turn kinds`,
  );
  assert.ok(
    !parsed.turns.some((turn) => turn.kind === 'system'),
    `${runtime.id}: the parser never emits a system turn`,
  );
  const finalTurn = parsed.turns[parsed.turns.length - 1];
  assert.ok(
    finalTurn !== undefined &&
      finalTurn.kind === 'assistant' &&
      finalTurn.isFinalAnswer === true &&
      finalTurn.text === t.expectedFinalAnswerText,
    `${runtime.id}: the final assistant turn carries the final-answer marker and text`,
  );

  // ---- malformed lines never abort the parse ------------------------------
  const malformed = t.malformed;
  if (malformed) {
    let result: ReturnType<typeof t.parse> | undefined;
    assert.doesNotThrow(() => {
      result = t.parse(malformed.jsonl);
    }, `${runtime.id}: a malformed line never aborts the parse`);
    assert.ok(result, `${runtime.id}: the malformed fixture still parses`);
    assert.deepEqual(
      result.turns.map((turn) => turn.text),
      [...malformed.expectedSurvivorTexts],
      `${runtime.id}: the parseable lines still yield their turns`,
    );
  }
}
