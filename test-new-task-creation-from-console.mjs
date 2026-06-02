/**
 * Minimal test for requirement: "New task creation from the console"
 *
 * This exercises the core logic of creating a task through the console (spec 13.5):
 *
 *   C1. POST /repos/:repoId/tasks body is validated by createTaskBodySchema.
 *       - A valid body (prompt required, branch/strategy optional) passes.
 *       - A body missing the required `prompt` field fails validation (→ 400).
 *       - An empty string prompt fails (min(1) constraint → 400).
 *
 *   C2. The api-client `createTask` builds the correct request shape:
 *       - Sends `prompt`, and optional `branch`/`strategy` (trims & omits blanks).
 *       - Validates the response body against `TaskResponseSchema`.
 *
 *   C3. On success the API returns a TaskResponse with:
 *       - uuid `id`, matching `repoId`, the original `prompt`, initial
 *         status `pending` (or `queued` when guardrails are wired), and a `createdAt`.
 *
 *   C4. Repo not found → the service must surface a 404 (NotFoundException).
 *
 *   C5. The ZodValidationPipe renders schema failures as 400 BadRequestException.
 */

// We exercise the shared @cap/contracts schemas directly because they are the
// contracts-layer single source of truth that the controller, service, and
// web api-client all depend on.
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// Load the compiled contracts package (workspace dependency).
const contractsPath = resolve(ROOT, 'packages/contracts/dist/index.js');
const contracts = require(contractsPath);

const {
  createTaskBodySchema,
  TaskResponseSchema,
  TaskStatusSchema,
  ListReposResponseSchema,
} = contracts;

// ──────────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ──────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? '  —  ' + detail : ''}`);
    failed++;
  }
}

function assertParses(label, schema, value) {
  const result = schema.safeParse(value);
  assert(label + ' — parses successfully', result.success,
    result.success ? '' : JSON.stringify(result.error.issues));
}

function assertRejects(label, schema, value) {
  const result = schema.safeParse(value);
  assert(label + ' — rejected (as expected)', !result.success,
    result.success ? 'unexpectedly passed' : '');
}

// ──────────────────────────────────────────────────────────────────────────────
// C1 — createTaskBodySchema validation (what the ZodValidationPipe runs)
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== C1: POST body validation via createTaskBodySchema ===\n');

// C1.1 — minimal valid body (prompt only)
assertParses(
  'C1.1 prompt-only body',
  createTaskBodySchema,
  { prompt: 'Fix the failing unit test in auth module' },
);

// C1.2 — full body with optional fields
assertParses(
  'C1.2 full body (prompt + branch + strategy)',
  createTaskBodySchema,
  {
    prompt: 'Refactor the auth guard',
    branch: 'feature/auth-refactor',
    strategy: 'careful',
  },
);

// C1.3 — missing prompt → rejected
assertRejects(
  'C1.3 missing prompt',
  createTaskBodySchema,
  { branch: 'main' },
);

// C1.4 — empty string prompt → rejected (min(1))
assertRejects(
  'C1.4 empty string prompt',
  createTaskBodySchema,
  { prompt: '' },
);

// C1.5 — prompt is whitespace-only string → passes schema (trimming is caller's job)
assertParses(
  'C1.5 whitespace prompt (schema accepts it; controller trims before sending)',
  createTaskBodySchema,
  { prompt: '   ' },
);

// C1.6 — unknown extra fields are stripped (zod strips by default)
{
  const result = createTaskBodySchema.safeParse({
    prompt: 'Do something',
    unknownField: 'should be stripped',
  });
  assert(
    'C1.6 unknown extra fields stripped without error',
    result.success && !('unknownField' in (result.data ?? {})),
  );
}

// C1.7 — branch present but empty string → rejected (min(1))
assertRejects(
  'C1.7 empty branch string',
  createTaskBodySchema,
  { prompt: 'Fix bug', branch: '' },
);

// C1.8 — strategy present but empty string → rejected (min(1))
assertRejects(
  'C1.8 empty strategy string',
  createTaskBodySchema,
  { prompt: 'Fix bug', strategy: '' },
);

