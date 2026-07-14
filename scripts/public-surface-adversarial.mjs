#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_REPO_ROOT,
  loadRegistryInventory,
  validateChangeMetadata,
} from './openspec-metadata.mjs';
import { classifyPublicSurfaceFiles } from './public-surface-files.mjs';

/** Task surfaces that require observable cross-surface verification. */
export const DYNAMIC_PUBLIC_TASK_SURFACES = Object.freeze([
  'contracts',
  'public-v1',
  'mcp',
  'openapi',
  'playground',
]);

/** Evidence lanes a public requirement must exercise before verify may pass. */
export const PUBLIC_SURFACE_EVIDENCE_LANES = Object.freeze([
  'sidecar',
  'registry',
  'restMetadata',
  'mcpSdkMetadata',
  'behavior',
]);

const DYNAMIC_SURFACE_SET = new Set(DYNAMIC_PUBLIC_TASK_SURFACES);

export const PUBLIC_SURFACE_VERIFY_COMMAND = Object.freeze({
  command: 'pnpm',
  args: Object.freeze(['test:public-surface']),
});

const PROCESS_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
const FAILURE_EVIDENCE_LIMIT = 2_000;

const CLASSIFIER_SURFACE_MAP = Object.freeze({
  contracts: Object.freeze(['publicV1', 'mcp', 'openapi', 'apiPlayground']),
  publicV1: Object.freeze(['publicV1']),
  mcp: Object.freeze(['mcp']),
  openapi: Object.freeze(['openapi']),
  publicErrors: Object.freeze(['publicV1', 'mcp']),
  playground: Object.freeze(['apiPlayground']),
  developerWorkflow: Object.freeze(['internalOnly']),
});

function sorted(values) {
  return [...new Set(values)].sort();
}

function nulPaths(output) {
  return String(output ?? '')
    .split('\0')
    .filter((value) => value.length > 0);
}

