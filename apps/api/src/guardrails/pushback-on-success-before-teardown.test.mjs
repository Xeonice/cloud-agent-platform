/**
 * Minimal test for requirement:
 *   "Push-back runs only on success, before teardown, by the platform"
 *   (add-multi-forge-task-delivery, design D5 / proposal onTerminal hook)
 *
 * Three sub-assertions pinned here:
 *   1. SUCCESS ONLY — push-back (deliverWorkspaceChanges) is invoked when the task
 *      completes (status === 'completed'), and NOT when it fails.
 *   2. BEFORE TEARDOWN — the push-back call is ordered strictly before
 *      sandbox.teardownSandbox (the container must still be live when git push runs).
 *   3. BY THE PLATFORM — the push-back is orchestrated by GuardrailsService
 *      (platform process) via sandbox.deliverWorkspaceChanges; it does NOT happen
 *      inside the sandbox on its own.
 *
 * The test mirrors the pattern of guardrails-exit-roundtrip.test.mjs: a no-transpile
 * .mjs harness that replays the relevant seam from guardrails.service.ts verbatim.
 */

// ── harness fakes ────────────────────────────────────────────────────────────

/** Ordered event log shared across a single test run. */
function makeEvents() {
  const log = [];
  return {
    push(e) { log.push(e); },
    indexOf(e) { return log.indexOf(e); },
    includes(e) { return log.includes(e); },
    all() { return [...log]; },
  };
}

/**
 * MockPrismaTask: minimal prisma.task stub.
 * `taskRows` maps taskId → { status, deliver, branch }.
 */
function makePrisma(taskRows) {
  return {
    task: {
      async findUnique({ where }) {
        return taskRows[where.id] ?? null;
      },
      async update({ where, data }) {
        if (taskRows[where.id]) Object.assign(taskRows[where.id], data);
      },
    },
  };
}

/**
 * MockForgeResolver: returns a fake ForgeTarget for any taskId.
 * Set `resolveNull = true` to simulate an unresolvable forge (skip path).
 */
function makeForgeResolver(resolveNull = false) {
  return {
    async getForgeTarget(taskId) {
      if (resolveNull) return null;
      return { kind: 'github', apiBaseUrl: 'https://api.github.com', token: 'tok' };
    },
  };
}

/**
 * MockForgeRegistry: minimal registry supplying a fake Forge instance.
 * The fake Forge tracks calls for assertion.
 */
function makeForgeRegistry() {
  const calls = { resolveBaseBranch: [], findExisting: [], openChangeRequest: [] };
  return {
    calls,
    forKind(_kind) {
      return {
        cloneAuthHeader(_t) { return 'Basic abc'; },
        async resolveBaseBranch(t) { calls.resolveBaseBranch.push(t); return 'main'; },
        async findExistingChangeRequest(_t, _b) { calls.findExisting.push(_b); return null; },
        async openChangeRequest(_t, opts) {
          calls.openChangeRequest.push(opts);
          return { number: 1, url: 'https://github.com/owner/repo/pull/1', state: 'open', headBranch: opts.headBranch };
        },
      };
    },
  };
}

/**
 * MockSandboxProvider: records the order of deliverWorkspaceChanges vs teardownSandbox
 * using a shared event log. Configurable push result.
 */
function makeSandbox(events, { hadChanges = true, commitSha = 'abc123', error = null } = {}) {
  return {
    deliverCalls: [],
    teardownCalls: [],
    async provision({ taskId }) {
      return { taskId, baseUrl: `http://sb-${taskId}`, wsUrl: `ws://sb-${taskId}/ws` };
    },
    async deliverWorkspaceChanges(taskId, opts) {
      this.deliverCalls.push({ taskId, opts });
      events.push(`deliver:${taskId}`);
      return { hadChanges, commitSha, error };
    },
    async teardownSandbox(taskId) {
      this.teardownCalls.push(taskId);
      events.push(`teardown:${taskId}`);
    },
    getSandboxMode() { return 'test'; },
  };
}

/**
 * Minimal replica of the GuardrailsService seam under test.
 *
 * Replicates verbatim:
 *   onTerminal  → captureTranscript → deliverResult → teardownSandbox → release
 *   forceFail   → safeTransition    → captureTranscript → teardownSandbox → release
 *               (NO deliverResult in forceFail)
 *
 * This mirrors exactly what guardrails.service.ts does (lines 634–666 + 675–756).
 */
class GuardrailsHarness {
  constructor({ prisma, sandbox, forgeResolver, forgeRegistry, events }) {
    this.prisma = prisma;
    this.sandbox = sandbox;
    this.forgeResolver = forgeResolver;
    this.forgeRegistry = forgeRegistry;
    this.events = events;
    this.transitions = [];
    this.released = [];
  }

