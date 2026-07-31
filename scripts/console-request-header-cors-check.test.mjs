import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CORS_DECLARATION,
  CORS_DECLARATION_NAME,
  CONSOLE_TRANSPORTS,
  SHARED_CONSTANT_SOURCES,
  findSecondDeclarations,
  findUnadmittedHeaders,
  readAttachedHeaders,
  readDeclaredAllowList,
  readSharedConstants,
} from './console-request-header-cors-check.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

const SHARED_FIXTURE = [
  `export const CONSOLE_BUILD_ID_HEADER = 'x-cap-console-build' as const;`,
];
const declaring = (...entries) =>
  `export const ${CORS_DECLARATION_NAME}: readonly string[] = [${entries.join(', ')}];`;

// ---- the live repository ----------------------------------------------------

test('the live console and the live allow-list agree on every header', () => {
  const unadmitted = findUnadmittedHeaders({
    transports: CONSOLE_TRANSPORTS.map((p) => [p, read(p)]),
    declaration: read(CORS_DECLARATION),
    shared: SHARED_CONSTANT_SOURCES.map((p) => read(p)),
  });
  assert.deepEqual(
    unadmitted,
    [],
    `these headers would be rejected at the CORS preflight, which means the browser ` +
      `never sends the request at all:\n${unadmitted
        .map((u) => `  ${u.header} (${u.attachedBy})`)
        .join('\n')}`,
  );
});

test('the api still bootstraps its CORS from exactly one declaration', () => {
  // Both known bootstraps must derive: `main.ts` serves production, and the browser
  // e2e runs its own Nest app and answers its own preflights.
  const bootstraps = [
    'apps/api/src/main.ts',
    'apps/api/test/scheduled-tasks-live-e2e-server.mjs',
  ];
  for (const path of bootstraps) {
    assert.match(
      read(path),
      new RegExp(`allowedHeaders[^\\]]*${CORS_DECLARATION_NAME}`, 'u'),
      `${path} does not derive its allow-list from ${CORS_DECLARATION_NAME}`,
    );
  }
});

// ---- the defect this was written for ----------------------------------------

test('it catches a header the allow-list does not admit', () => {
  // The exact shape that shipped: the console attaches the build identity on every
  // call, and the allow-list is the four entries that predate it. Every other check
  // passed on this — typecheck, every unit suite, and boot-smoke, which probes the
  // api directly and so never issues a preflight.
  const unadmitted = findUnadmittedHeaders({
    transports: [
      [
        'real.ts',
        `headers["Authorization"] = token;
         headers[CONSOLE_BUILD_ID_HEADER] = buildId();`,
      ],
    ],
    declaration: declaring(
      `'Content-Type'`,
      `'Authorization'`,
      `'Idempotency-Key'`,
      `'Last-Event-ID'`,
    ),
    shared: SHARED_FIXTURE,
  });
  assert.deepEqual(unadmitted, [
    { header: 'x-cap-console-build', attachedBy: 'real.ts' },
  ]);
});

test('it catches a SECOND declaration, which is how the first fix fell short', () => {
  // Fixing only main.ts would have left the e2e harness's own copy stale — red for
  // the same reason, while a gate reading main.ts reported agreement.
  const found = findSecondDeclarations([
    ['apps/api/src/main.ts', `allowedHeaders: [...${CORS_DECLARATION_NAME}],`],
    [
      'apps/api/test/scheduled-tasks-live-e2e-server.mjs',
      `allowedHeaders: ['Content-Type', 'Authorization'],`,
    ],
  ]);
  assert.deepEqual(found, [
    {
      path: 'apps/api/test/scheduled-tasks-live-e2e-server.mjs',
      literals: ['Content-Type', 'Authorization'],
    },
  ]);
});

test('/mcp keeps its own list — a separate domain is not a duplicate', () => {
  // Bearer-only and non-credentialed. Folding it in would hand a wildcard-origin
  // surface headers it has no use for.
  const found = findSecondDeclarations([
    ['apps/api/src/mcp/mcp-cors.spec.ts', `allowedHeaders: ['Content-Type', 'Authorization'],`],
  ]);
  assert.deepEqual(found, []);
});

// ---- reading each side ------------------------------------------------------

test('naming the header from the shared constant on both sides is enough', () => {
  const unadmitted = findUnadmittedHeaders({
    transports: [['real.ts', `headers[CONSOLE_BUILD_ID_HEADER] = buildId();`]],
    declaration: declaring(`'Authorization'`, 'CONSOLE_BUILD_ID_HEADER'),
    shared: SHARED_FIXTURE,
  });
  assert.deepEqual(unadmitted, []);
});

test('matching is case-insensitive, because HTTP header matching is', () => {
  const unadmitted = findUnadmittedHeaders({
    transports: [['real.ts', `headers["X-Cap-Console-Build"] = id;`]],
    declaration: declaring(`'x-cap-console-build'`),
    shared: [],
  });
  assert.deepEqual(unadmitted, []);
});

test('Cookie is not demanded — it can never reach a preflight', () => {
  // A forbidden header name: the browser will not let JS set it. The console sets it
  // only on the SSR path, where a server-side fetch forwards the incoming request's
  // cookie and no CORS is involved.
  const unadmitted = findUnadmittedHeaders({
    transports: [['real.ts', `if (incomingCookie) headers["Cookie"] = incomingCookie;`]],
    declaration: declaring(`'Authorization'`),
    shared: [],
  });
  assert.deepEqual(unadmitted, []);
});

test('a per-call object literal counts as attaching a header', () => {
  // Not every header goes through authHeaders(); some ride a call site's own
  // `headers: { ... }`. A gate that only read the shared helper would miss those.
  const unadmitted = findUnadmittedHeaders({
    transports: [['real.ts', `fetch(u, { headers: { "X-Custom": "1" } });`]],
    declaration: declaring(`'Authorization'`),
    shared: [],
  });
  assert.deepEqual(unadmitted, [{ header: 'X-Custom', attachedBy: 'real.ts' }]);
});

test('prose about a header does not count as attaching or admitting one', () => {
  // The contracts import gate read its own doc comment as an import once its walk
  // widened. A comment is not code, on either side of this comparison.
  assert.deepEqual(
    [
      ...readAttachedHeaders(
        `// headers["X-Ghost"] = never;
         /* headers["X-Phantom"] = never; */
         headers["X-Real"] = yes;`,
        new Map(),
      ),
    ],
    ['X-Real'],
  );

  assert.deepEqual(
    [
      ...readDeclaredAllowList(
        declaring(`'Authorization'`, `\n // 'X-Commented-Out',\n`),
        new Map(),
      ),
    ],
    ['Authorization'],
  );

  assert.deepEqual(
    findSecondDeclarations([['a.ts', `// allowedHeaders: ['X-Ghost'],`]]),
    [],
  );
});

// ---- failing closed ---------------------------------------------------------

test('a missing declaration fails loudly rather than passing vacuously', () => {
  // The failure mode this repository keeps finding: a gate that finds nothing to
  // compare and reports success. If the declaration moves, this must go red.
  assert.throws(
    () =>
      findUnadmittedHeaders({
        transports: [['real.ts', `headers["X-Anything"] = v;`]],
        declaration: `app.enableCors({ origin: true });`,
        shared: [],
      }),
    new RegExp(`no ${CORS_DECLARATION_NAME} array found`, 'u'),
  );
});

test('constants are read as values, not as names', () => {
  const constants = readSharedConstants(SHARED_FIXTURE);
  assert.equal(constants.get('CONSOLE_BUILD_ID_HEADER'), 'x-cap-console-build');
});
