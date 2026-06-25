import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');

const forbiddenImportPattern = /from\s+['"](@cap\/sandbox-[^'"]+)['"]|import\(\s*['"](@cap\/sandbox-[^'"]+)['"]\s*\)/g;

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
for (const file of walk(join(apiRoot, 'src'))) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(forbiddenImportPattern)) {
    violations.push({
      file: file.slice(repoRoot.length + 1),
      specifier: match[1] ?? match[2],
    });
  }
}

assert.deepEqual(
  violations,
  [],
  'apps/api source must import sandbox APIs through @cap/sandbox only',
);

console.log('ok - apps/api imports sandbox domain through @cap/sandbox facade only');
