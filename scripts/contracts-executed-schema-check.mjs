#!/usr/bin/env node
/**
 * Contracts executed-schema gate.
 *
 * A schema nothing runs is not a rule. It is a comment shaped like one, and it
 * can contradict what the api actually sends with no signal anywhere. This
 * repository has now found that exact defect three times:
 *
 *   SmtpConfigReadSchema        declared host/user/from `.min(1)` while the api
 *                               returned a blank tuple for an unset config
 *   RuntimeReadinessResponse    declared `z.array(…)` while the api sent
 *                               `{ runtimes: [...] }`, from the same commit
 *   AdminRevealResponseSchema   declares { email, password } both required while
 *                               the controller returns `{}` on two of three paths
 *
 * All three had ZERO call sites. Every gate in the repository was green.
 *
 * The sibling `contracts-shared-export-check.mjs` measures whether anything
 * NAMES an export. This measures whether anything RUNS it, which is a different
 * question with a different answer: a schema every consumer imports the type of,
 * and no consumer ever parses, is unexecuted.
 *
 * Run: node scripts/contracts-executed-schema-check.mjs [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  readDeclarationBlocks,
  stripComments,
} from './contracts-shared-export-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONTRACTS_SRC = path.join(ROOT, 'packages/contracts/src');

/**
 * Places where a parse happens through indirection, so the call site names a
 * property path rather than a schema.
 *
 * DECLARED, never inferred. The alternative — treating everything reachable from
 * a large object as executed — hands a blanket amnesty to whatever is put in that
 * object next, which is how a gate stops being a gate. Each entry says where the
 * parse is and which declarations it covers; a new indirection point costs one
 * entry, and forgetting one costs a false positive that surfaces immediately.
 *
 * @type {ReadonlyArray<{ module: string, wrapper: RegExp, parseSite: string, reason: string }>}
 */
