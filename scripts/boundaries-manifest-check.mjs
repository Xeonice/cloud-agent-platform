#!/usr/bin/env node
/**
 * Boundaries manifest interpreter — the CI-side enforcement of the boundary
 * rules declared in `docs/refactor/boundaries-manifest.json`.
 *
 * WHY A SECOND INTERPRETER EXISTS. The same manifest also drives the shared
 * ESLint config, which is what a developer sees in the IDE and at pre-commit.
 * That layer is escapable by design: one `eslint-disable` line switches off a
 * whole rule for a file, an esquery selector only sees the spellings it was
 * written for, and `no-restricted-imports` never looks at dynamic
 * `import('…')`. This script reads the same JSON and walks the tree itself, so
 * a disable comment is just a comment — comments are blanked before matching
 * and cannot exempt anything. The two consumers derive from the manifest
 * independently; neither reads the other's output.
 *
 * WHAT THIS SCRIPT IS NOT ALLOWED TO READ (the ruling tasks.md 3.2 asked for,
 * where design D5 and the spec disagreed). design.md D5 floated letting this
 * interpreter read `eslint-suppressions.json` as a committed data ceiling for
 * the pre-existing S1/S2 sites. The spec is narrower and wins:
 * `boundaries-manifest` → "The interpreters do not feed each other" states the
 * interpreter reads "the manifest and repository source files only — no ESLint
 * output, suppression file, or ESLint config". So: manifest + source, nothing
 * else. Anything this gate must tolerate is tolerated as three-field
 * `{reason, owner, change}` manifest data, which is reviewable in the same
 * place the rule is declared. Reconciling the pre-existing real-tree sites so
 * each debt sits in exactly one ledger belongs to the integration track; this
 * file proves the mechanism on fixtures.
 *
 * MANIFEST SHAPE IT CONSUMES (only the rule collections; the D-table security
 * seams are another gate's data and are read by scripts/security-seam-check.mjs):
 *
 *   {
 *     "$comment": "…",
 *     "packageRules": [                   // A 表 P1–P8
 *       {
 *         "id": "P1",
 *         "enforcement": "manifest",      // | "existing-gate"
 *         "provenance": "docs/refactor/02-boundaries-manifest.md:16",  // required
 *         "change": "enforce-boundaries-from-manifest",                // required
 *         "appliesTo": ["apps/web/src"],  // repo-relative scan roots (`*` segments allowed)
 *         "forbid": {
 *           "packagePatterns": ["@cap-console/api", "@cap-console/sandbox-*"],
 *           "paths": ["apps/api"],        // forbidden target DIRECTORIES
 *           "allowTypeImports": false     // true ⇒ only value imports are forbidden (P6/P8)
 *         }
 *       },
 *       { "id": "P3", "enforcement": "existing-gate",
 *         "enforcedBy": ["apps/api/src/sandbox/sandbox-package-boundary.test.mjs"] }
 *     ],
 *     "seamRules": [                      // C 表 S1–S3
 *       { "id": "S1", "enforcement": "manifest", "appliesTo": ["apps/web/src"],
 *         "transports": ["apps/web/src/lib/api/real.ts", "apps/web/src/lib/ws-client.ts"],
 *         "egress": { "calls": ["fetch"], "constructors": ["WebSocket"],
 *                     "receivers": ["window", "globalThis", "self"] },
 *         "exemptions": [{ "path": "…", "reason": "…", "owner": "…", "change": "…" }] },
 *       { "id": "S2", "enforcement": "manifest", "appliesTo": ["apps/web/src/components"],
 *         "target": { "path": "apps/web/src/lib/api/real.ts", "specifiers": ["@/lib/api/real"] },
 *         "allowNames": [{ "name": "ApiError", "reason": "…", "owner": "…", "change": "…" }] }
 *     ]
 *   }
 *
 * The rule KIND is derived from what the entry declares, never from a separate
 * `kind` field that could disagree with the data next to it: `existing-gate` is
 * a reference, `forbid` is a package-import rule, `egress` is an egress scan,
 * `target` is a seam-import rule. An entry declaring none of them is a boundary
 * that was written down and enforced by nobody — that is red, not a skip.
 *
 * `enforcement: "existing-gate"` is how an already-landed rule (P3/P7/S3)
 * appears: it names the enforcer that already exists and this script
 * deliberately does not re-implement it — a second implementation is exactly
 * the drift the manifest is meant to prevent.
 *
 * OWN-PACKAGE IMPORTS ARE NEVER VIOLATIONS. `forbid.paths` names forbidden
 * target directories (`apps`, `packages`), and the manifest's own conventions
 * block states the reading: only CROSS-package reach is a violation, so an
 * import resolving inside the importing file's own package never is. Without
 * that, P5's `paths: ["packages"]` would flag every relative import
 * `packages/contracts` makes to itself.
 *
 * HOW A SPECIFIER IS JUDGED. Against three spellings of the same target: the
 * specifier as written, the repo-relative path a `../` traversal lands on, and
 * the path a tsconfig `paths` alias expands to. The third is not a nicety —
 * every intra-app import here is written `@/lib/api/real`, so a resolver that
 * only knew about `../` would have reported the console's seam bypasses as a
 * clean tree.
 *
 * FAIL-CLOSED, EVERYWHERE. Missing or unparsable manifest, an empty rule set,
 * a rule missing `provenance`/`change`, a rule of a kind this interpreter does
 * not implement, a tolerance entry missing one of `{reason, owner, change}`,
 * or a scan root that resolves to zero files — each is a non-zero exit naming
 * what was wrong. A gate that scans nothing is not a passing gate.
 *
 * KNOWN LIMIT: masking is a lexer for comments, strings and template literals,
 * not a full parser — a regular-expression literal containing an unbalanced
 * quote can mislead it. Every governed file is TypeScript/JS source; the
 * fixtures pin the forms that matter.
 *
 * Run: node scripts/boundaries-manifest-check.mjs
 *      node scripts/boundaries-manifest-check.mjs --root <dir> --manifest <file>
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

export const DEFAULT_MANIFEST_PATH = 'docs/refactor/boundaries-manifest.json';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.next',
  '.output',
  '.vercel',
  '.nitro',
  '.tanstack',
  // The frozen visual-gate prototype: served to a browser as-is, not app source.
  'design-baseline',
]);

/** Rule kinds this interpreter implements. */
const RULE_KINDS = ['package-imports', 'egress', 'seam-import', 'reference'];

