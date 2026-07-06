/**
 * Verify-phase test for the pure account-settings + Codex-credential logic
 * (account-settings, tasks 7.2 / 7.3 / 7.4).
 *
 * Requirement semantics (from settings-logic.ts):
 *   1. resolveAccountSettings: allowedAccount is the read-only session-sourced
 *      identity; defaults (retention 30, writeConfirm true, defaultRepoId null)
 *      are returned when nothing is saved; the stored row (THIS account's only)
 *      otherwise. Per-account scoping = caller passes only that account's row.
 *   2. validateDefaultRepoSelection: undefined leaves current; null clears; a
 *      string is accepted ONLY when imported, else rejected (not_imported)
 *      WITHOUT mutating.
 *   3. projectCredentialSave: the two modes are MUTUALLY EXCLUSIVE — official
 *      clears base URL/key/model; compatible keeps prior key on same-mode update
 *      with no new key, replaces on a new key, and clears on a switch IN from
 *      official.
 *   4. deriveCredentialState / projectCredentialRead: connection state is shared;
 *      the API key is NEVER returned (only hasApiKey + masked suffix); official
 *      reads null the compatible-only fields.
 *   5. SYSTEM-LEVEL slot ceiling (configurable-task-slots 5.1–5.4):
 *      resolveMaxConcurrentTasks resolves `dbSetting ?? env ?? 5`; a valid save
 *      persists on ONE shared fixed-id row, reads back exactly, and pushes the
 *      live semaphore ceiling synchronously (no restart); an invalid value is
 *      rejected mutating neither the stored value nor the live ceiling; a write
 *      by one operator is observed by another operator's read.
 *
 * Logic is inlined (mirrors settings-logic.ts / settings.service.ts) so the
 * test runs under plain node:test with no transpile.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_WRITE_CONFIRM = true;

function resolveAccountSettings(displayAccount, stored) {
  return {
    allowedAccount: displayAccount,
    defaultRepoId: stored?.defaultRepoId ?? null,
    defaultSandboxEnvironmentId: stored?.defaultSandboxEnvironmentId ?? null,
    retention: stored?.retention ?? DEFAULT_RETENTION_DAYS,
    writeConfirm: stored?.writeConfirm ?? DEFAULT_WRITE_CONFIRM,
  };
}

function validateDefaultRepoSelection(requested, importedRepoIds, currentDefaultRepoId) {
  if (requested === undefined) return { ok: true, defaultRepoId: currentDefaultRepoId };
  if (requested === null) return { ok: true, defaultRepoId: null };
  const imported = importedRepoIds instanceof Set ? importedRepoIds : new Set(importedRepoIds);
  if (!imported.has(requested)) return { ok: false, reason: 'not_imported' };
  return { ok: true, defaultRepoId: requested };
}

function validateDefaultSandboxEnvironmentSelection(requested, selectableEnvironmentIds, currentDefaultSandboxEnvironmentId) {
  if (requested === undefined) {
    return { ok: true, defaultSandboxEnvironmentId: currentDefaultSandboxEnvironmentId };
  }
  if (requested === null) return { ok: true, defaultSandboxEnvironmentId: null };
  const selectable =
    selectableEnvironmentIds instanceof Set
      ? selectableEnvironmentIds
      : new Set(selectableEnvironmentIds);
  if (!selectable.has(requested)) return { ok: false, reason: 'not_selectable' };
  return { ok: true, defaultSandboxEnvironmentId: requested };
}

function applySettingsUpdate(current, patch, resolvedDefaultRepoId, resolvedDefaultSandboxEnvironmentId) {
  return {
    defaultRepoId: resolvedDefaultRepoId,
    defaultSandboxEnvironmentId: resolvedDefaultSandboxEnvironmentId,
    retention: patch.retention ?? current.retention,
    writeConfirm: patch.writeConfirm ?? current.writeConfirm,
  };
}

function deriveCredentialState(facts, officialConnected) {
  if (facts.mode === 'official') return officialConnected ? 'connected' : 'not_connected';
  // compatible: `connected` means VALIDATED — surface the persisted save-time
  // state, not field presence (an unvalidated baseUrl+key row reads not_saved).
  if (facts.persistedState === 'connected') return 'connected';
  const hasBaseUrl = typeof facts.baseUrl === 'string' && facts.baseUrl.length > 0;
  if (hasBaseUrl || facts.hasApiKey) return 'not_saved';
  return 'not_connected';
}

function projectCredentialRead(facts, officialConnected) {
  if (facts === null) {
    return { mode: 'official', state: 'not_connected', baseUrl: null, hasApiKey: false, apiKeySuffix: null, defaultModel: null };
  }
  const state = deriveCredentialState(facts, officialConnected);
  if (facts.mode === 'official') {
    return { mode: 'official', state, baseUrl: null, hasApiKey: false, apiKeySuffix: null, defaultModel: null };
  }
  return { mode: 'compatible', state, baseUrl: facts.baseUrl, hasApiKey: facts.hasApiKey, apiKeySuffix: facts.apiKeyLast4, defaultModel: facts.defaultModel };
}

function projectCredentialSave(request, previous) {
  if (request.mode === 'official') {
    // Official carries the ChatGPT login (auth.json): replace on a fresh paste,
    // else preserve on an official->official re-save, else clear when switching
    // IN from compatible (nothing to preserve). The compatible apiKey is always
    // cleared for an unused mode.
    const switchingIntoOfficial = previous === null || previous.mode !== 'official';
    const authJsonAction = request.hasNewAuthJson
      ? 'replace'
      : switchingIntoOfficial
        ? 'clear'
        : 'keep';
    return { mode: 'official', baseUrl: null, defaultModel: null, keyAction: 'clear', authJsonAction };
  }
  const baseUrl = request.baseUrl ?? null;
  const defaultModel = request.defaultModel ?? null;
  // Switching to compatible always clears any stored official auth.json.
  const base = { mode: 'compatible', baseUrl, defaultModel, authJsonAction: 'clear' };
  if (request.hasNewKey) return { ...base, keyAction: 'replace' };
  const switchingIntoCompatible = previous === null || previous.mode !== 'compatible';
  return { ...base, keyAction: switchingIntoCompatible ? 'clear' : 'keep' };
}

// 1. defaults + read-only identity + scoping
test('resolveAccountSettings returns defaults when nothing is saved', () => {
  const s = resolveAccountSettings('tanghehui', null);
  assert.deepEqual(s, {
    allowedAccount: 'tanghehui',
    defaultRepoId: null,
    defaultSandboxEnvironmentId: null,
    retention: 30,
    writeConfirm: true,
  });
});

test('resolveAccountSettings surfaces the saved row and the read-only identity', () => {
  const s = resolveAccountSettings('tanghehui', {
    defaultRepoId: 'r1',
    defaultSandboxEnvironmentId: 'env1',
    retention: 90,
    writeConfirm: false,
  });
  assert.equal(s.allowedAccount, 'tanghehui');
  assert.equal(s.defaultRepoId, 'r1');
  assert.equal(s.defaultSandboxEnvironmentId, 'env1');
  assert.equal(s.retention, 90);
  assert.equal(s.writeConfirm, false);
});

test('per-account scoping: each account sees only its own passed-in row', () => {
  const a = resolveAccountSettings('alice', {
    defaultRepoId: 'rA',
    defaultSandboxEnvironmentId: 'envA',
    retention: 7,
    writeConfirm: true,
  });
  const b = resolveAccountSettings('bob', null);
  assert.equal(a.allowedAccount, 'alice');
  assert.equal(a.defaultRepoId, 'rA');
  assert.equal(a.defaultSandboxEnvironmentId, 'envA');
  assert.equal(b.allowedAccount, 'bob');
  assert.equal(b.defaultRepoId, null); // bob never sees alice's repo
  assert.equal(b.defaultSandboxEnvironmentId, null); // nor alice's default image
});

test('allowedAccount always tracks the session identity, never a stored value', () => {
  // even if a (hypothetical) stored object carried allowedAccount, it is ignored
  const stored = {
    defaultRepoId: null,
    defaultSandboxEnvironmentId: null,
    retention: 30,
    writeConfirm: true,
    allowedAccount: 'EVIL',
  };
  const s = resolveAccountSettings('realuser', stored);
  assert.equal(s.allowedAccount, 'realuser');
});

// 2. default-must-be-imported
test('validateDefaultRepoSelection: undefined leaves the current default', () => {
  const r = validateDefaultRepoSelection(undefined, ['r1'], 'r9');
  assert.deepEqual(r, { ok: true, defaultRepoId: 'r9' });
});

test('validateDefaultRepoSelection: null clears the default', () => {
  const r = validateDefaultRepoSelection(null, ['r1'], 'r9');
  assert.deepEqual(r, { ok: true, defaultRepoId: null });
});

test('validateDefaultRepoSelection: an imported id is accepted', () => {
  const r = validateDefaultRepoSelection('r1', new Set(['r1', 'r2']), null);
  assert.deepEqual(r, { ok: true, defaultRepoId: 'r1' });
});

test('validateDefaultRepoSelection: an un-imported id is rejected without mutating', () => {
  const r = validateDefaultRepoSelection('ghost', ['r1', 'r2'], 'r1');
  assert.deepEqual(r, { ok: false, reason: 'not_imported' });
});

test('validateDefaultSandboxEnvironmentSelection: undefined leaves the current default image', () => {
  const r = validateDefaultSandboxEnvironmentSelection(undefined, ['env1'], 'env9');
  assert.deepEqual(r, { ok: true, defaultSandboxEnvironmentId: 'env9' });
});

test('validateDefaultSandboxEnvironmentSelection: null clears the default image', () => {
  const r = validateDefaultSandboxEnvironmentSelection(null, ['env1'], 'env9');
  assert.deepEqual(r, { ok: true, defaultSandboxEnvironmentId: null });
});

test('validateDefaultSandboxEnvironmentSelection: a selectable image is accepted', () => {
  const r = validateDefaultSandboxEnvironmentSelection('env1', new Set(['env1', 'env2']), null);
  assert.deepEqual(r, { ok: true, defaultSandboxEnvironmentId: 'env1' });
});

test('validateDefaultSandboxEnvironmentSelection: an unknown image is rejected without mutating', () => {
  const r = validateDefaultSandboxEnvironmentSelection('ghost', ['env1', 'env2'], 'env1');
  assert.deepEqual(r, { ok: false, reason: 'not_selectable' });
});

test('applySettingsUpdate only mutates supplied keys', () => {
  const current = {
    defaultRepoId: 'r1',
    defaultSandboxEnvironmentId: 'env1',
    retention: 30,
    writeConfirm: true,
  };
  const next = applySettingsUpdate(current, { writeConfirm: false }, 'r1', 'env1');
  assert.deepEqual(next, {
    defaultRepoId: 'r1',
    defaultSandboxEnvironmentId: 'env1',
    retention: 30,
    writeConfirm: false,
  });
});

// 3. mode mutual-exclusivity
test('official mode clears base URL, key, and model (mutual exclusivity)', () => {
  const prev = { mode: 'compatible', baseUrl: 'https://p', hasApiKey: true, apiKeyLast4: 'abcd', defaultModel: 'm', hasAuthJson: false };
  const plan = projectCredentialSave({ mode: 'official', hasNewKey: false, hasNewAuthJson: false }, prev);
  // Switching compatible -> official with NO pasted login must NOT resurrect a
  // stale auth.json (there is none on a compatible row): authJsonAction clears.
  assert.deepEqual(plan, { mode: 'official', baseUrl: null, defaultModel: null, keyAction: 'clear', authJsonAction: 'clear' });
});

// 3b. official ChatGPT auth.json: replace on a fresh paste, keep on re-save,
//     clear on a switch IN from compatible (security-critical for the new flow).
test('official: a fresh authJson paste REPLACES the stored login', () => {
  const prev = { mode: 'official', baseUrl: null, hasApiKey: false, apiKeyLast4: null, defaultModel: null, hasAuthJson: true };
  const plan = projectCredentialSave({ mode: 'official', hasNewKey: false, hasNewAuthJson: true }, prev);
  assert.equal(plan.authJsonAction, 'replace');
});

test('official: re-save with NO new paste KEEPS the prior login (token preserved)', () => {
  const prev = { mode: 'official', baseUrl: null, hasApiKey: false, apiKeyLast4: null, defaultModel: null, hasAuthJson: true };
  const plan = projectCredentialSave({ mode: 'official', hasNewKey: false, hasNewAuthJson: false }, prev);
  assert.equal(plan.authJsonAction, 'keep');
});

test('official: a fresh connect (no prior row) with no paste CLEARS (no phantom login)', () => {
  const plan = projectCredentialSave({ mode: 'official', hasNewKey: false, hasNewAuthJson: false }, null);
  assert.equal(plan.authJsonAction, 'clear');
});

test('compatible: switching IN from official always CLEARS the official auth.json', () => {
  const prevOfficial = { mode: 'official', baseUrl: null, hasApiKey: false, apiKeyLast4: null, defaultModel: null, hasAuthJson: true };
  const plan = projectCredentialSave({ mode: 'compatible', baseUrl: 'https://p', hasNewKey: true, hasNewAuthJson: false }, prevOfficial);
  assert.equal(plan.authJsonAction, 'clear');
});

test('compatible: a new key REPLACES; no new key on same-mode update KEEPS', () => {
  const prev = { mode: 'compatible', baseUrl: 'https://p', hasApiKey: true, apiKeyLast4: 'abcd', defaultModel: 'm' };
  const replace = projectCredentialSave({ mode: 'compatible', baseUrl: 'https://p', hasNewKey: true }, prev);
  assert.equal(replace.keyAction, 'replace');
  const keep = projectCredentialSave({ mode: 'compatible', baseUrl: 'https://p', hasNewKey: false }, prev);
  assert.equal(keep.keyAction, 'keep');
});

test('compatible: switching IN from official with no key CLEARS (no key to preserve)', () => {
  const prevOfficial = { mode: 'official', baseUrl: null, hasApiKey: false, apiKeyLast4: null, defaultModel: null };
  const plan = projectCredentialSave({ mode: 'compatible', baseUrl: 'https://p', hasNewKey: false }, prevOfficial);
  assert.equal(plan.keyAction, 'clear');
  const planFresh = projectCredentialSave({ mode: 'compatible', baseUrl: 'https://p', hasNewKey: false }, null);
  assert.equal(planFresh.keyAction, 'clear');
});

// 4. state derivation + secret-free read
test('deriveCredentialState: compatible connected/not_saved/not_connected', () => {
  // `connected` ONLY when the save-time validation persisted `connected`.
  assert.equal(deriveCredentialState({ mode: 'compatible', baseUrl: 'https://p', hasApiKey: true, persistedState: 'connected' }), 'connected');
  // baseUrl + key PRESENT but unvalidated => not_saved (spec: presence without validation reads not_saved).
  assert.equal(deriveCredentialState({ mode: 'compatible', baseUrl: 'https://p', hasApiKey: true, persistedState: 'not_saved' }), 'not_saved');
  assert.equal(deriveCredentialState({ mode: 'compatible', baseUrl: 'https://p', hasApiKey: true }), 'not_saved');
  assert.equal(deriveCredentialState({ mode: 'compatible', baseUrl: 'https://p', hasApiKey: false }), 'not_saved');
  assert.equal(deriveCredentialState({ mode: 'compatible', baseUrl: null, hasApiKey: false }), 'not_connected');
});

test('projectCredentialRead never returns a plaintext key field', () => {
  const facts = { mode: 'compatible', baseUrl: 'https://p', hasApiKey: true, apiKeyLast4: 'wxyz', defaultModel: 'gpt' };
  const read = projectCredentialRead(facts, false);
  assert.ok(!('apiKey' in read));
  assert.equal(read.hasApiKey, true);
  assert.equal(read.apiKeySuffix, 'wxyz');
  assert.equal(read.baseUrl, 'https://p');
  assert.equal(read.defaultModel, 'gpt');
});

test('projectCredentialRead nulls compatible-only fields for official mode', () => {
  const facts = { mode: 'official', baseUrl: 'https://stale', hasApiKey: true, apiKeyLast4: 'leak', defaultModel: 'stale' };
  const read = projectCredentialRead(facts, true);
  assert.equal(read.mode, 'official');
  assert.equal(read.state, 'connected');
  assert.equal(read.baseUrl, null);
  assert.equal(read.hasApiKey, false);
  assert.equal(read.apiKeySuffix, null);
  assert.equal(read.defaultModel, null);
});

test('projectCredentialRead: null facts => not_connected official default', () => {
  const read = projectCredentialRead(null, false);
  assert.deepEqual(read, { mode: 'official', state: 'not_connected', baseUrl: null, hasApiKey: false, apiKeySuffix: null, defaultModel: null });
});

// ---------------------------------------------------------------------------
// 5. SYSTEM-LEVEL slot ceiling (configurable-task-slots 5.1–5.4)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENT_TASKS = 5;
const MAX_CONCURRENT_TASKS_MIN = 1;
const MAX_CONCURRENT_TASKS_MAX = 20;

// Mirrors settings-logic.ts isValidMaxConcurrentTasks.
function isValidMaxConcurrentTasks(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MAX_CONCURRENT_TASKS_MIN &&
    value <= MAX_CONCURRENT_TASKS_MAX
  );
}

// Mirrors settings-logic.ts resolveMaxConcurrentTasks: `dbSetting ?? env ?? 5`.
function resolveMaxConcurrentTasks(stored, envSeed) {
  if (isValidMaxConcurrentTasks(stored)) return stored;
  const parsed = envSeed === undefined || envSeed.trim() === '' ? Number.NaN : Number(envSeed);
  if (Number.isInteger(parsed) && parsed > 0) {
    return Math.min(Math.max(parsed, MAX_CONCURRENT_TASKS_MIN), MAX_CONCURRENT_TASKS_MAX);
  }
  return DEFAULT_MAX_CONCURRENT_TASKS;
}

/**
 * Mirrors the settings.service.ts system-ceiling save/read flow: ONE shared
 * fixed-id `SystemSettings` row (operator-independent), a guard rejecting an
 * invalid value BEFORE any mutation, and a SYNCHRONOUS push of a successful
 * save into the live semaphore ceiling (env value seeds the semaphore at
 * construction; the read path never touches it).
 */
