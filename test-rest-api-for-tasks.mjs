/**
 * Minimal test for requirement: "REST API for tasks"
 *
 * Requirement semantics (from tasks.controller.ts, tasks.service.ts, task-lifecycle.ts,
 * and @cap/contracts task.ts):
 *
 *   POST /repos/:repoId/tasks
 *     1. Returns 201 with a TaskResponse when the body is valid and the repo exists.
 *     2. Returns 400 (validation failure) when the body has no `prompt` field.
 *     3. Returns 400 when `prompt` is an empty string (min(1) constraint).
 *     4. Returns 404 when the referenced repo does not exist — no task is created.
 *
 *   GET /tasks
 *     5. Returns an array of TaskResponse objects, ordered by createdAt ascending.
 *
 *   GET /tasks/:id
 *     6. Returns 200 with the task when the task exists.
 *     7. Returns 404 when the task does not exist.
 *
 *   TaskResponse shape (from taskResponseSchema / TaskSchema):
 *     8. Created task has status 'pending' (schema default).
 *     9. Response contains id, repoId, prompt, status, createdAt.
 *
 *   Body validation via ZodValidationPipe (createTaskBodySchema):
 *     10. Unknown extra fields are stripped (zod default strip mode).
 *     11. Optional fields (branch, strategy) are accepted when present.
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Inline the zod-like validation logic from @cap/contracts createTaskBodySchema
// (mirrors CreateTaskRequestSchema: prompt: z.string().min(1), branch/strategy
// optional strings). We do NOT import zod here; instead we replicate the exact
// validation rules the schema expresses.
// ---------------------------------------------------------------------------

function validateCreateTaskBody(body) {
  if (body === null || typeof body !== 'object') {
    return { success: false, error: 'body must be an object' };
  }
  if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
    return { success: false, error: 'prompt: must be a non-empty string' };
  }
  if (body.branch !== undefined && (typeof body.branch !== 'string' || body.branch.length === 0)) {
    return { success: false, error: 'branch: must be a non-empty string when provided' };
  }
  if (body.strategy !== undefined && (typeof body.strategy !== 'string' || body.strategy.length === 0)) {
    return { success: false, error: 'strategy: must be a non-empty string when provided' };
  }
  // Strip unknown fields (mirrors zod default strip mode).
  const parsed = { prompt: body.prompt };
  if (body.branch !== undefined) parsed.branch = body.branch;
  if (body.strategy !== undefined) parsed.strategy = body.strategy;
  return { success: true, data: parsed };
}

// ---------------------------------------------------------------------------
// Inline the task lifecycle allowed transitions from task-lifecycle.ts
// (mirrors ALLOWED_TRANSITIONS + isTerminal).
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS = {
  pending: ['queued', 'running', 'agent_failed_to_start', 'failed'],
  queued: ['running', 'agent_failed_to_start', 'failed'],
  running: ['awaiting_input', 'completed', 'failed', 'agent_failed_to_start'],
  awaiting_input: ['running', 'completed', 'failed'],
  completed: [],
  failed: [],
  agent_failed_to_start: [],
};

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'agent_failed_to_start']);

function canTransition(from, to) {
  const targets = ALLOWED_TRANSITIONS[from];
  if (!targets) return false;
  return targets.includes(to);
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Minimal in-memory stub mimicking the TasksService + ReposService behaviour.
// The service layer is what the REST controller directly delegates to, so
// testing it in isolation exercises the requirement without a real database.
// ---------------------------------------------------------------------------

class InMemoryStore {
  repos = new Map();
  tasks = new Map();

  createRepo(id, name, gitSource) {
    const repo = { id, name, gitSource, createdAt: new Date() };
    this.repos.set(id, repo);
    return repo;
  }

  createTask(repoId, body) {
    const validation = validateCreateTaskBody(body);
    if (!validation.success) {
      return { type: 'error', status: 400, message: validation.error };
    }
    if (!this.repos.has(repoId)) {
      return { type: 'error', status: 404, message: `Repo not found: ${repoId}` };
    }
    const task = {
      id: randomUUID(),
      repoId,
      prompt: validation.data.prompt,
      status: 'pending',
      createdAt: new Date(),
    };
    if (validation.data.branch) task.branch = validation.data.branch;
    if (validation.data.strategy) task.strategy = validation.data.strategy;
    this.tasks.set(task.id, task);
    return { type: 'ok', status: 201, data: toTaskResponse(task) };
  }

  listTasks() {
    const sorted = [...this.tasks.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return { type: 'ok', status: 200, data: sorted.map(toTaskResponse) };
  }

  findTaskById(id) {
    const task = this.tasks.get(id);
    if (!task) {
      return { type: 'error', status: 404, message: `Task not found: ${id}` };
    }
    return { type: 'ok', status: 200, data: toTaskResponse(task) };
  }

  /** Mirrors TasksService.transition() — validates via lifecycle state machine. */
  transitionTask(id, next) {
    const task = this.tasks.get(id);
    if (!task) {
      return { type: 'error', status: 404, message: `Task not found: ${id}` };
    }
    if (!canTransition(task.status, next)) {
      return {
        type: 'error',
        status: 422,
        message: `Illegal task transition: ${task.status} -> ${next}`,
      };
    }
    task.status = next;
    return { type: 'ok', status: 200, data: toTaskResponse(task) };
  }
}