const INDIRECTION_POINTS = [
  {
    module: 'public-v1-operations',
    // Every schema handed to `definePublicSchemaPair`, plus every schema named in
    // the operation table's `responseSchema`/`input` positions.
    wrapper: /definePublicSchemaPair\(|responseSchema:|input:\s*\{/u,
    parseSite:
      'apps/api/src/public-surface/public-v1-operation.ts:436-455 — parsePublicV1Input calls operation.input.{params,query,headers,body}.parse on a table entry',
    reason:
      'the /v1 surface validates every request through the operation registry, so the parse call names a property path and no text scan can attribute it to the schema',
  },
  {
    module: 'asciicast',
    helper: 'parseAsciicastEvent',
    calledBy: 'apps/api/src/terminal/terminal.gateway.ts:81',
    parseSite:
      'packages/contracts/src/asciicast.ts:78 — parseAsciicastEvent calls AsciicastEventSchema.safeParse inside the contracts package',
    reason:
      'the parse lives in an exported helper INSIDE this package, which production calls by name (terminal.gateway.ts for the resume tail, session-cast-log.tsx through parseCast). The scan walks consumer packages, so a schema parsed by a contracts helper read as never-run — a false positive of the instrument, not a finding about the schema',
  },
  {
    module: 'asciicast',
    helper: 'parseAsciicastHeader',
    calledBy: 'apps/api/src/terminal/terminal.gateway.ts:82',
    parseSite:
      'packages/contracts/src/asciicast.ts:65 — parseAsciicastHeader calls AsciicastHeaderSchema.safeParse inside the contracts package',
    reason: 'same in-package helper form as parseAsciicastEvent above',
  },
];

/**
 * Schemas deliberately not executed by production code.
 * Every entry needs a reason. An empty list is the healthy state.
 *
 * @type {ReadonlyArray<{ schema: string, reason: string }>}
 */
const EXCEPTIONS = [
  // ── Path-param shapes the routes deliberately do not enforce ──────────────
  //
  // Each is `{ id: z.string().uuid() }` for a route taking `@Param('id')` as a raw
  // string. Wiring them in is a one-liner and would be WRONG: today a malformed id
  // falls through to a lookup that finds nothing and answers exactly as it does for
  // a well-formed id with no row. Validating the param would make the two
  // distinguishable — 400 "malformed" against 404/403 "absent" — which is strictly
  // more information to an enumerating caller. The schema describes the id space;
  // it is not a rule this boundary is meant to apply.
  { schema: 'AdminAccountParamsSchema', reason: 'path-param shape; route answers by lookup' },
  { schema: 'ApiKeyRevokeParamsSchema', reason: 'path-param shape; route answers by lookup' },
  { schema: 'McpTokenRevokeParamsSchema', reason: 'path-param shape; route answers by lookup' },
  {
    schema: 'CodexDeviceLoginSessionParamsSchema',
    reason:
      'settings.controller.ts:317/332 already validate the id — through `.shape.sessionId`, the field, so the object wrapper itself is never parsed. Adjudicated as enforced-by-its-field rather than unexecuted; converging the wrapper away is tidier than parsing it',
  },

  // ── Declarations the wire already contradicts ─────────────────────────────
  //
  // The SmtpConfigRead pattern: giving these a call site before fixing the
  // declaration would turn a silent drift into a 500, which is why
  // AdminRevealResponseSchema had to grow an arm BEFORE its parse went in
  // (design D5). Each needs a contract fix first, and each fix is a new request
  // surface this change did not scope.
  {
    schema: 'AuditQuerySchema',
    reason:
      'declares `limit: z.number()` while HTTP query params arrive as strings, so `GET /audit/events` parses a file-local restatement with `z.coerce.number()` (audit.controller.ts:94-98) whose own comment admits it "mirrors the contracts AuditQuerySchema but coerces limit". The contract needs the coercion arm before it can be the thing parsed',
  },
  {
    schema: 'ForgeConnectionSchema',
    reason:
      'reported violated on an input-dependent path rather than the happy one; needs the violating shape pinned down before a parse is safe to add',
  },

  // ── The inline-literal class, scoped OUT of this change ───────────────────
  //
  // The value is used, the constant is not. Converging them is the follow-up
  // change; deleting them now would ratify the restatement, which design D3
  // forbids.
  {
    schema: 'IdentityProviderSchema',
    reason:
      "value 'password' written as a literal at admin-seed.service.ts:274/298/300 and as a LOCAL constant PASSWORD_IDENTITY_PROVIDER at password.service.ts:77",
  },
  {
    schema: 'TaskFailureActionSchema',
    reason:
      "apps/web/src/components/runtime-credential-alert.tsx:13,20 compares against the literal 'reconnect_runtime' rather than the enum",
  },

  // ── Vocabularies no payload carries ──────────────────────────────────────
  {
    schema: 'SandboxModeSchema',
    reason:
      'a vocabulary, not a wire shape — no REST or WS payload in the repository carries a sandbox mode, so there is no boundary at which to parse it',
  },
  {
    schema: 'GithubListErrorCodeSchema',
    reason:
      'a bare vocabulary composed into no envelope schema; its one reference is a compile-time `import type`',
  },
  {
    schema: 'TaskProvisioningDiagnosticOutcomeSchema',
    reason:
      'every `outcome` the system writes or reads is already validated through the diagnostic EVENT schema; this standalone enum is the same vocabulary at a granularity nothing parses on its own',
  },

  // ── Declaration halves of unbuilt work ───────────────────────────────────
  //
  // Deleting these removes the only part of a stated intention that exists.
  {
    schema: 'NotifyLevelSchema',
    reason: 'agent-events-and-approvals SHALL "define a notification adapter port"; no adapter exists anywhere',
  },
  { schema: 'NotifyPayloadSchema', reason: 'same unimplemented SHALL' },
  { schema: 'RequestDecisionPayloadSchema', reason: 'same unimplemented SHALL' },
  { schema: 'NotificationCapabilitySchema', reason: 'same unimplemented SHALL' },
  {
    schema: 'DecisionEnvelopeSchema',
    reason:
      'the declaration half of a compatibility path a test forbids the shipped image from wiring',
  },
  {
    schema: 'TaskProvisioningDiagnosticExpectationSchema',
    reason:
      'pins schemaVersion + nextAttempt for a diagnostics-expectation exchange nothing implements',
  },
  {
    schema: 'Xterm550ResponseProfileSchema',
    reason:
      'declares that a drifted descriptor/fingerprint "is not negotiable" and has no production call site — no wire, DB row or env value carries a TerminalResponseProfile object, so the rule guards a negotiation that transmits only an id. Named here because it is the sharpest remaining example of a rule written and unenforced, and closing it means changing what the attach frame carries',
  },
];

/** Directory names never descended into. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '.vercel',
]);

/** Where production code lives. Tests are excluded on purpose — see `testOnly`. */
const PRODUCTION_ROOTS = [
  'apps/api/src',
  'apps/web/src',
  'apps/sandbox-hooks/src',
  'packages/sandbox/src',
  'packages/sandbox-core/src',
  'packages/sandbox-environment/src',
  'packages/ui/src',
];

const isTestFile = (file) =>
  /\.(test|spec)\.(ts|tsx|mts|mjs|js)$/u.test(file) ||
  file.includes(`${path.sep}test${path.sep}`) ||
  file.includes(`${path.sep}__tests__${path.sep}`);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx|mts|mjs|js|jsx)$/u.test(entry)) out.push(abs);
  }
  return out;
}

