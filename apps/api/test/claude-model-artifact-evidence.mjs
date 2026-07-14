import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { TaskModelSelectorSchema } from '@cap/contracts';
import {
  ClaudeArtifactCompatibilityE2eConfigSchema,
  evidenceChecksum,
  promoteClaudeArtifactCompatibilityEvidence,
  signClaudeArtifactCompatibilityEvidence,
} from '../dist/runtime-models/claude-model-capability-evidence.js';

const execFile = promisify(execFileCallback);
const ENABLE_ENV = 'CAP_TASK_MODEL_REAL_CREDENTIAL_E2E';
const TOKEN_ENV = 'TASK_MODEL_REAL_CREDENTIAL_CLAUDE_OAUTH_TOKEN';
const CONFIG_ENV = 'TASK_MODEL_CLAUDE_ARTIFACT_CONFIG';
const EVIDENCE_ENV = 'TASK_MODEL_CLAUDE_ARTIFACT_EVIDENCE';
const MANIFEST_ENV = 'TASK_MODEL_CLAUDE_ARTIFACT_MANIFEST';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROMPT =
  'Reply with exactly CAP_TASK_MODEL_E2E_OK. Do not call tools and do not modify files.';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function readConfig(path) {
  return ClaudeArtifactCompatibilityE2eConfigSchema.parse(
    JSON.parse(await readFile(resolve(path), 'utf8')),
  );
}

function platformArgs(image) {
  return image.platform ? ['--platform', image.platform] : [];
}

