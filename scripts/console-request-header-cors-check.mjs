#!/usr/bin/env node
/**
 * Every request header the console attaches must be admitted by the credentialed
 * CORS allow-list — and that allow-list must have exactly one declaration.
 *
 * WHY THIS EXISTS. The console and the api are different origins in every
 * deployment that matters — `cap-console.douglasdong.com` talking to
 * `cap-api.douglasdong.com`, and in the browser e2e a console on one loopback port
 * talking to an api on another. A request carrying any header outside the CORS
 * safelist is therefore PREFLIGHTED, and the preflight is answered from a
 * hand-maintained array.
 *
 * A header missing from that array does not degrade anything. It takes the console
 * OFF THE AIR: the browser refuses the preflight and never sends the request, so
 * the api never sees it, never logs it, and reports nothing.
 *
 * This gate was written after that shipped. `couple-console-deploy-to-the-release`
 * added `x-cap-console-build` to `authHeaders()` — attached to every REST call —
 * and did not add it to the allow-list. Typecheck passed, every unit suite passed,
 * `boot-smoke` passed (it probes the api directly, with no browser and therefore no
 * preflight), and the change went green everywhere except the one job that drives a
 * real browser. The failure named nothing: a 90-second timeout waiting for a
 * response to a request the browser had declined to send.
 *
 * WHY IT ALSO COUNTS DECLARATIONS. There were TWO copies of that array — `main.ts`
 * and the browser e2e's own Nest bootstrap, which answers its own preflights. The
 * first fix updated only `main.ts`, which would have left the e2e red while making
 * a gate that reads `main.ts` green. Admitting the header is the instance; having
 * one declaration is the class, so this checks both.
 *
 * `/mcp` is deliberately a separate domain and is NOT folded in: it is bearer-only
 * and non-credentialed, with its own narrower list, and merging them would hand a
 * wildcard-origin surface headers it has no use for.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The console transports. Every browser-visible request originates in one of these. */
export const CONSOLE_TRANSPORTS = [
  'apps/web/src/lib/api/real.ts',
  'apps/web/src/lib/ws-client.ts',
];

/** The one file permitted to spell the credentialed allow-list out. */
export const CORS_DECLARATION = 'apps/api/src/auth/auth-config.ts';

/** The exported name every consumer must derive from. */
export const CORS_DECLARATION_NAME = 'CONSOLE_CORS_ALLOWED_HEADERS';

/** Where a header name declared once and used by both sides is declared. */
export const SHARED_CONSTANT_SOURCES = ['packages/contracts/src/version.ts'];

/** Searched for a second literal declaration of the credentialed allow-list. */
export const API_TREE = 'apps/api';

/**
 * `/mcp` is a distinct CORS domain — bearer-only, non-credentialed, never reached
 * by a console — so its narrower list is a separate declaration on purpose rather
 * than a copy of this one.
 */
export const SEPARATE_CORS_DOMAINS = [/(^|\/)mcp(\/|-)/u];

/**
 * Headers the browser never puts on the wire from JS, so no preflight can ever ask
 * about them. `Cookie` is a forbidden header name: the console sets it only on the
 * SSR path, where a server-side fetch forwards the incoming request's cookie and no
 * CORS exists at all. Requiring it would demand an entry for a header that cannot
 * reach a preflight.
 */
export const NEVER_PREFLIGHTED = new Set(['cookie']);

/** Strips comments so prose about a header is never mistaken for one. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** Resolves `NAME = 'literal'` string constants used as header names. */
export function readSharedConstants(sources) {
  const constants = new Map();
  for (const source of sources) {
    const pattern =
      /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*['"]([^'"]+)['"]/gu;
    for (const match of stripComments(source).matchAll(pattern)) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/**
 * The header names a source can attach to a request. Three forms, which is all the
 * console uses: an indexed assignment with a literal key, the same with an
 * identifier, and a string key in an object literal passed as `headers:`.
 */
export function readAttachedHeaders(source, constants) {
  const text = stripComments(source);
  const names = new Set();

  for (const match of text.matchAll(/\bheaders\s*\[\s*['"]([^'"]+)['"]\s*\]\s*=/gu)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/\bextra\s*\[\s*['"]([^'"]+)['"]\s*\]\s*=/gu)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(
    /\b(?:headers|extra)\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=/gu,
  )) {
    const resolved = constants.get(match[1]);
    if (resolved) names.add(resolved);
  }
  for (const match of text.matchAll(/\bheaders\s*:\s*\{([^}]*)\}/gu)) {
    for (const key of match[1].matchAll(/['"]([\w-]+)['"]\s*:/gu)) {
      names.add(key[1]);
    }
  }

  return names;
}

/** The header names the credentialed allow-list declaration admits. */
export function readDeclaredAllowList(source, constants) {
  const text = stripComments(source);
  const block = new RegExp(
    `${CORS_DECLARATION_NAME}[^=]*=\\s*\\[([\\s\\S]*?)\\]`,
    'u',
  ).exec(text);
  if (!block) {
    throw new Error(
      `no ${CORS_DECLARATION_NAME} array found in ${CORS_DECLARATION} — the ` +
        'credentialed CORS allow-list moved or was renamed, and this gate cannot ' +
        'compare against something it cannot find. Fix the gate rather than ' +
        'deleting it.',
    );
  }
  const names = new Set();
  for (const match of block[1].matchAll(/['"]([^'"]+)['"]/gu)) {
    names.add(match[1]);
  }
  for (const match of block[1].matchAll(/\b([A-Z][A-Z0-9_]*)\b/gu)) {
    const resolved = constants.get(match[1]);
    if (resolved) names.add(resolved);
  }
  return names;
}

/** Every source file under a directory, recursively. */
function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.(ts|mjs|js)$/u.test(entry)) out.push(full);
    }
  };
  visit(root);
  return out;
}

