import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_REPO_ROOT,
  MetadataValidationError,
  SURFACE_STATUSES,
  VERIFIER_ALLOWLIST,
  changedOpenSpecChangeNames,
  collectRequirementIds,
  loadRegistryInventory,
  parseTaskMetadata,
  runTaskVerifier,
  runVerifier,
  validateChangeMetadata,
  validateChangedOpenSpecChanges,
  validateSurfaceImpactDocument,
} from './openspec-metadata.mjs';

const KNOWN_REGISTRY = {
  operationIds: new Set(['tasks.create', 'tasks.events']),
  toolIds: new Set(['create_task']),
  toolByOperationId: new Map([['tasks.create', 'create_task']]),
  excludedOperationIds: new Set(['tasks.events']),
  differenceKindsByOperationId: new Map([['tasks.create', new Set()]]),
};

const DOGFOOD_CHANGE = 'enforce-api-mcp-development-parity';
const DOGFOOD_TASKS_PATH = join(
  DEFAULT_REPO_ROOT,
  'openspec',
  'changes',
  DOGFOOD_CHANGE,
  'tasks.md',
);
const HAS_ACTIVE_DOGFOOD_CHANGE = existsSync(DOGFOOD_TASKS_PATH);

function unchanged(reason) {
  return { status: 'unchanged', reason };
}

function changedSidecar(change = 'fixture-change') {
  return {
    version: 1,
    change,
    intent: 'public-feature',
    runtimeWireBehavior: 'changed',
    surfaces: {
      publicV1: {
        status: 'changed',
        operationIds: ['tasks.create'],
        reason: 'The public task input changes.',
      },
      mcp: {
        status: 'changed',
        operationIds: ['tasks.create'],
        toolIds: ['create_task'],
        reason: 'The mapped MCP tool changes with the public capability.',
      },
      openapi: {
        status: 'derived',
        operationIds: ['tasks.create'],
        reason: 'OpenAPI derives the changed request schema.',
      },
      apiPlayground: {
        status: 'derived',
        operationIds: ['tasks.create'],
        reason: 'The Playground derives the changed operation.',
      },
      internalOnly: unchanged('No internal-only behavior changes.'),
    },
    protocolDifferences: [],
    verification: {
      id: 'public-surface-full',
      requiresWireCompatibilityFixture: true,
    },
  };
}

function internalOnlySidecar(change = 'fixture-change') {
  return {
    version: 1,
    change,
    intent: 'developer-workflow',
    runtimeWireBehavior: 'unchanged',
    surfaces: {
      publicV1: {
        status: 'not-applicable',
        reason: 'No public HTTP capability changes.',
      },
      mcp: {
        status: 'not-applicable',
        reason: 'No MCP capability changes.',
      },
      openapi: {
        status: 'not-applicable',
        reason: 'No OpenAPI operation changes.',
      },
      apiPlayground: {
        status: 'not-applicable',
        reason: 'No API Playground operation changes.',
      },
      internalOnly: {
        status: 'changed',
        scope: 'developer-workflow',
        reason: 'Only repository development tooling changes.',
      },
    },
    protocolDifferences: [],
    verification: {
      id: 'openspec-metadata',
      requiresWireCompatibilityFixture: false,
    },
  };
}

function excludedSidecar(change = 'fixture-change') {
  const sidecar = changedSidecar(change);
  sidecar.runtimeWireBehavior = 'unchanged';
  sidecar.surfaces.publicV1 = {
    status: 'changed',
    operationIds: ['tasks.events'],
    reason: 'The existing lifecycle stream is explicitly classified.',
  };
  sidecar.surfaces.mcp = {
    status: 'excluded',
    operationIds: ['tasks.events'],
    reason: 'The operation has no request-response tool mapping.',
    protocolReason: 'MCP tools cannot represent the lifecycle SSE stream.',
  };
  sidecar.surfaces.openapi = {
    status: 'derived',
    operationIds: ['tasks.events'],
    reason: 'OpenAPI retains the lifecycle stream operation.',
  };
  sidecar.surfaces.apiPlayground = {
    status: 'derived',
    operationIds: ['tasks.events'],
    reason: 'The Playground retains the lifecycle stream operation.',
  };
  sidecar.protocolDifferences = [
    {
      operation: 'tasks.events',
      kind: 'mcp-exclusion',
      detail: 'Lifecycle SSE remains REST-only.',
    },
  ];
  return sidecar;
}

