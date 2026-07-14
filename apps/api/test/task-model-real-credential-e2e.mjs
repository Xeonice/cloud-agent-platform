import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import {
  RuntimeModelCatalogSchema,
  SessionHistorySchema,
  TaskModelSelectionCapabilityStatusSchema,
  TaskModelSelectorSchema,
  TaskResponseSchema,
  TERMINAL_TASK_STATUSES,
} from '@cap/contracts';
import {
  ClaudeReferenceSubscriptionE2eConfigSchema,
  bindClaudeReferenceConfigToArtifactEvidence,
  evidenceChecksum,
  promoteClaudeReferenceSubscriptionEvidence,
  signClaudeReferenceSubscriptionEvidence,
} from '../dist/runtime-models/claude-model-capability-evidence.js';

/**
 * Explicitly gated, real-account black-box verification.
 *
 * This runner never discovers or loads a workstation credential. The caller
 * must deliberately pass a scoped bearer token and a non-secret config file.
 * It stores only catalog metadata, task ids, requested/actual model facts and a
 * transcript digest; bearer tokens and transcript text are never persisted.
 */

const ENABLE_ENV = 'CAP_TASK_MODEL_REAL_CREDENTIAL_E2E';
const BASE_URL_ENV = 'TASK_MODEL_REAL_CREDENTIAL_BASE_URL';
const TOKEN_ENV = 'TASK_MODEL_REAL_CREDENTIAL_BEARER_TOKEN';
const CONFIG_ENV = 'TASK_MODEL_REAL_CREDENTIAL_CONFIG';
const ARTIFACT_EVIDENCE_ENV =
  'TASK_MODEL_REAL_CREDENTIAL_ARTIFACT_EVIDENCE';
const EVIDENCE_ENV = 'TASK_MODEL_REAL_CREDENTIAL_EVIDENCE';
const MANIFEST_ENV = 'TASK_MODEL_REAL_CREDENTIAL_MANIFEST';
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const TRANSCRIPT_SETTLE_MS = 60_000;
const PROMPT =
  'Reply with exactly CAP_TASK_MODEL_E2E_OK. Do not call tools and do not modify files.';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseBaseUrl(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${BASE_URL_ENV} must not contain credentials, query, or hash.`);
  }
  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1' ||
    url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${BASE_URL_ENV} must use HTTPS or loopback HTTP.`);
  }
  url.pathname = url.pathname.replace(/\/$/u, '');
  return url;
}

async function readConfig(path) {
  const raw = await readFile(resolve(path), 'utf8');
  return ClaudeReferenceSubscriptionE2eConfigSchema.parse(JSON.parse(raw));
}

function sandboxEnvironmentBody(environment) {
  return Object.prototype.hasOwnProperty.call(
    environment,
    'sandboxEnvironmentId',
  )
    ? { sandboxEnvironmentId: environment.sandboxEnvironmentId }
    : {};
}

function safeHttpFailure(response, body) {
  const code =
    body && typeof body === 'object' && typeof body.code === 'string'
      ? ` code=${body.code}`
      : '';
  return new Error(`CAP request failed: HTTP ${response.status}.${code}`);
}

async function fetchJson(baseUrl, token, path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Do not echo an unexpected HTML/proxy body: it is not part of the safe API
    // contract and could contain deployment details.
  }
  if (!response.ok) throw safeHttpFailure(response, body);
  if (body === null) throw new Error('CAP returned a non-JSON success response.');
  return body;
}

async function assertDeploymentGateOpen(baseUrl, token) {
  const status = TaskModelSelectionCapabilityStatusSchema.parse(
    await fetchJson(
      baseUrl,
      token,
      '/deployment-capabilities/task-model-selection-v1',
    ),
  );
  assert.equal(status.gate.open, true, 'task-model-selection-v1 gate must be open');
}

async function queryCatalog(baseUrl, token, environment, artifactBinding) {
  const catalog = RuntimeModelCatalogSchema.parse(
    await fetchJson(baseUrl, token, '/v1/runtime-models/query', {
      method: 'POST',
      body: JSON.stringify({
        runtime: 'claude-code',
        ...sandboxEnvironmentBody(environment),
      }),
    }),
  );
  assert.equal(catalog.runtime, 'claude-code');
  assert.equal(
    catalog.cliVersion,
    artifactBinding.cliVersion,
    'the live catalog CLI version must match signed artifact evidence',
  );
  assert.equal(catalog.source, 'versioned-cli-capabilities');
  assert.equal(catalog.completeness, 'supported-subset');
  assert.equal(catalog.defaultModel, null);
  assert.ok(catalog.models.length > 0, 'Claude evidence catalog must not be empty');
  for (const model of catalog.models) {
    assert.equal(model.availabilityEvidence, 'cli-version-verified');
  }

  const configured = new Map(
    environment.selectors.map((selector) => [selector.id, selector]),
  );
  assert.deepEqual(
    [...catalog.models.map((model) => model.id)].sort(),
    [...configured.keys()].sort(),
    'the gated run must cover every candidate manifest selector exactly',
  );
  for (const model of catalog.models) {
    assert.equal(configured.get(model.id)?.displayName, model.displayName);
  }
  return catalog;
}

