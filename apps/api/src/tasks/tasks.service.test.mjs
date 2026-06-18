/**
 * Tasks-layer unit tests for the per-task agent runtime selector
 * (add-claude-code-runtime, tasks-api 4.1–4.3).
 *
 * Proves the create/read paths of `tasks.service.ts`:
 *   4.1 — `runtime` persists on create and is echoed on EVERY read path (create
 *         201, list, fetch-by-id), defaulting to `codex` when omitted or when a
 *         pre-runtime row reads back null; admission resolves the selected runtime.
 *   4.2 — a create selecting an UNCONFIGURED runtime fails closed with a distinct
 *         `runtime not configured` reason and persists NO task row (never launches
 *         an unauthenticated agent).
 *   4.3 — runtime persists + echoes on all read paths; omitted ⇒ codex; an invalid
 *         value is rejected (400) by the contract schema before the service; an
 *         unconfigured `claude-code` create fails closed.
 *
 * Like the sibling no-transpile `.mjs` tests (`startup-recovery.test.mjs`,
 * `task-lifecycle.test.mjs`), this inlines a FAITHFUL mirror of ONLY the seams
 * under test — `TasksService.create`/`toResponse` and the contract runtime
 * validation — plus in-memory fakes, because the real modules pull in
 * `@cap/contracts` + Nest. The REAL service is additionally exercised by
 * `test/api-e2e.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- mirrored constants (kept byte-for-byte with the real sources) -----------

/** Mirror of `@cap/contracts` RuntimeSchema's allowed set + default. */
const RUNTIME_VALUES = ['claude-code', 'codex'];
const DEFAULT_TASK_RUNTIME = 'codex';

/** Mirror of tasks.service.ts RUNTIME_NOT_CONFIGURED_REASON. */
const RUNTIME_NOT_CONFIGURED_REASON = 'runtime not configured';

// --- mirror of the contract create-body runtime validation (the 400 seam) ----

/**
 * Faithful mirror of the `runtime: RuntimeSchema.optional()` validation the
 * `ZodValidationPipe(createTaskBodySchema)` runs at the controller boundary. A
 * value OUTSIDE the allowed set is rejected (the real pipe maps that to HTTP
 * 400); an omitted value is accepted (and later defaults to codex). Returns the
 * validated body or throws a `ValidationError` (the 400 analog) — exactly the
 * reject-before-service semantics the contract enforces.
 */
class ValidationError extends Error {}
function validateCreateBody(body) {
  if (body.runtime !== undefined && !RUNTIME_VALUES.includes(body.runtime)) {
    throw new ValidationError(
      `invalid runtime "${body.runtime}" (400 — outside the allowed set)`,
    );
  }
  return body;
}

// --- fakes -------------------------------------------------------------------

/**
 * Minimal Prisma fake over an in-memory task table. Supports the create +
 * findMany + findUnique shapes the create/list/findById paths issue. `create`
 * persists the supplied `data` verbatim (so an absent `runtime` is stored as the
 * supplied `null`, mirroring the additive-nullable column) and stamps an id.
 */
class FakePrisma {
  constructor({ repos = [{ id: 'repo-1' }] } = {}) {
    this.repos = repos;
    this.rows = [];
    this._seq = 0;
  }

  get repo() {
    const repos = this.repos;
    return {
      async findUnique({ where }) {
        return repos.find((r) => r.id === where.id) ?? null;
      },
    };
  }

  get task() {
    const self = this;
    return {
      async create({ data }) {
        const row = {
          id: `task-${++self._seq}`,
          status: 'pending',
          createdAt: new Date(self._seq * 1000),
          // Column defaults the create relies on.
          skills: data.skills ?? [],
          ...data,
        };
        self.rows.push(row);
        return row;
      },
      async findMany({ orderBy } = {}) {
        let matched = [...self.rows];
        if (orderBy?.createdAt === 'asc') {
          matched.sort((a, b) => a.createdAt - b.createdAt);
        }
        return matched;
      },
      async findUnique({ where }) {
        return self.rows.find((r) => r.id === where.id) ?? null;
      },
    };
  }
}

/** Fake runtime registry: resolves any id in `known`, throws otherwise. */
class FakeRuntimeRegistry {
  constructor(known = RUNTIME_VALUES) {
    this.known = new Set(known);
    this.resolved = [];
  }
  resolve(runtime) {
    const id = runtime ?? DEFAULT_TASK_RUNTIME;
    if (!this.known.has(id)) {
      throw new Error(`no runtime registered for "${id}"`);
    }
    this.resolved.push(id);
    return { id };
  }
}