function makeSystemCeilingHarness(env) {
  const db = { row: null }; // the single system_settings row (fixed id)
  const semaphore = { ceiling: resolveMaxConcurrentTasks(null, env) }; // env-seeded live ceiling
  return {
    db,
    semaphore,
    // PATCH /settings with { maxConcurrentTasks } — `operator` is deliberately
    // unused on the write path: the row is system-level, not per-account.
    save(_operator, value) {
      if (value !== undefined && !isValidMaxConcurrentTasks(value)) {
        return { status: 400 }; // rejected pre-mutation: db row + ceiling untouched
      }
      if (value !== undefined) {
        db.row = { id: 'system', maxConcurrentTasks: value }; // fixed-id upsert
        semaphore.ceiling = value; // synchronous push — effective without restart
      }
      return { status: 200, maxConcurrentTasks: this.read(_operator) };
    },
    // GET /settings — same single row regardless of which operator reads.
    read(_operator) {
      return resolveMaxConcurrentTasks(db.row?.maxConcurrentTasks ?? null, env);
    },
  };
}

test('resolveMaxConcurrentTasks: persisted value wins over env', () => {
  assert.equal(resolveMaxConcurrentTasks(8, '3'), 8);
});

test('resolveMaxConcurrentTasks: env seeds when no row exists; default 5 when unset', () => {
  assert.equal(resolveMaxConcurrentTasks(null, '7'), 7);
  assert.equal(resolveMaxConcurrentTasks(null, undefined), 5);
  assert.equal(resolveMaxConcurrentTasks(undefined, ''), 5);
});

