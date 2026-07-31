/**
 * G11 — apps/api must not touch concrete sandbox-provider internals.
 *
 * Two scans over the SAME manifest-driven source roots (S3 — the roots come
 * from `docs/refactor/contexts-manifest.json` `scope`, never from a hardcoded
 * list in this file, so a later directory move edits the manifest, not the gate):
 *
 *   1. forbidden-IMPORT scan — apps/api may import sandbox APIs only through
 *      the `@cap-console/sandbox` facade, never `@cap-console/sandbox-*`
 *      subpackages;
 *   2. forbidden-SYMBOL scan (R3, full source tree) — provider implementation
 *      symbols (dockerode/Docker, provider factories, env-family parsing,
 *      terminal transports, protocol strings) must not appear in ANY
 *      production source under the manifest scope.
 *
 * Known 存量 for the symbol scan rides the R3 ratchet baseline
 * (`scripts/ratchets/r3.json`), consumed through the SHARED comparator
 * (`scripts/ratchets/comparator.mjs`) — strict fail-on-stale, count-keyed,
 * shrink-only. When the measured count reaches zero the baseline file is
 * deleted and this gate runs with zero tolerance.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');

const forbiddenImportPattern = /from\s+['"](@cap-console\/sandbox-[^'"]+)['"]|import\(\s*['"](@cap-console\/sandbox-[^'"]+)['"]\s*\)/g;

// Targeted negative for the import scan (P3, and apps/api/CLAUDE.md's declared
// dependency set): `@cap-console/sandbox-conformance` is the conformance kit —
// a sanctioned devDependency for TESTS ONLY (change close-gate-blindspots task
// 2.2 repointed the two public-surface story specs at it directly). Production
// sources still may not import it: the exemption is keyed on BOTH the exact
// specifier AND the file being a test/spec file, so no provider package and no
// production import can ride it.
const CONFORMANCE_SPECIFIER = '@cap-console/sandbox-conformance';
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|mts|cts|mjs|js)$/;
function isExemptConformanceImport(specifier, file) {
  return specifier === CONFORMANCE_SPECIFIER && TEST_FILE_PATTERN.test(file);
}

// S3: the scanned roots are manifest data, not literals in this gate. The
// contexts manifest declares the boundary scope for apps/api; both the import
// scan and the symbol scan walk exactly the roots resolved here. Fail closed:
// a missing manifest, a missing `scope`, or a scope that resolves to nothing
// on disk is a gate failure, never a silent no-op.
const contextsManifestPath = join(repoRoot, 'docs', 'refactor', 'contexts-manifest.json');
assert.ok(
  existsSync(contextsManifestPath),
  `boundary manifest missing: ${contextsManifestPath} — the gate's scan roots are manifest-driven (S3) and cannot fall back to hardcoded paths`,
);
const contextsManifest = JSON.parse(readFileSync(contextsManifestPath, 'utf8'));
assert.ok(
  typeof contextsManifest.scope === 'string' && contextsManifest.scope.trim() !== '',
  'contexts-manifest.json must declare a non-empty `scope` — the source root both boundary scans walk',
);
const sourceBoundaryRoots = [resolve(repoRoot, contextsManifest.scope)];
for (const root of sourceBoundaryRoots) {
  assert.ok(
    existsSync(root) && statSync(root).isDirectory(),
    `manifest scope "${contextsManifest.scope}" does not resolve to a directory: ${root}`,
  );
}

const forbiddenSourcePatterns = [
  {
    pattern: /\bdefineAioSandboxProvider\b|\bdefineAioSandboxProviderFromDocker\b|\bdefineBoxLiteSandboxProvider\b|\bdefineHttpCloudSandboxProvider\b/,
    reason: 'concrete provider factories belong in @cap-console/sandbox or provider packages',
  },
  {
    pattern: /\bAioSandboxContainerController\b|\bDocker\b|\bdockerode\b/,
    reason: 'Docker/provider lifecycle must not be implemented in API sandbox or terminal code',
  },
  {
    pattern: /\breadBoxLiteProviderConfig\b|\breadConfiguredSandboxProviderFamily\b|\bBOXLITE_[A-Z0-9_]*\b|\bAIO_SANDBOX_[A-Z0-9_]*\b|\bCAP_SANDBOX_PROVIDER\b/,
    reason: 'provider env and family parsing must stay behind the sandbox host harness',
    // Targeted negative (R3 6th-file disposition, design D2): an env-family
    // NAME quoted inside CJK operator copy (e.g. the load-bearing message
    // "请设置 AIO_SANDBOX_IMAGE。" in codex-device-login-runner.ts, which tells
    // the operator exactly which variable to set) is documentation, not env
    // parsing. The exemption is deliberately narrow — see
    // isOperatorCopyMention below — and the fixture self-test proves the
    // refined matcher still catches every real 存量 shape.
    copyMentionExempt: true,
  },
  {
    pattern: /\bAioPtyClient\b|\bAioTerminalTransport\b|\bBoxLiteTerminalTransport\b|\bTerminalTransport\b/,
    reason: 'provider terminal clients/transports must live behind the sandbox terminal harness',
  },
  {
    pattern: /['"](?:aio-json-v1|boxlite-v1|aio-http-exec-v1|boxlite-exec-v1)['"]/,
    reason: 'provider protocol strings must not be registered or switched on in API',
  },
];

// A match is an operator-copy mention ONLY when (a) the matched token is an
// ALL-CAPS env-style name (function-name alternates are never exempt) and
// (b) BOTH neighbors within 3 characters are CJK prose/punctuation — code
// references (`process.env.X`, imports, string keys) are ASCII-adjacent on at
// least one side, so they can never satisfy this.
const ENV_STYLE_NAME = /^[A-Z][A-Z0-9_]*$/;
const CJK_NEIGHBOR = /[\p{Script=Han}、。！-･]/u;
function isOperatorCopyMention(text, match) {
  if (!ENV_STYLE_NAME.test(match[0])) return false;
  const start = match.index;
  const end = match.index + match[0].length;
  return (
    CJK_NEIGHBOR.test(text.slice(Math.max(0, start - 3), start)) &&
    CJK_NEIGHBOR.test(text.slice(end, end + 3))
  );
}

function patternHits(entry, text) {
  if (!entry.copyMentionExempt) return entry.pattern.test(text);
  for (const match of text.matchAll(new RegExp(entry.pattern.source, 'g'))) {
    if (!isOperatorCopyMention(text, match)) return true;
  }
  return false;
}

// ---- refined-matcher self-test (fixtures only, never the live tree) ----
// Proves the targeted negative does not weaken the ban: every real 存量 shape
// measured on 2026-07-31 still hits; only the CJK operator-copy mention is
// exempt.
{
  const envFamilyEntry = forbiddenSourcePatterns[2];
  const fixtures = [
    {
      name: 'env fallback read (docker-codex-device-login-runner.ts:144 shape)',
      text: "const image = this.options.image ?? process.env.AIO_SANDBOX_IMAGE;",
      hits: true,
    },
    {
      name: 'provider constant import (sandbox-environments.validator.ts:15 shape)',
      text: "import {\n  AIO_SANDBOX_WORKSPACE_DIR,\n} from '@cap-console/sandbox';",
      hits: true,
    },
    {
      name: 'BOXLITE_ env-family constant (self-update.service.ts:65 shape)',
      text: "export const BOXLITE_ROOTFS_PATH_ENV = 'BOXLITE_ROOTFS_PATH';",
      hits: true,
    },
    {
      name: 'provider family switch (CAP_SANDBOX_PROVIDER)',
      text: 'if (process.env.CAP_SANDBOX_PROVIDER === "boxlite") {}',
      hits: true,
    },
    {
      name: 'config reader call is never exempt even beside CJK copy',
      text: "// 说明：readBoxLiteProviderConfig 读取配置\nconst c = readBoxLiteProviderConfig();",
      hits: true,
    },
    {
      name: 'env name quoted inside CJK operator copy (codex-device-login-runner.ts:26 shape)',
      text: "const msg = 'Codex 登录工作器未配置，请设置 AIO_SANDBOX_IMAGE。';",
      hits: false,
    },
  ];
  for (const fixture of fixtures) {
    assert.equal(
      patternHits(envFamilyEntry, fixture.text),
      fixture.hits,
      `env-family matcher self-test failed: ${fixture.name}`,
    );
  }
}

// ---- conformance-exemption self-test (fixtures only, never the live tree) ----
// Proves the P3 test-only conformance exemption cannot widen: only the exact
// conformance specifier, and only in a test/spec file, is exempt.
{
  const fixtures = [
    {
      name: 'conformance import in a spec file is exempt (P3 devDep for tests)',
      specifier: CONFORMANCE_SPECIFIER,
      file: 'apps/api/src/public-surface/private-git-secret-canary.story.spec.ts',
      exempt: true,
    },
    {
      name: 'conformance import in a PRODUCTION source is still a violation',
      specifier: CONFORMANCE_SPECIFIER,
      file: 'apps/api/src/sandbox/sandbox.service.ts',
      exempt: false,
    },
    {
      name: 'a provider subpackage import in a spec file is still a violation',
      specifier: '@cap-console/sandbox-provider-aio',
      file: 'apps/api/src/sandbox/some.spec.ts',
      exempt: false,
    },
    {
      name: 'a specifier merely prefixed with the conformance name is a violation',
      specifier: '@cap-console/sandbox-conformance-extras',
      file: 'apps/api/src/sandbox/some.spec.ts',
      exempt: false,
    },
  ];
  for (const fixture of fixtures) {
    assert.equal(
      isExemptConformanceImport(fixture.specifier, fixture.file),
      fixture.exempt,
      `conformance-exemption self-test failed: ${fixture.name}`,
    );
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, out);
    } else if (/\.(ts|mts|cts|mjs|js)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

function productionSources(dir) {
  return walk(dir).filter((file) => !/\.(test|spec)\.(ts|mjs|js)$/.test(file));
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const packageJson = JSON.parse(
  readFileSync(join(apiRoot, 'package.json'), 'utf8'),
);
const directSandboxDeps = Object.keys(packageJson.dependencies ?? {}).filter(
  (name) => name.startsWith('@cap-console/sandbox-'),
);

assert.deepEqual(
  directSandboxDeps,
  [],
  'apps/api must depend on @cap-console/sandbox only, not sandbox subpackages',
);
assert.equal(
  packageJson.dependencies?.['@cap-console/sandbox'],
  'workspace:*',
  'apps/api must consume the sandbox facade package',
);

const violations = [];
const concreteProviderViolations = [];
const importScanFiles = sourceBoundaryRoots.flatMap((root) => walk(root));
assert.ok(
  importScanFiles.length > 0,
  'boundary import scan found zero files — an empty scan is a failing scan',
);
for (const file of importScanFiles) {
  const text = readFileSync(file, 'utf8');
  const relative = file.slice(repoRoot.length + 1);
  for (const match of text.matchAll(forbiddenImportPattern)) {
    const specifier = match[1] ?? match[2];
    if (isExemptConformanceImport(specifier, relative)) continue;
    violations.push({
      file: relative,
      specifier,
    });
  }
  if (
    /apps\/api\/src\/sandbox\/.*provider\.ts$/.test(relative) &&
    relative !== 'apps/api/src/sandbox/sandbox-provider.port.ts'
  ) {
    concreteProviderViolations.push({
      file: relative,
      reason: 'concrete sandbox providers belong in provider packages',
    });
  }
  if (/export\s+class\s+AioSandboxProvider\b/.test(text)) {
    concreteProviderViolations.push({
      file: relative,
      reason: 'API must not export an AIO provider class',
    });
  }
}

// R3 — forbidden-SYMBOL scan over the full manifest scope (the same walk the
// import scan performs), producing a count-keyed measurement for the shared
// ratchet comparator: file → number of forbidden pattern families present.
const measuredSymbolCounts = {};
const measuredSymbolReasons = new Map();
const symbolScanFiles = sourceBoundaryRoots.flatMap((root) => productionSources(root));
assert.ok(
  symbolScanFiles.length > 0,
  'boundary symbol scan found zero production sources — an empty scan is a failing scan',
);
for (const file of symbolScanFiles) {
  const text = stripComments(readFileSync(file, 'utf8'));
  const relative = file.slice(repoRoot.length + 1);
  for (const entry of forbiddenSourcePatterns) {
    if (patternHits(entry, text)) {
      measuredSymbolCounts[relative] = (measuredSymbolCounts[relative] ?? 0) + 1;
      if (!measuredSymbolReasons.has(relative)) measuredSymbolReasons.set(relative, []);
      measuredSymbolReasons.get(relative).push(entry.reason);
    }
  }
}

// The known 存量 rides the R3 ratchet baseline through the SHARED comparator —
// imported, never re-implemented (one comparison loop in the repository).
const { compareToBaseline, readBaseline } = await import(
  pathToFileURL(join(repoRoot, 'scripts', 'ratchets', 'comparator.mjs')).href
);
const r3BaselinePath = join(repoRoot, 'scripts', 'ratchets', 'r3.json');
let ratchetProblems;
if (existsSync(r3BaselinePath)) {
  ratchetProblems = compareToBaseline(measuredSymbolCounts, readBaseline(r3BaselinePath));
} else {
  // Endgame: no baseline file means zero tolerance — the gate passes only on
  // a clean tree ("reaching zero deletes the baseline").
  ratchetProblems = Object.keys(measuredSymbolCounts)
    .sort()
    .map(
      (file) =>
        `${file}: ${measuredSymbolCounts[file]} forbidden-symbol violation(s) with no ratchet baseline present`,
    );
}

assert.deepEqual(
  violations,
  [],
  'apps/api source must import sandbox APIs through @cap-console/sandbox only',
);
assert.deepEqual(
  concreteProviderViolations,
  [],
  'apps/api must not define concrete sandbox provider classes; use @cap-console/sandbox registry descriptors',
);
if (ratchetProblems.length > 0) {
  const lines = [
    'forbidden provider symbols under the manifest scope disagree with the R3 ratchet baseline (scripts/ratchets/r3.json):',
    ...ratchetProblems.map((problem) => `  ${problem}`),
    '',
    'measured forbidden-symbol files (file: pattern reasons):',
    ...[...measuredSymbolReasons.keys()].sort().flatMap((file) => [
      `  ${file}:`,
      ...measuredSymbolReasons.get(file).map((reason) => `    - ${reason}`),
    ]),
  ];
  assert.fail(lines.join('\n'));
}

console.log('ok - apps/api imports sandbox domain through @cap-console/sandbox facade only');
console.log(
  `ok - forbidden-symbol scan covered ${symbolScanFiles.length} production sources under ${contextsManifest.scope} (R3 ratchet: ${existsSync(r3BaselinePath) ? 'baseline in force' : 'zero tolerance, no baseline'})`,
);