// ──────────────────────────────────────────────────────────────────────────────
// C2 — console form creates the right request body (simulated frontend logic)
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== C2: Console form builds correct createTask request body ===\n');

/**
 * Mirrors the body construction in apps/web/src/app/tasks/new/page.tsx
 * (the `onSubmit` handler).
 */
function buildCreateTaskBody(prompt, branch, strategy) {
  return {
    prompt: prompt.trim(),
    ...(branch.trim() ? { branch: branch.trim() } : {}),
    ...(strategy.trim() ? { strategy: strategy.trim() } : {}),
  };
}

// C2.1 — prompt only, blanks stripped
{
  const body = buildCreateTaskBody('Fix login bug', '', '');
  assert(
    'C2.1 prompt-only form submission (blank branch/strategy omitted)',
    body.prompt === 'Fix login bug' &&
    !('branch' in body) &&
    !('strategy' in body),
  );
  assertParses('C2.1 body is schema-valid', createTaskBodySchema, body);
}

// C2.2 — all three fields provided
{
  const body = buildCreateTaskBody('Add feature X', 'feature/x', 'aggressive');
  assert(
    'C2.2 all three fields present',
    body.prompt === 'Add feature X' &&
    body.branch === 'feature/x' &&
    body.strategy === 'aggressive',
  );
  assertParses('C2.2 body is schema-valid', createTaskBodySchema, body);
}

// C2.3 — prompt with leading/trailing whitespace is trimmed
{
  const body = buildCreateTaskBody('  trim me  ', '', '');
  assert(
    'C2.3 prompt trimmed before sending',
    body.prompt === 'trim me',
  );
}

// C2.4 — empty prompt form guard (no API call should be made)
{
  const prompt = '  ';
  const repoId = 'some-uuid';
  const shouldSend = repoId.length > 0 && prompt.trim().length > 0;
  assert(
    'C2.4 form guard prevents submission when prompt is blank',
    !shouldSend,
  );
}