test('resolveMaxConcurrentTasks: invalid env seeds fall back to 5; oversized env clamps for the read shape', () => {
  for (const bad of ['abc', '0', '-2', '5.5']) {
    assert.equal(resolveMaxConcurrentTasks(null, bad), 5);
  }
  // The semaphore may seed >20 from env, but the contracts read shape is 1–20.
  assert.equal(resolveMaxConcurrentTasks(null, '50'), 20);
});

test('isValidMaxConcurrentTasks: accepts integers 1–20, rejects 0/21/negatives/non-integers', () => {
  assert.equal(isValidMaxConcurrentTasks(1), true);
  assert.equal(isValidMaxConcurrentTasks(5), true);
  assert.equal(isValidMaxConcurrentTasks(20), true);
  for (const bad of [0, 21, -3, 4.5, Number.NaN, '8', null, undefined]) {
    assert.equal(isValidMaxConcurrentTasks(bad), false);
  }
});

test('valid ceiling save persists, reads back exactly, and updates the live ceiling immediately', () => {
  const h = makeSystemCeilingHarness('5');
  const res = h.save('alice', 8);
  assert.equal(res.status, 200);
  assert.equal(res.maxConcurrentTasks, 8); // sanitized response carries the new value
  assert.equal(h.read('alice'), 8); // read-back-after-write
  assert.deepEqual(h.db.row, { id: 'system', maxConcurrentTasks: 8 }); // fixed-id row persisted
  assert.equal(h.semaphore.ceiling, 8); // pushed synchronously — no restart needed
});

