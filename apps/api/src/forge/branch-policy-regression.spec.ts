import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const API_SOURCE_ROOT = path.resolve(__dirname, '..', '..', 'src');
const REPO_ROOT = path.resolve(API_SOURCE_ROOT, '..', '..', '..');

interface SourcePolicyViolation {
  readonly file: string;
  readonly reason: string;
}

function productionTypeScriptFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = path.join(root, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      productionTypeScriptFiles(absolute).forEach((file) => out.push(file));
      continue;
    }
    if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.d.ts') &&
      !/\.(?:spec|test)\.ts$/u.test(entry)
    ) {
      out.push(absolute);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function auditBranchPlanningSource(
  source: string,
  file: string,
): SourcePolicyViolation[] {
  const code = stripComments(source);
  const violations: SourcePolicyViolation[] = [];
  if (/\bresolveBaseBranch\b/u.test(code)) {
    violations.push({
      file,
      reason: 'base branch must come from the shared TaskBranchResolver snapshot',
    });
  }
  if (/(['"])(?:main|master)\1/u.test(code)) {
    violations.push({
      file,
      reason: 'production branch planning must not hard-code a conventional default',
    });
  }
  return violations;
}

test('production forge/import/task planning contains no implicit default-branch bypass', () => {
  const apiProduction = productionTypeScriptFiles(API_SOURCE_ROOT);
  const branchPlanningFiles = [
    ...productionTypeScriptFiles(path.join(API_SOURCE_ROOT, 'forge')),
    ...productionTypeScriptFiles(path.join(API_SOURCE_ROOT, 'repos')),
    ...productionTypeScriptFiles(path.join(API_SOURCE_ROOT, 'tasks')),
    ...productionTypeScriptFiles(path.join(API_SOURCE_ROOT, 'sandbox')),
    ...productionTypeScriptFiles(path.join(API_SOURCE_ROOT, 'guardrails')),
    ...productionTypeScriptFiles(
      path.join(REPO_ROOT, 'packages', 'sandbox-core', 'src'),
    ),
    ...productionTypeScriptFiles(
      path.join(REPO_ROOT, 'packages', 'sandbox', 'src'),
    ),
  ];

  const independentBaseResolution = apiProduction.flatMap((file) => {
    const source = stripComments(readFileSync(file, 'utf8'));
    return /\bresolveBaseBranch\b/u.test(source)
      ? [
          {
            file: relative(file),
            reason:
              'base branch must come from the shared TaskBranchResolver snapshot',
          },
        ]
      : [];
  });
  const fabricatedDefaults = [...new Set(branchPlanningFiles)].flatMap((file) =>
    auditBranchPlanningSource(readFileSync(file, 'utf8'), relative(file)).filter(
      (violation) =>
        violation.reason ===
        'production branch planning must not hard-code a conventional default',
    ),
  );

  assert.ok(
    branchPlanningFiles.some((file) =>
      file.endsWith('apps/api/src/forge/task-branch-resolver.ts'),
    ),
    'the recursive audit includes the canonical branch resolver',
  );
  assert.deepEqual(independentBaseResolution, []);
  assert.deepEqual(fabricatedDefaults, []);

  const prismaLookup = stripComments(
    readFileSync(
      path.join(API_SOURCE_ROOT, 'sandbox', 'prisma-provision-lookup.ts'),
      'utf8',
    ),
  );
  assert.equal(
    /\bTASK_REPO_URL\b/u.test(prismaLookup),
    false,
    'production task planning must not read the deployment-global repo URL',
  );

  const configuredProvider = stripComments(
    readFileSync(
      path.join(
        REPO_ROOT,
        'packages',
        'sandbox',
        'src',
        'host-harness',
        'configured-provider.ts',
      ),
      'utf8',
    ),
  );
  assert.equal(
    /\bgetCloneSpec\b/u.test(configuredProvider),
    false,
    'the production AIO descriptor must not re-read a legacy clone spec',
  );
});

test('branch source policy detects representative regression mutations', () => {
  assert.deepEqual(
    auditBranchPlanningSource(
      `const base = repo.defaultBranch ?? 'main';\nforge.resolveBaseBranch(target);`,
      'mutation.ts',
    ),
    [
      {
        file: 'mutation.ts',
        reason: 'base branch must come from the shared TaskBranchResolver snapshot',
      },
      {
        file: 'mutation.ts',
        reason:
          'production branch planning must not hard-code a conventional default',
      },
    ],
  );
  assert.deepEqual(
    auditBranchPlanningSource(
      `const base = repo.defaultBranch || 'master';`,
      'master-mutation.ts',
    ),
    [
      {
        file: 'master-mutation.ts',
        reason:
          'production branch planning must not hard-code a conventional default',
      },
    ],
  );
});
