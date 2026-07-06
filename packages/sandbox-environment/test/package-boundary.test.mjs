import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const sourceRoot = join(packageRoot, 'src');

const forbiddenImportPattern =
  /from\s+['"](@nestjs\/|@prisma\/|@cap\/ui|@cap\/sandbox-provider-|dockerode|ws|react|@tanstack\/|\.prisma\/|prisma)['"][^;\n]*|import\(\s*['"](@nestjs\/|@prisma\/|@cap\/ui|@cap\/sandbox-provider-|dockerode|ws|react|@tanstack\/|\.prisma\/|prisma)['"]\s*\)/g;

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

const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), ['@cap/sandbox-core']);

const violations = [];
for (const file of walk(sourceRoot)) {
  const text = readFileSync(file, 'utf8');
  const relative = file.slice(packageRoot.length + 1);
  for (const match of text.matchAll(forbiddenImportPattern)) {
    violations.push({
      file: relative,
      specifier: match[1] ?? match[2],
    });
  }
}

assert.deepEqual(
  violations,
  [],
  '@cap/sandbox-environment must stay provider-neutral and framework-free',
);

console.log('ok - @cap/sandbox-environment imports only provider-neutral dependencies');