function plannedSidecar(change = 'fixture-change') {
  const sidecar = changedSidecar(change);
  sidecar.surfaces.publicV1 = {
    status: 'changed',
    plannedOperationIds: ['widgets.create'],
    reason: 'The change adds a new Public V1 widget operation.',
  };
  sidecar.surfaces.mcp = {
    status: 'changed',
    plannedOperationIds: ['widgets.create'],
    plannedToolIds: ['create_widget'],
    reason: 'The change adds the corresponding MCP tool.',
  };
  sidecar.surfaces.openapi = {
    status: 'derived',
    plannedOperationIds: ['widgets.create'],
    reason: 'OpenAPI will derive the new operation.',
  };
  sidecar.surfaces.apiPlayground = {
    status: 'derived',
    plannedOperationIds: ['widgets.create'],
    reason: 'The Playground will derive the new operation.',
  };
  return sidecar;
}

function tasksMarkdown({ verifier = 'docs', requirement = 'sample/one' } = {}) {
  return [
    '## 1. Track: metadata (depends: none)',
    '',
    '- [ ] 1.1 Implement metadata',
    `  - requirements: [${JSON.stringify(requirement)}]`,
    '  - surfaces: ["openspec", "developer-workflow"]',
    `  - verify: ${JSON.stringify(verifier)}`,
    '',
    '## 2. Track: consumer (depends: metadata)',
    '',
    '- [ ] 2.1 Consume metadata',
    `  - requirements: [${JSON.stringify(requirement)}]`,
    '  - surfaces: ["docs"]',
    `  - verify: ${JSON.stringify(verifier)}`,
    '',
  ].join('\n');
}