/** Fake Claude readiness source: `configured()` is a BOOLEAN only (no token). */
class FakeClaudeReadiness {
  constructor(ready) {
    this.ready = ready;
    this.calls = 0;
  }
  async configured() {
    this.calls += 1;
    return this.ready;
  }
}

// --- inline mirror of tasks.service.ts create/toResponse ---------------------

/** The fail-closed exception mirror (carries the distinct reason). */
class RuntimeNotConfiguredException extends Error {
  constructor(runtime) {
    super(`runtime "${runtime}" is not configured`);
    this.reason = RUNTIME_NOT_CONFIGURED_REASON;
    this.runtime = runtime;
  }
}

class TasksHarness {
  constructor({ prisma, runtimes, claudeReadiness } = {}) {
    this.prisma = prisma;
    this.runtimes = runtimes;
    this.claudeReadiness = claudeReadiness;
  }

  // mirrors TasksService.create (runtime resolution + fail-closed gate + persist)
  async create(repoId, body) {
    const repo = await this.prisma.repo.findUnique({ where: { id: repoId } });
    if (!repo) throw new Error(`Repo not found: ${repoId}`);

    const runtime = body.runtime ?? DEFAULT_TASK_RUNTIME;

    // 4.1 — resolve the selected runtime so admission dispatches to the right agent.
    if (this.runtimes) {
      try {
        this.runtimes.resolve(runtime);
      } catch {
        throw new RuntimeNotConfiguredException(runtime);
      }
    }

    // 4.2 — fail closed BEFORE any row is created when claude is unconfigured.
    if (runtime === 'claude-code' && this.claudeReadiness) {
      const ready = await this.claudeReadiness.configured();
      if (!ready) throw new RuntimeNotConfiguredException(runtime);
    }

    const task = await this.prisma.task.create({
      data: {
        repoId,
        prompt: body.prompt,
        runtime: body.runtime ?? null,
        branch: body.branch ?? null,
        strategy: body.strategy ?? null,
        skills: body.skills ?? [],
        idleTimeoutMs: body.idleTimeoutMs ?? null,
        deadlineMs: body.deadlineMs ?? null,
      },
    });
    return this.toResponse(task);
  }

  async list() {
    const tasks = await this.prisma.task.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return tasks.map((t) => this.toResponse(t));
  }

  async findById(id) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new Error(`Task not found: ${id}`);
    return this.toResponse(task);
  }

  // mirrors TasksService.toResponse runtime echo (null -> default codex)
  toResponse(task) {
    return {
      id: task.id,
      repoId: task.repoId,
      prompt: task.prompt,
      status: task.status,
      runtime: task.runtime ?? DEFAULT_TASK_RUNTIME,
    };
  }
}

function makeHarness({ ready = true, knownRuntimes = RUNTIME_VALUES } = {}) {
  const prisma = new FakePrisma();
  const runtimes = new FakeRuntimeRegistry(knownRuntimes);
  const claudeReadiness = new FakeClaudeReadiness(ready);
  return {
    harness: new TasksHarness({ prisma, runtimes, claudeReadiness }),
    prisma,
    runtimes,
    claudeReadiness,
  };
}

// --- 4.3 tests ---------------------------------------------------------------

test('4.1/4.3 — runtime persists and echoes on create, list, and fetch-by-id', async () => {
  const { harness, prisma } = makeHarness();

  const created = await harness.create('repo-1', {
    prompt: 'do the thing',
    runtime: 'claude-code',
  });
  assert.equal(created.runtime, 'claude-code', 'create response echoes the runtime');

  // Persisted column carries the supplied value (not fabricated/defaulted).
  assert.equal(prisma.rows[0].runtime, 'claude-code', 'runtime persisted on the row');

  const listed = await harness.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].runtime, 'claude-code', 'list echoes the runtime');

  const fetched = await harness.findById(created.id);
  assert.equal(fetched.runtime, 'claude-code', 'fetch-by-id echoes the runtime');
});

test('4.1/4.3 — a codex create round-trips runtime = codex on every read path', async () => {
  const { harness } = makeHarness();
  const created = await harness.create('repo-1', {
    prompt: 'codex please',
    runtime: 'codex',
  });
  assert.equal(created.runtime, 'codex');
  const [listed] = await harness.list();
  assert.equal(listed.runtime, 'codex');
  assert.equal((await harness.findById(created.id)).runtime, 'codex');
});

test('4.3 — an OMITTED runtime defaults to codex and is dispatched to codex', async () => {
  const { harness, prisma, runtimes } = makeHarness();

  const created = await harness.create('repo-1', { prompt: 'no runtime field' });

  // Stored as null (additive-nullable column), but reads back as the default.
  assert.equal(prisma.rows[0].runtime, null, 'omitted runtime stores null');
  assert.equal(created.runtime, 'codex', 'omitted runtime reads back as codex');
  assert.equal(
    (await harness.findById(created.id)).runtime,
    'codex',
    'fetch-by-id reads back codex for an omitted runtime',
  );
  // Admission resolved codex (the default), not claude.
  assert.deepEqual(runtimes.resolved, ['codex']);
});

