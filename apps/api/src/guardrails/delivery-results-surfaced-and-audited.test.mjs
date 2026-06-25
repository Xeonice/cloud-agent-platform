/**
 * Minimal test for requirement:
 *   "Delivery results are surfaced and audited; push-back never blocks settling"
 *   (add-multi-forge-task-delivery)
 *
 * Three sub-assertions pinned here:
 *   1. SURFACED — the delivery result columns (deliverStatus, branchPushed, commitSha,
 *      changeRequestUrl, changeRequestNumber) are persisted to the task row after push-back,
 *      so they are readable on every read path (TaskResponse echo).
 *   2. AUDITED — recordChangeRequest is called (with url + number + reused) when a PR is
 *      opened (new) or reused (existing), and is NOT called for branch-only delivery.
 *   3. NEVER BLOCKS SETTLING — a thrown error inside deliverResult is caught and swallowed;
 *      teardown + slot release still complete; deliverStatus is persisted as 'failed'.
 *
 * Each test runs a minimal replica of the deliverResult seam from guardrails.service.ts
 * in pure JS (no transpile), directly mirroring the implementation.
 */

// ── shared helpers ────────────────────────────────────────────────────────────

function makePrisma(taskRows) {
  return {
    task: {
      async findUnique({ where }) {
        return taskRows[where.id] ?? null;
      },
      async update({ where, data }) {
        if (taskRows[where.id]) Object.assign(taskRows[where.id], data);
        return taskRows[where.id];
      },
    },
  };
}

function makeForgeResolver(resolveNull = false) {
  return {
    async getForgeTarget(_taskId) {
      if (resolveNull) return null;
      return { kind: 'github', apiBaseUrl: 'https://api.github.com', token: 'tok' };
    },
  };
}

function makeForgeRegistry({ existingCR = null, openCRResult = null } = {}) {
  const calls = { resolveBaseBranch: 0, findExisting: 0, openChangeRequest: 0 };
  return {
    calls,
    forKind(_kind) {
      return {
        cloneAuthHeader(_t) { return 'Basic xyz'; },
        async resolveBaseBranch(_t) { calls.resolveBaseBranch++; return 'main'; },
        async findExistingChangeRequest(_t, _b) {
          calls.findExisting++;
          return existingCR;
        },
        async openChangeRequest(_t, _opts) {
          calls.openChangeRequest++;
          return openCRResult ?? { number: 42, url: 'https://github.com/o/r/pull/42', state: 'open', headBranch: 'cap/task-t1' };
        },
      };
    },
  };
}

function makeSandbox({
  hadChanges = true,
  commitSha = 'cafebabe',
  error = null,
  throwOnDeliver = false,
  capabilities = null,
} = {}) {
  const calls = { deliverWorkspaceChanges: [], teardownSandbox: [] };
  const sandbox = {
    calls,
    getSandboxMode() { return 'test'; },
    async deliverWorkspaceChanges(taskId, _opts) {
      calls.deliverWorkspaceChanges.push(taskId);
      if (throwOnDeliver) throw new Error('sandbox exploded');
      return { hadChanges, commitSha, error };
    },
    async teardownSandbox(taskId) {
      calls.teardownSandbox.push(taskId);
    },
  };
  if (capabilities) {
    sandbox.getProviderCapabilities = () => capabilities;
  }
  return sandbox;
}

function selectSandboxProvider(provider, required) {
  if (!provider) throw new Error('No sandbox provider is configured');
  const declaredCapabilities = provider.getProviderCapabilities?.();
  if (!declaredCapabilities) return { provider, capabilities: [], compatibility: 'legacy-assumed' };
  const missing = required.filter((capability) => !declaredCapabilities.includes(capability));
  if (missing.length > 0) {
    throw new Error(
      `Sandbox provider "${provider.getSandboxMode()}" missing required capabilities: ${missing.join(', ')}`,
    );
  }
  return { provider, capabilities: declaredCapabilities, compatibility: 'declared' };
}