function lineValues(output) {
  return String(output ?? '')
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function gitValues(
  args,
  { repoRoot, spawnSyncImpl, nulSeparated = false },
) {
  const result = spawnSyncImpl('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: PROCESS_OUTPUT_MAX_BUFFER,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return nulSeparated ? nulPaths(result.stdout) : lineValues(result.stdout);
}

/**
 * Collect the whole change under verification, not merely HEAD or staged files.
 *
 * Pre-push/CI provide an explicit base; an ordinary local verify uses the
 * branch upstream. Staged, unstaged, and non-ignored untracked paths are always
 * added because a local OpenSpec verify commonly runs before the first commit.
 */
export function collectCompleteDiffPaths({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const paths = new Set();
  const addRequired = (args, description) => {
    const values = gitValues(args, {
      repoRoot,
      spawnSyncImpl,
      nulSeparated: true,
    });
    if (values === null) throw new Error(`Unable to collect ${description}.`);
    for (const value of values) paths.add(value);
  };

  addRequired(
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z'],
    'staged paths',
  );
  addRequired(
    ['diff', '--name-only', '--diff-filter=ACMRD', '-z'],
    'unstaged paths',
  );
  addRequired(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    'non-ignored untracked paths',
  );

  let base = env.CAP_PUBLIC_SURFACE_BASE_SHA?.trim();
  if (!base && env.GITHUB_BASE_REF?.trim()) {
    base = `origin/${env.GITHUB_BASE_REF.trim()}`;
  }
  if (!base) {
    const upstream = gitValues(['rev-parse', '--verify', '@{upstream}'], {
      repoRoot,
      spawnSyncImpl,
    });
    base = upstream?.[0];
  }
  if (!base) {
    throw new Error(
      'Unable to resolve a complete public-surface base diff. Set ' +
        'CAP_PUBLIC_SURFACE_BASE_SHA or configure a branch upstream.',
    );
  }

  addRequired(
    [
      'diff',
      '--name-only',
      '--diff-filter=ACMRD',
      '-z',
      `${base}...HEAD`,
    ],
    `committed paths from base ${base}`,
  );
  return Object.freeze([...paths].sort());
}

/** Map the shared file-classifier categories to surface-impact.json keys. */
export function changedSurfacesFromClassification(classification) {
  return Object.freeze(
    sorted(
      classification.categories.flatMap(
        (category) => CLASSIFIER_SURFACE_MAP[category] ?? [],
      ),
    ),
  );
}

function evidenceStringArray(value, subject) {
  if (
    !Array.isArray(value) ||
    value.some((field) => typeof field !== 'string' || field.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${subject} must be a unique non-empty string array.`);
  }
  return Object.freeze([...value]);
}

function evidenceObject(value, subject) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${subject} must be an object.`);
  }
  return value;
}

/**
 * Read and validate the artifact emitted by the real API focused collector.
 * Registry identities are independently checked against the fail-closed AST
 * inventory; exact REST/MCP field evidence comes from reflection, SDK
 * registration, and executable adapter sentinels inside the API test process.
 */
export function readPublicSurfaceRuntimeEvidence(
  evidencePath,
  registryInventory,
) {
  const document = evidenceObject(
    JSON.parse(readFileSync(evidencePath, 'utf8')),
    'public-surface evidence',
  );
  if (document.version !== 1) {
    throw new Error('public-surface evidence.version must equal 1.');
  }
  if (document.collector !== 'api-focused-public-surface') {
    throw new Error(
      'public-surface evidence must come from api-focused-public-surface.',
    );
  }
  if (!Array.isArray(document.operations)) {
    throw new Error('public-surface evidence.operations must be an array.');
  }

  const operations = document.operations.map((raw, index) => {
    const operation = evidenceObject(raw, `operations[${index}]`);
    if (typeof operation.id !== 'string' || operation.id.length === 0) {
      throw new Error(`operations[${index}].id must be a non-empty string.`);
    }
    const registry = evidenceObject(
      operation.registry,
      `operations[${index}].registry`,
    );
    const registryRest = evidenceObject(
      registry.rest,
      `operations[${index}].registry.rest`,
    );
    const registryMcp = evidenceObject(
      registry.mcp,
      `operations[${index}].registry.mcp`,
    );
    const rest = evidenceObject(operation.rest, `operations[${index}].rest`);
    const mcp = evidenceObject(operation.mcp, `operations[${index}].mcp`);
    if (typeof rest.present !== 'boolean' || typeof mcp.present !== 'boolean') {
      throw new Error(
        `operations[${index}] REST/MCP presence must be boolean.`,
      );
    }

    const expectedTool = registryInventory.toolByOperationId.get(operation.id);
    const status = registryMcp.status;
    if (expectedTool) {
      if (status !== 'mapped' || registryMcp.tool !== expectedTool) {
        throw new Error(
          `${operation.id} evidence registry mapping contradicts ${expectedTool}.`,
        );
      }
    } else if (status !== 'excluded') {
      throw new Error(
        `${operation.id} evidence must preserve its registry MCP exclusion.`,
      );
    }
    if (mcp.present && typeof mcp.tool !== 'string') {
      throw new Error(`${operation.id} present MCP evidence requires a tool.`);
    }

    return Object.freeze({
      id: operation.id,
      registry: Object.freeze({
        rest: Object.freeze({
          inputFields: evidenceStringArray(
            registryRest.inputFields,
            `${operation.id}.registry.rest.inputFields`,
          ),
        }),
        mcp: Object.freeze({
          status,
          ...(status === 'mapped' ? { tool: registryMcp.tool } : {}),
          inputFields: evidenceStringArray(
            registryMcp.inputFields,
            `${operation.id}.registry.mcp.inputFields`,
          ),
        }),
      }),
      rest: Object.freeze({
        present: rest.present,
        inputFields: evidenceStringArray(
          rest.inputFields,
          `${operation.id}.rest.inputFields`,
        ),
        forwardedInputFields: evidenceStringArray(
          rest.forwardedInputFields,
          `${operation.id}.rest.forwardedInputFields`,
        ),
      }),
      mcp: mcp.present
        ? Object.freeze({
            present: true,
            tool: mcp.tool,
            inputFields: evidenceStringArray(
              mcp.inputFields,
              `${operation.id}.mcp.inputFields`,
            ),
            forwardedInputFields: evidenceStringArray(
              mcp.forwardedInputFields,
              `${operation.id}.mcp.forwardedInputFields`,
            ),
          })
        : Object.freeze({ present: false }),
    });
  });

  const actualIds = operations.map((operation) => operation.id);
  const expectedIds = [...registryInventory.operationIds].sort();
  if (
    new Set(actualIds).size !== actualIds.length ||
    JSON.stringify([...actualIds].sort()) !== JSON.stringify(expectedIds)
  ) {
    throw new Error(
      'public-surface evidence operation ids must exactly match the registry.',
    );
  }
  return Object.freeze(operations);
}

/**
 * Build the deterministic requirement routing consumed by adversarial verify.
 *
 * The task metadata is the authority: a requirement referenced by any task that
 * touches a public contract/adapter/projection cannot be downgraded to a static
 * verdict by an LLM risk estimate.
 */
export function buildPublicSurfaceVerificationPlan(taskPlan) {
  const requirements = new Map();

  for (const task of taskPlan.tasks) {
    for (const requirementId of task.requirements) {
      const current = requirements.get(requirementId) ?? {
        requirementId,
        taskIds: [],
        surfaces: [],
      };
      current.taskIds.push(task.id);
      current.surfaces.push(...task.surfaces);
      requirements.set(requirementId, current);
    }
  }

  return Object.freeze(
    [...requirements.values()]
      .map((entry) => {
        const surfaces = sorted(entry.surfaces);
        const dynamicRequired = surfaces.some((surface) =>
          DYNAMIC_SURFACE_SET.has(surface),
        );
        return Object.freeze({
          requirementId: entry.requirementId,
          taskIds: Object.freeze(sorted(entry.taskIds)),
          surfaces: Object.freeze(surfaces),
          dynamicRequired,
          evidenceLanes: dynamicRequired
            ? PUBLIC_SURFACE_EVIDENCE_LANES
            : Object.freeze([]),
        });
      })
      .sort((left, right) =>
        left.requirementId.localeCompare(right.requirementId),
      ),
  );
}

function exactFieldSetDelta(expected, actual) {
  const expectedSet = new Set(expected ?? []);
  const actualSet = new Set(actual ?? []);
  return Object.freeze({
    missing: Object.freeze(
      sorted([...expectedSet].filter((field) => !actualSet.has(field))),
    ),
    extra: Object.freeze(
      sorted([...actualSet].filter((field) => !expectedSet.has(field))),
    ),
  });
}

function selectedByExclusion(surface, operationId, toolId) {
  if (surface?.status !== 'excluded') return false;
  if (surface.scope === 'all-existing') return true;
  return (
    (Array.isArray(surface.operationIds) &&
      surface.operationIds.includes(operationId)) ||
    (typeof toolId === 'string' &&
      Array.isArray(surface.toolIds) &&
      surface.toolIds.includes(toolId))
  );
}

function finding({
  kind,
  route,
  requirementIds,
  detail,
  surface,
  operationId,
}) {
  return Object.freeze({
    kind,
    route,
    blocking: true,
    requirementIds: Object.freeze(sorted(requirementIds ?? [])),
    detail,
    ...(surface ? { surface } : {}),
    ...(operationId ? { operationId } : {}),
  });
}

function pushExactFieldSetFindings(
  findings,
  {
    missingKind,
    extraKind,
    label,
    expected,
    actual,
    requirementIds,
    surface,
    operationId,
  },
) {
  // `expected` is the registry-resolved exact projection. Intentional protocol
  // omissions/additions belong in the registry projection/difference first;
  // there is deliberately no local allowlist that could legitimize drift.
  const { missing, extra } = exactFieldSetDelta(expected, actual);
  if (missing.length > 0) {
    findings.push(
      finding({
        kind: missingKind,
        route: 'unmet',
        requirementIds,
        surface,
        operationId,
        detail: `${label} omits registry-projected fields: ${missing.join(', ')}`,
      }),
    );
  }
  if (extra.length > 0) {
    findings.push(
      finding({
        kind: extraKind,
        route: 'unmet',
        requirementIds,
        surface,
        operationId,
        detail:
          `${label} exposes fields absent from the registry projection/` +
          `difference: ${extra.join(', ')}`,
      }),
    );
  }
}

/**
 * Evaluate already-collected real-gate evidence.
 *
 * This deliberately accepts evidence instead of importing controllers or MCP
 * internals. The focused API tests own collection from reflected Nest metadata,
 * official SDK tools/list, and adapter calls; this function owns fail-closed
 * routing and is also the mutation-test seam.
 */
export function evaluatePublicSurfaceEvidence({
  requirementIds = [],
  changedSurfaces = [],
  sidecar,
  lanes = {},
  operations = [],
}) {
  const findings = [];

  for (const lane of PUBLIC_SURFACE_EVIDENCE_LANES) {
    if (lanes[lane] === true) continue;
    findings.push(
      finding({
        kind: 'dynamic-evidence-missing',
        route: 'unmet',
        requirementIds,
        detail: `Mandatory dynamic evidence lane did not pass: ${lane}`,
      }),
    );
  }

  for (const surface of sorted(changedSurfaces)) {
    const status = sidecar?.surfaces?.[surface]?.status;
    if (['changed', 'derived', 'excluded'].includes(status)) continue;
    findings.push(
      finding({
        kind: 'undeclared-impact',
        route: 'spec-defect',
        requirementIds,
        surface,
        detail:
          `Code evidence changes ${surface}, but surface-impact.json declares ` +
          `${status ?? 'no status'}.`,
      }),
    );
  }

  for (const operation of operations) {
    const operationId = operation.id;
    const expectedRest = operation.registry?.rest?.inputFields ?? [];
    const expectedMcp = operation.registry?.mcp?.inputFields ?? [];
    const registryMcpTool = operation.registry?.mcp?.tool;
    const mcpExcluded = selectedByExclusion(
      sidecar?.surfaces?.mcp,
      operationId,
      registryMcpTool ?? operation.mcp?.tool,
    );
    const registryMcpMapped = operation.registry?.mcp?.status === 'mapped';
    const actualMcpPresent = operation.mcp?.present === true;

    if (mcpExcluded && (registryMcpMapped || actualMcpPresent)) {
      findings.push(
        finding({
          kind: 'false-exclusion',
          route: 'spec-defect',
          requirementIds,
          surface: 'mcp',
          operationId,
          detail:
            `surface-impact.json excludes ${operationId} from MCP, but the ` +
            'registry or actual SDK inventory exposes a mapping.',
        }),
      );
    }

    if (operation.rest?.present !== true) {
      findings.push(
        finding({
          kind: 'rest-metadata-mismatch',
          route: 'unmet',
          requirementIds,
          surface: 'publicV1',
          operationId,
          detail: `${operationId} is absent from reflected REST metadata.`,
        }),
      );
    } else {
      pushExactFieldSetFindings(findings, {
        missingKind: 'rest-schema-field-stripping',
        extraKind: 'rest-schema-field-leakage',
        label: 'Reflected REST request metadata',
        expected: expectedRest,
        actual: operation.rest.inputFields,
        requirementIds,
        surface: 'publicV1',
        operationId,
      });
      pushExactFieldSetFindings(findings, {
        missingKind: 'rest-field-stripping',
        extraKind: 'rest-field-leakage',
        label: 'Reflected REST canonical parameter bindings',
        expected: expectedRest,
        actual: operation.rest.forwardedInputFields,
        requirementIds,
        surface: 'publicV1',
        operationId,
      });
    }

    if (!registryMcpMapped) {
      if (actualMcpPresent && !mcpExcluded) {
        findings.push(
          finding({
            kind: 'undeclared-mcp-mapping',
            route: 'spec-defect',
            requirementIds,
            surface: 'mcp',
            operationId,
            detail:
              `${operationId} is excluded by the registry but appears in the ` +
              'actual SDK inventory.',
          }),
        );
      }
      continue;
    }

    if (!actualMcpPresent) {
      findings.push(
        finding({
          kind: 'mcp-sdk-metadata-mismatch',
          route: 'unmet',
          requirementIds,
          surface: 'mcp',
          operationId,
          detail: `${operationId} is absent from the actual SDK tool inventory.`,
        }),
      );
      continue;
    }

    const expectedTool = registryMcpTool;
    if (operation.mcp.tool !== expectedTool) {
      findings.push(
        finding({
          kind: 'mcp-sdk-metadata-mismatch',
          route: 'unmet',
          requirementIds,
          surface: 'mcp',
          operationId,
          detail:
            `${operationId} advertises ${String(operation.mcp.tool)} instead ` +
            `of registry tool ${String(expectedTool)}.`,
        }),
      );
    }
    pushExactFieldSetFindings(findings, {
      missingKind: 'mcp-schema-field-stripping',
      extraKind: 'mcp-schema-field-leakage',
      label: 'Actual MCP SDK input schema',
      expected: expectedMcp,
      actual: operation.mcp.inputFields,
      requirementIds,
      surface: 'mcp',
      operationId,
    });
    pushExactFieldSetFindings(findings, {
      missingKind: 'mcp-field-stripping',
      extraKind: 'mcp-field-leakage',
      label: 'Observed MCP use-case arguments',
      expected: expectedMcp,
      actual: operation.mcp.forwardedInputFields,
      requirementIds,
      surface: 'mcp',
      operationId,
    });
  }

  const unique = new Map();
  for (const item of findings) {
    const key = [
      item.kind,
      item.route,
      item.surface ?? '',
      item.operationId ?? '',
      item.detail,
    ].join('\u0000');
    unique.set(key, item);
  }
  return Object.freeze([...unique.values()]);
}

/** Convert findings into the archive gate's unmet/spec-defect destinations. */
export function routePublicSurfaceFindings(findings) {
  const unmet = findings.filter(
    (item) => item.blocking && item.route === 'unmet',
  );
  const blockingSpecDefects = findings.filter(
    (item) => item.blocking && item.route === 'spec-defect',
  );
  return Object.freeze({
    pass: unmet.length === 0 && blockingSpecDefects.length === 0,
    unmet: Object.freeze(unmet),
    blockingSpecDefects: Object.freeze(blockingSpecDefects),
    archiveBlockers: Object.freeze([...unmet, ...blockingSpecDefects]),
  });
}

function processFailureEvidence(result) {
  const raw = [result.stderr, result.stdout]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n');
  if (raw.length === 0) {
    return result.error?.message ?? 'The focused gate returned no diagnostics.';
  }
  const lines = raw.split(/\r?\n/u);
  const excerpts = [];
  for (const [index, line] of lines.entries()) {
    if (!/(?:\bnot ok \d+\b|(?:^|\s)FAIL\s+\S)/u.test(line)) continue;
    excerpts.push(...lines.slice(index, index + 30));
  }
  const focused = excerpts.length > 0 ? excerpts.join('\n') : raw;
  return focused.length <= FAILURE_EVIDENCE_LIMIT
    ? focused
    : focused.slice(0, FAILURE_EVIDENCE_LIMIT);
}

function evidenceLane(passed, evidence) {
  return Object.freeze({ passed, evidence });
}

function verificationFinding({ kind, route, requirementIds, reason }) {
  return Object.freeze({
    kind,
    route,
    blocking: true,
    requirementIds: Object.freeze(sorted(requirementIds ?? [])),
    reason,
  });
}

function failedVerificationVerdict(changeName, reason, requirementIds = []) {
  const command = Object.freeze({
    argv: Object.freeze([
      PUBLIC_SURFACE_VERIFY_COMMAND.command,
      ...PUBLIC_SURFACE_VERIFY_COMMAND.args,
    ]),
    shell: false,
    ran: false,
    exitCode: null,
  });
  const sidecar = evidenceLane(false, reason);
  const notRun = evidenceLane(
    false,
    'Not run because validate-change --phase verify failed.',
  );
  return Object.freeze({
    verdictVersion: 1,
    changeName,
    phase: 'verify',
    requirementIds: Object.freeze(sorted(requirementIds)),
    passed: false,
    command,
    sidecar,
    registry: notRun,
    restMetadata: notRun,
    mcpSdkMetadata: notRun,
    behavior: notRun,
    findings: Object.freeze([
      verificationFinding({
        kind: 'metadata-validation-failed',
        route: 'spec-defect',
        requirementIds,
        reason,
      }),
    ]),
  });
}

function publicEvaluatorFinding(item) {
  return verificationFinding({
    kind: item.kind,
    route: item.route,
    requirementIds: item.requirementIds,
    reason: item.detail,
  });
}

/**
 * Run the deterministic public-surface verify gate.
 *
 * This command is called only by opsx-verify. The root focused command does not
 * invoke this CLI, so its child `pnpm test:public-surface` cannot recurse. The
 * focused package tests remain the collectors for registry, reflected REST,
 * official SDK MCP metadata, and observable adapter behavior.
 */
export function verifyPublicSurfaceChange(
  changeName,
  {
    repoRoot = DEFAULT_REPO_ROOT,
    env = process.env,
    spawnSyncImpl = spawnSync,
    gitSpawnSyncImpl = spawnSync,
    validateChangeMetadataImpl = validateChangeMetadata,
    collectDiffPathsImpl = collectCompleteDiffPaths,
    classifyFilesImpl = classifyPublicSurfaceFiles,
    loadRegistryInventoryImpl = loadRegistryInventory,
    readRuntimeEvidenceImpl = readPublicSurfaceRuntimeEvidence,
    evaluateEvidenceImpl = evaluatePublicSurfaceEvidence,
  } = {},
) {
  let validated;
  let plan;
  let requirementIds = Object.freeze([]);
  let changedSurfaces;
  let registryInventory;
  try {
    validated = validateChangeMetadataImpl(changeName, {
      repoRoot,
      phase: 'verify',
    });
    plan = buildPublicSurfaceVerificationPlan(validated.taskPlan);
    requirementIds = Object.freeze(
      plan
        .filter((entry) => entry.dynamicRequired)
        .map((entry) => entry.requirementId),
    );
    const changedPaths = collectDiffPathsImpl({
      repoRoot,
      env,
      spawnSyncImpl: gitSpawnSyncImpl,
    });
    const classification = classifyFilesImpl(changedPaths, repoRoot);
    changedSurfaces = changedSurfacesFromClassification(classification);
    registryInventory = loadRegistryInventoryImpl(repoRoot);
  } catch (error) {
    return failedVerificationVerdict(
      changeName,
      error instanceof Error ? error.message : String(error),
      requirementIds,
    );
  }
  const evidenceDirectory = mkdtempSync(
    path.join(tmpdir(), 'cap-public-surface-evidence-'),
  );
  const evidencePath = path.join(evidenceDirectory, 'runtime-evidence.json');
  let result;
  let operationEvidence = Object.freeze([]);
  let runtimeEvidenceError;
  let runtimeEvidenceLoaded = false;
  try {
    result = spawnSyncImpl(
      PUBLIC_SURFACE_VERIFY_COMMAND.command,
      [...PUBLIC_SURFACE_VERIFY_COMMAND.args],
      {
        cwd: repoRoot,
        env: {
          ...env,
          CAP_PUBLIC_SURFACE_EVIDENCE_PATH: evidencePath,
        },
        encoding: 'utf8',
        maxBuffer: PROCESS_OUTPUT_MAX_BUFFER,
        shell: false,
      },
    );
    if (existsSync(evidencePath)) {
      try {
        operationEvidence = readRuntimeEvidenceImpl(
          evidencePath,
          registryInventory,
        );
        runtimeEvidenceLoaded = true;
      } catch (error) {
        runtimeEvidenceError =
          error instanceof Error ? error.message : String(error);
      }
    } else if (!result.error && result.status === 0) {
      runtimeEvidenceError = `Focused collector did not emit ${evidencePath}.`;
    }
  } catch (error) {
    result = {
      status: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
  const exitCode = Number.isInteger(result.status) ? result.status : null;
  const gatePassed = !result.error && exitCode === 0;
  const collectorPassed =
    gatePassed && runtimeEvidenceLoaded && runtimeEvidenceError === undefined;
  const command = Object.freeze({
    argv: Object.freeze([
      PUBLIC_SURFACE_VERIFY_COMMAND.command,
      ...PUBLIC_SURFACE_VERIFY_COMMAND.args,
    ]),
    shell: false,
    ran: true,
    exitCode,
  });
  const sidecar = evidenceLane(
    true,
    `validate-change ${changeName} --phase verify passed.`,
  );
  const gateEvidence = gatePassed
    ? 'pnpm test:public-surface passed.'
    : `pnpm test:public-surface exited ${exitCode ?? 'without a code'}.`;
  const failureReason = gatePassed
    ? gateEvidence
    : `${gateEvidence}\n${processFailureEvidence(result)}`;
  const collectorFailure = gatePassed
    ? `API focused collector evidence failed: ${runtimeEvidenceError}`
    : gateEvidence;
  const laneEvidence = Object.freeze({
    registry: collectorPassed
      ? 'API focused collector read the executable canonical registry.'
      : collectorFailure,
    restMetadata: collectorPassed
      ? 'API focused collector reflected real Nest Public V1 handler metadata and parameter bindings.'
      : collectorFailure,
    mcpSdkMetadata: collectorPassed
      ? 'API focused collector observed official MCP Client.listTools metadata over InMemoryTransport.'
      : collectorFailure,
    behavior: collectorPassed
      ? 'Focused conformance passed and the collector traced unique field sentinels through the executable MCP adapter map.'
      : collectorFailure,
  });
  const lanes = Object.freeze({
    sidecar: true,
    registry: collectorPassed,
    restMetadata: collectorPassed,
    mcpSdkMetadata: collectorPassed,
    behavior: collectorPassed,
  });
  const evaluated = evaluateEvidenceImpl({
    requirementIds,
    changedSurfaces,
    sidecar: validated.sidecar,
    lanes,
    operations: runtimeEvidenceLoaded ? operationEvidence : [],
  });
  const findings = [
    ...(gatePassed
      ? []
      : [
          verificationFinding({
            kind: 'public-surface-gate-failed',
            route: 'unmet',
            requirementIds,
            reason: failureReason,
          }),
        ]),
    ...evaluated.map(publicEvaluatorFinding),
  ];
  const routed = routePublicSurfaceFindings(findings);

  return Object.freeze({
    verdictVersion: 1,
    changeName,
    phase: 'verify',
    requirementIds,
    passed: gatePassed && routed.pass,
    command,
    sidecar,
    registry: evidenceLane(collectorPassed, laneEvidence.registry),
    restMetadata: evidenceLane(collectorPassed, laneEvidence.restMetadata),
    mcpSdkMetadata: evidenceLane(collectorPassed, laneEvidence.mcpSdkMetadata),
    behavior: evidenceLane(collectorPassed, laneEvidence.behavior),
    findings: Object.freeze(findings),
  });
}

export function verificationExitCode(verdict) {
  return verdict.passed ? 0 : 1;
}

function parseCli(argv) {
  const positional = [];
  let repoRoot = DEFAULT_REPO_ROOT;
  let phase = 'verify';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--repo-root') {
      repoRoot = path.resolve(argv[index + 1]);
      index += 1;
    } else if (value === '--phase') {
      phase = argv[index + 1];
      index += 1;
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option ${value}`);
    } else {
      positional.push(value);
    }
  }
  return { positional, repoRoot, phase };
}

export function main(argv = process.argv.slice(2)) {
  const { positional, repoRoot, phase } = parseCli(argv);
  const [command, changeName] = positional;
  if (!['plan', 'verify'].includes(command) || !changeName || positional.length !== 2) {
    throw new Error(
      'Usage: public-surface-adversarial.mjs <plan|verify> <change> ' +
        '[--phase apply|verify] [--repo-root <path>]',
    );
  }
  if (command === 'verify') {
    if (phase !== 'verify') {
      throw new Error('public-surface verify only supports --phase verify');
    }
    const verdict = verifyPublicSurfaceChange(changeName, { repoRoot });
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    return verificationExitCode(verdict);
  }
  const validated = validateChangeMetadata(changeName, { repoRoot, phase });
  const plan = buildPublicSurfaceVerificationPlan(validated.taskPlan);
  process.stdout.write(
    `${JSON.stringify({ changeName, phase, requirements: plan }, null, 2)}\n`,
  );
  return 0;
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