test('invalid ceiling body mutates neither the stored value nor the live semaphore', () => {
  const h = makeSystemCeilingHarness('5');
  h.save('alice', 8); // establish a persisted value first
  for (const bad of [0, 21, -1, 3.5]) {
    const res = h.save('alice', bad);
    assert.equal(res.status, 400);
    assert.deepEqual(h.db.row, { id: 'system', maxConcurrentTasks: 8 }); // stored unchanged
    assert.equal(h.semaphore.ceiling, 8); // live ceiling unchanged
  }
});

test('a write by one operator is observed by another operator: one shared system value', () => {
  const h = makeSystemCeilingHarness(undefined);
  assert.equal(h.read('alice'), 5); // both start at the default
  assert.equal(h.read('bob'), 5);
  h.save('alice', 12);
  assert.equal(h.read('bob'), 12); // bob reads alice's write — single shared row
  assert.equal(h.read('alice'), 12);
});

test('first boot (no persisted row) reads the env seed; a save then becomes authoritative', () => {
  const h = makeSystemCeilingHarness('7');
  assert.equal(h.read('alice'), 7); // env seed applies while no row exists
  h.save('alice', 4);
  assert.equal(h.read('alice'), 4); // persisted value wins over env thereafter
  assert.equal(h.semaphore.ceiling, 4);
});