test('4.3 — a pre-runtime row (null column) reads back as codex on every path', async () => {
  const { harness, prisma } = makeHarness();
  // Simulate a row written before the runtime column existed.
  prisma.rows.push({
    id: 'legacy-1',
    repoId: 'repo-1',
    prompt: 'old task',
    status: 'completed',
    createdAt: new Date(0),
    skills: [],
    runtime: null,
  });
  assert.equal((await harness.findById('legacy-1')).runtime, 'codex');
  const listed = await harness.list();
  assert.equal(listed.find((t) => t.id === 'legacy-1').runtime, 'codex');
});

test('4.3 — an INVALID runtime value is rejected (400) before the service', () => {
  // The contract pipe (mirrored) rejects an out-of-set value with the 400 analog.
  assert.throws(
    () => validateCreateBody({ prompt: 'x', runtime: 'gpt-5' }),
    ValidationError,
    'a runtime outside the allowed set is rejected',
  );
  // ...and a valid / omitted value passes the pipe.
  assert.doesNotThrow(() => validateCreateBody({ prompt: 'x', runtime: 'claude-code' }));
  assert.doesNotThrow(() => validateCreateBody({ prompt: 'x', runtime: 'codex' }));
  assert.doesNotThrow(() => validateCreateBody({ prompt: 'x' }));
});

test('4.3 — an invalid runtime creates NO task row (rejected at the boundary)', async () => {
  const { harness, prisma } = makeHarness();
  // The pipe rejects before the service runs, so create is never reached.
  assert.throws(() => validateCreateBody({ prompt: 'x', runtime: 'bogus' }), ValidationError);
  assert.equal(prisma.rows.length, 0, 'no task persisted for an invalid runtime');
  // Sanity: a valid claude create on a ready server DOES persist.
  await harness.create('repo-1', { prompt: 'ok', runtime: 'claude-code' });
  assert.equal(prisma.rows.length, 1);
});

test('4.2/4.3 — an unconfigured claude-code create fails closed with a distinct reason', async () => {
  const { harness, prisma, claudeReadiness } = makeHarness({ ready: false });

  await assert.rejects(
    () => harness.create('repo-1', { prompt: 'needs claude', runtime: 'claude-code' }),
    (err) => {
      assert.ok(err instanceof RuntimeNotConfiguredException);
      assert.equal(err.reason, RUNTIME_NOT_CONFIGURED_REASON, 'distinct fail-closed reason');
      assert.equal(err.runtime, 'claude-code');
      return true;
    },
  );
  // Fails closed BEFORE persistence: no unauthenticated agent, no orphan row.
  assert.equal(prisma.rows.length, 0, 'no task created when claude is unconfigured');
  assert.equal(claudeReadiness.calls, 1, 'readiness was consulted');
});

test('4.2 — codex is NOT gated by Claude readiness (degrades to unauthenticated)', async () => {
  // Claude unconfigured, but a codex create still succeeds (codex parity).
  const { harness, claudeReadiness } = makeHarness({ ready: false });
  const created = await harness.create('repo-1', { prompt: 'codex run', runtime: 'codex' });
  assert.equal(created.runtime, 'codex');
  assert.equal(claudeReadiness.calls, 0, 'a codex create never consults Claude readiness');
});

test('4.2 — a configured claude-code create succeeds and dispatches to claude', async () => {
  const { harness, prisma, runtimes, claudeReadiness } = makeHarness({ ready: true });
  const created = await harness.create('repo-1', { prompt: 'go', runtime: 'claude-code' });
  assert.equal(created.runtime, 'claude-code');
  assert.equal(prisma.rows.length, 1);
  assert.deepEqual(runtimes.resolved, ['claude-code'], 'admission resolved the claude runtime');
  assert.equal(claudeReadiness.calls, 1);
});

test('4.1 — an unknown/unregistered runtime fails closed at resolve (never admits)', async () => {
  // Registry knows only codex; a claude create resolves nothing -> fail closed.
  const { harness, prisma } = makeHarness({ knownRuntimes: ['codex'] });
  await assert.rejects(
    () => harness.create('repo-1', { prompt: 'x', runtime: 'claude-code' }),
    (err) => {
      assert.ok(err instanceof RuntimeNotConfiguredException);
      assert.equal(err.reason, RUNTIME_NOT_CONFIGURED_REASON);
      return true;
    },
  );
  assert.equal(prisma.rows.length, 0, 'no row created when the runtime resolves nothing');
});