function fixtureRepository(change = 'legacy-change') {
  const root = mkdtempSync(join(tmpdir(), 'cap-openspec-metadata-'));
  const specDirectory = join(root, 'openspec', 'specs', 'sample');
  const changeDirectory = join(root, 'openspec', 'changes', change);
  const registryDirectory = join(root, 'packages', 'contracts', 'src');
  mkdirSync(specDirectory, { recursive: true });
  mkdirSync(changeDirectory, { recursive: true });
  mkdirSync(registryDirectory, { recursive: true });
  writeFileSync(
    join(specDirectory, 'spec.md'),
    [
      '## Requirements',
      '',
      '### Requirement: One',
      'The fixture SHALL work.',
      '',
      '#### Scenario: Works',
      '- **WHEN** it runs',
      '- **THEN** it works',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(registryDirectory, 'public-v1-operations.ts'),
    [
      'export const PUBLIC_V1_OPERATIONS = definePublicV1Operations([',
      '  {',
      "    id: 'tasks.create',",
      "    mcp: { tool: 'create_task', differences: [] },",
      '  },',
      ']);',
      '',
    ].join('\n'),
  );
  writeFileSync(join(changeDirectory, 'tasks.md'), tasksMarkdown());
  return {
    root,
    change,
    changeDirectory,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('the live change has complete allowlisted task metadata', {
  skip: HAS_ACTIVE_DOGFOOD_CHANGE
    ? false
    : `${DOGFOOD_CHANGE} has been archived`,
}, () => {
  const plan = parseTaskMetadata(readFileSync(DOGFOOD_TASKS_PATH, 'utf8'), {
    allowedRequirementIds: collectRequirementIds(
      DEFAULT_REPO_ROOT,
      DOGFOOD_CHANGE,
    ),
  });
  assert.equal(plan.tasks.length, 42);
  assert.deepEqual(
    [...new Set(plan.tasks.map((task) => task.verify))].sort(),
    [
      'api-mcp',
      'api-public-errors',
      'api-v1',
      'contracts-registry',
      'docs',
      'openapi-playground',
      'openspec-metadata',
      'public-surface-fast',
      'public-surface-full',
      'workflow-gates',
    ],
  );
});

test('task-model evidence verification is fixed, offline, and shell-free', () => {
  const verifier = VERIFIER_ALLOWLIST['task-model-evidence'];
  assert.ok(verifier);
  assert.deepEqual(verifier.argv, [
    ['pnpm', '-w', 'exec', 'turbo', 'run', 'build', '--filter=@cap/api'],
    [process.execPath, 'apps/api/test/task-model-evidence-offline.mjs'],
  ]);
  assert.doesNotMatch(
    JSON.stringify(verifier.argv),
    /test:e2e:task-model-real-credential|claude-model-artifact-evidence/u,
  );
});

test('task parser rejects missing metadata, unknown requirements, and raw commands', () => {
  assert.throws(
    () =>
      parseTaskMetadata(
        [
          '## 1. Track: metadata (depends: none)',
          '- [ ] 1.1 Unsafe task',
          '  - requirements: ["sample/missing"]',
          '  - surfaces: ["openspec"]',
          '  - verify: "node -e process.exit(0)"',
        ].join('\n'),
        { allowedRequirementIds: new Set(['sample/one']) },
      ),
    (error) =>
      error instanceof MetadataValidationError &&
      error.message.includes('unknown requirement sample/missing') &&
      error.message.includes('unknown verifier node -e process.exit(0)'),
  );

  assert.throws(
    () =>
      parseTaskMetadata(
        [
          '## 1. Track: metadata (depends: none)',
          '- [ ] 1.1 Incomplete task',
          '  - requirements: ["sample/one"]',
        ].join('\n'),
        { allowedRequirementIds: new Set(['sample/one']) },
      ),
    /missing adjacent surfaces metadata/u,
  );
});

test('semantic requirement surfaces must share a track or an explicit dependency path', () => {
  const linkedPlan = parseTaskMetadata(
    [
      '## 1. Track: contract-rest (depends: none)',
      '',
      '- [ ] 1.1 Bind the shared contract and REST adapter',
      '  - requirements: ["sample/one"]',
      '  - surfaces: ["contracts", "public-v1"]',
      '  - verify: "docs"',
      '',
      '## 2. Track: mcp-adapter (depends: contract-rest)',
      '',
      '- [ ] 2.1 Bind the MCP adapter',
      '  - requirements: ["sample/one"]',
      '  - surfaces: ["mcp"]',
      '  - verify: "docs"',
      '',
      '## 3. Track: documentation (depends: none)',
      '',
      '- [ ] 3.1 Document the behavior',
      '  - requirements: ["sample/one"]',
      '  - surfaces: ["docs"]',
      '  - verify: "docs"',
      '',
      '## 4. Track: automation (depends: none)',
      '',
      '- [ ] 4.1 Add an independent CI note',
      '  - requirements: ["sample/one"]',
      '  - surfaces: ["ci"]',
      '  - verify: "docs"',
      '',
    ].join('\n'),
    { allowedRequirementIds: new Set(['sample/one']) },
  );
  assert.equal(linkedPlan.tasks.length, 4);

  assert.throws(
    () =>
      parseTaskMetadata(
        [
          '## 1. Track: contract (depends: none)',
          '',
          '- [ ] 1.1 Add the contract',
          '  - requirements: ["sample/one"]',
          '  - surfaces: ["contracts"]',
          '  - verify: "docs"',
          '',
          '## 2. Track: rest (depends: none)',
          '',
          '- [ ] 2.1 Add the REST adapter',
          '  - requirements: ["sample/one"]',
          '  - surfaces: ["public-v1"]',
          '  - verify: "docs"',
          '',
          '## 3. Track: mcp (depends: none)',
          '',
          '- [ ] 3.1 Add the MCP adapter',
          '  - requirements: ["sample/one"]',
          '  - surfaces: ["mcp"]',
          '  - verify: "docs"',
          '',
        ].join('\n'),
        { allowedRequirementIds: new Set(['sample/one']) },
      ),
    (error) =>
      error instanceof MetadataValidationError &&
      error.message.includes(
        'requirement sample/one has uncoupled semantic surfaces contracts (contract) and public-v1 (rest)',
      ) &&
      error.message.includes(
        'requirement sample/one has uncoupled semantic surfaces contracts (contract) and mcp (mcp)',
      ) &&
      error.message.includes(
        'requirement sample/one has uncoupled semantic surfaces public-v1 (rest) and mcp (mcp)',
      ),
  );
});

test('allowlisted runner uses fixed argv and shell false for every step', () => {
  const calls = [];
  runVerifier('openapi-playground', {
    cwd: '/fixture',
    stdio: 'pipe',
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args]),
    VERIFIER_ALLOWLIST['openapi-playground'].argv,
  );
  assert.ok(calls.every(({ options }) => options.shell === false));
  assert.ok(calls.every(({ options }) => options.cwd === '/fixture'));
  assert.ok(Object.isFrozen(VERIFIER_ALLOWLIST));

  let invoked = false;
  assert.throws(
    () =>
      runVerifier('node -e process.exit(0)', {
        spawnSyncImpl() {
          invoked = true;
          return { status: 0 };
        },
      }),
    /unknown verifier id/u,
  );
  assert.equal(invoked, false);
  assert.throws(
    () => runVerifier('toString', { spawnSyncImpl: () => ({ status: 0 }) }),
    /unknown verifier id/u,
  );
});

test('failed task verifier never edits the task checkbox', () => {
  const fixture = fixtureRepository();
  try {
    writeFileSync(
      join(fixture.changeDirectory, 'surface-impact.json'),
      `${JSON.stringify(internalOnlySidecar(fixture.change), null, 2)}\n`,
    );
    const tasksPath = join(fixture.changeDirectory, 'tasks.md');
    assert.throws(
      () =>
        runTaskVerifier(fixture.change, '1.1', {
          repoRoot: fixture.root,
          registryInventory: undefined,
          stdio: 'pipe',
          spawnSyncImpl() {
            return { status: 7 };
          },
        }),
      /verifier docs failed/u,
    );
    assert.match(readFileSync(tasksPath, 'utf8'), /- \[ \] 1\.1/u);
  } finally {
    fixture.cleanup();
  }
});

test('surface validator accepts changed, excluded, internal-only, and registry-wide decisions', () => {
  validateSurfaceImpactDocument(changedSidecar(), {
    changeName: 'fixture-change',
    phase: 'apply',
    registryInventory: KNOWN_REGISTRY,
  });
  validateSurfaceImpactDocument(excludedSidecar(), {
    changeName: 'fixture-change',
    phase: 'apply',
    registryInventory: KNOWN_REGISTRY,
  });
  validateSurfaceImpactDocument(internalOnlySidecar(), {
    changeName: 'fixture-change',
    phase: 'apply',
    registryInventory: KNOWN_REGISTRY,
  });

  const registryWide = changedSidecar();
  registryWide.runtimeWireBehavior = 'unchanged';
  registryWide.protocolDifferences.push({
    scope: 'all-existing',
    kind: 'error-envelope-compatibility',
    detail: 'All existing REST errors retain their legacy envelope.',
  });
  validateSurfaceImpactDocument(registryWide, {
    changeName: 'fixture-change',
    phase: 'apply',
    registryInventory: KNOWN_REGISTRY,
  });
});

test('all five surface statuses are closed and require their status-specific evidence', () => {
  assert.deepEqual(SURFACE_STATUSES, [
    'changed',
    'unchanged',
    'derived',
    'excluded',
    'not-applicable',
  ]);

  const missingReason = internalOnlySidecar();
  missingReason.surfaces.mcp.reason = '';
  assert.throws(
    () => validateSurfaceImpactDocument(missingReason, { changeName: 'fixture-change' }),
    /surfaces\.mcp\.reason must be a non-empty string/u,
  );

  const missingSelector = changedSidecar();
  delete missingSelector.surfaces.publicV1.operationIds;
  assert.throws(
    () =>
      validateSurfaceImpactDocument(missingSelector, {
        changeName: 'fixture-change',
        registryInventory: KNOWN_REGISTRY,
      }),
    /requires scope or operation\/tool ids/u,
  );

  const badExclusion = excludedSidecar();
  delete badExclusion.surfaces.mcp.protocolReason;
  assert.throws(
    () =>
      validateSurfaceImpactDocument(badExclusion, {
        changeName: 'fixture-change',
        registryInventory: KNOWN_REGISTRY,
      }),
    /protocolReason must be a non-empty string/u,
  );

  const mismatchedExclusion = excludedSidecar();
  mismatchedExclusion.protocolDifferences[0].operation = 'tasks.create';
  assert.throws(
    () =>
      validateSurfaceImpactDocument(mismatchedExclusion, {
        changeName: 'fixture-change',
        registryInventory: KNOWN_REGISTRY,
      }),
    /excludes tasks\.events but has no matching protocol exclusion/u,
  );

  const asymmetricExclusion = excludedSidecar();
  asymmetricExclusion.surfaces.publicV1.operationIds = ['tasks.create'];
  assert.throws(
    () =>
      validateSurfaceImpactDocument(asymmetricExclusion, {
        changeName: 'fixture-change',
        registryInventory: KNOWN_REGISTRY,
      }),
    /Public V1 and excluded MCP selectors disagree on tasks\.(?:create|events)/u,
  );

  const mappedOperationExclusion = excludedSidecar();
  mappedOperationExclusion.surfaces.publicV1.operationIds = ['tasks.create'];
  mappedOperationExclusion.surfaces.mcp.operationIds = ['tasks.create'];
  mappedOperationExclusion.protocolDifferences[0].operation = 'tasks.create';
  assert.throws(
    () =>
      validateSurfaceImpactDocument(mappedOperationExclusion, {
        changeName: 'fixture-change',
        registryInventory: KNOWN_REGISTRY,
      }),
    /declares tasks\.create excluded, but the registry maps it to an MCP tool/u,
  );

  const badScope = changedSidecar();
  badScope.protocolDifferences.push({
    scope: 'some-operations',
    kind: 'error-envelope-compatibility',
    detail: 'This scope is intentionally invalid.',
  });
  assert.throws(
    () =>
      validateSurfaceImpactDocument(badScope, {
        changeName: 'fixture-change',
        registryInventory: KNOWN_REGISTRY,
      }),
    /scope must equal "all-existing"/u,
  );

  const ambiguousSelector = changedSidecar();
  ambiguousSelector.surfaces.mcp.scope = 'all-existing';
  assert.throws(
    () =>
      validateSurfaceImpactDocument(ambiguousSelector, {
        changeName: 'fixture-change',
        registryInventory: KNOWN_REGISTRY,
      }),
    /surfaces\.mcp must declare either scope or operation\/tool ids, not both/u,
  );
});

test('public V1 changes require an explicit MCP change or reasoned exclusion', () => {
  const sidecar = changedSidecar();
  sidecar.surfaces.mcp = unchanged('MCP is claimed to be unchanged.');
  assert.throws(
    () =>
      validateSurfaceImpactDocument(sidecar, {
        changeName: 'fixture-change',
        registryInventory: KNOWN_REGISTRY,
      }),
    /requires MCP changed\/derived or a reasoned exclusion/u,
  );
});

test('MCP-only changes require a targeted inverse protocol rationale', () => {
  const sidecar = changedSidecar();
  sidecar.surfaces.publicV1 = unchanged(
    'The HTTP adapter intentionally keeps its existing behavior.',
  );
  assert.throws(
    () =>
      validateSurfaceImpactDocument(sidecar, {
        changeName: 'fixture-change',
        registryInventory: KNOWN_REGISTRY,
      }),
    /MCP-only change for tasks\.create requires a matching protocol difference explaining the inverse Public V1 decision/u,
  );

  sidecar.protocolDifferences.push({
    operation: 'tasks.create',
    kind: 'mcp-only-projection',
    detail:
      'Only MCP compatibility text changes; canonical HTTP input and output stay unchanged.',
  });
  validateSurfaceImpactDocument(sidecar, {
    changeName: 'fixture-change',
    registryInventory: KNOWN_REGISTRY,
  });
});

test('MCP operation and tool selectors must match each other and Public V1', () => {
  const registry = {
    operationIds: new Set([
      ...KNOWN_REGISTRY.operationIds,
      'repos.get',
    ]),
    toolIds: new Set([...KNOWN_REGISTRY.toolIds, 'get_repo']),
    toolByOperationId: new Map([
      ...KNOWN_REGISTRY.toolByOperationId,
      ['repos.get', 'get_repo'],
    ]),
  };
  const wrongTool = changedSidecar();
  wrongTool.surfaces.mcp.toolIds = ['get_repo'];
  assert.throws(
    () =>
      validateSurfaceImpactDocument(wrongTool, {
        changeName: 'fixture-change',
        registryInventory: registry,
      }),
    (error) =>
      error instanceof MetadataValidationError &&
      error.message.includes(
        'surfaces.mcp operation tasks.create requires mapped tool create_task',
      ) &&
      error.message.includes(
        'surfaces.mcp tool get_repo requires mapped operation repos.get',
      ),
  );

  const mismatchedOperations = changedSidecar();
  mismatchedOperations.surfaces.mcp.operationIds = ['repos.get'];
  mismatchedOperations.surfaces.mcp.toolIds = ['get_repo'];
  assert.throws(
    () =>
      validateSurfaceImpactDocument(mismatchedOperations, {
        changeName: 'fixture-change',
        registryInventory: registry,
      }),
    (error) =>
      error instanceof MetadataValidationError &&
      error.message.includes(
        'Public V1/MCP selectors disagree on tasks.create without a matching protocol difference',
      ) &&
      error.message.includes(
        'Public V1/MCP selectors disagree on repos.get without a matching protocol difference',
      ),
  );

  mismatchedOperations.protocolDifferences.push(
    {
      operation: 'tasks.create',
      kind: 'rest-only-capability',
      detail: 'This change intentionally affects only the REST task operation.',
    },
    {
      operation: 'repos.get',
      kind: 'mcp-only-capability',
      detail: 'This change intentionally affects only the MCP repo operation.',
    },
  );
  validateSurfaceImpactDocument(mismatchedOperations, {
    changeName: 'fixture-change',
    registryInventory: registry,
  });
});

test('operation-scoped sidecar differences exactly match selected registry differences at verify', () => {
  const registry = {
    operationIds: new Set([
      'tasks.create',
      'tasks.events',
      'runtimeModels.query',
      'schedules.delete',
    ]),
    toolIds: new Set([
      'create_task',
      'list_runtime_models',
      'delete_schedule',
    ]),
    toolByOperationId: new Map([
      ['tasks.create', 'create_task'],
      ['runtimeModels.query', 'list_runtime_models'],
      ['schedules.delete', 'delete_schedule'],
    ]),
    excludedOperationIds: new Set(['tasks.events']),
    differenceKindsByOperationId: new Map([
      [
        'tasks.create',
        new Set([
          'rest-only-header',
          'mcp-compatibility-text',
          'mcp-description-projection',
          'rate-limit-policy',
        ]),
      ],
      ['runtimeModels.query', new Set(['rate-limit-policy'])],
      ['schedules.delete', new Set(['success-projection'])],
    ]),
  };
  const sidecar = changedSidecar();
  for (const key of ['publicV1', 'mcp', 'openapi', 'apiPlayground']) {
    sidecar.surfaces[key] = {
      status: key === 'publicV1' || key === 'mcp' ? 'changed' : 'derived',
      scope: 'all-existing',
      reason: `The ${key} registry-wide projection changes.`,
    };
  }
  sidecar.protocolDifferences = [
    {
      operation: 'tasks.create',
      kind: 'rest-only-header',
      detail: 'The HTTP header is not an MCP input.',
    },
    {
      operation: 'tasks.create',
      kind: 'mcp-compatibility-text',
      detail: 'The existing text result remains available.',
    },
    {
      operation: 'tasks.create',
      kind: 'mcp-description-projection',
      detail: 'MCP uses transport-specific description copy.',
    },
    {
      operation: 'tasks.create',
      kind: 'rate-limit-policy',
      detail: 'The transports retain their own limiter policies.',
    },
    {
      operation: 'tasks.events',
      kind: 'mcp-exclusion',
      detail: 'SSE has no request-response MCP mapping.',
    },
    {
      operation: 'runtimeModels.query',
      kind: 'rate-limit-policy',
      detail:
        'Public V1 has a dedicated principal catalog throttle while MCP uses its transport limiter.',
    },
    {
      operation: 'schedules.delete',
      kind: 'success-projection',
      detail: 'REST 204 maps to an MCP acknowledgement.',
    },
  ];
  validateSurfaceImpactDocument(sidecar, {
    changeName: 'fixture-change',
    phase: 'verify',
    registryInventory: registry,
  });

  const missingCompatibilityText = structuredClone(sidecar);
  missingCompatibilityText.protocolDifferences =
    missingCompatibilityText.protocolDifferences.filter(
      (difference) => difference.kind !== 'mcp-compatibility-text',
    );
  assert.throws(
    () =>
      validateSurfaceImpactDocument(missingCompatibilityText, {
        changeName: 'fixture-change',
        phase: 'verify',
        registryInventory: registry,
      }),
    /registry protocol difference tasks\.create\/mcp-compatibility-text is missing/u,
  );

  const missingRuntimeRatePolicy = structuredClone(sidecar);
  missingRuntimeRatePolicy.protocolDifferences =
    missingRuntimeRatePolicy.protocolDifferences.filter(
      (difference) =>
        !(
          difference.operation === 'runtimeModels.query' &&
          difference.kind === 'rate-limit-policy'
        ),
    );
  assert.throws(
    () =>
      validateSurfaceImpactDocument(missingRuntimeRatePolicy, {
        changeName: 'fixture-change',
        phase: 'verify',
        registryInventory: registry,
      }),
    /registry protocol difference runtimeModels\.query\/rate-limit-policy is missing/u,
  );

  const aliasedSuccessProjection = structuredClone(sidecar);
  const successDifference = aliasedSuccessProjection.protocolDifferences.find(
    (difference) => difference.operation === 'schedules.delete',
  );
  successDifference.kind = 'output-projection';
  assert.throws(
    () =>
      validateSurfaceImpactDocument(aliasedSuccessProjection, {
        changeName: 'fixture-change',
        phase: 'verify',
        registryInventory: registry,
      }),
    (error) =>
      error instanceof MetadataValidationError &&
      error.message.includes(
        'registry protocol difference schedules.delete/success-projection is missing',
      ) &&
      error.message.includes(
        'protocolDifferences declares schedules.delete/output-projection, but the registry does not declare that operation difference',
      ),
  );
});

test('planned ids are explicit and verify fails until the registry implements them', () => {
  const sidecar = plannedSidecar();
  validateSurfaceImpactDocument(sidecar, {
    changeName: 'fixture-change',
    phase: 'propose',
    registryInventory: KNOWN_REGISTRY,
  });
  validateSurfaceImpactDocument(sidecar, {
    changeName: 'fixture-change',
    phase: 'apply',
    registryInventory: KNOWN_REGISTRY,
  });
  assert.throws(
    () =>
      validateSurfaceImpactDocument(sidecar, {
        changeName: 'fixture-change',
        phase: 'verify',
        registryInventory: KNOWN_REGISTRY,
      }),
    (error) =>
      error instanceof MetadataValidationError &&
      error.message.includes('planned operation id widgets.create is not implemented') &&
      error.message.includes('planned tool id create_widget is not implemented'),
  );
  validateSurfaceImpactDocument(sidecar, {
    changeName: 'fixture-change',
    phase: 'verify',
    registryInventory: {
      operationIds: new Set([...KNOWN_REGISTRY.operationIds, 'widgets.create']),
      toolIds: new Set([...KNOWN_REGISTRY.toolIds, 'create_widget']),
      toolByOperationId: new Map([
        ...KNOWN_REGISTRY.toolByOperationId,
        ['widgets.create', 'create_widget'],
      ]),
    },
  });

  const disguisedTypo = changedSidecar();
  disguisedTypo.surfaces.publicV1.operationIds = ['widgets.create'];
  assert.throws(
    () =>
      validateSurfaceImpactDocument(disguisedTypo, {
        changeName: 'fixture-change',
        phase: 'propose',
        registryInventory: KNOWN_REGISTRY,
      }),
    /references unknown operation id widgets\.create/u,
  );

  const plannedExclusion = excludedSidecar();
  plannedExclusion.surfaces.mcp.plannedOperationIds = ['widgets.create'];
  assert.throws(
    () =>
      validateSurfaceImpactDocument(plannedExclusion, {
        changeName: 'fixture-change',
        phase: 'apply',
        registryInventory: KNOWN_REGISTRY,
      }),
    /may mark planned ids only when status is changed or derived/u,
  );
});

test('registry inventory is loaded from the canonical source without executing TypeScript', () => {
  const inventory = loadRegistryInventory(DEFAULT_REPO_ROOT);
  assert.ok(inventory);
  assert.ok(inventory.operationIds.has('tasks.create'));
  assert.ok(inventory.operationIds.has('tasks.events'));
  assert.ok(inventory.toolIds.has('create_task'));
  assert.equal(inventory.toolIds.has('tasks.events'), false);
  assert.equal(inventory.toolByOperationId.get('tasks.create'), 'create_task');
  assert.equal(inventory.toolByOperationId.has('tasks.events'), false);
  assert.ok(inventory.excludedOperationIds.has('tasks.events'));
  assert.deepEqual(
    [...inventory.differenceKindsByOperationId.get('tasks.create')],
    [
      'rest-only-header',
      'mcp-compatibility-text',
      'mcp-description-projection',
      'rate-limit-policy',
    ],
  );
  assert.deepEqual(
    [...inventory.differenceKindsByOperationId.get('runtimeModels.query')],
    ['rate-limit-policy'],
  );
  assert.deepEqual(
    [...inventory.differenceKindsByOperationId.get('schedules.delete')],
    ['success-projection'],
  );
  assert.deepEqual(
    [...inventory.differenceKindsByOperationId.get('tasks.transcript')],
    ['mcp-output-schema-relaxation'],
  );

  if (HAS_ACTIVE_DOGFOOD_CHANGE) {
    assert.doesNotThrow(() =>
      validateChangeMetadata(DOGFOOD_CHANGE, {
        repoRoot: DEFAULT_REPO_ROOT,
        phase: 'apply',
        registryInventory: inventory,
      }),
    );
  }
});

test('registry inventory parsing tolerates formatting but fails closed on structural drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-registry-inventory-'));
  const sourceDirectory = join(root, 'packages', 'contracts', 'src');
  const registryPath = join(sourceDirectory, 'public-v1-operations.ts');
  mkdirSync(sourceDirectory, { recursive: true });
  try {
    writeFileSync(
      registryPath,
      [
        'const CREATE_DIFFERENCES = [{ kind: "rest-only-header" }] as const;',
        'export const',
        '  PUBLIC_V1_OPERATIONS =',
        '    definePublicV1Operations',
        '    (',
        '      [',
        '        {',
        '          id : "tasks.create",',
        '          mcp : { tool : "create_task", differences: CREATE_DIFFERENCES },',
        '        },',
        '        { id: \'tasks.events\', mcp: { excluded: \'SSE only\' } },',
        '      ],',
        '    );',
        '',
      ].join('\n'),
    );
    const inventory = loadRegistryInventory(root);
    assert.deepEqual([...inventory.operationIds], [
      'tasks.create',
      'tasks.events',
    ]);
    assert.deepEqual([...inventory.toolIds], ['create_task']);
    assert.deepEqual([...inventory.toolByOperationId], [
      ['tasks.create', 'create_task'],
    ]);
    assert.deepEqual([...inventory.excludedOperationIds], ['tasks.events']);
    assert.deepEqual(
      [...inventory.differenceKindsByOperationId.get('tasks.create')],
      ['rest-only-header'],
    );

    writeFileSync(
      registryPath,
      [
        'export const PUBLIC_V1_OPERATIONS = definePublicV1Operations([',
        '  {',
        "    id: 'tasks.create',",
        "    mcp: { tool: 'create_task', differences: buildDifferences() },",
        '  },',
        ']);',
        '',
      ].join('\n'),
    );
    assert.throws(
      () => loadRegistryInventory(root),
      /differences must be a static array literal or a direct static-array constant/u,
    );

    writeFileSync(
      registryPath,
      'export const PUBLIC_V1_OPERATIONS = buildElsewhere();\n',
    );
    assert.throws(
      () => loadRegistryInventory(root),
      (error) =>
        error instanceof MetadataValidationError &&
        error.subject === 'public registry inventory' &&
        error.message.includes('direct definePublicV1Operations'),
    );

    rmSync(registryPath);
    assert.throws(
      () => loadRegistryInventory(root),
      /public-v1-operations\.ts is required/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diff-aware migration validates touched changes without bulk-failing legacy changes', () => {
  const fixture = fixtureRepository();
  try {
    assert.deepEqual(
      validateChangedOpenSpecChanges([], {
        repoRoot: fixture.root,
        registryInventory: undefined,
      }),
      [],
    );
    assert.throws(
      () =>
        validateChangedOpenSpecChanges(
          [`openspec/changes/${fixture.change}/tasks.md`],
          { repoRoot: fixture.root, registryInventory: undefined },
        ),
      /surface-impact\.json is required/u,
    );

    writeFileSync(
      join(fixture.changeDirectory, 'surface-impact.json'),
      `${JSON.stringify(internalOnlySidecar(fixture.change), null, 2)}\n`,
    );
    const validated = validateChangedOpenSpecChanges(
      [`openspec/changes/${fixture.change}/tasks.md`],
      { repoRoot: fixture.root, registryInventory: undefined },
    );
    assert.equal(validated.length, 1);
    assert.equal(validated[0].changeName, fixture.change);
    assert.deepEqual(
      changedOpenSpecChangeNames([
        'openspec/changes/archive/2026-01-01-old/tasks.md',
        `openspec/changes/${fixture.change}/surface-impact.json`,
        'apps/api/src/app.module.ts',
      ]),
      [fixture.change],
    );
  } finally {
    fixture.cleanup();
  }
});

test('Codex and Claude propose/apply instructions remain byte-identical', () => {
  for (const skill of ['openspec-propose', 'openspec-apply-change']) {
    const codex = readFileSync(
      join(DEFAULT_REPO_ROOT, '.codex', 'skills', skill, 'SKILL.md'),
    );
    const claude = readFileSync(
      join(DEFAULT_REPO_ROOT, '.claude', 'skills', skill, 'SKILL.md'),
    );
    assert.deepEqual(codex, claude, `${skill} instructions drifted`);
    const text = codex.toString('utf8');
    assert.match(text, /scripts\/openspec-metadata\.mjs/u);
    assert.match(text, /artifact dependency graph/u);
  }
});

test('metadata enforcement leaves the OpenSpec CLI schema and artifact graph unchanged', () => {
  const schemaPath = join(
    DEFAULT_REPO_ROOT,
    'openspec',
    'schemas',
    'spec-driven',
    'schema.yaml',
  );
  const schema = readFileSync(schemaPath);
  assert.equal(
    createHash('sha256').update(schema).digest('hex'),
    'd37cd90778df150b95f975ac2fa1bc111211d1c20180de56bb7b38807665fecc',
  );
  const text = schema.toString('utf8');
  assert.doesNotMatch(text, /surface-impact\.json/u);
  assert.match(text, /artifacts:\n  - id: proposal/u);
  assert.match(text, /  - id: specs/u);
  assert.match(text, /  - id: design/u);
  assert.match(text, /  - id: tasks/u);
  assert.match(text, /apply:\n  requires:\n    - tasks/u);

  const implementation = readFileSync(
    join(DEFAULT_REPO_ROOT, 'scripts', 'openspec-metadata.mjs'),
    'utf8',
  );
  assert.doesNotMatch(implementation, /openspec\s+schema\s+(?:fork|edit|remove)/u);
  assert.doesNotMatch(implementation, /spawnSync\(\s*['"]openspec['"]/u);
});