/**
 * Finds `allowedHeaders: [ 'literal', ... ]` sites outside the one declaration.
 *
 * A site that spreads the shared constant is fine — that IS deriving. A site that
 * spells names out is a second declaration, and a second declaration is how a
 * header admitted in production goes missing from the bootstrap that answers a
 * browser's preflight in CI.
 */
export function findSecondDeclarations(files) {
  const found = [];
  for (const [path, source] of files) {
    if (path === CORS_DECLARATION) continue;
    if (SEPARATE_CORS_DOMAINS.some((pattern) => pattern.test(path))) continue;
    const text = stripComments(source);
    for (const match of text.matchAll(/allowedHeaders\s*:\s*\[([\s\S]*?)\]/gu)) {
      const body = match[1];
      if (body.includes(CORS_DECLARATION_NAME)) continue;
      const literals = [...body.matchAll(/['"]([^'"]+)['"]/gu)].map((m) => m[1]);
      if (literals.length > 0) found.push({ path, literals });
    }
  }
  return found;
}

/**
 * Returns the headers the console attaches that the allow-list would reject at the
 * preflight. Empty means the two sides agree.
 */
export function findUnadmittedHeaders({ transports, declaration, shared }) {
  const constants = readSharedConstants(shared);
  const allowed = new Set(
    [...readDeclaredAllowList(declaration, constants)].map((h) => h.toLowerCase()),
  );

  const unadmitted = [];
  for (const [path, source] of transports) {
    for (const name of readAttachedHeaders(source, constants)) {
      const lower = name.toLowerCase();
      if (NEVER_PREFLIGHTED.has(lower) || allowed.has(lower)) continue;
      unadmitted.push({ header: name, attachedBy: path });
    }
  }
  return unadmitted;
}

function read(relative_) {
  return readFileSync(join(REPO_ROOT, relative_), 'utf8');
}

function main() {
  const unadmitted = findUnadmittedHeaders({
    transports: CONSOLE_TRANSPORTS.map((p) => [p, read(p)]),
    declaration: read(CORS_DECLARATION),
    shared: SHARED_CONSTANT_SOURCES.map((p) => read(p)),
  });

  const apiFiles = walk(join(REPO_ROOT, API_TREE)).map((full) => [
    relative(REPO_ROOT, full),
    readFileSync(full, 'utf8'),
  ]);
  const seconds = findSecondDeclarations(apiFiles);

  let failed = false;

  if (unadmitted.length > 0) {
    failed = true;
    console.error(
      `${unadmitted.length} header(s) the console attaches are not admitted by ` +
        `${CORS_DECLARATION_NAME}.\n\n` +
        'The console and the api are different origins, so these requests are\n' +
        'preflighted. A header the preflight rejects means the browser NEVER SENDS\n' +
        'the request — the console goes dark and nothing anywhere reports why.\n',
    );
    for (const { header, attachedBy } of unadmitted) {
      console.error(`  ${header}\n    attached by ${attachedBy}`);
    }
    console.error(`\nAdd each to ${CORS_DECLARATION_NAME} in ${CORS_DECLARATION}.\n`);
  }

  if (seconds.length > 0) {
    failed = true;
    console.error(
      `${seconds.length} second declaration(s) of the credentialed CORS allow-list.\n\n` +
        'Each answers its own preflights, so a header added to one and missed by\n' +
        'another fails wherever the forgotten copy is the one serving — which is how\n' +
        'this gate came to exist.\n',
    );
    for (const { path, literals } of seconds) {
      console.error(`  ${path}\n    spells out: ${literals.join(', ')}`);
    }
    console.error(
      `\nSpread ${CORS_DECLARATION_NAME} instead, or — if this really is a separate\n` +
        'CORS domain like /mcp — add it to SEPARATE_CORS_DOMAINS with the reason.',
    );
  }

  if (failed) process.exit(1);

  console.log(
    `console request headers: every header attached by ${CONSOLE_TRANSPORTS.length} ` +
      `transport(s) is admitted by ${CORS_DECLARATION_NAME}, which is the only ` +
      'declaration of the credentialed allow-list.',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