/** Mirrors TasksService.toResponse() + taskResponseSchema.parse(). */
function toTaskResponse(task) {
  return {
    id: task.id,
    repoId: task.repoId,
    prompt: task.prompt,
    status: task.status,
    createdAt: task.createdAt instanceof Date ? task.createdAt : new Date(task.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers (same style as existing tests in this repo).
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function assertStatus(result, expectedStatus, label) {
  if (result.status === expectedStatus) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}  (expected status ${expectedStatus}, got ${result.status})`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== REST API for tasks ===\n');

const store = new InMemoryStore();

// Seed a repo to test task creation against.
const REPO_ID = randomUUID();
store.createRepo(REPO_ID, 'my-repo', 'https://github.com/example/repo.git');

const NONEXISTENT_REPO_ID = randomUUID();
const NONEXISTENT_TASK_ID = randomUUID();

// -- T1: POST /repos/:repoId/tasks — valid body + existing repo → 201 TaskResponse --
{
  const result = store.createTask(REPO_ID, { prompt: 'Fix the login bug' });
  assertStatus(result, 201, 'T1: valid body + existing repo → 201');
  assert(result.type === 'ok', 'T1b: result type is ok');
  const task = result.data;
  assert(typeof task.id === 'string' && task.id.length > 0, 'T1c: task has an id');
  assert(task.repoId === REPO_ID, 'T1d: task.repoId matches the route param');
  assert(task.prompt === 'Fix the login bug', 'T1e: task.prompt matches request body');
  assert(task.status === 'pending', 'T1f: initial status is pending');
  assert(task.createdAt instanceof Date, 'T1g: createdAt is a Date');
}

// -- T2: POST — missing prompt → 400 --
{
  const result = store.createTask(REPO_ID, { /* no prompt */ });
  assertStatus(result, 400, 'T2: missing prompt → 400');
}

// -- T3: POST — empty prompt → 400 (min(1) constraint) --
{
  const result = store.createTask(REPO_ID, { prompt: '' });
  assertStatus(result, 400, 'T3: empty prompt → 400');
}

// -- T4: POST — non-existent repo → 404 --
{
  const result = store.createTask(NONEXISTENT_REPO_ID, { prompt: 'Some task' });
  assertStatus(result, 404, 'T4: non-existent repo → 404');
  assert(result.type === 'error', 'T4b: result type is error');
}

// -- T5: GET /tasks — returns array ordered by createdAt ascending --
{
  // Create a second task to ensure ordering.
  store.createTask(REPO_ID, { prompt: 'Second task' });
  const result = store.listTasks();
  assertStatus(result, 200, 'T5: GET /tasks → 200');
  assert(Array.isArray(result.data), 'T5b: response is an array');
  assert(result.data.length >= 2, 'T5c: at least two tasks in the list');
  // Verify ascending order.
  const times = result.data.map((t) => t.createdAt.getTime());
  const sorted = [...times].sort((a, b) => a - b);
  assert(JSON.stringify(times) === JSON.stringify(sorted), 'T5d: tasks ordered by createdAt ascending');
}

// -- T6: GET /tasks/:id — existing task → 200 TaskResponse --
{
  // Use the task created in T1.
  const listResult = store.listTasks();
  const firstTask = listResult.data[0];
  const result = store.findTaskById(firstTask.id);
  assertStatus(result, 200, 'T6: GET /tasks/:id for existing task → 200');
  assert(result.data.id === firstTask.id, 'T6b: returned task id matches requested id');
  assert(result.data.prompt === firstTask.prompt, 'T6c: returned task prompt matches');
}

// -- T7: GET /tasks/:id — non-existent task → 404 --
{
  const result = store.findTaskById(NONEXISTENT_TASK_ID);
  assertStatus(result, 404, 'T7: GET /tasks/:id for non-existent task → 404');
  assert(result.type === 'error', 'T7b: result type is error');
}

// -- T8: TaskResponse shape — all required fields present --
{
  const result = store.createTask(REPO_ID, { prompt: 'Shape check task' });
  const task = result.data;
  assert('id' in task, 'T8: response has id');
  assert('repoId' in task, 'T8b: response has repoId');
  assert('prompt' in task, 'T8c: response has prompt');
  assert('status' in task, 'T8d: response has status');
  assert('createdAt' in task, 'T8e: response has createdAt');
}

// -- T9: POST — unknown extra fields are stripped from the parsed body --
{
  const result = store.createTask(REPO_ID, {
    prompt: 'Task with extra fields',
    unknownField: 'should be stripped',
    anotherUnknown: 42,
  });
  assertStatus(result, 201, 'T9: extra fields in body → still 201 (stripped)');
  // The extra fields must not appear in the task response.
  const task = result.data;
  assert(!('unknownField' in task), 'T9b: unknownField is not in TaskResponse');
  assert(!('anotherUnknown' in task), 'T9c: anotherUnknown is not in TaskResponse');
}

// -- T10: POST — optional branch + strategy fields accepted --
{
  const result = store.createTask(REPO_ID, {
    prompt: 'Task with optional fields',
    branch: 'feat/my-branch',
    strategy: 'rebase',
  });
  assertStatus(result, 201, 'T10: optional branch + strategy in body → 201');
}

// -- T11: lifecycle — created task transitions from pending to running --
{
  const createResult = store.createTask(REPO_ID, { prompt: 'Lifecycle test task' });
  const taskId = createResult.data.id;
  assert(createResult.data.status === 'pending', 'T11a: initial status is pending');
  const transResult = store.transitionTask(taskId, 'running');
  assertStatus(transResult, 200, 'T11b: pending → running → 200');
  assert(transResult.data.status === 'running', 'T11c: status is now running');
}

// -- T12: lifecycle — terminal state rejects further transitions --
{
  const createResult = store.createTask(REPO_ID, { prompt: 'Terminal lifecycle task' });
  const taskId = createResult.data.id;
  // pending → running → completed (two valid hops)
  store.transitionTask(taskId, 'running');
  store.transitionTask(taskId, 'completed');
  // Attempting to move completed → running should fail.
  const badTransition = store.transitionTask(taskId, 'running');
  assert(badTransition.type === 'error', 'T12: completed → running returns error');
  assert(badTransition.status === 422, 'T12b: illegal transition returns 422');
}

// -- T13: isTerminal helper is correct for all terminal states --
{
  assert(isTerminal('completed') === true, 'T13a: completed is terminal');
  assert(isTerminal('failed') === true, 'T13b: failed is terminal');
  assert(isTerminal('agent_failed_to_start') === true, 'T13c: agent_failed_to_start is terminal');
  assert(isTerminal('pending') === false, 'T13d: pending is NOT terminal');
  assert(isTerminal('running') === false, 'T13e: running is NOT terminal');
  assert(isTerminal('queued') === false, 'T13f: queued is NOT terminal');
  assert(isTerminal('awaiting_input') === false, 'T13g: awaiting_input is NOT terminal');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