/**
 * Whether `source` parses `name` — directly, or by handing it to something whose
 * whole job is to parse it.
 *
 * `UsePipes(new ZodValidationPipe(X))` is the Nest form and matters as much as
 * `X.parse(...)`: it is how every request body in this api is validated.
 */
export function parsesSchema(source, name) {
  // Four forms, not six. `zodToJsonSchema(X)` and `parseZodValue(X)` were here
  // and are gone: both had ZERO call sites repository-wide, and each was wrong on
  // its own terms. Reflecting a schema into JSON Schema validates no wire bytes,
  // so counting it as execution is the reachable-but-unexecuted amnesty this gate
  // exists to separate — and it would silently exempt the first OpenAPI-only
  // reference someone adds. `parseZodValue`'s real call sites pass a property
  // path (`operation.input.params.parse`), never a schema name, which is exactly
  // why D2 chose DECLARED indirection over textual inference; that indirection is
  // already declared, so the pattern was inference the design had rejected.
  const patterns = [
    `\\b${name}\\s*\\.(?:parse|safeParse|parseAsync|safeParseAsync)\\b`,
    `ZodValidationPipe\\(\\s*${name}\\b`,
    `UsePipes\\([^)]*\\b${name}\\b`,
  ];
  return new RegExp(patterns.join('|'), 'u').test(source);
}

/** Memoized: the tree does not change within a process, and the tests call this
 *  once per case. Five identical full walks is five times the work for one answer. */
let cached = null;

/** The full scan. */
export function scan() {
  if (cached) return cached;
  cached = computeScan();
  return cached;
}