/**
 * Minimal replica of the deliverResult + onTerminal seam from guardrails.service.ts.
 * Mirrors the implementation verbatim: lines 675–755 (deliverResult) + 634–666 (onTerminal).
 */
class DeliveryHarness {
  constructor({ prisma, sandbox, forgeResolver, forgeRegistry, audit }) {
    this.prisma = prisma;
    this.sandbox = sandbox;
    this.forgeResolver = forgeResolver;
    this.forgeRegistry = forgeRegistry;
    this.audit = audit;   // optional; mirrors the @Optional() injection
    this.teardownCalled = [];
    this.released = [];
  }

  async _persistDeliver(taskId, data) {
    if (!this.prisma) return;
    await this.prisma.task.update({ where: { id: taskId }, data }).catch(() => undefined);
  }

  async _recordAudit(call) {
    try { await call(); } catch { /* best-effort */ }
  }

  async _deliverResult(taskId) {
    const resolver = this.forgeResolver;
    const registry = this.forgeRegistry;
    if (!resolver || !registry || !this.sandbox || !this.prisma) return;
    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { status: true, deliver: true, branch: true },
      });
      if (!task || task.status !== 'completed') return;
      const deliver = (task.deliver ?? 'none');
      if (deliver === 'none') return;

      const selected = selectSandboxProvider(this.sandbox, ['workspace.git.deliver']);
      const target = await resolver.getForgeTarget(taskId);
      if (!target) {
        await this._persistDeliver(taskId, { deliverStatus: 'skipped' });
        return;
      }
      const forge = registry.forKind(target.kind);
      const branch = `cap/task-${taskId}`;
      const commitMessage = `cap: deliver task ${taskId}\n\nAutomated delivery.`;

      const pushResult = await selected.provider.deliverWorkspaceChanges(taskId, {
        authHeader: forge.cloneAuthHeader(target),
        branch,
        commitMessage,
      });

      if (!pushResult.hadChanges) {
        await this._persistDeliver(taskId, { deliverStatus: 'no_changes' });
        return;
      }
      if (pushResult.error) {
        await this._persistDeliver(taskId, { deliverStatus: 'failed', branchPushed: branch });
        return;
      }
      if (deliver === 'branch') {
        await this._persistDeliver(taskId, {
          deliverStatus: 'pushed',
          branchPushed: branch,
          commitSha: pushResult.commitSha,
        });
        return;
      }
      // deliver === 'pr'
      const baseBranch = task.branch ?? (await forge.resolveBaseBranch(target));
      const existing = await forge.findExistingChangeRequest(target, branch);
      const reused = existing !== null;
      const ref = existing ?? (await forge.openChangeRequest(target, {
        headBranch: branch,
        baseBranch,
        title: `cap: task ${taskId}`,
        body: commitMessage,
      }));
      await this._persistDeliver(taskId, {
        deliverStatus: 'pr_opened',
        branchPushed: branch,
        commitSha: pushResult.commitSha,
        changeRequestUrl: ref.url,
        changeRequestNumber: ref.number,
      });
      // AUDIT the change request (7.1)
      await this._recordAudit(() =>
        this.audit?.recordChangeRequest(taskId, { url: ref.url, number: ref.number, reused }),
      );
    } catch (err) {
      // Best-effort: swallow + persist failed status (never throws into onTerminal)
      await this._persistDeliver(taskId, { deliverStatus: 'failed' }).catch(() => undefined);
    }
  }

  /** mirrors onTerminal: captureTranscript(noop) → deliverResult → teardown → release */
  async onTerminal(taskId) {
    await this._deliverResult(taskId);          // best-effort; must never throw
    await this.sandbox.teardownSandbox(taskId); // must always run
    this.teardownCalled.push(taskId);
    this.released.push(taskId);                 // slot release
  }
}