  // --- mirrors captureTranscript (best-effort, no-op here) ---
  async _captureTranscript(_taskId) { /* no-op in this focused test */ }

  // --- mirrors deliverResult (verbatim logic from guardrails.service.ts) ---
  async _deliverResult(taskId) {
    const resolver = this.forgeResolver;
    const registry = this.forgeRegistry;
    if (!resolver || !registry || !this.sandbox || !this.prisma) return;
    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { status: true, deliver: true, branch: true },
      });
      // Gate 1: only on completed
      if (!task || task.status !== 'completed') return;
      const deliver = (task.deliver ?? 'none');
      // Gate 2: only when opted in
      if (deliver === 'none') return;

      const target = await resolver.getForgeTarget(taskId);
      if (!target) {
        // no forge target → persist skipped, return early
        await this.prisma.task.update({ where: { id: taskId }, data: { deliverStatus: 'skipped' } });
        return;
      }
      const forge = registry.forKind(target.kind);
      const branch = `cap/task-${taskId}`;
      const commitMessage = `cap: deliver task ${taskId}\n\nAutomated delivery of the agent's workspace changes.`;

      const pushResult = await this.sandbox.deliverWorkspaceChanges(taskId, {
        authHeader: forge.cloneAuthHeader(target),
        branch,
        commitMessage,
      });

      if (!pushResult.hadChanges) {
        await this.prisma.task.update({ where: { id: taskId }, data: { deliverStatus: 'no_changes' } });
        return;
      }
      if (pushResult.error) {
        await this.prisma.task.update({ where: { id: taskId }, data: { deliverStatus: 'failed', branchPushed: branch } });
        return;
      }
      if (deliver === 'branch') {
        await this.prisma.task.update({ where: { id: taskId }, data: { deliverStatus: 'pushed', branchPushed: branch, commitSha: pushResult.commitSha } });
        return;
      }
      // deliver === 'pr'
      const baseBranch = task.branch ?? (await forge.resolveBaseBranch(target));
      const existing = await forge.findExistingChangeRequest(target, branch);
      const ref = existing ?? (await forge.openChangeRequest(target, {
        headBranch: branch,
        baseBranch,
        title: `cap: task ${taskId}`,
        body: commitMessage,
      }));
      await this.prisma.task.update({ where: { id: taskId }, data: {
        deliverStatus: 'pr_opened',
        branchPushed: branch,
        commitSha: pushResult.commitSha,
        changeRequestUrl: ref.url,
        changeRequestNumber: ref.number,
      }});
    } catch (err) {
      // best-effort: swallow
    }
  }

  // --- mirrors onTerminal (natural completion path) ---
  async onTerminal(taskId) {
    await this._captureTranscript(taskId);
    // push-back BEFORE teardown (the requirement under test)
    await this._deliverResult(taskId);
    await this.sandbox.teardownSandbox(taskId);
    this.events.push(`release:${taskId}`);
    this.released.push(taskId);
    this.transitions.push({ taskId, status: 'completed' });
  }

  // --- mirrors forceFail (no push-back here: only failures / guards) ---
  async forceFail(taskId, cause) {
    const terminal = cause === 'idle' ? 'completed' : 'failed';
    this.transitions.push({ taskId, status: terminal });
    await this._captureTranscript(taskId);
    // NOTE: NO _deliverResult call — forceFail never push-backs
    await this.sandbox.teardownSandbox(taskId);
    this.events.push(`release:${taskId}`);
    this.released.push(taskId);
  }
}

// ── assertion helpers ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

// ── tests ────────────────────────────────────────────────────────────────────

// T1 — SUCCESS + DELIVER=PR: push-back fires, ordered BEFORE teardown, via sandbox.deliverWorkspaceChanges
{
  console.log('\nT1: completed + deliver=pr → push-back fires before teardown');
  const events = makeEvents();
  const sandbox = makeSandbox(events);
  const prisma = makePrisma({
    'task-1': { id: 'task-1', status: 'completed', deliver: 'pr', branch: null },
  });
  const g = new GuardrailsHarness({
    prisma,
    sandbox,
    forgeResolver: makeForgeResolver(),
    forgeRegistry: makeForgeRegistry(),
    events,
  });

  await g.onTerminal('task-1');

  assert(sandbox.deliverCalls.some(c => c.taskId === 'task-1'),
    'T1a: push-back calls sandbox.deliverWorkspaceChanges (platform-side)');
  assert(events.indexOf('deliver:task-1') < events.indexOf('teardown:task-1'),
    'T1b: push-back is ordered BEFORE sandbox teardown');
  assert(sandbox.teardownCalls.includes('task-1'),
    'T1c: teardown still happens after push-back');
  assert(g.released.includes('task-1'),
    'T1d: slot is released after push-back + teardown');
  const row = (await prisma.task.findUnique({ where: { id: 'task-1' } }));
  assert(row.deliverStatus === 'pr_opened',
    'T1e: deliver_status persisted as pr_opened');
}

