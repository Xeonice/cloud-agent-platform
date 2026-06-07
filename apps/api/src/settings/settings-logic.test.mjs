/**
 * Verify-phase test for the pure account-settings + Codex-credential logic
 * (account-settings, tasks 7.2 / 7.3 / 7.4).
 *
 * Requirement semantics (from settings-logic.ts):
 *   1. resolveAccountSettings: allowedAccount is the read-only OAuth-sourced
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
 *
 * Logic is inlined (mirrors settings-logic.ts) so the test runs under plain
 * node:test with no transpile.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_WRITE_CONFIRM = true;

function resolveAccountSettings(displayAccount, stored) {
  return {
    allowedAccount: displayAccount,
    defaultRepoId: stored?.defaultRepoId ?? null,
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

function applySettingsUpdate(current, patch, resolvedDefaultRepoId) {
  return {
    defaultRepoId: resolvedDefaultRepoId,
    retention: patch.retention ?? current.retention,
    writeConfirm: patch.writeConfirm ?? current.writeConfirm,
  };
}

function deriveCredentialState(facts, officialConnected) {
  if (facts.mode === 'official') return officialConnected ? 'connected' : 'not_connected';
  const hasBaseUrl = typeof facts.baseUrl === 'string' && facts.baseUrl.length > 0;
  if (hasBaseUrl && facts.hasApiKey) return 'connected';
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
  assert.deepEqual(s, { allowedAccount: 'tanghehui', defaultRepoId: null, retention: 30, writeConfirm: true });
});

test('resolveAccountSettings surfaces the saved row and the read-only identity', () => {
  const s = resolveAccountSettings('tanghehui', { defaultRepoId: 'r1', retention: 90, writeConfirm: false });
  assert.equal(s.allowedAccount, 'tanghehui');
  assert.equal(s.defaultRepoId, 'r1');
  assert.equal(s.retention, 90);
  assert.equal(s.writeConfirm, false);
});

test('per-account scoping: each account sees only its own passed-in row', () => {
  const a = resolveAccountSettings('alice', { defaultRepoId: 'rA', retention: 7, writeConfirm: true });
  const b = resolveAccountSettings('bob', null);
  assert.equal(a.allowedAccount, 'alice');
  assert.equal(a.defaultRepoId, 'rA');
  assert.equal(b.allowedAccount, 'bob');
  assert.equal(b.defaultRepoId, null); // bob never sees alice's repo
});

test('allowedAccount always tracks the OAuth identity, never a stored value', () => {
  // even if a (hypothetical) stored object carried allowedAccount, it is ignored
  const stored = { defaultRepoId: null, retention: 30, writeConfirm: true, allowedAccount: 'EVIL' };
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

test('applySettingsUpdate only mutates supplied keys', () => {
  const current = { defaultRepoId: 'r1', retention: 30, writeConfirm: true };
  const next = applySettingsUpdate(current, { writeConfirm: false }, 'r1');
  assert.deepEqual(next, { defaultRepoId: 'r1', retention: 30, writeConfirm: false });
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
  assert.equal(deriveCredentialState({ mode: 'compatible', baseUrl: 'https://p', hasApiKey: true }), 'connected');
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