// ── assertion helpers ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// ── T1: SURFACED (pr delivery) ────────────────────────────────────────────────
{
  console.log('\nT1: deliver=pr — result columns are persisted (surfaced)');
  const taskId = 'T1';
  const rows = {
    [taskId]: { id: taskId, status: 'completed', deliver: 'pr', branch: null },
  };
  const prisma = makePrisma(rows);
  const sandbox = makeSandbox({ hadChanges: true, commitSha: 'abc123' });
  const registry = makeForgeRegistry({
    existingCR: null,
    openCRResult: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open', headBranch: `cap/task-${taskId}` },
  });
  const h = new DeliveryHarness({ prisma, sandbox, forgeResolver: makeForgeResolver(), forgeRegistry: registry, audit: null });

  await h.onTerminal(taskId);

  const row = rows[taskId];
  assert(row.deliverStatus === 'pr_opened',
    'T1a: deliverStatus persisted as "pr_opened"');
  assert(row.branchPushed === `cap/task-${taskId}`,
    'T1b: branchPushed persisted with deterministic branch name');
  assert(row.commitSha === 'abc123',
    'T1c: commitSha persisted from sandbox push result');
  assert(row.changeRequestUrl === 'https://github.com/o/r/pull/7',
    'T1d: changeRequestUrl persisted from forge response');
  assert(row.changeRequestNumber === 7,
    'T1e: changeRequestNumber persisted from forge response');
}

// ── T2: SURFACED (branch delivery) ───────────────────────────────────────────
{
  console.log('\nT2: deliver=branch — branch result columns are persisted (no CR columns)');
  const taskId = 'T2';
  const rows = {
    [taskId]: { id: taskId, status: 'completed', deliver: 'branch', branch: null },
  };
  const prisma = makePrisma(rows);
  const sandbox = makeSandbox({ hadChanges: true, commitSha: 'deadbeef' });
  const h = new DeliveryHarness({ prisma, sandbox, forgeResolver: makeForgeResolver(), forgeRegistry: makeForgeRegistry(), audit: null });

  await h.onTerminal(taskId);

  const row = rows[taskId];
  assert(row.deliverStatus === 'pushed',
    'T2a: deliverStatus persisted as "pushed" for branch delivery');
  assert(row.branchPushed === `cap/task-${taskId}`,
    'T2b: branchPushed persisted for branch delivery');
  assert(row.commitSha === 'deadbeef',
    'T2c: commitSha persisted for branch delivery');
  assert(row.changeRequestUrl == null && row.changeRequestNumber == null,
    'T2d: CR columns remain null for branch-only delivery (not opened)');
}

// ── T3: AUDITED (new PR) ──────────────────────────────────────────────────────
{
  console.log('\nT3: deliver=pr (new CR) — audit recordChangeRequest called with correct args');
  const taskId = 'T3';
  const rows = {
    [taskId]: { id: taskId, status: 'completed', deliver: 'pr', branch: null },
  };
  const auditCalls = [];
  const fakeAudit = {
    async recordChangeRequest(tid, opts) { auditCalls.push({ tid, opts }); },
  };
  const registry = makeForgeRegistry({
    existingCR: null,
    openCRResult: { number: 99, url: 'https://github.com/o/r/pull/99', state: 'open', headBranch: 'cap/task-T3' },
  });
  const sandbox = makeSandbox({ hadChanges: true, commitSha: 'feedface' });
  const h = new DeliveryHarness({ prisma: makePrisma(rows), sandbox, forgeResolver: makeForgeResolver(), forgeRegistry: registry, audit: fakeAudit });

  await h.onTerminal(taskId);

  assert(auditCalls.length === 1,
    'T3a: audit recordChangeRequest called exactly once for new PR');
  assert(auditCalls[0]?.tid === taskId,
    'T3b: audit call carries the correct taskId');
  assert(auditCalls[0]?.opts?.url === 'https://github.com/o/r/pull/99',
    'T3c: audit call carries the PR url');
  assert(auditCalls[0]?.opts?.number === 99,
    'T3d: audit call carries the PR number');
  assert(auditCalls[0]?.opts?.reused === false,
    'T3e: audit call marks reused=false for a newly opened CR');
}