test('save without maxConcurrentTasks leaves the ceiling and stored row untouched', () => {
  const h = makeSystemCeilingHarness('5');
  h.save('alice', 9);
  const res = h.save('alice', undefined); // e.g. a retention-only PATCH
  assert.equal(res.status, 200);
  assert.equal(res.maxConcurrentTasks, 9);
  assert.deepEqual(h.db.row, { id: 'system', maxConcurrentTasks: 9 });
  assert.equal(h.semaphore.ceiling, 9);
});

// ---------------------------------------------------------------------------
// 6. Compatible credential: validated-`connected` + base-URL-required
//    (wire-compatible-provider-execution, tasks 2.4/2.5; design D5).
//
//    `connected` for compatible mode means VALIDATED against the provider (a
//    successful discovery probe whose model list contains the selected default),
//    NOT merely "a base URL + key are present". A compatible save with no base
//    URL is rejected before any write. Logic mirrors settings.service.ts
//    saveCredential + the SaveCodexCredentialRequest refine so it runs under
//    plain node:test.
// ---------------------------------------------------------------------------

// Mirrors the SaveCodexCredentialRequest refine (task 2.3 invariant exercised
// here): mode === 'compatible' REQUIRES a non-null/non-empty base URL.
function validateSaveRequest(request) {
  if (request.mode === 'compatible') {
    const hasBaseUrl = typeof request.baseUrl === 'string' && request.baseUrl.length > 0;
    if (!hasBaseUrl) return { ok: false, reason: 'compatible_base_url_required' };
  }
  return { ok: true };
}