/**
 * Receivers a global may be spelled through (`window.fetch`) when the manifest
 * entry names none. The manifest's `egress.receivers` is the declaration; this
 * is only the fallback for an entry that omits the field.
 */
const DEFAULT_EGRESS_RECEIVERS = ['window', 'globalThis', 'self'];

const THREE_FIELDS = ['reason', 'owner', 'change'];

// ---- source masking --------------------------------------------------------

/**
 * Blank out what must not be matched, keeping every byte offset (and therefore
 * every line number) intact.
 *
 * Two views come back:
 *   - `code`: comments blanked, string bodies kept — import specifiers live in
 *     strings, and an `eslint-disable` comment must be invisible.
 *   - `bare`: comments AND string bodies blanked — so the egress scan cannot
 *     be fooled by the word "fetch" inside a URL or a query key.
 *
 * @param {string} source
 * @returns {{ code: string, bare: string }}
 */
export function maskSource(source) {
  const code = [...source];
  const bare = [...source];
  const n = source.length;

  const blankBoth = (k) => {
    if (source[k] !== '\n') {
      code[k] = ' ';
      bare[k] = ' ';
    }
  };
  const blankBare = (k) => {
    if (source[k] !== '\n') bare[k] = ' ';
  };

  /** @type {Array<{ kind: 'code' | 'template', depth: number }>} */
  const stack = [{ kind: 'code', depth: 0 }];
  let i = 0;

  while (i < n) {
    const top = stack[stack.length - 1];
    const ch = source[i];
    const next = source[i + 1];

    if (top.kind === 'template') {
      if (ch === '\\') {
        blankBare(i);
        if (i + 1 < n) blankBare(i + 1);
        i += 2;
        continue;
      }
      if (ch === '`') {
        stack.pop();
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        stack.push({ kind: 'code', depth: 0 });
        i += 2;
        continue;
      }
      blankBare(i);
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        blankBoth(i);
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      blankBoth(i);
      blankBoth(i + 1);
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        blankBoth(i);
        i += 1;
      }
      if (i < n) {
        blankBoth(i);
        blankBoth(i + 1);
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') {
          blankBare(i);
          if (i + 1 < n) blankBare(i + 1);
          i += 2;
          continue;
        }
        blankBare(i);
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template', depth: 0 });
      i += 1;
      continue;
    }
    if (ch === '{') {
      top.depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (top.depth > 0) top.depth -= 1;
      else if (stack.length > 1) stack.pop();
      i += 1;
      continue;
    }
    i += 1;
  }

  return { code: code.join(''), bare: bare.join('') };
}