function catalogEvidence(environment, catalog) {
  const configured = new Map(
    environment.selectors.map((selector) => [selector.id, selector]),
  );
  return {
    providerSeam: environment.providerSeam,
    sandboxEnvironmentId: catalog.effectiveEnvironment.id,
    environmentFingerprint: catalog.effectiveEnvironment.fingerprint,
    cliVersion: catalog.cliVersion,
    cliArtifactChecksum: environment.cliArtifactChecksum,
    catalogRevision: catalog.revision,
    source: catalog.source,
    completeness: catalog.completeness,
    availabilityEvidence: 'cli-version-verified',
    selectors: catalog.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      provenance: configured.get(model.id).provenance,
    })),
  };
}

function planLaunches(catalogs) {
  const byArtifact = new Map();
  for (const item of catalogs) {
    const key = `${item.catalog.cliVersion}\0${item.environment.cliArtifactChecksum}`;
    const group = byArtifact.get(key) ?? [];
    group.push(item);
    byArtifact.set(key, group);
  }

  const planned = [];
  for (const group of byArtifact.values()) {
    const groupPlanned = [];
    const selectorOwners = new Map();
    for (const item of group) {
      for (const model of item.catalog.models) {
        if (!selectorOwners.has(model.id)) selectorOwners.set(model.id, item);
      }
    }
    for (const [selector, item] of selectorOwners) {
      groupPlanned.push({ ...item, selector });
    }

    const represented = new Set(
      groupPlanned.map((item) => item.environment.providerSeam),
    );
    for (const item of group) {
      if (represented.has(item.environment.providerSeam)) continue;
      const selector = item.catalog.models[0]?.id;
      assert.ok(selector, 'representative provider seam needs one selector');
      groupPlanned.push({ ...item, selector });
      represented.add(item.environment.providerSeam);
    }
    planned.push(...groupPlanned);
  }

  const unique = new Map();
  for (const item of planned) {
    const key = [
      item.environment.providerSeam,
      item.catalog.effectiveEnvironment.fingerprint,
      item.selector,
    ].join('\0');
    unique.set(key, item);
  }
  return [...unique.values()];
}