// Mirrors settings.service.ts saveCredential compatible-mode state derivation:
// `connected` ONLY when a probe validates the saved base URL + key (and the
// selected default model is offered); otherwise present-but-unvalidated reads as
// `not_saved`. `probe` is the injected discovery result so no network is touched.
function deriveCompatibleSaveState(plan, hasKeyCiphertext, probe) {
  if (!plan.baseUrl || !hasKeyCiphertext) {
    return plan.baseUrl || hasKeyCiphertext ? 'not_saved' : 'not_connected';
  }
  if (!probe || !probe.ok) return 'not_saved';
  if (plan.defaultModel && !probe.models.includes(plan.defaultModel)) return 'not_saved';
  return 'connected';
}

test('compatible save without a base URL is rejected before any write', () => {
  const r = validateSaveRequest({ mode: 'compatible', apiKey: 'sk-key' });
  assert.deepEqual(r, { ok: false, reason: 'compatible_base_url_required' });
  // empty-string base URL is equally incoherent
  assert.equal(validateSaveRequest({ mode: 'compatible', baseUrl: '', apiKey: 'sk-key' }).ok, false);
  // a present base URL passes the guard
  assert.equal(validateSaveRequest({ mode: 'compatible', baseUrl: 'https://p/v1', apiKey: 'sk-key' }).ok, true);
  // official mode never requires a base URL
  assert.equal(validateSaveRequest({ mode: 'official' }).ok, true);
});

