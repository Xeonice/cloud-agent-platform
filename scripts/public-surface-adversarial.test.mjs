import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_REPO_ROOT,
  validateChangeMetadata,
} from './openspec-metadata.mjs';
import {
  DYNAMIC_PUBLIC_TASK_SURFACES,
  PUBLIC_SURFACE_EVIDENCE_LANES,
  PUBLIC_SURFACE_VERIFY_COMMAND,
  buildPublicSurfaceVerificationPlan,
  changedSurfacesFromClassification,
  collectCompleteDiffPaths,
  evaluatePublicSurfaceEvidence,
  routePublicSurfaceFindings,
  verificationExitCode,
  verifyPublicSurfaceChange,
} from './public-surface-adversarial.mjs';
import { classifyPublicSurfaceFiles } from './public-surface-files.mjs';

const FIXTURE_CHANGE = 'public-surface-fixture';
const FIXTURE_REQUIREMENT = 'sample/public-widget-contract';
const FIXTURE_OPERATION = 'widgets.create';
const FIXTURE_TOOL = 'create_widget';
const WORKFLOW_SOURCE = readFileSync(
  join(DEFAULT_REPO_ROOT, '.claude', 'workflows', 'opsx-verify.js'),
  'utf8',
);

function fixtureSurfaceImpact() {
  const selectedOperation = { operationIds: [FIXTURE_OPERATION] };
  return {
    version: 1,
    change: FIXTURE_CHANGE,
    intent: 'public-feature-fixture',
    runtimeWireBehavior: 'changed',
    surfaces: {
      publicV1: {
        status: 'changed',
        ...selectedOperation,
        reason: 'Exercise one synthetic REST operation.',
      },
      mcp: {
        status: 'changed',
        ...selectedOperation,
        toolIds: [FIXTURE_TOOL],
        reason: 'Exercise the synthetic operation through one MCP mapping.',
      },
      openapi: {
        status: 'derived',
        ...selectedOperation,
        reason: 'Project the synthetic operation into OpenAPI.',
      },
      apiPlayground: {
        status: 'derived',
        ...selectedOperation,
        reason: 'Project the synthetic operation into the API Playground.',
      },
      internalOnly: {
        status: 'unchanged',
        reason: 'The fixture does not model an internal-only change.',
      },
    },
    protocolDifferences: [],
    verification: {
      id: 'public-surface-full',
      requiresWireCompatibilityFixture: true,
    },
  };
}