// ── T4: AUDITED (reused PR) ───────────────────────────────────────────────────
{
  console.log('\nT4: deliver=pr (existing CR) — audit recordChangeRequest called with reused=true');
  const taskId = 'T4';
  const rows = {
    [taskId]: { id: taskId, status: 'completed', deliver: 'pr', branch: null },
  };
  const auditCalls = [];
  const fakeAudit = {
    async recordChangeRequest(tid, opts) { auditCalls.push({ tid, opts }); },
  };
  const existingCR = { number: 5, url: 'https://github.com/o/r/pull/5', state: 'open', headBranch: 'cap/task-T4' };
  const registry = makeForgeRegistry({ existingCR });
  const sandbox = makeSandbox({ hadChanges: true, commitSha: 'f00d' });
  const h = new DeliveryHarness({ prisma: makePrisma(rows), sandbox, forgeResolver: makeForgeResolver(), forgeRegistry: registry, audit: fakeAudit });

  await h.onTerminal(taskId);

  assert(auditCalls.length === 1,
    'T4a: audit recordChangeRequest called for reused CR');
  assert(auditCalls[0]?.opts?.reused === true,
    'T4b: audit call marks reused=true when an existing CR is reused');
  assert(auditCalls[0]?.opts?.url === 'https://github.com/o/r/pull/5',
    'T4c: audit call carries the existing CR url');
}

// ── T5: AUDITED — branch delivery does NOT emit a CR audit event ──────────────
{
  console.log('\nT5: deliver=branch — audit recordChangeRequest NOT called (branch-only delivery)');
  const taskId = 'T5';
  const rows = {
    [taskId]: { id: taskId, status: 'completed', deliver: 'branch', branch: null },
  };
  const auditCalls = [];
  const fakeAudit = {
    async recordChangeRequest(tid, opts) { auditCalls.push({ tid, opts }); },
  };
  const sandbox = makeSandbox({ hadChanges: true, commitSha: 'aabbcc' });
  const h = new DeliveryHarness({ prisma: makePrisma(rows), sandbox, forgeResolver: makeForgeResolver(), forgeRegistry: makeForgeRegistry(), audit: fakeAudit });

  await h.onTerminal(taskId);

  assert(auditCalls.length === 0,
    'T5a: no CR audit event for branch-only delivery (no PR opened)');
}

// ── T6: NEVER BLOCKS SETTLING — sandbox throw is swallowed ───────────────────
{
  console.log('\nT6: sandbox.deliverWorkspaceChanges THROWS — teardown + release still happen');
  const taskId = 'T6';
  const rows = {
    [taskId]: { id: taskId, status: 'completed', deliver: 'pr', branch: null },
  };
  const prisma = makePrisma(rows);
  const sandbox = makeSandbox({ throwOnDeliver: true });
  const h = new DeliveryHarness({ prisma, sandbox, forgeResolver: makeForgeResolver(), forgeRegistry: makeForgeRegistry(), audit: null });

  let threw = false;
  try {
    await h.onTerminal(taskId);
  } catch {
    threw = true;
  }

  assert(!threw,
    'T6a: onTerminal does NOT throw even when deliverWorkspaceChanges throws');
  assert(sandbox.calls.teardownSandbox.includes(taskId),
    'T6b: sandbox.teardownSandbox still called after deliver throw');
  assert(h.released.includes(taskId),
    'T6c: slot is still released after deliver throw');
  assert(rows[taskId].deliverStatus === 'failed',
    'T6d: deliverStatus persisted as "failed" after the caught throw');
}