test('compatible: `connected` ONLY after a successful validation probe', () => {
  const plan = { mode: 'compatible', baseUrl: 'https://p/v1', defaultModel: 'gpt-4o' };
  // successful probe whose model list contains the selected default => connected
  const okProbe = { ok: true, models: ['gpt-4o', 'gpt-4o-mini'] };
  assert.equal(deriveCompatibleSaveState(plan, true, okProbe), 'connected');
});

test('compatible: a FAILED probe does NOT mark connected (reads not_saved)', () => {
  const plan = { mode: 'compatible', baseUrl: 'https://p/v1', defaultModel: 'gpt-4o' };
  for (const probe of [
    { ok: false, error: 'provider_auth_failed' },
    { ok: false, error: 'provider_unreachable' },
    { ok: false, error: 'provider_url_blocked' },
    { ok: false, error: 'provider_bad_response' },
  ]) {
    assert.equal(deriveCompatibleSaveState(plan, true, probe), 'not_saved', probe.error);
  }
});

test('compatible: a default model NOT offered by the provider is not connected', () => {
  const plan = { mode: 'compatible', baseUrl: 'https://p/v1', defaultModel: 'phantom-model' };
  const okProbe = { ok: true, models: ['gpt-4o'] };
  assert.equal(deriveCompatibleSaveState(plan, true, okProbe), 'not_saved');
});

test('compatible: base URL + key present but NO probe run reads as not_saved (validated-connected)', () => {
  const plan = { mode: 'compatible', baseUrl: 'https://p/v1', defaultModel: null };
  // no probe (e.g. could not decrypt the carried-over key) => unvalidated => not_saved
  assert.equal(deriveCompatibleSaveState(plan, true, undefined), 'not_saved');
});

test('compatible: a base URL with no key still reads as not_saved (partial entry)', () => {
  const plan = { mode: 'compatible', baseUrl: 'https://p/v1', defaultModel: null };
  assert.equal(deriveCompatibleSaveState(plan, false, undefined), 'not_saved');
});

test('compatible: a successful probe with NO default model selected is connected', () => {
  const plan = { mode: 'compatible', baseUrl: 'https://p/v1', defaultModel: null };
  const okProbe = { ok: true, models: ['gpt-4o'] };
  assert.equal(deriveCompatibleSaveState(plan, true, okProbe), 'connected');
});