function writePublicSurfaceFixture(root) {
  const changeRoot = join(root, 'openspec', 'changes', FIXTURE_CHANGE);
  const registryRoot = join(root, 'packages', 'contracts', 'src');
  const mcpRoot = join(root, 'apps', 'api', 'src', 'mcp');
  mkdirSync(join(changeRoot, 'specs', 'sample'), { recursive: true });
  mkdirSync(registryRoot, { recursive: true });
  mkdirSync(mcpRoot, { recursive: true });

  writeFileSync(
    join(changeRoot, 'surface-impact.json'),
    `${JSON.stringify(fixtureSurfaceImpact(), null, 2)}\n`,
  );
  writeFileSync(
    join(changeRoot, 'tasks.md'),
    [
      '## 1. Track: public-surface-fixture (depends: none)',
      '',
      '- [x] 1.1 Verify the synthetic public widget contract.',
      `  - requirements: ["${FIXTURE_REQUIREMENT}"]`,
      '  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground"]',
      '  - verify: "public-surface-full"',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(changeRoot, 'specs', 'sample', 'spec.md'),
    [
      '## ADDED Requirements',
      '',
      '### Requirement: Public widget contract',
      '',
      'The fixture SHALL expose one synthetic widget operation consistently.',
      '',
      '#### Scenario: Widget operation remains aligned',
      '',
      '- **WHEN** the fixture public surfaces are verified',
      '- **THEN** REST and MCP expose the same synthetic widget fields',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(registryRoot, 'public-v1-operations.ts'),
    [
      'export const PUBLIC_V1_OPERATIONS = definePublicV1Operations([',
      '  {',
      `    id: '${FIXTURE_OPERATION}',`,
      '    mcp: {',
      `      tool: '${FIXTURE_TOOL}',`,
      '      differences: [],',
      '    },',
      '  },',
      '] as const);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(mcpRoot, 'mcp-tools.ts'),
    'export const fixtureMcpVersion = 1;\n',
  );
  return { changeRoot, mcpRoot };
}

function initializeFixtureRepository(root) {
  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.email', 'fixture@example.invalid']);
  runGit(root, ['config', 'user.name', 'Public Surface Fixture']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'fixture baseline']);
  return runGit(root, ['rev-parse', 'HEAD']);
}

function withPublicSurfaceFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'cap-public-surface-fixture-'));
  try {
    writePublicSurfaceFixture(root);
    const base = initializeFixtureRepository(root);
    return run(root, base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function compileVerifyWorkflow() {
  const executableBody = WORKFLOW_SOURCE.replace(
    /^export const meta =/u,
    'const meta =',
  );
  return new Function(
    'args',
    'agent',
    'phase',
    'log',
    'pipeline',
    'parallel',
    `return async function workflow() {\n${executableBody}\n}`,
  );
}

async function runDeterministicVerdictThroughVerify(item = null) {
  const requirementId = 'sample/public-widget-contract';
  const workflow = compileVerifyWorkflow();
  const agent = async (_prompt, options) => {
    if (options.label === 'enumerate') {
      return {
        requirements: [
          {
            capability: 'sample',
            name: 'Public widget contract',
            scenarios: ['Public widget remains aligned'],
          },
        ],
      };
    }
    if (options.label === 'enumerate:public-surface-plan') {
      return {
        changeName: 'fixture',
        phase: 'verify',
        requirements: [
          {
            requirementId,
            taskIds: ['1.1'],
            surfaces: ['public-v1', 'mcp'],
            dynamicRequired: true,
            evidenceLanes: [...PUBLIC_SURFACE_EVIDENCE_LANES],
          },
        ],
      };
    }
    if (options.label === 'dynamic:public-surface-verdict') {
      const passed = item === null;
      const passedLane = { passed: true, evidence: 'fixture evidence' };
      const failedLane = {
        passed: false,
        evidence: item?.detail ?? 'fixture failure',
      };
      return {
        verdictVersion: 1,
        changeName: 'fixture',
        phase: 'verify',
        requirementIds: [requirementId],
        passed,
        command: {
          argv: [
            PUBLIC_SURFACE_VERIFY_COMMAND.command,
            ...PUBLIC_SURFACE_VERIFY_COMMAND.args,
          ],
          shell: false,
          ran: true,
          exitCode: item?.commandExitCode ?? (passed ? 0 : 1),
        },
        sidecar: passedLane,
        registry: passed ? passedLane : failedLane,
        restMetadata: passed ? passedLane : failedLane,
        mcpSdkMetadata: passed ? passedLane : failedLane,
        behavior: passed ? passedLane : failedLane,
        findings: item
          ? [
              {
                kind: item.kind,
                route: item.route,
                requirementIds: item.requirementIds,
                reason: item.detail,
                blocking: item.blocking,
              },
            ]
          : [],
      };
    }
    if (options.label.startsWith('triage:')) {
      return {
        met: true,
        confidence: 'high',
        risk: 'low',
        evidence: 'fixture:1',
      };
    }
    if (options.label.startsWith('refute:')) {
      return { lens: options.label, refuted: false, reason: 'survives' };
    }
    if (options.label === 'check:gap' || options.label === 'check:scope') {
      return [];
    }
    if (options.label === 'route:findings') {
      return {
        reopenedTasks:
          item?.route === 'unmet' ? [...item.requirementIds] : [],
        specDefects:
          item?.route === 'spec-defect' ? [...item.requirementIds] : [],
        blockingSpecDefects:
          item?.route === 'spec-defect' ? [...item.requirementIds] : [],
        reclassifiedMet: [],
      };
    }
    throw new Error(`Unexpected workflow agent label: ${options.label}`);
  };
  const parallel = async (steps) => Promise.all(steps.map((step) => step()));
  const pipeline = async (items, first, second) =>
    Promise.all(
      items.map(async (entry) => second(await first(entry))),
    );
  const execute = workflow(
    JSON.stringify({ changeName: 'fixture', changeDir: 'fixture/change' }),
    agent,
    () => {},
    () => {},
    pipeline,
    parallel,
  );
  return execute();
}

async function runFindingThroughVerify(item) {
  return runDeterministicVerdictThroughVerify(item);
}

function fixtureSidecar() {
  return {
    surfaces: {
      publicV1: {
        status: 'changed',
        operationIds: ['widgets.create'],
      },
      mcp: {
        status: 'changed',
        operationIds: ['widgets.create'],
        toolIds: ['create_widget'],
      },
      openapi: {
        status: 'derived',
        operationIds: ['widgets.create'],
      },
      apiPlayground: {
        status: 'derived',
        operationIds: ['widgets.create'],
      },
    },
  };
}

function healthyEvidence() {
  return {
    requirementIds: ['sample/public-widget-contract'],
    changedSurfaces: ['publicV1', 'mcp'],
    sidecar: fixtureSidecar(),
    lanes: Object.fromEntries(
      PUBLIC_SURFACE_EVIDENCE_LANES.map((lane) => [lane, true]),
    ),
    operations: [
      {
        id: 'widgets.create',
        registry: {
          rest: { inputFields: ['name', 'priority'] },
          mcp: {
            status: 'mapped',
            tool: 'create_widget',
            inputFields: ['name', 'priority'],
          },
        },
        rest: {
          present: true,
          inputFields: ['name', 'priority'],
          forwardedInputFields: ['name', 'priority'],
        },
        mcp: {
          present: true,
          tool: 'create_widget',
          inputFields: ['name', 'priority'],
          forwardedInputFields: ['name', 'priority'],
        },
      },
    ],
  };
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr ?? ''}`,
  );
  return String(result.stdout ?? '').trim();
}

function focusedEvidenceFixture({ stripMcpField = false } = {}) {
  const fields = ['canonicalField', 'optionalField'];
  const operations = [
    {
      id: FIXTURE_OPERATION,
      registry: {
        rest: { inputFields: fields },
        mcp: {
          status: 'mapped',
          tool: FIXTURE_TOOL,
          inputFields: fields,
        },
      },
      rest: {
        present: true,
        inputFields: fields,
        forwardedInputFields: fields,
      },
      mcp: {
        present: true,
        tool: FIXTURE_TOOL,
        inputFields: fields,
        forwardedInputFields: stripMcpField ? fields.slice(0, -1) : fields,
      },
    },
  ];
  return {
    evidence: {
      version: 1,
      collector: 'api-focused-public-surface',
      operations,
    },
    fieldBearingOperation: FIXTURE_OPERATION,
    strippedField: 'optionalField',
  };
}

function runPublicSurfaceCliMutation({
  mutateSidecar = () => {},
  stripMcpField = false,
  gateExitCode = 0,
}) {
  const root = mkdtempSync(join(tmpdir(), 'cap-public-surface-cli-'));
  try {
    const { changeRoot, mcpRoot } = writePublicSurfaceFixture(root);
    const binRoot = join(root, 'fixture-bin');
    mkdirSync(binRoot, { recursive: true });
    const base = initializeFixtureRepository(root);

    const sidecarPath = join(changeRoot, 'surface-impact.json');
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    mutateSidecar(sidecar);
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
    writeFileSync(
      join(mcpRoot, 'mcp-tools.ts'),
      'export const fixtureMcpVersion = 2;\n',
    );

    const fixture = focusedEvidenceFixture({ stripMcpField });
    const evidencePath = join(root, 'focused-evidence.json');
    writeFileSync(evidencePath, `${JSON.stringify(fixture.evidence)}\n`);
    const pnpmFixture = join(binRoot, 'pnpm');
    writeFileSync(
      pnpmFixture,
      '#!/bin/sh\ncp "$CAP_TEST_PUBLIC_SURFACE_EVIDENCE" ' +
        `"$CAP_PUBLIC_SURFACE_EVIDENCE_PATH"\nexit ${gateExitCode}\n`,
    );
    chmodSync(pnpmFixture, 0o755);
    const result = spawnSync(
      process.execPath,
      [
        join(DEFAULT_REPO_ROOT, 'scripts', 'public-surface-adversarial.mjs'),
        'verify',
        FIXTURE_CHANGE,
        '--repo-root',
        root,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CAP_PUBLIC_SURFACE_BASE_SHA: base,
          CAP_TEST_PUBLIC_SURFACE_EVIDENCE: evidencePath,
          PATH: `${binRoot}:${process.env.PATH ?? ''}`,
        },
        encoding: 'utf8',
        shell: false,
      },
    );
    return { result, fixture };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('fixture task metadata forces every touched public requirement through all evidence lanes', () => {
  withPublicSurfaceFixture((repoRoot) => {
    const validated = validateChangeMetadata(FIXTURE_CHANGE, {
      repoRoot,
      phase: 'apply',
    });
    const plan = buildPublicSurfaceVerificationPlan(validated.taskPlan);
    const byRequirement = new Map(
      plan.map((entry) => [entry.requirementId, entry]),
    );
    const publicSurfaces = new Set(DYNAMIC_PUBLIC_TASK_SURFACES);

    for (const task of validated.taskPlan.tasks) {
      if (!task.surfaces.some((surface) => publicSurfaces.has(surface))) continue;
      for (const requirementId of task.requirements) {
        const routed = byRequirement.get(requirementId);
        assert.ok(routed, `${requirementId} is present in dynamic routing`);
        assert.equal(routed.dynamicRequired, true, requirementId);
        assert.deepEqual(
          routed.evidenceLanes,
          PUBLIC_SURFACE_EVIDENCE_LANES,
          requirementId,
        );
      }
    }

    assert.equal(
      byRequirement.get(FIXTURE_REQUIREMENT)?.dynamicRequired,
      true,
    );
  });
});

test('complete diff classification includes committed, staged, unstaged, and untracked surfaces', () => {
  const calls = [];
  const outputs = new Map([
    [
      'diff --cached --name-only --diff-filter=ACMRD -z',
      'apps/api/src/v1/staged.ts\0',
    ],
    [
      'diff --name-only --diff-filter=ACMRD -z',
      'apps/api/src/mcp/unstaged.ts\0',
    ],
    [
      'ls-files --others --exclude-standard -z',
      'apps/web/src/components/api/untracked.ts\0',
    ],
    [
      'diff --name-only --diff-filter=ACMRD -z base-sha...HEAD',
      'packages/contracts/src/committed.ts\0',
    ],
  ]);
  const paths = collectCompleteDiffPaths({
    repoRoot: '/fixture',
    env: { CAP_PUBLIC_SURFACE_BASE_SHA: 'base-sha' },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      const stdout = outputs.get(args.join(' '));
      assert.notEqual(stdout, undefined, `unexpected git argv: ${args.join(' ')}`);
      return { status: 0, stdout, stderr: '' };
    },
  });

  assert.deepEqual(paths, [
    'apps/api/src/mcp/unstaged.ts',
    'apps/api/src/v1/staged.ts',
    'apps/web/src/components/api/untracked.ts',
    'packages/contracts/src/committed.ts',
  ]);
  assert.ok(calls.every((call) => call.command === 'git'));
  assert.ok(calls.every((call) => call.options.shell === false));
  assert.deepEqual(
    changedSurfacesFromClassification(
      classifyPublicSurfaceFiles(paths, '/fixture'),
    ),
    ['apiPlayground', 'mcp', 'openapi', 'publicV1'],
  );
});

test('opsx verify consumes the metadata plan and cannot outvote dynamic blockers', () => {
  assert.doesNotThrow(
    () => compileVerifyWorkflow(),
    'workflow remains syntactically valid in its async DSL wrapper',
  );

  assert.match(
    WORKFLOW_SOURCE,
    /public-surface-adversarial\.mjs plan/u,
    'workflow consumes the repository-owned routing plan',
  );
  assert.match(
    WORKFLOW_SOURCE,
    /req\.dynamicRequired \|\| triage\.risk === 'high'/u,
    'task metadata forces escalation independently of static risk',
  );
  assert.match(
    WORKFLOW_SOURCE,
    /expectedArgv = \['pnpm', 'test:public-surface'\]/u,
    'workflow validates the deterministic child argv',
  );
  assert.match(
    WORKFLOW_SOURCE,
    /public-surface-adversarial\.mjs verify/u,
    'workflow consumes the deterministic verify CLI verdict',
  );
  assert.match(
    WORKFLOW_SOURCE,
    /deterministicPublicVerdict\(req\)/u,
    'public requirements use machine routing instead of an LLM verdict',
  );
  for (const lane of PUBLIC_SURFACE_EVIDENCE_LANES) {
    assert.match(WORKFLOW_SOURCE, new RegExp(`\\b${lane}\\b`, 'u'), lane);
  }
  assert.match(
    WORKFLOW_SOURCE,
    /!dyn\.refuted && !dyn\.archiveBlocked/u,
    'a dynamic failure cannot be majority-voted away',
  );
  assert.match(
    WORKFLOW_SOURCE,
    /pass: confirmedUnmet === 0 && blockingSpecDefects\.size === 0/u,
    'archive requires both unmet and blocking specification defects to be clear',
  );
  assert.match(
    WORKFLOW_SOURCE,
    /publicGroundTruth\.command\.exitCode === 0[\s\S]*lanesPassed[\s\S]*blockingFindings\.length === 0/u,
    'a zero focused-gate exit cannot outvote evaluator findings or failed evidence lanes',
  );
  assert.match(
    WORKFLOW_SOURCE,
    /field set in BOTH directions/u,
    'dynamic verify compares missing and extra fields',
  );
  assert.match(
    WORKFLOW_SOURCE,
    /registry-declared projection\/difference is the only allowance/u,
    'only explicit registry metadata may authorize a field difference',
  );
});

test('deterministic verify uses fixed argv and fails non-zero with a blocking finding', () => {
  withPublicSurfaceFixture((repoRoot, base) => {
    const calls = [];
    const verdict = verifyPublicSurfaceChange(FIXTURE_CHANGE, {
      repoRoot,
      env: { CAP_PUBLIC_SURFACE_BASE_SHA: base },
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, options });
        return {
          status: 23,
          stdout:
            'setup noise\n FAIL fixture.test.ts > exact gate\n' +
            'AssertionError: fixture focused failure\ntrailing noise',
          stderr: 'turbo summary',
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, PUBLIC_SURFACE_VERIFY_COMMAND.command);
    assert.deepEqual(calls[0].args, PUBLIC_SURFACE_VERIFY_COMMAND.args);
    assert.equal(calls[0].options.shell, false);
    assert.equal(verdict.command.exitCode, 23);
    assert.equal(verdict.passed, false);
    assert.equal(verificationExitCode(verdict), 1);
    assert.equal(verdict.sidecar.passed, true);
    assert.equal(verdict.registry.passed, false);
    assert.equal(
      verdict.registry.evidence,
      'pnpm test:public-surface exited 23.',
    );
    assert.match(verdict.findings[0]?.reason ?? '', /fixture focused failure/u);
    assert.doesNotMatch(verdict.findings[0]?.reason ?? '', /setup noise/u);
    assert.ok(
      verdict.findings.some(
        (item) =>
          item.kind === 'public-surface-gate-failed' &&
          item.route === 'unmet' &&
          item.blocking,
      ),
    );
    assert.equal(routePublicSurfaceFindings(verdict.findings).pass, false);

    const rootPackage = JSON.parse(
      readFileSync(join(DEFAULT_REPO_ROOT, 'package.json'), 'utf8'),
    );
    assert.doesNotMatch(
      rootPackage.scripts['test:public-surface'],
      /public-surface-adversarial\.mjs\s+verify/u,
      'the root focused gate never recursively invokes the verify CLI',
    );
  });
});

test('a zero focused-gate exit without a collector artifact fails closed', () => {
  withPublicSurfaceFixture((repoRoot, base) => {
    const verdict = verifyPublicSurfaceChange(FIXTURE_CHANGE, {
      repoRoot,
      env: { CAP_PUBLIC_SURFACE_BASE_SHA: base },
      spawnSyncImpl() {
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    assert.equal(verdict.command.exitCode, 0);
    assert.equal(verdict.passed, false);
    assert.equal(verdict.registry.passed, false);
    assert.match(verdict.registry.evidence, /did not emit/u);
    assert.ok(
      verdict.findings.some(
        (item) =>
          item.kind === 'dynamic-evidence-missing' && item.route === 'unmet',
      ),
    );
  });
});

test('a passing deterministic verdict passes workflow without an LLM dynamic override', async () => {
  const verify = await runDeterministicVerdictThroughVerify();
  assert.equal(verify.pass, true);
  assert.equal(verify.unmet, 0);
  assert.deepEqual(verify.dynamicFindings, []);
  assert.deepEqual(verify.archiveBlockers, []);
});

test('workflow accepts and blocks an evaluator finding after a zero focused-gate exit', async () => {
  const requirementIds = ['sample/public-widget-contract'];
  const verify = await runDeterministicVerdictThroughVerify({
    kind: 'undeclared-impact',
    route: 'spec-defect',
    requirementIds,
    detail: 'MCP code changed while the sidecar declared it unchanged.',
    blocking: true,
    commandExitCode: 0,
  });

  assert.equal(verify.pass, false);
  assert.ok(verify.specDefects.includes(requirementIds[0]));
  assert.ok(verify.blockingSpecDefects.includes(requirementIds[0]));
});

test('deterministic verify does not run the focused gate after metadata validation fails', () => {
  let spawned = false;
  const verdict = verifyPublicSurfaceChange('fixture', {
    repoRoot: DEFAULT_REPO_ROOT,
    validateChangeMetadataImpl() {
      throw new Error('fixture sidecar mismatch');
    },
    spawnSyncImpl() {
      spawned = true;
      return { status: 0 };
    },
  });

  assert.equal(spawned, false);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.command.ran, false);
  assert.equal(verdict.command.exitCode, null);
  assert.equal(verdict.sidecar.passed, false);
  assert.equal(verdict.findings[0]?.route, 'spec-defect');
  assert.equal(verificationExitCode(verdict), 1);
});

test('verify CLI rejects an undeclared MCP mutation even when the focused command exits zero', () => {
  const { result } = runPublicSurfaceCliMutation({
    mutateSidecar(sidecar) {
      for (const surface of ['publicV1', 'mcp']) {
        sidecar.surfaces[surface] = {
          status: 'unchanged',
          reason:
            'Mutation fixture falsely declares the changed public adapter unchanged.',
        };
      }
      sidecar.protocolDifferences = sidecar.protocolDifferences.filter(
        (difference) => difference.scope === 'all-existing',
      );
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(
    verdict.command.exitCode,
    0,
    JSON.stringify(verdict.findings),
  );
  assert.equal(verdict.passed, false);
  assert.ok(
    verdict.findings.some(
      (item) =>
        item.kind === 'undeclared-impact' &&
        item.route === 'spec-defect' &&
        /mcp/u.test(item.reason),
    ),
    JSON.stringify(verdict.findings),
  );
});

test('verify CLI rejects a false all-existing MCP exclusion from metadata registry evidence', () => {
  const { result } = runPublicSurfaceCliMutation({
    mutateSidecar(sidecar) {
      sidecar.surfaces.mcp = {
        status: 'excluded',
        scope: 'all-existing',
        reason: 'Mutation fixture falsely excludes mapped MCP operations.',
        protocolReason: 'Mutation fixture claims the protocol cannot map tools.',
      };
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.command.ran, false);
  assert.equal(verdict.command.exitCode, null);
  assert.equal(verdict.sidecar.passed, false);
  assert.equal(verdict.passed, false);
  assert.ok(
    verdict.findings.some(
      (item) =>
        item.kind === 'metadata-validation-failed' &&
        item.route === 'spec-defect' &&
        /registry maps it to an MCP tool/u.test(item.reason),
    ),
    JSON.stringify(verdict.findings),
  );
});

test('verify CLI rejects MCP field stripping reported by focused collector evidence', () => {
  const { result, fixture } = runPublicSurfaceCliMutation({
    stripMcpField: true,
    gateExitCode: 1,
  });

  assert.equal(result.status, 1, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.command.exitCode, 1);
  assert.equal(verdict.passed, false);
  assert.ok(
    verdict.findings.some(
      (item) =>
        item.kind === 'mcp-field-stripping' &&
        item.route === 'unmet' &&
        item.reason.includes(fixture.strippedField),
    ),
    JSON.stringify(verdict.findings),
  );
});

test('healthy reflected REST, SDK MCP, and behavior evidence passes without a fixed inventory', () => {
  const findings = evaluatePublicSurfaceEvidence(healthyEvidence());
  assert.deepEqual(findings, []);
  assert.deepEqual(routePublicSurfaceFindings(findings), {
    pass: true,
    unmet: [],
    blockingSpecDefects: [],
    archiveBlockers: [],
  });
});

test('missing a mandatory dynamic lane fails closed as unmet', () => {
  const evidence = healthyEvidence();
  evidence.lanes.behavior = false;

  const findings = evaluatePublicSurfaceEvidence(evidence);
  assert.ok(
    findings.some(
      (item) =>
        item.kind === 'dynamic-evidence-missing' && item.route === 'unmet',
    ),
  );
  assert.equal(routePublicSurfaceFindings(findings).pass, false);
});

test('undeclared public impact becomes a blocking specification defect', async () => {
  const evidence = healthyEvidence();
  evidence.sidecar.surfaces.mcp = { status: 'unchanged' };

  const findings = evaluatePublicSurfaceEvidence(evidence);
  const undeclared = findings.find(
    (item) => item.kind === 'undeclared-impact',
  );
  assert.equal(undeclared?.route, 'spec-defect');
  assert.equal(undeclared?.surface, 'mcp');

  const gate = routePublicSurfaceFindings(findings);
  assert.equal(gate.pass, false);
  assert.deepEqual(gate.blockingSpecDefects, [undeclared]);
  assert.ok(gate.archiveBlockers.includes(undeclared));

  const verify = await runFindingThroughVerify(undeclared);
  assert.equal(verify.pass, false);
  assert.ok(verify.specDefects.includes(undeclared.requirementIds[0]));
  assert.ok(verify.blockingSpecDefects.includes(undeclared.requirementIds[0]));
});

test('a false MCP exclusion becomes a blocking specification defect', async () => {
  const evidence = healthyEvidence();
  evidence.sidecar.surfaces.mcp = {
    status: 'excluded',
    toolIds: ['create_widget'],
  };

  const findings = evaluatePublicSurfaceEvidence(evidence);
  const falseExclusion = findings.find(
    (item) => item.kind === 'false-exclusion',
  );
  assert.equal(falseExclusion?.route, 'spec-defect');
  assert.equal(falseExclusion?.operationId, 'widgets.create');
  assert.equal(routePublicSurfaceFindings(findings).pass, false);

  const verify = await runFindingThroughVerify(falseExclusion);
  assert.equal(verify.pass, false);
  assert.ok(verify.specDefects.includes(falseExclusion.requirementIds[0]));
  assert.ok(
    verify.blockingSpecDefects.includes(falseExclusion.requirementIds[0]),
  );
});

test('MCP field stripping becomes unmet even when schema and type checks still pass', async () => {
  const evidence = healthyEvidence();
  evidence.operations[0].mcp.forwardedInputFields = ['name'];

  const findings = evaluatePublicSurfaceEvidence(evidence);
  const stripped = findings.find(
    (item) => item.kind === 'mcp-field-stripping',
  );
  assert.equal(stripped?.route, 'unmet');
  assert.match(stripped?.detail ?? '', /priority/u);

  const gate = routePublicSurfaceFindings(findings);
  assert.equal(gate.pass, false);
  assert.deepEqual(gate.unmet, [stripped]);
  assert.ok(gate.archiveBlockers.includes(stripped));

  const verify = await runFindingThroughVerify(stripped);
  assert.equal(verify.pass, false);
  assert.equal(verify.unmet, 1);
  assert.ok(verify.reopenedTasks.includes(stripped.requirementIds[0]));
});

test('an extra REST secret forwarded outside the registry exact set becomes unmet', async () => {
  const evidence = healthyEvidence();
  evidence.operations[0].rest.forwardedInputFields.push('secret');

  const findings = evaluatePublicSurfaceEvidence(evidence);
  const leaked = findings.find(
    (item) => item.kind === 'rest-field-leakage',
  );
  assert.equal(leaked?.route, 'unmet');
  assert.equal(leaked?.blocking, true);
  assert.match(leaked?.detail ?? '', /secret/u);
  assert.equal(routePublicSurfaceFindings(findings).pass, false);

  const verify = await runFindingThroughVerify(leaked);
  assert.equal(verify.pass, false);
  assert.equal(verify.unmet, 1);
  assert.ok(verify.reopenedTasks.includes(leaked.requirementIds[0]));
});

test('an extra MCP internalFlag forwarded outside the registry exact set becomes unmet', async () => {
  const evidence = healthyEvidence();
  evidence.operations[0].mcp.forwardedInputFields.push('internalFlag');

  const findings = evaluatePublicSurfaceEvidence(evidence);
  const leaked = findings.find(
    (item) => item.kind === 'mcp-field-leakage',
  );
  assert.equal(leaked?.route, 'unmet');
  assert.equal(leaked?.blocking, true);
  assert.match(leaked?.detail ?? '', /internalFlag/u);
  assert.equal(routePublicSurfaceFindings(findings).pass, false);

  const verify = await runFindingThroughVerify(leaked);
  assert.equal(verify.pass, false);
  assert.equal(verify.unmet, 1);
  assert.ok(verify.reopenedTasks.includes(leaked.requirementIds[0]));
});