function computeScan() {
  // 1. Contract declarations, as blocks, so composition can be read off bodies.
  const blocks = new Map();
  const schemaNames = [];
  for (const file of readdirSync(CONTRACTS_SRC)) {
    if (!file.endsWith('.ts') || file.endsWith('.typecheck.ts')) continue;
    if (file === 'index.ts') continue;
    const module = file.replace(/\.ts$/u, '');
    const source = readFileSync(path.join(CONTRACTS_SRC, file), 'utf8');
    for (const block of readDeclarationBlocks(stripComments(source))) {
      if (blocks.has(block.name)) continue;
      blocks.set(block.name, { module, body: block.lines.join('\n') });
      // A schema is a `const` whose name ends in `Schema`. A FUNCTION so named —
      // `composePublicInputWireSchema` builds one — is a factory, and asking
      // whether anything parses it is a category error that would put a helper
      // on the list of rules nothing enforces.
      if (block.name.endsWith('Schema') && /^(?:export\s+)?const\b/u.test(block.lines[0].trim())) {
        schemaNames.push(block.name);
      }
    }
  }

  // 2. Seed: parsed by production code, or covered by a declared indirection.
  const executed = new Set();
  const why = new Map();

  const production = PRODUCTION_ROOTS.flatMap((dir) =>
    walk(path.join(ROOT, dir)),
  ).filter((file) => !isTestFile(file));
  for (const file of production) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const name of schemaNames) {
      if (executed.has(name)) continue;
      if (parsesSchema(source, name)) {
        executed.add(name);
        why.set(name, `parsed at ${path.relative(ROOT, file)}`);
      }
    }
  }

  // 2c. Parses that live in an exported helper INSIDE this package, where some
  //     production file imports that helper by name. The parse is real and the
  //     caller is real; only the scan's file list made it invisible.
  const productionText = production
    .map((file) => stripComments(readFileSync(file, 'utf8')))
    .join('\n');
  for (const [name, block] of blocks) {
    if (!/^(?:export\s+)?(?:async\s+)?function\b/u.test(block.body.trim())) continue;
    if (!new RegExp(`\\b${name}\\b`, 'u').test(productionText)) continue;
    for (const candidate of schemaNames) {
      if (executed.has(candidate)) continue;
      if (parsesSchema(block.body, candidate)) {
        executed.add(candidate);
        why.set(candidate, `parsed by in-package helper ${name}(), called from production`);
      }
    }
  }

  for (const point of INDIRECTION_POINTS) {
    // An in-package parse helper: the parse is real and inside the package, so
    // whatever its own body parses counts — provided a production caller exists,
    // which `calledBy` asserts and the check below verifies.
    if (point.helper) {
      const helper = blocks.get(point.helper);
      const [callerFile] = (point.calledBy ?? '').split(':');
      let called = false;
      try {
        called = readFileSync(path.join(ROOT, callerFile), 'utf8').includes(point.helper);
      } catch {
        called = false;
      }
      if (!helper || !called) {
        // Declared and no longer true. Reported by leaving the schemas
        // unexecuted rather than by silently keeping them alive.
        continue;
      }
      for (const candidate of schemaNames) {
        if (executed.has(candidate)) continue;
        if (parsesSchema(helper.body, candidate)) {
          executed.add(candidate);
          why.set(candidate, `in-package helper ${point.parseSite}`);
        }
      }
      continue;
    }
    for (const [name, block] of blocks) {
      if (block.module !== point.module || executed.has(name)) continue;
      if (!point.wrapper.test(block.body)) continue;
      // Everything this wrapper block names is parsed through the declared site.
      for (const candidate of schemaNames) {
        if (executed.has(candidate)) continue;
        if (new RegExp(`\\b${candidate}\\b`, 'u').test(block.body)) {
          executed.add(candidate);
          why.set(candidate, `indirect via ${point.parseSite}`);
        }
      }
    }
  }

  // 3. Propagate: whatever an executed schema is built out of runs with it.
  //
  // Through EVERY declaration, not only the `*Schema`-suffixed ones. This package
  // routinely composes through an un-suffixed intermediate —
  // `RuntimeModelErrorBaseShape`, `DiagnosticEventIdentityFields` — and a
  // propagation that only stepped schema-to-schema stopped at the first such hop,
  // reporting a dozen schemas as never-run while the union they build IS parsed.
  // Those were false positives of this instrument, not findings about the package.
  const reached = new Set(executed);
  const queue = [...executed];
  while (queue.length > 0) {
    const name = queue.pop();
    const block = blocks.get(name);
    if (!block) continue;
    for (const [candidate] of blocks) {
      if (reached.has(candidate) || candidate === name) continue;
      if (new RegExp(`\\b${candidate}\\b`, 'u').test(block.body)) {
        reached.add(candidate);
        queue.push(candidate);
        if (candidate.endsWith('Schema') && !executed.has(candidate)) {
          executed.add(candidate);
          why.set(candidate, `composed into ${name}`);
        }
      }
    }
  }

  // 4. Test-only: parsed somewhere, but only by a test. Reported, not counted.
  const testOnly = new Set();
  const testFiles = [
    ...walk(CONTRACTS_SRC),
    ...PRODUCTION_ROOTS.flatMap((dir) => walk(path.join(ROOT, dir))),
  ].filter(isTestFile);
  for (const file of testFiles) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const name of schemaNames) {
      if (executed.has(name) || testOnly.has(name)) continue;
      if (parsesSchema(source, name)) testOnly.add(name);
    }
  }

  const excepted = new Set(EXCEPTIONS.map((e) => e.schema));
  const unexecuted = schemaNames
    .filter((name) => !executed.has(name) && !excepted.has(name))
    .sort();

  return {
    schemas: schemaNames.length,
    executed: executed.size,
    testOnly: [...testOnly].sort(),
    excepted: [...excepted].sort(),
    unexecuted,
    moduleOf: (name) => blocks.get(name)?.module ?? '?',
    reasonFor: (name) => why.get(name) ?? '',
  };
}

function main() {
  const result = scan();

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          schemas: result.schemas,
          executed: result.executed,
          testOnly: result.testOnly,
          unexecuted: result.unexecuted,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `contracts-executed-schema-check: ${result.schemas} schemas, ${result.executed} executed by production code`,
  );
  if (result.testOnly.length > 0) {
    console.log(
      `  ${result.testOnly.length} parsed ONLY by tests: ${result.testOnly.join(' · ')}`,
    );
  }

  if (result.unexecuted.length === 0) {
    console.log('  every schema is executed');
    return;
  }

  console.error(
    `\ncontracts-executed-schema-check: ${result.unexecuted.length} schema(s) nothing runs:\n`,
  );
  const byModule = new Map();
  for (const name of result.unexecuted) {
    const module = result.moduleOf(name);
    byModule.set(module, [...(byModule.get(module) ?? []), name]);
  }
  for (const [module, names] of [...byModule].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    console.error(`  packages/contracts/src/${module}.ts`);
    for (const name of names) console.error(`    ${name}`);
  }
  console.error(
    '\nA schema nothing runs is not a rule — it can contradict what is actually sent',
  );
  console.error(
    'with no signal. Three shipped defects in this repository were exactly this.',
  );
  console.error(
    'Give it a production call site, delete it, or add it to EXCEPTIONS with a reason.',
  );
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
