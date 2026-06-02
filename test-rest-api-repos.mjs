/**
 * Minimal test for requirement: "REST API for repos"
 *
 * Requirement semantics (from repos.controller.ts + repos.service.ts):
 *   1. POST /repos with valid body → 201 with the created repo matching the
 *      contracts RepoResponse schema (id, name, gitSource, createdAt)
 *   2. POST /repos with invalid body (missing required fields) → 400 BadRequest,
 *      nothing is stored (ZodValidationPipe rejects before service is called)
 *   3. GET /repos → 200 with an array of repos
 *   4. GET /repos/:id existing id → 200 with the repo
 *   5. GET /repos/:id non-existent id → 404 NotFoundException
 *
 * Strategy: load the compiled service + pipe + contracts directly via CJS
 * require with a module-resolution shim for the ESM-only @cap/contracts package.
 * No real database or HTTP server needed — we call methods directly.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDist = path.join(__dirname, 'apps/api/dist');
const contractsDist = path.join(__dirname, 'packages/contracts/dist/index.js');

// Shim: CJS require cannot load ESM-only @cap/contracts directly.
// The contracts dist/index.js is ESM (export *), but Node CJS loader supports
// loading ESM files when they are reached via require() in recent Node versions
// using the experimental CJS-require-ESM interop.  If that is not available
// we patch _resolveFilename to redirect the bare specifier to the dist file so
// that require() attempts the load.
import { Module } from 'node:module';
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
  if (request === '@cap/contracts') return contractsDist;
  return origResolve(request, parent, isMain, options);
};

const require = createRequire(import.meta.url);

const { ReposService } = require(path.join(apiDist, 'repos/repos.service.js'));
const { ZodValidationPipe } = require(path.join(apiDist, 'repos/zod-validation.pipe.js'));
const { BadRequestException, NotFoundException } = require(
  path.join(__dirname, 'apps/api/node_modules/@nestjs/common'),
);
// Import contracts schemas for validation (ESM dynamic import)
const contracts = await import(contractsDist);
const { createRepoBodySchema, repoResponseSchema } = contracts;

// ---------- in-memory PrismaService mock --------------------------------------

let store = [];

const mockPrisma = {
  repo: {
    create: async ({ data }) => {
      const repo = {
        id: crypto.randomUUID(),
        name: data.name,
        gitSource: data.gitSource,
        createdAt: new Date(),
      };
      store.push(repo);
      return repo;
    },
    findMany: async () => [...store].sort((a, b) => +a.createdAt - +b.createdAt),
    findUnique: async ({ where }) => store.find((r) => r.id === where.id) ?? null,
  },
};

// ---------- helpers -----------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    const msg = detail ? `${label} — ${detail}` : label;
    console.error(`  FAIL  ${msg}`);
    failed++;
    failures.push(msg);
  }
}

async function runTest(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`  FAIL  ${label} — threw unexpectedly: ${err?.message ?? err}`);
    failed++;
    failures.push(`${label}: ${err?.message ?? err}`);
  }
}

// ---------- setup -------------------------------------------------------------

console.log('\nREST API for repos — test suite\n');

const svc = new ReposService(mockPrisma);
const pipe = new ZodValidationPipe(createRepoBodySchema);

// ---------- 1. POST /repos valid body → 201 with created repo -----------------
await runTest('POST /repos valid body → 201 with created repo', async () => {
  // Simulate ZodValidationPipe + service create
  const body = pipe.transform({ name: 'acme', gitSource: 'https://github.com/acme/repo.git' });
  const result = await svc.create(body);

  ok('create returns an id', typeof result.id === 'string' && result.id.length > 0);
  ok('create returns correct name', result.name === 'acme');
  ok('create returns correct gitSource', result.gitSource === 'https://github.com/acme/repo.git');
  ok('create returns a createdAt Date', result.createdAt instanceof Date);
  // Validate against the contracts schema (defensive check in service must pass)
  const parse = repoResponseSchema.safeParse(result);
  ok('result passes repoResponseSchema', parse.success, parse.error?.message);
});

// ---------- 2. POST /repos missing name → 400 BadRequest, nothing stored ------
await runTest('POST /repos missing name → 400 no record created', async () => {
  const beforeCount = store.length;

  let threw = false;
  let isBadRequest = false;
  try {
    pipe.transform({ gitSource: 'https://github.com/example/repo.git' });
  } catch (err) {
    threw = true;
    isBadRequest = err instanceof BadRequestException;
  }

  ok('ZodValidationPipe throws on missing name', threw);
  ok('thrown error is BadRequestException (400)', isBadRequest);
  ok('no record was stored', store.length === beforeCount);
});

// ---------- 3. GET /repos → 200 with array ------------------------------------
await runTest('GET /repos → 200 with array of repos', async () => {
  const results = await svc.list();

  ok('list() returns an array', Array.isArray(results));
  ok('list() has at least the created repo', results.length >= 1);
  // Every item must satisfy the contracts schema
  const allValid = results.every((r) => repoResponseSchema.safeParse(r).success);
  ok('all list items pass repoResponseSchema', allValid);
});

// ---------- 4. GET /repos/:id existing id → 200 with repo --------------------
await runTest('GET /repos/:id existing id → 200 with repo', async () => {
  const created = store[0];
  const result = await svc.findById(created.id);

  ok('findById returns the correct id', result.id === created.id);
  ok('findById returns the correct name', result.name === created.name);
  const parse = repoResponseSchema.safeParse(result);
  ok('findById result passes repoResponseSchema', parse.success, parse.error?.message);
});

// ---------- 5. GET /repos/:id non-existent → 404 -----------------------------
await runTest('GET /repos/:id non-existent → 404', async () => {
  const nonExistentId = crypto.randomUUID();

  let threw = false;
  let isNotFound = false;
  try {
    await svc.findById(nonExistentId);
  } catch (err) {
    threw = true;
    isNotFound = err instanceof NotFoundException;
  }

  ok('findById throws on non-existent id', threw);
  ok('thrown error is NotFoundException (404)', isNotFound);
});

// ---------- summary -----------------------------------------------------------
console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
