#!/usr/bin/env node
/**
 * Agent-identity branch gate.
 *
 * `openspec/specs/agent-runtime/spec.md` — "No agent-identity branch exists in
 * shared scaffolding" — forbids branching on which agent is running
 * (`runtime.id === 'codex'`, `!== 'codex'`, or equivalent) anywhere the code is
 * shared across runtimes, and asks for a grep that finds ZERO matches.
 *
 * The scan is a COMPLEMENT: every production source in scope is scanned EXCEPT
 * an explicit exemption list. The previous shape was the inverse — a ten-entry
 * list of the scaffolding files that ARE scanned — which silently exempted
 * every file nobody remembered to add; widening to the complement immediately
 * surfaced hits the enumerated list could not see. A new hit is resolved by
 * removing the branch or by adding a three-field exemption (file, reason,
 * owning change); an entry missing a field fails the audit, and a scan that
 * resolves to ZERO files exits non-zero instead of passing on nothing.
 *
 * In-scope production sources are the agent-execution backend (`apps/api/src`),
 * the sandbox-side hooks, and every workspace package — the pty client, the
 * providers, credential resolution, image preflight, transcript selection and
 * model-catalogue routing all live there. The web console renders the runtime
 * vocabulary but executes no agent, so it is outside this check's scope. Test
 * files remain out of the branch scan's scope.
 *
 * Run: node scripts/agent-identity-branch-check.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * Roots whose subtrees are in-scope production sources. Directory ROOTS, never
 * individual files — enumerating scanned files is the failure mode this scan
 * replaces.
 */
const SCAN_ROOTS = ['apps/api/src', 'apps/sandbox-hooks/src', 'packages'];

/**
 * Sources exempt from the scan. Three fields each — file, reason, owning
 * change — so every entry is either permanent by nature (a runtime
 * implementation necessarily names its own id) or owned debt with an exit
 * path. An entry missing a field fails the audit; an entry whose file no
 * longer exists is stale and fails too.
 *
 * @type {ReadonlyArray<{ file: string, reason: string, change: string }>}
 */
const EXEMPTIONS = [
  {
    file: 'apps/api/src/agent-runtime/codex-runtime.ts',
    reason:
      'the codex runtime implementation itself — a runtime necessarily names ' +
      'its own id; this is declaration, not a branch in shared scaffolding',
    change: 'fail-loud-on-unknown-runtime',
  },
  {
    file: 'apps/api/src/agent-runtime/claude-code-runtime.ts',
    reason:
      'the claude-code runtime implementation itself — a runtime necessarily ' +
      'names its own id; this is declaration, not a branch in shared scaffolding',
    change: 'fail-loud-on-unknown-runtime',
  },
  {
    file: 'apps/api/src/tasks/tasks.service.ts',
    reason:
      'deliberate fail-closed create gate: a claude-code task must not launch ' +
      'unauthenticated while codex deliberately degrades to its prior ' +
      'unauthenticated behavior, so no total mapping exists yet; the exit is a ' +
      'runtime-declared readiness policy read by the mechanism',
    change: 'add-claude-code-runtime',
  },
  {
    file: 'apps/api/src/task-failure/task-failure.ts',
    reason:
      'per-runtime failure copy (display labels) and persisted-row runtime ' +
      'normalization keyed on identity; the exit is a total mapping over the ' +
      'runtime vocabulary so an added id fails compilation instead of ' +
      'inheriting codex wording',
    change: 'add-claude-code-runtime',
  },
];

/** Extensions worth scanning. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs'];

/** Directory names never descended into. Test directories are out of scope. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'test',
  'tests',
  '__tests__',
  'e2e',
]);

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
        if (!SKIP_DIRS.has(entry.name)) walk(entryAbs);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.push(path.relative(root, entryAbs));
      }
    }
  };
  walk(abs);
  return found;
}

/**
 * Findings, each `{ kind, ... }`:
 *   - `identity-branch`: a shared-scaffolding line comparing a runtime id.
 *   - `malformed-exemption`: an exemption entry missing file, reason or change.
 *   - `stale-exemption`: an exemption naming a file that no longer exists.
 *   - `empty-scan`: the complement resolved to zero files.
 * Any finding is red — the gate never distinguishes "broken" from "violated".
 */
export function findAgentIdentityBranches({
  root = ROOT,
  scanRoots = SCAN_ROOTS,
  exemptions = EXEMPTIONS,
} = {}) {
  const findings = [];

  for (const entry of exemptions) {
    const missing = ['file', 'reason', 'change'].filter(
      (field) => typeof entry[field] !== 'string' || entry[field].trim() === '',
    );
    if (missing.length > 0) {
      findings.push({
        kind: 'malformed-exemption',
        file: typeof entry.file === 'string' ? entry.file : '(no file)',
        detail: `exemption entry is missing: ${missing.join(', ')} — every entry carries file, reason, owning change`,
      });
      continue;
    }
    let exists = false;
    try {
      exists = statSync(path.join(root, entry.file)).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      findings.push({
        kind: 'stale-exemption',
        file: entry.file,
        detail: 'exemption names a file that does not exist — remove or update the entry',
      });
    }
  }

  const exemptSet = new Set(exemptions.map((entry) => entry.file));
  const seen = new Set();
  let scanned = 0;

  for (const target of scanRoots) {
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
      scanned += 1;
      const lines = stripComments(source).split('\n');
      lines.forEach((line, index) => {
        if (IDENTITY_COMPARISON.test(line)) {
          findings.push({
            kind: 'identity-branch',
            file: rel,
            line: index + 1,
            text: line.trim(),
          });
        }
      });
    }
  }

  if (scanned === 0) {
    findings.push({
      kind: 'empty-scan',
      file: '(scan roots)',
      detail:
        'the complement scan resolved to ZERO files — a moved root or a broken ' +
        'glob would look exactly like this, so an empty scan fails instead of ' +
        'passing on nothing',
    });
  }

  return findings;
}

function main() {
  const findings = findAgentIdentityBranches();
  if (findings.length === 0) {
    console.log(
      'agent-identity-branch: no in-scope production source branches on runtime identity',
    );
    return;
  }
  console.error(`agent-identity-branch: ${findings.length} finding(s):\n`);
  for (const f of findings) {
    if (f.kind === 'identity-branch') {
      console.error(`  [${f.kind}] ${f.file}:${f.line}`);
      console.error(`    ${f.text}`);
    } else {
      console.error(`  [${f.kind}] ${f.file}`);
      console.error(`    ${f.detail}`);
    }
  }
  console.error(
    '\nA shared decision must read the runtime\'s DECLARED policy, not its identity.',
  );
  console.error(
    'Where the decision maps every runtime to a value, use a total mapping so adding',
  );
  console.error(
    'an id is a compile error; otherwise raise a named error for an unknown id.',
  );
  console.error(
    'A new hit is resolved by removing the branch, or by a three-field exemption',
  );
  console.error('(file, reason, owning change) in scripts/agent-identity-branch-check.mjs.');
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
