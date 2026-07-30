#!/usr/bin/env node
/**
 * Agent-identity branch gate.
 *
 * `openspec/specs/agent-runtime/spec.md` — "No agent-identity branch exists in
 * shared scaffolding" — forbids branching on which agent is running
 * (`runtime.id === 'codex'`, `!== 'codex'`, or equivalent) anywhere the code is
 * shared across runtimes, and asks for a grep that finds ZERO matches. Nothing
 * ran that grep, so the rule depended on review from the day it was written, and
 * drifted: it is violated in the two areas the requirement names by hand.
 *
 * Why a source scan and not a lint rule: a runtime IMPLEMENTATION legitimately
 * names its own id, so a lint rule would need per-file suppressions, and those
 * suppressions are how a rule rots. This check instead carries an explicit list
 * of the paths that count as shared scaffolding. Adding a path to that list is a
 * reviewable diff; an inline disable comment is not.
 *
 * Run: node scripts/agent-identity-branch-check.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * Sources that are shared across runtimes. A decision here must be driven by a
 * runtime's declared policy, never by its identity.
 *
 * The requirement names the pty client, the provider, the liveness poller and
 * "any integration/registry wiring"; the entries below are those areas plus the
 * places the same shape has since appeared — credential resolution, image
 * preflight, transcript selection, model-catalogue routing.
 *
 * A directory entry covers its subtree. A file entry covers just that file.
 */
const SHARED_SCAFFOLDING = [
  'apps/api/src/agent-runtime/agent-runtime.integration.ts',
  'apps/api/src/agent-runtime/agent-runtime.registry.ts',
  'apps/api/src/agent-runtime/agent-runtime.port.ts',
  'apps/api/src/runtime-models/prisma-runtime-model-credential.resolver.ts',
  'apps/api/src/runtime-models/runtime-model-catalog.port.ts',
  'apps/api/src/sandbox-environments/sandbox-environments.validator.ts',
  'apps/api/src/tasks/task-transcript-reader.ts',
  'apps/api/src/tasks/session-transcript.service.ts',
  'packages/sandbox/src/host-harness',
  'packages/sandbox/src/terminal',
];

/**
 * Sources that are ALLOWED to name a runtime: a runtime's own implementation,
 * which necessarily declares which agent it is. Listed explicitly so the
 * exemption is visible rather than inferred from a path prefix.
 */
const RUNTIME_IMPLEMENTATIONS = [
  'apps/api/src/agent-runtime/codex-runtime.ts',
  'apps/api/src/agent-runtime/claude-code-runtime.ts',
];

/** Extensions worth scanning. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs'];

/** Files whose names mark them as tests — a test may name a runtime freely. */
function isTestFile(rel) {
  return /\.(test|spec)\.[a-z]+$/.test(rel);
}

/**
 * A comparison against a runtime identity literal. Matches `=== 'codex'`,
 * `!== "claude-code"`, and the same with a `claude` alias, in either quote
 * style. Deliberately narrow: it looks for a COMPARISON, not any mention, so a
 * doc comment or a log message naming a runtime does not trip it.
 */
const IDENTITY_COMPARISON = /[!=]==\s*['"](codex|claude-code|claude)['"]/;

/** Strip line comments and block-comment bodies so prose cannot trip the scan. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length));
}

function listSourceFiles(root, target) {
  const abs = path.join(root, target);
  let stats;
  try {
    stats = statSync(abs);
  } catch {
    return [];
  }
  if (stats.isFile()) return [target];

  const found = [];
  const walk = (dirAbs) => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      const entryAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(entryAbs);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.push(path.relative(root, entryAbs));
      }
    }
  };
  walk(abs);
  return found;
}

export function findAgentIdentityBranches({
  root = ROOT,
  scaffolding = SHARED_SCAFFOLDING,
  exempt = RUNTIME_IMPLEMENTATIONS,
} = {}) {
  const exemptSet = new Set(exempt);
  const violations = [];
  const seen = new Set();

  for (const target of scaffolding) {
    for (const rel of listSourceFiles(root, target)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (exemptSet.has(rel) || isTestFile(rel)) continue;

      let source;
      try {
        source = readFileSync(path.join(root, rel), 'utf8');
      } catch {
        continue;
      }
      const lines = stripComments(source).split('\n');
      lines.forEach((line, index) => {
        if (IDENTITY_COMPARISON.test(line)) {
          violations.push({ file: rel, line: index + 1, text: line.trim() });
        }
      });
    }
  }
  return violations;
}

function main() {
  const violations = findAgentIdentityBranches();
  if (violations.length === 0) {
    console.log(
      'agent-identity-branch: no shared-scaffolding source branches on runtime identity',
    );
    return;
  }
  console.error(
    `agent-identity-branch: ${violations.length} shared-scaffolding branch(es) on runtime identity:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error(
    '\nA shared decision must read the runtime\'s DECLARED policy, not its identity.',
  );
  console.error(
    'Where the decision maps every runtime to a value, use a total mapping so adding',
  );
  console.error('an id is a compile error; otherwise raise a named error for an unknown id.');
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