async function docker(args, options = {}) {
  const result = await execFile('docker', args, {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: options.timeout,
    env: options.env ?? process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function inspectImage(image) {
  const { stdout } = await docker([
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    image.image,
  ]);
  const imageIdentity = stdout.trim();
  assert.match(imageIdentity, /^sha256:[a-f0-9]{64}$/u);

  const { stdout: metadata } = await docker([
    'run',
    '--rm',
    ...platformArgs(image),
    '--entrypoint',
    '/bin/bash',
    image.image,
    '-lc',
    'set -e; claude --version; node /usr/local/bin/runtime-artifact-checksum.mjs claude-code',
  ]);
  const lines = metadata
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const version = lines.find((line) => /^\d+\.\d+\.\d+\b/u.test(line));
  const checksum = lines.find((line) => /^[a-f0-9]{64}$/u.test(line));
  if (!version || !checksum) {
    throw new Error('Packaged Claude version/checksum probe was malformed.');
  }
  return {
    ...image,
    imageIdentity,
    cliVersion: version.split(/\s/u)[0],
    cliArtifactChecksum: `sha256:${checksum}`,
  };
}

function planLaunches(images, selectors) {
  const groups = new Map();
  for (const image of images) {
    const key = `${image.cliVersion}\0${image.cliArtifactChecksum}`;
    const group = groups.get(key) ?? [];
    group.push(image);
    groups.set(key, group);
  }

  const planned = [];
  for (const group of groups.values()) {
    const groupPlanned = selectors.map((selector) => ({
      image: group[0],
      selector,
    }));
    const represented = new Set(
      groupPlanned.map((item) => item.image.providerSeam),
    );
    for (const image of group) {
      if (represented.has(image.providerSeam)) continue;
      groupPlanned.push({ image, selector: selectors[0] });
      represented.add(image.providerSeam);
    }
    planned.push(...groupPlanned);
  }
  return planned;
}

function parseStructuredResult(stdout) {
  const events = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const result = events.findLast((event) => event?.type === 'result');
  if (!result || result.is_error !== false || result.subtype !== 'success') {
    throw new Error('Claude structured result did not report success.');
  }

  const assistantModels = events
    .filter((event) => event?.type === 'assistant')
    .map((event) => event?.message?.model)
    .filter(
      (model) =>
        typeof model === 'string' && model.length > 0 && model !== '<synthetic>',
    );
  const init = events.find((event) => event?.type === 'system' && event?.subtype === 'init');
  const observed = assistantModels.at(-1) ?? init?.model ?? null;
  const actualModel =
    observed === null ? null : TaskModelSelectorSchema.parse(observed);
  return {
    actualModel,
    resultDigest: evidenceChecksum(events),
  };
}

async function runSelector(image, selector, config) {
  const containerName = `cap-claude-model-evidence-${randomUUID()}`;
  const childEnv = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: required(TOKEN_ENV),
    CAP_EVIDENCE_SELECTOR: selector.id,
    CAP_EVIDENCE_PROMPT: PROMPT,
    CAP_EVIDENCE_MAX_BUDGET_USD: String(config.maxBudgetUsd),
  };
  try {
    const { stdout } = await docker(
      [
        'run',
        '--rm',
        '--name',
        containerName,
        '--label',
        'cap.resource-purpose=claude-model-evidence',
        ...platformArgs(image),
        '--env',
        'CLAUDE_CODE_OAUTH_TOKEN',
        '--env',
        'CAP_EVIDENCE_SELECTOR',
        '--env',
        'CAP_EVIDENCE_PROMPT',
        '--env',
        'CAP_EVIDENCE_MAX_BUDGET_USD',
        '--env',
        'CLAUDE_CODE_SANDBOXED=1',
        '--env',
        'DISABLE_AUTOUPDATER=1',
        '--entrypoint',
        '/bin/bash',
        image.image,
        '-lc',
        'claude -p --safe-mode --no-session-persistence --output-format stream-json --verbose --tools "" --max-budget-usd "$CAP_EVIDENCE_MAX_BUDGET_USD" --model "$CAP_EVIDENCE_SELECTOR" "$CAP_EVIDENCE_PROMPT"',
      ],
      { timeout: config.timeoutMs, env: childEnv },
    );
    const structured = parseStructuredResult(stdout);
    return {
      providerSeam: image.providerSeam,
      imageIdentity: image.imageIdentity,
      cliVersion: image.cliVersion,
      cliArtifactChecksum: image.cliArtifactChecksum,
      selector: selector.id,
      requestedModel: selector.id,
      actualModel: structured.actualModel,
      requestedVsActual:
        structured.actualModel === null
          ? 'unknown'
          : structured.actualModel === selector.id
            ? 'matched'
            : 'different',
      structuredOutput: 'claude-stream-json',
      result: 'success',
      resultDigest: structured.resultDigest,
      completedAt: new Date().toISOString(),
    };
  } finally {
    await docker(['rm', '-f', containerName]).catch(() => undefined);
  }
}

async function writeExclusive(path, value) {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

export async function runClaudeArtifactEvidence() {
  if (process.env[ENABLE_ENV] !== '1') {
    throw new Error(`Refusing real-credential E2E without ${ENABLE_ENV}=1.`);
  }
  required(TOKEN_ENV);
  const config = await readConfig(required(CONFIG_ENV));
  const evidencePath = required(EVIDENCE_ENV);
  const manifestPath = required(MANIFEST_ENV);
  await docker(['version', '--format', '{{.Server.Version}}']);

  const images = [];
  for (const image of config.images) images.push(await inspectImage(image));
  const runs = [];
  for (const planned of planLaunches(images, config.selectors)) {
    runs.push(
      await runSelector(planned.image, planned.selector, config),
    );
  }
  const evidence = signClaudeArtifactCompatibilityEvidence({
    schemaVersion: 1,
    kind: 'claude-artifact-reference-subscription-e2e',
    gate: 'explicit-operator-opt-in',
    gatedReferenceSubscription: true,
    entitlementClaim: 'cli-compatibility-only',
    generatedAt: new Date().toISOString(),
    selectors: config.selectors,
    images: images.map((image) => ({
      providerSeam: image.providerSeam,
      imageIdentity: image.imageIdentity,
      cliVersion: image.cliVersion,
      cliArtifactChecksum: image.cliArtifactChecksum,
    })),
    runs,
  });
  const manifest = promoteClaudeArtifactCompatibilityEvidence(evidence);
  await writeExclusive(evidencePath, evidence);
  await writeExclusive(manifestPath, manifest);
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      evidencePath: resolve(evidencePath),
      evidenceChecksum: evidence.evidenceChecksum,
      manifestPath: resolve(manifestPath),
      selectorRuns: runs.length,
      artifactCount: manifest.artifacts.length,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runClaudeArtifactEvidence().catch((error) => {
    process.stderr.write(
      `claude-model-artifact-evidence: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