async function waitForCompletedTask(baseUrl, token, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = TaskResponseSchema.parse(
      await fetchJson(baseUrl, token, `/v1/tasks/${taskId}`),
    );
    if (TERMINAL_TASK_STATUSES.includes(task.status)) {
      if (task.status !== 'completed') {
        const code = task.failure?.code ? ` (${task.failure.code})` : '';
        throw new Error(`Claude evidence task ended as ${task.status}${code}.`);
      }
      return task;
    }
    if (Date.now() >= deadline) {
      throw new Error('Claude evidence task did not complete within the bound.');
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function waitForTranscript(baseUrl, token, taskId, deadline) {
  for (;;) {
    const transcript = SessionHistorySchema.parse(
      await fetchJson(baseUrl, token, `/v1/tasks/${taskId}/transcript`),
    );
    if (transcript.status === 'available') return transcript;
    if (Date.now() >= deadline) {
      throw new Error('Claude evidence transcript was not retained within the bound.');
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function stopTask(baseUrl, token, taskId) {
  try {
    await fetchJson(baseUrl, token, `/v1/tasks/${taskId}/stop`, {
      method: 'POST',
    });
  } catch {
    // Cleanup is best effort; the original bounded failure remains authoritative.
  }
}

async function runLaunch(baseUrl, token, planned, repoId, timeoutMs, activeTasks) {
  const body = {
    repoId,
    prompt: PROMPT,
    runtime: 'claude-code',
    model: planned.selector,
    ...sandboxEnvironmentBody(planned.environment),
  };
  const created = TaskResponseSchema.parse(
    await fetchJson(baseUrl, token, '/v1/tasks', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(body),
    }),
  );
  activeTasks.add(created.id);
  assert.equal(created.runtime, 'claude-code');
  assert.equal(created.executionMode, 'headless-exec');
  assert.equal(created.model, planned.selector);

  const completed = await waitForCompletedTask(
    baseUrl,
    token,
    created.id,
    timeoutMs,
  );
  activeTasks.delete(created.id);
  assert.equal(completed.model, planned.selector);
  const transcript = await waitForTranscript(
    baseUrl,
    token,
    created.id,
    Date.now() + Math.min(timeoutMs, TRANSCRIPT_SETTLE_MS),
  );
  assert.ok(
    transcript.turns.some((turn) => turn.kind === 'assistant'),
    'retained transcript must contain an assistant turn',
  );
  const actualModel =
    transcript.meta.model === undefined
      ? null
      : TaskModelSelectorSchema.parse(transcript.meta.model);
  return {
    providerSeam: planned.environment.providerSeam,
    environmentFingerprint: planned.catalog.effectiveEnvironment.fingerprint,
    cliVersion: planned.catalog.cliVersion,
    cliArtifactChecksum: planned.environment.cliArtifactChecksum,
    catalogRevision: planned.catalog.revision,
    selector: planned.selector,
    requestedModel: completed.model,
    actualModel,
    requestedVsActual:
      actualModel === null
        ? 'unknown'
        : actualModel === completed.model
          ? 'matched'
          : 'different',
    requestSurface: 'public-v1',
    executionMode: completed.executionMode,
    taskId: completed.id,
    taskStatus: completed.status,
    transcriptStatus: transcript.status,
    transcriptDigest: evidenceChecksum(transcript),
    completedAt: new Date().toISOString(),
  };
}

async function writeExclusive(path, value) {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

export async function runRealCredentialE2e() {
  if (process.env[ENABLE_ENV] !== '1') {
    throw new Error(`Refusing real-credential E2E without ${ENABLE_ENV}=1.`);
  }
  const baseUrl = parseBaseUrl(required(BASE_URL_ENV));
  const token = required(TOKEN_ENV);
  const config = await readConfig(required(CONFIG_ENV));
  const artifactEvidence = JSON.parse(
    await readFile(resolve(required(ARTIFACT_EVIDENCE_ENV)), 'utf8'),
  );
  const artifactBindings = bindClaudeReferenceConfigToArtifactEvidence(
    config,
    artifactEvidence,
  );
  const evidencePath = required(EVIDENCE_ENV);
  const activeTasks = new Set();

  await assertDeploymentGateOpen(baseUrl, token);
  const catalogs = [];
  for (const [environmentIndex, environment] of config.environments.entries()) {
    const artifactBinding = artifactBindings[environmentIndex];
    assert.equal(artifactBinding?.environmentIndex, environmentIndex);
    const catalog = await queryCatalog(
      baseUrl,
      token,
      environment,
      artifactBinding,
    );
    catalogs.push({ environment, catalog });
  }

  const runs = [];
  try {
    for (const planned of planLaunches(catalogs)) {
      runs.push(
        await runLaunch(
          baseUrl,
          token,
          planned,
          config.repoId,
          config.pollTimeoutMs,
          activeTasks,
        ),
      );
    }
  } finally {
    await Promise.all(
      [...activeTasks].map((taskId) => stopTask(baseUrl, token, taskId)),
    );
  }

  const evidence = signClaudeReferenceSubscriptionEvidence({
    schemaVersion: 1,
    kind: 'claude-reference-subscription-e2e',
    gate: 'explicit-operator-opt-in',
    gatedReferenceSubscription: true,
    entitlementClaim: 'cli-compatibility-only',
    artifactEvidenceChecksum:
      artifactBindings[0].artifactEvidenceChecksum,
    generatedAt: new Date().toISOString(),
    catalogs: catalogs.map(({ environment, catalog }) =>
      catalogEvidence(environment, catalog),
    ),
    runs,
  });
  const manifest = promoteClaudeReferenceSubscriptionEvidence(
    evidence,
    artifactEvidence,
  );
  await writeExclusive(evidencePath, evidence);
  const manifestPath = process.env[MANIFEST_ENV]?.trim();
  if (manifestPath) await writeExclusive(manifestPath, manifest);

  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      evidencePath: resolve(evidencePath),
      evidenceChecksum: evidence.evidenceChecksum,
      manifestPath: manifestPath ? resolve(manifestPath) : null,
      selectorRuns: evidence.runs.length,
      artifactCount: manifest.artifacts.length,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runRealCredentialE2e().catch((error) => {
    process.stderr.write(
      `task-model-real-credential-e2e: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