/** Offset → 1-based line number, without rescanning the file each time. */
export function lineCounter(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---- import extraction -----------------------------------------------------

/**
 * An import clause never contains a `;`, a quote or a backtick, so forbidding
 * them keeps a lazy match from spanning two statements (which would report the
 * wrong line for the second one).
 */
const STATIC_IMPORT = /(?<![\w$.])(import|export)\b([^;'"`]*?)\bfrom\s*(['"])([^'"]+)\3/g;
const SIDE_EFFECT_IMPORT = /(?<![\w$.])import\s*(['"])([^'"]+)\1/g;
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*(['"])([^'"]+)\1/g;
const REQUIRE_CALL = /(?<![\w$.])require\s*\(\s*(['"])([^'"]+)\1/g;

/**
 * Every imported name a clause binds, and whether the binding is type-only.
 * `import { type A, B }` binds A as a type and B as a value; the statement is
 * value-level because B is.
 *
 * @param {string} clause text between `import`/`export` and `from`
 */
export function readClause(clause) {
  const trimmed = clause.trim();
  const statementType = /^type\b/.test(trimmed);
  const body = statementType ? trimmed.replace(/^type\b/, '').trim() : trimmed;

  /** @type {Array<{ name: string, typeOnly: boolean }>} */
  const names = [];
  let sawValueBinding = false;

  const braced = body.match(/\{([\s\S]*)\}/);
  const outside = braced ? body.replace(braced[0], '') : body;

  for (const piece of outside.split(',')) {
    const text = piece.trim();
    if (!text) continue;
    if (/^\*\s+as\s+[\w$]+$/.test(text)) {
      names.push({ name: '*', typeOnly: statementType });
      if (!statementType) sawValueBinding = true;
      continue;
    }
    if (/^[\w$]+$/.test(text)) {
      names.push({ name: 'default', typeOnly: statementType });
      if (!statementType) sawValueBinding = true;
    }
  }

  if (braced) {
    for (const piece of braced[1].split(',')) {
      const text = piece.trim();
      if (!text) continue;
      const typeOnly = statementType || /^type\s+/.test(text);
      const name = text.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      names.push({ name, typeOnly });
      if (!typeOnly) sawValueBinding = true;
    }
  }

  // `import 'x'`-style empty clause is a runtime side effect, i.e. a value use.
  const typeOnly = statementType || (names.length > 0 && !sawValueBinding);
  return { typeOnly, names };
}

/**
 * Every module specifier a file references, with import kind and line.
 * Static clauses, re-exports, side-effect imports, dynamic `import('…')` and
 * `require('…')` all count — the last two are what the ESLint layer cannot see.
 *
 * @param {string} source raw file text
 * @returns {Array<{ specifier: string, typeOnly: boolean, names: Array<{name: string, typeOnly: boolean}>, form: string, line: number }>}
 */
export function readImports(source) {
  const { code } = maskSource(source);
  const lineAt = lineCounter(source);
  const found = [];
  const seen = new Set();

  const push = (entry) => {
    const key = `${entry.line}:${entry.specifier}:${entry.form}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(entry);
  };

  for (const m of code.matchAll(STATIC_IMPORT)) {
    const clause = readClause(m[2] ?? '');
    push({
      specifier: m[4],
      typeOnly: clause.typeOnly,
      names: clause.names,
      form: m[1] === 'export' ? 're-export' : 'static import',
      line: lineAt(m.index),
    });
  }
  for (const m of code.matchAll(SIDE_EFFECT_IMPORT)) {
    push({
      specifier: m[2],
      typeOnly: false,
      names: [],
      form: 'side-effect import',
      line: lineAt(m.index),
    });
  }
  for (const m of code.matchAll(DYNAMIC_IMPORT)) {
    push({
      specifier: m[2],
      typeOnly: false,
      names: [],
      form: 'dynamic import',
      line: lineAt(m.index),
    });
  }
  for (const m of code.matchAll(REQUIRE_CALL)) {
    push({
      specifier: m[2],
      typeOnly: false,
      names: [],
      form: 'require',
      line: lineAt(m.index),
    });
  }

  return found.sort((a, b) => a.line - b.line);
}

// ---- egress extraction -----------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every reference to a network-egress global, in any spelling the selector
 * layer misses: `fetch(…)`, `window.fetch(…)`, `globalThis.fetch(…)`,
 * `new WebSocket(…)`, and taking the function as a value (`const f = fetch`),
 * which is how an alias call is reached.
 *
 * Property access on some other object (`query.refetch()`, `client.fetchAll()`)
 * is not egress and is not reported.
 *
 * @param {string} source raw file text
 * @param {string[]} names egress globals declared by the manifest
 * @param {string[]} receivers objects the global may be reached through
 * @returns {Array<{ name: string, spelling: string, form: string, line: number }>}
 */
export function readEgress(source, names, receivers = DEFAULT_EGRESS_RECEIVERS) {
  const receiverAlternation = receivers.map(escapeRegExp).join('|') || 'window';
  const { bare } = maskSource(source);
  const lineAt = lineCounter(source);
  const found = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.line}:${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(entry);
  };

  for (const name of names) {
    // `const { fetch: send } = window` — an alias taken by destructuring. It has
    // to be looked for on its own, because the `name:` spelling is also how a
    // property or a type member is written, and those are not egress.
    const destructured = new RegExp(
      `(?:const|let|var)\\s*\\{[^}]*?\\b${escapeRegExp(name)}\\b[^}]*?\\}\\s*=\\s*` +
        `(?:${receiverAlternation})(?![\\w$])`,
      'g',
    );
    for (const m of bare.matchAll(destructured)) {
      push({
        name,
        spelling: `{ ${name} } = ${m[0].split('=').pop().trim()}`,
        form: 'destructured alias',
        line: lineAt(m.index),
      });
    }

    const re = new RegExp(
      `(?:(${receiverAlternation})\\s*\\.\\s*)?(${escapeRegExp(name)})(?![\\w$])`,
      'g',
    );
    for (const m of bare.matchAll(re)) {
      const before = bare.slice(Math.max(0, m.index - 24), m.index);
      const after = bare.slice(m.index + m[0].length, m.index + m[0].length + 24);

      // `myfetch`, `refetch`, `MyWindow.fetch` — not the global.
      if (/[\w$]$/.test(before)) continue;
      // `client.fetch(…)` / `client?.fetch(…)` — a method on something else.
      if (!m[1] && /\??\.\s*$/.test(before)) continue;
      // A declaration or type member named `fetch`, not a use of the global.
      if (/^\s*\??\s*:/.test(after)) continue;

      const form = /\bnew\s+$/.test(before)
        ? 'construction'
        : /^\s*\(/.test(after)
          ? 'call'
          : 'reference';

      push({
        name,
        spelling: m[0].replace(/\s+/g, ''),
        form,
        line: lineAt(m.index),
      });
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

// ---- manifest loading ------------------------------------------------------

/**
 * @param {string} absPath
 * @returns {{ manifest: object | null, errors: string[] }}
 */
export function loadManifest(absPath) {
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return {
      manifest: null,
      errors: [
        `manifest not readable at ${absPath} — the boundary rules are declared there, ` +
          'and a gate with no rules is not a passing gate',
      ],
    };
  }
  try {
    const manifest = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { manifest: null, errors: [`manifest at ${absPath} is not a JSON object`] };
    }
    return { manifest, errors: [] };
  } catch (error) {
    return {
      manifest: null,
      errors: [`manifest at ${absPath} is not parsable JSON: ${error.message}`],
    };
  }
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstDefined(rule, keys) {
  for (const key of keys) {
    if (rule[key] !== undefined) return rule[key];
  }
  return undefined;
}

/**
 * Validate one tolerance entry (a manifest exemption, or a rule-scoped
 * allowlist entry — the spec treats them alike): it is three-field reviewable
 * data or it is not honored.
 *
 * @returns {string[]} errors
 */
function validateTolerance(entry, label) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [
      `${label}: tolerance entries are three-field data — write ` +
        `{ …, reason, owner, change }, not ${JSON.stringify(entry)}`,
    ];
  }
  const missing = THREE_FIELDS.filter(
    (field) => typeof entry[field] !== 'string' || entry[field].trim() === '',
  );
  if (missing.length === 0) return [];
  return [`${label}: exemption is missing ${missing.join(', ')}`];
}

/**
 * Which rule kind an entry declares, derived from the entry's own data.
 *
 * There is deliberately no `kind` field to read: a label sitting beside the
 * data can disagree with it, and then the gate enforces the label while the
 * reviewer reads the data. `enforcement` says whether this interpreter runs the
 * rule at all; the shape of what is declared says what running it means.
 *
 * @returns {{ kind?: string, error?: string }}
 */
export function deriveKind(entry, id) {
  const enforcement =
    typeof entry.enforcement === 'string' ? entry.enforcement.trim().toLowerCase() : '';

  if (enforcement === 'existing-gate') return { kind: 'reference' };
  if (enforcement !== 'manifest') {
    return {
      error:
        `rule ${id}: enforcement ${JSON.stringify(entry.enforcement ?? null)} is not ` +
        `'manifest' (this interpreter runs it) or 'existing-gate' (another gate already ` +
        'does) — an entry that says neither is a boundary nobody is committed to enforcing',
    };
  }

  if (entry.forbid !== undefined) return { kind: 'package-imports' };
  if (entry.egress !== undefined) return { kind: 'egress' };
  if (entry.target !== undefined) return { kind: 'seam-import' };

  return {
    error:
      `rule ${id}: manifest-enforced but declares no rule data this interpreter ` +
      `implements (forbid / egress / target ⇒ ${RULE_KINDS.join(', ')}) — skipping it ` +
      'would be a boundary declared and unenforced, which is the failure mode the ' +
      'manifest exists to end',
  };
}

/**
 * Normalize the manifest's rule collection and reject malformed entries.
 *
 * @param {object} manifest
 * @returns {{ rules: object[], exemptions: object[], errors: string[] }}
 */
export function normalizeManifest(manifest) {
  const errors = [];
  /** @type {object[]} */
  const collected = [];

  // The two collections the manifest declares, and no third spelling: a
  // container name this gate accepted but the manifest never used would be a
  // place for a rule to sit and never be read.
  for (const key of ['packageRules', 'seamRules']) {
    const section = manifest[key];
    if (section === undefined) continue;
    if (Array.isArray(section)) {
      collected.push(...section.filter((entry) => entry && typeof entry === 'object'));
    } else if (typeof section === 'object') {
      for (const [id, entry] of Object.entries(section)) {
        if (id.startsWith('$')) continue;
        if (entry && typeof entry === 'object') collected.push({ id, ...entry });
      }
    }
  }

  if (collected.length === 0) {
    errors.push(
      'manifest declares no boundary rules — an empty rule set is a gate that ' +
        'enforces nothing, so it fails rather than passes',
    );
  }

  const rules = [];
  for (const [index, entry] of collected.entries()) {
    const id = typeof entry.id === 'string' && entry.id ? entry.id : `rules[${index}]`;

    for (const field of ['provenance', 'change']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        errors.push(
          `rule ${id}: missing ${field} — a rule without it cannot be traced ` +
            'back to the table it transcribes',
        );
      }
    }

    const { kind, error: kindError } = deriveKind(entry, id);
    if (!kind) {
      errors.push(kindError);
      continue;
    }

    if (kind === 'reference') {
      const enforcer = firstDefined(entry, ['enforcedBy', 'enforcer', 'gate', 'reference']);
      if (!enforcer) {
        errors.push(
          `rule ${id}: an already-landed rule must name its existing enforcer ` +
            '(enforcedBy), otherwise nothing enforces it',
        );
      }
      rules.push({ ...entry, id, kind, enforcedBy: enforcer });
      continue;
    }

    const consumers = asList(
      firstDefined(entry, ['consumers', 'scope', 'roots', 'appliesTo', 'scan']),
    ).filter((value) => typeof value === 'string' && value.trim() !== '');
    if (consumers.length === 0) {
      errors.push(`rule ${id}: no scan roots declared (consumers)`);
    }

    const exemptions = asList(firstDefined(entry, ['exemptions', 'exempt']));
    exemptions.forEach((exemption, position) => {
      errors.push(...validateTolerance(exemption, `rule ${id} exemption[${position}]`));
    });

    const normalized = { ...entry, id, kind, consumers, exemptions };

    if (kind === 'package-imports') {
      const forbid = entry.forbid;
      if (typeof forbid !== 'object' || forbid === null || Array.isArray(forbid)) {
        errors.push(
          `rule ${id}: forbid must be an object of { packagePatterns, paths, ` +
            `allowTypeImports }, not ${JSON.stringify(forbid)}`,
        );
        continue;
      }
      // Two shapes of forbidden target, kept apart on purpose: a package
      // pattern is matched against the specifier as written, a path is matched
      // against where the specifier RESOLVES — and only when it resolves
      // outside the importing file's own package (the manifest's conventions).
      const patterns = asList(forbid.packagePatterns).filter(
        (value) => typeof value === 'string' && value.trim() !== '',
      );
      const paths = asList(forbid.paths).filter(
        (value) => typeof value === 'string' && value.trim() !== '',
      );
      if (patterns.length === 0 && paths.length === 0) {
        errors.push(
          `rule ${id}: no forbidden packagePatterns or paths declared — an empty ` +
            'rule enforces nothing while reporting green',
        );
      }
      const allow = asList(firstDefined(entry, ['allow', 'allowSpecifiers']));
      allow.forEach((item, position) => {
        errors.push(...validateTolerance(item, `rule ${id} allow[${position}]`));
      });
      normalized.forbid = [
        ...patterns.map((pattern) => ({ pattern, crossPackageOnly: false })),
        ...paths.map((pattern) => ({ pattern, crossPackageOnly: true })),
      ];
      normalized.allow = allow
        .map((item) => (typeof item === 'object' && item ? item.specifier ?? item.pattern : null))
        .filter(Boolean);
      if (forbid.allowTypeImports !== undefined && typeof forbid.allowTypeImports !== 'boolean') {
        errors.push(
          `rule ${id}: forbid.allowTypeImports ${JSON.stringify(forbid.allowTypeImports)} is ` +
            'not a boolean — the type-only distinction is not a place to guess',
        );
      }
      // `allowTypeImports: true` is the manifest's spelling of "zero RUNTIME
      // dependencies" (P6/P8): `import type` is erased at emit, a value import
      // is not. The ESLint layer expresses the same split with the
      // typescript-eslint rule option of that name.
      normalized.valueOnly = forbid.allowTypeImports === true;
    }

    if (kind === 'egress') {
      const egress = entry.egress;
      if (typeof egress !== 'object' || egress === null || Array.isArray(egress)) {
        errors.push(
          `rule ${id}: egress must be an object of { calls, constructors, receivers }, ` +
            `not ${JSON.stringify(egress)}`,
        );
        continue;
      }
      const names = [...asList(egress.calls), ...asList(egress.constructors)].filter(
        (value) => typeof value === 'string' && value.trim() !== '',
      );
      if (names.length === 0) {
        errors.push(
          `rule ${id}: no egress calls or constructors declared — this interpreter ` +
            'refuses to invent the list the manifest is supposed to hold',
        );
      }
      normalized.egress = names;
      // The member spellings (`window.fetch`) are manifest data too: the
      // receivers are declared once, in the rule, not hard-coded in this scan.
      const receivers = asList(egress.receivers).filter(
        (value) => typeof value === 'string' && value.trim() !== '',
      );
      normalized.receivers = receivers.length > 0 ? receivers : DEFAULT_EGRESS_RECEIVERS;
      normalized.seamFiles = asList(
        firstDefined(entry, ['transports', 'seamFiles', 'seamPaths', 'seams']),
      ).filter((value) => typeof value === 'string');
    }

    if (kind === 'seam-import') {
      const declared = entry.target;
      if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
        errors.push(
          `rule ${id}: target must be an object of { path, specifiers }, not ` +
            JSON.stringify(declared),
        );
        continue;
      }
      // Both spellings of the same module: the path it lives at, and the alias
      // the importing files actually write.
      const target = [declared.path, ...asList(declared.specifiers)].filter(
        (value) => typeof value === 'string' && value.trim() !== '',
      );
      if (target.length === 0) {
        errors.push(`rule ${id}: no seam module declared (target.path / target.specifiers)`);
      }
      const allowNames = asList(firstDefined(entry, ['allowNames', 'allowedNames']));
      allowNames.forEach((item, position) => {
        errors.push(...validateTolerance(item, `rule ${id} allowNames[${position}]`));
      });
      normalized.target = target;
      normalized.allowNames = new Set(
        allowNames
          .map((item) => (typeof item === 'object' && item ? item.name : null))
          .filter(Boolean),
      );
    }

    rules.push(normalized);
  }

  const globalExemptions = asList(manifest.exemptions);
  globalExemptions.forEach((exemption, position) => {
    errors.push(...validateTolerance(exemption, `exemptions[${position}]`));
  });

  return { rules, exemptions: globalExemptions, errors };
}

// ---- scanning --------------------------------------------------------------

function isGeneratedOrTest(name) {
  return (
    /\.(test|spec)\.[a-z]+$/.test(name) ||
    /\.gen\.[a-z]+$/.test(name) ||
    name.endsWith('.typecheck.ts')
  );
}

/**
 * Expand the `*` segments a scan root may carry (`packages/<star>/src`) into
 * the directories that exist. A `*` stands for one directory name, matching the
 * manifest's `appliesTo` convention; an expansion that finds nothing is left to
 * the caller, which reports the empty scan rather than passing.
 */
export function expandScanRoot(root, relRoot) {
  const segments = relRoot.split('/').filter(Boolean);
  if (!segments.includes('*')) return [relRoot];

  let candidates = [''];
  for (const segment of segments) {
    const next = [];
    for (const prefix of candidates) {
      if (segment !== '*') {
        next.push(prefix ? `${prefix}/${segment}` : segment);
        continue;
      }
      let entries;
      try {
        entries = readdirSync(path.join(root, prefix), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
        next.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
    candidates = next;
  }
  return candidates.filter((candidate) => existsSync(path.join(root, candidate))).sort();
}

/**
 * Source files under a repo-relative root. A root that names a single file
 * resolves to that file, so a manifest can govern one file precisely; a root
 * with `*` segments resolves to every directory it expands to.
 */
export function sourceFilesUnder(root, relRoot, { includeTests = false } = {}) {
  if (relRoot.includes('*')) {
    return [
      ...new Set(
        expandScanRoot(root, relRoot).flatMap((expanded) =>
          sourceFilesUnder(root, expanded, { includeTests }),
        ),
      ),
    ].sort();
  }
  const abs = path.join(root, relRoot);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return SOURCE_EXTENSIONS.has(path.extname(abs)) ? [relRoot] : [];
  }
  if (!stat.isDirectory()) return [];

  const out = [];
  const walk = (dirAbs, dirRel) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childAbs = path.join(dirAbs, entry.name);
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(childAbs, childRel);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (!includeTests && isGeneratedOrTest(entry.name)) continue;
      out.push(childRel);
    }
  };
  walk(abs, relRoot.replace(/\/+$/, ''));
  return out.sort();
}

/** A `*`-bearing package/path pattern, or an exact package plus its subpaths. */
export function matchesPattern(target, pattern) {
  if (pattern.includes('*')) {
    const source = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`;
    return new RegExp(source).test(target);
  }
  return target === pattern || target.startsWith(`${pattern}/`);
}

/**
 * TypeScript path aliases declared by the nearest `tsconfig.json`, as
 * repo-relative prefixes.
 *
 * This matters more than it looks: every intra-app import in this repository is
 * written `@/lib/api/real`, not `../../lib/api/real`. A resolver that only
 * understood `../` would have judged the console's imports against a specifier
 * that matches no rule and reported a clean tree — the silent-green failure
 * this gate exists to prevent. The aliases are read from the source of truth
 * the compiler uses, so they cannot drift from what the imports actually mean.
 *
 * @returns {Array<{ prefix: string, target: string }>} `@/` → `apps/web/src/`
 */
export function tsconfigAliases(root, fileRel, cache = new Map()) {
  let dir = path.posix.dirname(fileRel);
  const chain = [];
  while (true) {
    chain.push(dir);
    if (cache.has(dir)) break;
    if (dir === '.' || dir === '' || dir === '/') break;
    dir = path.posix.dirname(dir);
  }

  let resolved = cache.get(chain[chain.length - 1]);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const current = chain[i];
    if (cache.has(current)) {
      resolved = cache.get(current);
      continue;
    }
    const configPath = path.join(root, current === '.' ? '' : current, 'tsconfig.json');
    let aliases = resolved ?? [];
    try {
      const raw = readFileSync(configPath, 'utf8');
      // tsconfig is JSON with comments, and sometimes a trailing comma.
      const json = JSON.parse(
        maskSource(raw).code.replace(/,(\s*[}\]])/g, '$1'),
      );
      const paths = json?.compilerOptions?.paths;
      if (paths && typeof paths === 'object') {
        const baseUrl = json.compilerOptions.baseUrl ?? '.';
        const base = path.posix.normalize(
          path.posix.join(current === '.' ? '' : current, baseUrl),
        );
        aliases = [];
        for (const [pattern, targets] of Object.entries(paths)) {
          const target = asList(targets).find((value) => typeof value === 'string');
          if (!target) continue;
          aliases.push({
            prefix: pattern.replace(/\*$/, ''),
            target: `${path.posix.normalize(path.posix.join(base, target.replace(/\*$/, '')))}/`
              .replace(/\/+$/, '/')
              .replace(/^\.\//, ''),
          });
        }
      }
    } catch {
      // No tsconfig here (or unreadable): inherit whatever the parent declared.
    }
    cache.set(current, aliases);
    resolved = aliases;
  }

  return resolved ?? [];
}

/**
 * What a specifier can be judged against: the specifier itself, the
 * repo-relative path it resolves to when it is relative, and the path its
 * tsconfig alias expands to — so a rule written as `apps/api/*` catches
 * `../../api/src/thing`, and a seam declared as a path catches `@/lib/api/real`.
 */
function specifierTargets(root, fileRel, specifier, aliasCache) {
  const targets = [specifier];
  if (specifier.startsWith('.')) {
    targets.push(path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), specifier)));
    return targets;
  }
  for (const { prefix, target } of tsconfigAliases(root, fileRel, aliasCache)) {
    if (!prefix || !specifier.startsWith(prefix)) continue;
    targets.push(path.posix.normalize(`${target}${specifier.slice(prefix.length)}`));
  }
  return targets;
}

/** Is `candidate` the directory `dir` itself or something under it? */
export function isWithin(candidate, dir) {
  return candidate === dir || candidate.startsWith(`${dir}/`);
}

/**
 * The workspace package a repo-relative file belongs to, as a repo-relative
 * directory — the nearest ancestor carrying a `package.json`.
 *
 * A file with no such ancestor (a loose script, a fixture tree that declares no
 * packages) belongs to no package: the caller then treats every forbidden path
 * as crossing, which is the strict reading, not the lenient one.
 */
export function packageOf(root, fileRel, cache = new Map()) {
  let dir = path.posix.dirname(fileRel);
  const pending = [];
  for (;;) {
    if (cache.has(dir)) break;
    pending.push(dir);
    if (dir === '.' || dir === '' || dir === '/') break;
    dir = path.posix.dirname(dir);
  }
  let inherited = cache.get(dir) ?? null;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const current = pending[i];
    const own = existsSync(path.join(root, current === '.' ? '' : current, 'package.json'))
      ? current
      : inherited;
    cache.set(current, own);
    inherited = own;
  }
  return cache.get(path.posix.dirname(fileRel)) ?? null;
}

function pathMatches(fileRel, declared) {
  const normalized = declared.replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.includes('*')) return matchesPattern(fileRel, normalized);
  return fileRel === normalized || fileRel.endsWith(`/${normalized}`);
}