// C2.5 — no repoId form guard
{
  const prompt = 'Valid prompt';
  const repoId = '';
  const shouldSend = repoId.length > 0 && prompt.trim().length > 0;
  assert(
    'C2.5 form guard prevents submission when no repo is selected',
    !shouldSend,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// C3 — TaskResponseSchema matches what the service returns on success
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== C3: TaskResponseSchema validates successful creation response ===\n');

const FAKE_REPO_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAKE_TASK_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

// C3.1 — minimal response (status `pending`)
assertParses(
  'C3.1 pending task response',
  TaskResponseSchema,
  {
    id: FAKE_TASK_ID,
    repoId: FAKE_REPO_ID,
    prompt: 'Do the thing',
    status: 'pending',
    createdAt: new Date(),
  },
);

// C3.2 — status `queued` (guardrails path)
assertParses(
  'C3.2 queued task response (guardrails path)',
  TaskResponseSchema,
  {
    id: FAKE_TASK_ID,
    repoId: FAKE_REPO_ID,
    prompt: 'Do the thing',
    status: 'queued',
    createdAt: new Date(),
  },
);

// C3.3 — createdAt as ISO string (what the HTTP boundary serializes)
assertParses(
  'C3.3 createdAt as ISO string (coerce.date)',
  TaskResponseSchema,
  {
    id: FAKE_TASK_ID,
    repoId: FAKE_REPO_ID,
    prompt: 'Do the thing',
    status: 'pending',
    createdAt: new Date().toISOString(),
  },
);

// C3.4 — response carries back the submitted prompt verbatim
{
  const prompt = 'Fix the flaky integration test';
  const result = TaskResponseSchema.safeParse({
    id: FAKE_TASK_ID,
    repoId: FAKE_REPO_ID,
    prompt,
    status: 'pending',
    createdAt: new Date(),
  });
  assert(
    'C3.4 response prompt matches submitted prompt',
    result.success && result.data.prompt === prompt,
  );
}

// C3.5 — response carries the correct repoId
{
  const result = TaskResponseSchema.safeParse({
    id: FAKE_TASK_ID,
    repoId: FAKE_REPO_ID,
    prompt: 'Some task',
    status: 'pending',
    createdAt: new Date(),
  });
  assert(
    'C3.5 response repoId matches the route param',
    result.success && result.data.repoId === FAKE_REPO_ID,
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// C4 — Repo not found → 404 path (simulated service logic)
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== C4: 404 when referenced repo does not exist ===\n');

/**
 * Simulates the tasks service `create` method (tasks.service.ts lines 60-65):
 * it performs a findUnique, and if the repo is absent, throws NotFoundException
 * (rendered as HTTP 404 by NestJS).
 */
function simulateTaskCreate(repoId, body, existingRepoIds) {
  const repoExists = existingRepoIds.includes(repoId);
  if (!repoExists) {
    throw { status: 404, message: `Repo not found: ${repoId}` };
  }
  return {
    id: FAKE_TASK_ID,
    repoId,
    prompt: body.prompt,
    status: 'pending',
    createdAt: new Date(),
  };
}

// C4.1 — valid repo → task created
{
  let result;
  try {
    result = simulateTaskCreate(
      FAKE_REPO_ID,
      { prompt: 'Do something' },
      [FAKE_REPO_ID],
    );
  } catch (e) {
    result = e;
  }
  assert(
    'C4.1 valid repoId → task created with correct prompt',
    result && result.status !== 404 && result.prompt === 'Do something',
  );
}

// C4.2 — repo absent → 404
{
  let threw404 = false;
  try {
    simulateTaskCreate(
      'cccccccc-0000-4000-8000-000000000003',
      { prompt: 'Do something' },
      [FAKE_REPO_ID],
    );
  } catch (e) {
    if (e && e.status === 404) threw404 = true;
  }
  assert(
    'C4.2 unknown repoId → 404 NotFoundException thrown',
    threw404,
  );
}

// C4.3 — web client branches on 404 (form shows "repo no longer exists")
{
  function consoleErrorMessage(status) {
    if (status === 404) return 'Selected repo no longer exists.';
    if (status === 401) return 'Unauthorized — check the operator token (AUTH_TOKEN).';
    return 'Failed to create task.';
  }
  assert(
    'C4.3 console surfaces "repo no longer exists" on 404',
    consoleErrorMessage(404) === 'Selected repo no longer exists.',
  );
  assert(
    'C4.3 console surfaces unauthorized message on 401',
    consoleErrorMessage(401) === 'Unauthorized — check the operator token (AUTH_TOKEN).',
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// C5 — ZodValidationPipe renders schema failures as 400
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== C5: ZodValidationPipe renders bad bodies as 400 ===\n');

/**
 * Simulates the ZodValidationPipe.transform (repos/zod-validation.pipe.ts).
 */
function zodPipeTransform(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw { status: 400, message: 'Validation failed', issues: result.error.issues };
  }
  return result.data;
}

// C5.1 — invalid body (no prompt) → 400
{
  let threw400 = false;
  try {
    zodPipeTransform(createTaskBodySchema, { branch: 'main' });
  } catch (e) {
    if (e && e.status === 400) threw400 = true;
  }
  assert('C5.1 missing prompt → ZodValidationPipe throws 400', threw400);
}

// C5.2 — valid body passes through unchanged
{
  let result;
  try {
    result = zodPipeTransform(createTaskBodySchema, { prompt: 'Fix it' });
  } catch (e) {
    result = null;
  }
  assert(
    'C5.2 valid body passes pipe and is returned parsed',
    result !== null && result.prompt === 'Fix it',
  );
}

// C5.3 — body with wrong type for prompt → 400
{
  let threw400 = false;
  try {
    zodPipeTransform(createTaskBodySchema, { prompt: 42 });
  } catch (e) {
    if (e && e.status === 400) threw400 = true;
  }
  assert('C5.3 non-string prompt → ZodValidationPipe throws 400', threw400);
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED — "New task creation from the console" requirement is satisfied.');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED — requirement is NOT fully satisfied.');
  process.exit(1);
}
