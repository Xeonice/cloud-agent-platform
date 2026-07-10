#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeExactSandboxVersionValue } from './sandbox-version-selector.mjs';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function buildSandboxMetadata({ sandboxVersion, dependencies, inherited }) {
  const effectiveSandboxVersion = sandboxVersion ?? inherited?.sandboxVersion;
  const normalizedSandboxVersion = normalizeExactSandboxVersionValue(
    effectiveSandboxVersion,
    'sandboxVersion',
  );
  if ((!Array.isArray(dependencies) || dependencies.length === 0) && !inherited) {
    throw new Error('at least one --dependency id=version is required');
  }
  const entries = Object.entries(inherited?.dependencies ?? {}).map(([id, version]) => {
    if (!ID_PATTERN.test(id) || id.length > 64) throw new Error(`invalid dependency id: ${id}`);
    return [id, normalizeExactSandboxVersionValue(version, `dependency ${id}`)];
  });
  for (const raw of dependencies ?? []) {
    const separator = raw.indexOf('=');
    if (separator <= 0) throw new Error(`invalid dependency ${JSON.stringify(raw)}; expected id=version`);
    const id = raw.slice(0, separator);
    const version = raw.slice(separator + 1);
    if (!ID_PATTERN.test(id) || id.length > 64) throw new Error(`invalid dependency id: ${id}`);
    entries.push([id, normalizeExactSandboxVersionValue(version, `dependency ${id}`)]);
  }
  const ids = entries.map(([id]) => id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate dependency id');
  entries.sort(([left], [right]) => left.localeCompare(right));
  return {
    schemaVersion: 1,
    sandboxVersion: normalizedSandboxVersion,
    dependencies: Object.fromEntries(entries),
  };
}

export function parseArgs(argv) {
  let sandboxVersion;
  let output;
  let from;
  const dependencies = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === '--sandbox-version') sandboxVersion = value;
    else if (flag === '--dependency') dependencies.push(value);
    else if (flag === '--output') output = value;
    else if (flag === '--from') from = value;
    else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  if (!output) throw new Error('--output is required');
  return { sandboxVersion, dependencies, output, from };
}

function main() {
  const { output, from, ...input } = parseArgs(process.argv.slice(2));
  if (from) input.inherited = JSON.parse(readFileSync(from, 'utf8'));
  const metadata = buildSandboxMetadata(input);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