function exemptionCovers(entry, violation) {
  const rule = entry.rule ?? entry.ruleId ?? '*';
  if (rule !== '*' && rule !== violation.rule) return false;
  const declared = entry.path ?? entry.file ?? entry.paths;
  const paths = asList(declared).filter((value) => typeof value === 'string');
  if (paths.length === 0) return false;
  return paths.some((candidate) => pathMatches(violation.file, candidate));
}

function isExempt(violation, exemptions) {
  return exemptions.some((entry) => exemptionCovers(entry, violation));
}

/** How an exemption entry is named in a report. */
function exemptionLabel(entry) {
  const declared = entry.path ?? entry.file ?? entry.paths;
  const paths = asList(declared).filter((value) => typeof value === 'string');
  return paths.join(', ') || JSON.stringify(entry);
}

/**
 * Run every enforceable rule in the manifest over the tree.
 *
 * @param {{ root?: string, manifestPath?: string }} options
 * @returns {{ violations: object[], errors: string[], scanned: number, rules: number }}
 */
export function runCheck({ root = REPO_ROOT, manifestPath } = {}) {
  const absManifest = manifestPath
    ? path.resolve(manifestPath)
    : path.join(root, DEFAULT_MANIFEST_PATH);

  const { manifest, errors: loadErrors } = loadManifest(absManifest);
  if (!manifest) return { violations: [], errors: loadErrors, scanned: 0, rules: 0 };

  const { rules, exemptions, errors } = normalizeManifest(manifest);
  if (errors.length > 0) {
    return { violations: [], errors, scanned: 0, rules: rules.length };
  }

  /** @type {object[]} */
  const violations = [];
  const scannedFiles = new Set();
  const sourceCache = new Map();
  const aliasCache = new Map();
  const packageCache = new Map();
  /** @type {string[]} */
  const staleExemptions = [];
  const read = (fileRel) => {
    if (!sourceCache.has(fileRel)) {
      try {
        sourceCache.set(fileRel, readFileSync(path.join(root, fileRel), 'utf8'));
      } catch {
        sourceCache.set(fileRel, '');
      }
    }
    return sourceCache.get(fileRel);
  };

  const enforceable = rules.filter((rule) => rule.kind !== 'reference');
  if (enforceable.length === 0) {
    return {
      violations: [],
      errors: [
        'manifest declares no enforceable rule — every entry defers to another ' +
          'gate, so this one would pass without looking at anything',
      ],
      scanned: 0,
      rules: rules.length,
    };
  }

  for (const rule of enforceable) {
    const files = [
      ...new Set(
        rule.consumers.flatMap((consumer) =>
          sourceFilesUnder(root, consumer, { includeTests: rule.includeTests === true }),
        ),
      ),
    ].sort();

    if (files.length === 0) {
      return {
        violations: [],
        errors: [
          `rule ${rule.id}: scan roots ${rule.consumers.join(', ')} resolved to zero ` +
            'source files — an empty scan is a failure, not a pass',
        ],
        scanned: 0,
        rules: rules.length,
      };
    }
    for (const file of files) scannedFiles.add(file);

    // Exemptions declared next to the rule count too — a tolerance is data
    // wherever the manifest chose to put it.
    const ruleExemptions = [...exemptions, ...rule.exemptions];
    /** @type {object[]} */
    const found = [];

    for (const file of files) {
      const source = read(file);

      if (rule.kind === 'package-imports') {
        const ownPackage = packageOf(root, file, packageCache);
        for (const entry of readImports(source)) {
          if (rule.valueOnly && entry.typeOnly) continue;
          const targets = specifierTargets(root, file, entry.specifier, aliasCache);
          const hit = rule.forbid.find(({ pattern, crossPackageOnly }) =>
            targets.some(
              (target) =>
                matchesPattern(target, pattern) &&
                // A forbidden DIRECTORY (`packages`, `apps`) describes where a
                // rule may not reach ACROSS to. An import that resolves back
                // inside the importing file's own package never crosses
                // anything — flagging it would make P5 red for every relative
                // import `packages/contracts` makes to itself.
                !(crossPackageOnly && ownPackage && isWithin(target, ownPackage)),
            ),
          );
          if (!hit) continue;
          if (rule.allow.some((pattern) => targets.some((t) => matchesPattern(t, pattern)))) {
            continue;
          }
          found.push({
            rule: rule.id,
            kind: 'forbidden-import',
            file,
            line: entry.line,
            detail:
              `${entry.form} of '${entry.specifier}' matches ${rule.id}'s forbidden ` +
              `pattern '${hit.pattern}'` +
              (rule.valueOnly ? ' (this package may only import it as a type)' : ''),
          });
        }
      }

      if (rule.kind === 'egress') {
        if (rule.seamFiles.some((seam) => pathMatches(file, seam))) continue;
        for (const entry of readEgress(source, rule.egress, rule.receivers)) {
          found.push({
            rule: rule.id,
            kind: 'egress-outside-seam',
            file,
            line: entry.line,
            detail:
              `${entry.form} of '${entry.spelling}' — ${rule.id} routes network egress ` +
              `through ${rule.seamFiles.join(' and ') || 'the declared transport files'}`,
          });
        }
      }

      if (rule.kind === 'seam-import') {
        if (rule.target.some((target) => pathMatches(file, target))) continue;
        for (const entry of readImports(source)) {
          const targets = specifierTargets(root, file, entry.specifier, aliasCache);
          const hit = rule.target.find((target) =>
            targets.some(
              (candidate) =>
                pathMatches(candidate.replace(/\.[a-z]+$/, ''), target.replace(/\.[a-z]+$/, '')) ||
                pathMatches(candidate, target),
            ),
          );
          if (!hit) continue;
          for (const binding of entry.names) {
            if (binding.typeOnly) continue;
            if (rule.allowNames.has(binding.name)) continue;
            found.push({
              rule: rule.id,
              kind: 'seam-bypass',
              file,
              line: entry.line,
              detail:
                `value import of '${binding.name}' from '${entry.specifier}' bypasses the ` +
                `capabilities seam ${rule.id} declares (type imports are fine; a new ` +
                'non-fetching export belongs in the manifest allowNames)',
            });
          }
        }
      }
    }

    violations.push(...found.filter((violation) => !isExempt(violation, ruleExemptions)));

    // A tolerance that no longer tolerates anything is a stale ledger entry.
    // Reporting it is what keeps the manifest a shrink-only ledger: fixing a
    // site without deleting its entry fails, exactly as an unused ESLint bulk
    // suppression does. Without this, moving the pre-existing debts into the
    // manifest would have traded the ratchet for a permanent free pass.
    for (const exemption of ruleExemptions) {
      if (found.some((violation) => exemptionCovers(exemption, violation))) continue;
      staleExemptions.push(
        `rule ${rule.id}: exemption for ${exemptionLabel(exemption)} covers no violation — ` +
          'the site was fixed or moved; delete the entry in the same change',
      );
    }
  }

  if (staleExemptions.length > 0) {
    return { violations, errors: staleExemptions, scanned: scannedFiles.size, rules: rules.length };
  }

  return { violations, errors: [], scanned: scannedFiles.size, rules: rules.length };
}

// ---- CLI -------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') options.root = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--manifest') options.manifestPath = path.resolve(argv[++i] ?? '');
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { violations, errors, scanned, rules } = runCheck(options);

  if (errors.length > 0) {
    console.error('boundaries-manifest: the manifest could not be enforced:\n');
    for (const message of errors) console.error(`  ${message}`);
    console.error(
      '\nThe boundary rules live in one place on purpose. Fix the declaration —' +
        '\nthis gate will not guess what it was supposed to enforce.',
    );
    process.exitCode = 1;
    return;
  }

  if (violations.length === 0) {
    console.log(
      `boundaries-manifest: ${rules} rule(s) over ${scanned} file(s) — no boundary violations`,
    );
    return;
  }

  console.error(`boundaries-manifest: ${violations.length} violation(s):\n`);
  for (const violation of violations) {
    console.error(`  [${violation.rule}/${violation.kind}] ${violation.file}:${violation.line}`);
    console.error(`    ${violation.detail}`);
  }
  console.error(
    '\nThis gate reads docs/refactor/boundaries-manifest.json and the source, and' +
      '\nnothing else — an eslint-disable comment does not reach it. Either the' +
      '\nimport belongs elsewhere, or the manifest gains a three-field exemption.',
  );
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
