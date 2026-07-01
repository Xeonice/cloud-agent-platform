import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');

const forbiddenImportPattern = /from\s+['"](@cap\/sandbox-[^'"]+)['"]|import\(\s*['"](@cap\/sandbox-[^'"]+)['"]\s*\)/g;
const sourceBoundaryRoots = [
  join(apiRoot, 'src', 'sandbox'),
  join(apiRoot, 'src', 'terminal'),
];
const forbiddenSourcePatterns = [
  {
    pattern: /\bdefineAioSandboxProvider\b|\bdefineAioSandboxProviderFromDocker\b|\bdefineBoxLiteSandboxProvider\b|\bdefineHttpCloudSandboxProvider\b/,
    reason: 'concrete provider factories belong in @cap/sandbox or provider packages',
  },
  {
    pattern: /\bAioSandboxContainerController\b|\bDocker\b|\bdockerode\b/,
    reason: 'Docker/provider lifecycle must not be implemented in API sandbox or terminal code',
  },
  {
    pattern: /\breadBoxLiteProviderConfig\b|\breadConfiguredSandboxProviderFamily\b|\bBOXLITE_[A-Z0-9_]*\b|\bAIO_SANDBOX_[A-Z0-9_]*\b|\bCAP_SANDBOX_PROVIDER\b/,
    reason: 'provider env and family parsing must stay behind the sandbox host harness',
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
  (name) => name.startsWith('@cap/sandbox-'),
);

assert.deepEqual(
  directSandboxDeps,
  [],
  'apps/api must depend on @cap/sandbox only, not sandbox subpackages',
);
assert.equal(
  packageJson.dependencies?.['@cap/sandbox'],
  'workspace:*',
  'apps/api must consume the sandbox facade package',
);

const violations = [];
const concreteProviderViolations = [];
for (const file of walk(join(apiRoot, 'src'))) {
  const text = readFileSync(file, 'utf8');
  const relative = file.slice(repoRoot.length + 1);
  for (const match of text.matchAll(forbiddenImportPattern)) {
    violations.push({
      file: relative,
      specifier: match[1] ?? match[2],
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

const sourceBoundaryViolations = [];
for (const root of sourceBoundaryRoots) {
  for (const file of productionSources(root)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const relative = file.slice(repoRoot.length + 1);
    for (const { pattern, reason } of forbiddenSourcePatterns) {
      if (pattern.test(text)) {
        sourceBoundaryViolations.push({ file: relative, reason });
      }
    }
  }
}

assert.deepEqual(
  violations,
  [],
  'apps/api source must import sandbox APIs through @cap/sandbox only',
);
assert.deepEqual(
  concreteProviderViolations,
  [],
  'apps/api must not define concrete sandbox provider classes; use @cap/sandbox registry descriptors',
);
assert.deepEqual(
  sourceBoundaryViolations,
  [],
  'apps/api/src/sandbox and apps/api/src/terminal must not contain provider-specific implementation details',
);

console.log('ok - apps/api imports sandbox domain through @cap/sandbox facade only');
