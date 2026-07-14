import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  CHECKED_RUNTIME_MODEL_REJECTION_EVIDENCE_POLICY,
  classifyRuntimeModelRejectionEvidence,
  type RuntimeModelRejectionEvidencePolicy,
} from './runtime-model-rejection-evidence';

const STRUCTURED = {
  runtime: 'claude-code' as const,
  cliVersion: '2.1.207',
  source: 'claude-stream-json-result' as const,
  stableCode: 'model_not_found',
};

test('checked pins classify no model rejection without dedicated evidence', () => {
  assert.deepEqual(
    CHECKED_RUNTIME_MODEL_REJECTION_EVIDENCE_POLICY.entries,
    [],
  );
  assert.equal(classifyRuntimeModelRejectionEvidence(STRUCTURED), null);
  assert.equal(
    classifyRuntimeModelRejectionEvidence({
      ...STRUCTURED,
      stableCode: 'badRequest',
    }),
    null,
  );
});

test('an exact checksum/provenance-bound structured code can be enabled without text matching', () => {
  const policy: RuntimeModelRejectionEvidencePolicy = {
    cliPins: { codex: '0.144.1', 'claude-code': '2.1.207' },
    entries: [
      {
        ...STRUCTURED,
        provenance: 'https://code.claude.com/docs/en/cli-reference',
        evidenceChecksum: `sha256:${'a'.repeat(64)}`,
      },
    ],
  };
  assert.equal(
    classifyRuntimeModelRejectionEvidence(STRUCTURED, policy),
    'runtime_model_rejected',
  );
  assert.equal(
    classifyRuntimeModelRejectionEvidence(
      { ...STRUCTURED, cliVersion: '2.1.208' },
      policy,
    ),
    null,
  );
  assert.equal(
    classifyRuntimeModelRejectionEvidence(
      { ...STRUCTURED, stableCode: 'authentication_failed' },
      policy,
    ),
    null,
  );
});

test('checked rejection policy pins match both packaged Dockerfiles', async () => {
  const root = resolve(__dirname, '../../../..');
  const [aio, boxlite] = await Promise.all([
    readFile(resolve(root, 'docker/aio-sandbox.Dockerfile'), 'utf8'),
    readFile(resolve(root, 'docker/boxlite-sandbox.Dockerfile'), 'utf8'),
  ]);
  for (const dockerfile of [aio, boxlite]) {
    assert.equal(
      dockerfile.match(/ARG CODEX_VERSION=([^\s]+)/u)?.[1],
      CHECKED_RUNTIME_MODEL_REJECTION_EVIDENCE_POLICY.cliPins.codex,
    );
    assert.equal(
      dockerfile.match(/ARG CLAUDE_CODE_VERSION=([^\s]+)/u)?.[1],
      CHECKED_RUNTIME_MODEL_REJECTION_EVIDENCE_POLICY.cliPins['claude-code'],
    );
  }
});