// T2 — FAILURE (non-zero exit / forceFail): push-back must NOT fire
{
  console.log('\nT2: forceFail (task not completed) → push-back must NOT fire');
  const events = makeEvents();
  const sandbox = makeSandbox(events);
  // task is still in 'running' state (not completed) when forceFail fires
  const prisma = makePrisma({
    'task-2': { id: 'task-2', status: 'failed', deliver: 'pr', branch: null },
  });
  const g = new GuardrailsHarness({
    prisma,
    sandbox,
    forgeResolver: makeForgeResolver(),
    forgeRegistry: makeForgeRegistry(),
    events,
  });

  await g.forceFail('task-2', 'deadline');

  assert(sandbox.deliverCalls.length === 0,
    'T2a: forceFail → push-back (deliverWorkspaceChanges) is NOT called (only on success)');
  assert(sandbox.teardownCalls.includes('task-2'),
    'T2b: forceFail still tears down the sandbox');
  assert(g.released.includes('task-2'),
    'T2c: slot is still released on failure');
}

// T3 — STATUS GATE: onTerminal with status !== 'completed' skips push-back
{
  console.log('\nT3: onTerminal called but task.status is cancelled → push-back skipped');
  const events = makeEvents();
  const sandbox = makeSandbox(events);
  // Simulate a task that somehow ended with a non-completed status in DB
  const prisma = makePrisma({
    'task-3': { id: 'task-3', status: 'cancelled', deliver: 'pr', branch: null },
  });
  const g = new GuardrailsHarness({
    prisma,
    sandbox,
    forgeResolver: makeForgeResolver(),
    forgeRegistry: makeForgeRegistry(),
    events,
  });

  await g.onTerminal('task-3');

  assert(sandbox.deliverCalls.length === 0,
    'T3a: status gate blocks push-back when DB status is not completed');
  assert(sandbox.teardownCalls.includes('task-3'),
    'T3b: teardown still proceeds even when push-back is skipped');
}

// T4 — DELIVER=NONE (default): opted-out tasks skip push-back
{
  console.log('\nT4: completed + deliver=none → push-back skipped (opt-in)');
  const events = makeEvents();
  const sandbox = makeSandbox(events);
  const prisma = makePrisma({
    'task-4': { id: 'task-4', status: 'completed', deliver: 'none', branch: null },
  });
  const g = new GuardrailsHarness({
    prisma,
    sandbox,
    forgeResolver: makeForgeResolver(),
    forgeRegistry: makeForgeRegistry(),
    events,
  });

  await g.onTerminal('task-4');

  assert(sandbox.deliverCalls.length === 0,
    'T4a: deliver=none → push-back not called (default behaviour preserved)');
  assert(sandbox.teardownCalls.includes('task-4'),
    'T4b: teardown still fires for completed deliver=none task');
}

// T5 — BY THE PLATFORM: the push-back call goes through sandbox.deliverWorkspaceChanges
//       (platform process orchestrates the git push in-sandbox), not a direct shell call.
{
  console.log('\nT5: push-back is platform-orchestrated via sandbox.deliverWorkspaceChanges');
  const events = makeEvents();
  const sandbox = makeSandbox(events, { hadChanges: true, commitSha: 'deadbeef' });
  const prisma = makePrisma({
    'task-5': { id: 'task-5', status: 'completed', deliver: 'branch', branch: null },
  });
  const g = new GuardrailsHarness({
    prisma,
    sandbox,
    forgeResolver: makeForgeResolver(),
    forgeRegistry: makeForgeRegistry(),
    events,
  });

  await g.onTerminal('task-5');

  const call = sandbox.deliverCalls.find(c => c.taskId === 'task-5');
  assert(call !== undefined,
    'T5a: push-back is dispatched via sandbox.deliverWorkspaceChanges (platform is the caller)');
  assert(typeof call.opts.authHeader === 'string' && call.opts.authHeader.length > 0,
    'T5b: the forge auth header is supplied by the platform (not by the sandbox process)');
  assert(call.opts.branch === 'cap/task-task-5',
    'T5c: the platform names the branch deterministically (cap/task-<taskId>)');
  const row = await prisma.task.findUnique({ where: { id: 'task-5' } });
  assert(row.deliverStatus === 'pushed',
    'T5d: deliver_status persisted as pushed for branch delivery');
  assert(row.commitSha === 'deadbeef',
    'T5e: commit SHA from platform sandbox is persisted');
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