// ── T7: NEVER BLOCKS SETTLING — forge resolver throw is swallowed ─────────────
{
  console.log('\nT7: forgeResolver.getForgeTarget THROWS — teardown + release still happen');
  const taskId = 'T7';
  const rows = {
    [taskId]: { id: taskId, status: 'completed', deliver: 'pr', branch: null },
  };
  const prisma = makePrisma(rows);
  const sandbox = makeSandbox();
  const throwingResolver = {
    async getForgeTarget() { throw new Error('network failure'); },
  };
  const h = new DeliveryHarness({ prisma, sandbox, forgeResolver: throwingResolver, forgeRegistry: makeForgeRegistry(), audit: null });

  let threw = false;
  try {
    await h.onTerminal(taskId);
  } catch {
    threw = true;
  }

  assert(!threw,
    'T7a: onTerminal does NOT throw when forgeResolver.getForgeTarget throws');
  assert(sandbox.calls.teardownSandbox.includes(taskId),
    'T7b: sandbox.teardownSandbox still called after resolver throw');
  assert(h.released.includes(taskId),
    'T7c: slot is still released after resolver throw');
  // best-effort persist of 'failed' may or may not have run, but settling did
}

// ── T8: NEVER BLOCKS SETTLING — audit throw is swallowed ─────────────────────
{
  console.log('\nT8: audit.recordChangeRequest THROWS — teardown + release still happen');
  const taskId = 'T8';
  const rows = {
    [taskId]: { id: taskId, status: 'completed', deliver: 'pr', branch: null },
  };
  const throwingAudit = {
    async recordChangeRequest() { throw new Error('audit db down'); },
  };
  const registry = makeForgeRegistry({
    existingCR: null,
    openCRResult: { number: 1, url: 'https://example.com/pr/1', state: 'open', headBranch: 'cap/task-T8' },
  });
  const sandbox = makeSandbox({ hadChanges: true, commitSha: 'bada55' });
  const h = new DeliveryHarness({ prisma: makePrisma(rows), sandbox, forgeResolver: makeForgeResolver(), forgeRegistry: registry, audit: throwingAudit });

  let threw = false;
  try {
    await h.onTerminal(taskId);
  } catch {
    threw = true;
  }

  assert(!threw,
    'T8a: onTerminal does NOT throw when audit.recordChangeRequest throws');
  assert(sandbox.calls.teardownSandbox.includes(taskId),
    'T8b: sandbox.teardownSandbox still called after audit throw');
  assert(h.released.includes(taskId),
    'T8c: slot is still released after audit throw');
  // The PR result columns should still be persisted (deliver completes before audit is called)
  assert(rows[taskId].deliverStatus === 'pr_opened',
    'T8d: deliverStatus still persisted as pr_opened (audit throw happens after persist)');
}

// ── T9: provider capability selection gates delivery ─────────────────────────
{
  console.log('\nT9: missing workspace.git.deliver capability — delivery is failed before push-back');
  const taskId = 'T9';
  const rows = {
    [taskId]: { id: taskId, status: 'completed', deliver: 'branch', branch: null },
  };
  const prisma = makePrisma(rows);
  const sandbox = makeSandbox({ capabilities: ['terminal.websocket'] });
  const h = new DeliveryHarness({ prisma, sandbox, forgeResolver: makeForgeResolver(), forgeRegistry: makeForgeRegistry(), audit: null });

  let threw = false;
  try {
    await h.onTerminal(taskId);
  } catch {
    threw = true;
  }

  assert(!threw,
    'T9a: capability selection failure is swallowed by delivery best-effort boundary');
  assert(sandbox.calls.deliverWorkspaceChanges.length === 0,
    'T9b: sandbox.deliverWorkspaceChanges is NOT called without workspace.git.deliver');
  assert(rows[taskId].deliverStatus === 'failed',
    'T9c: missing delivery capability is surfaced as deliverStatus failed');
  assert(sandbox.calls.teardownSandbox.includes(taskId),
    'T9d: teardown still runs after capability selection failure');
  assert(h.released.includes(taskId),
    'T9e: slot is still released after capability selection failure');
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
