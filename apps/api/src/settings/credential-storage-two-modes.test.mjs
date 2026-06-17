/**
 * Minimal test exercising EVERY scenario of the spec requirement:
 *   account-settings / "Codex credential storage with two provider modes"
 *   (wire-compatible-provider-execution)
 *
 * Scenarios:
 *   S1 - Official-account mode stores connection state only
 *   S2 - Compatible-provider mode stores base URL, key, and default model
 *   S3 - Compatible save without a base URL is rejected
 *   S4 - Compatible credential present but unvalidated reads as not_saved
 *   S5 - Unsaved compatible provider (base URL only, no key) reads as not_saved
 *
 * Runs under plain node:test — no transpile, no NestJS, no Prisma.
 * Logic is inlined from settings-logic.ts / settings.service.ts to stay
 * self-contained; the mapping to the real source is noted per function.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Inline pure logic (mirrors settings-logic.ts)
// ---------------------------------------------------------------------------

/**
 * Mirrors settings-logic.ts deriveCredentialState.
 * Returns 'connected' | 'not_saved' | 'not_connected' for one credential row.
 */
function deriveCredentialState(facts, officialConnected) {
  if (facts.mode === 'official') {
    return officialConnected ? 'connected' : 'not_connected';
  }
  // compatible mode: `connected` means VALIDATED — surface the state PERSISTED at
  // save time (written `connected` only after a successful probe, design D5), NOT
  // re-derived from field presence. An unvalidated row reads `not_saved`.
  if (facts.persistedState === 'connected') return 'connected';
  const hasBaseUrl = typeof facts.baseUrl === 'string' && facts.baseUrl.length > 0;
  if (hasBaseUrl || facts.hasApiKey) return 'not_saved';
  return 'not_connected';
}

/**
 * Mirrors settings-logic.ts projectCredentialRead.
 * Projects stored facts into the secret-free read shape.
 */
function projectCredentialRead(facts, officialConnected) {
  if (facts === null) {
    return { mode: 'official', state: 'not_connected', baseUrl: null, hasApiKey: false, apiKeySuffix: null, defaultModel: null };
  }
  const state = deriveCredentialState(facts, officialConnected);
  if (facts.mode === 'official') {
    return { mode: 'official', state, baseUrl: null, hasApiKey: false, apiKeySuffix: null, defaultModel: null };
  }
  return {
    mode: 'compatible',
    state,
    baseUrl: facts.baseUrl,
    hasApiKey: facts.hasApiKey,
    apiKeySuffix: facts.apiKeyLast4,
    defaultModel: facts.defaultModel,
  };
}

/**
 * Mirrors settings-logic.ts projectCredentialSave.
 * Returns the next persisted plan (non-secret) from a save request + previous state.
 */
function projectCredentialSave(request, previous) {
  if (request.mode === 'official') {
    const switchingIntoOfficial = previous === null || previous.mode !== 'official';
    const authJsonAction = request.hasNewAuthJson
      ? 'replace'
      : switchingIntoOfficial ? 'clear' : 'keep';
    return { mode: 'official', baseUrl: null, defaultModel: null, keyAction: 'clear', authJsonAction };
  }
  const baseUrl = request.baseUrl ?? null;
  const defaultModel = request.defaultModel ?? null;
  const base = { mode: 'compatible', baseUrl, defaultModel, authJsonAction: 'clear' };
  if (request.hasNewKey) return { ...base, keyAction: 'replace' };
  const switchingIntoCompatible = previous === null || previous.mode !== 'compatible';
  return { ...base, keyAction: switchingIntoCompatible ? 'clear' : 'keep' };
}

/**
 * Mirrors the SaveCodexCredentialRequest Zod refine in settings.controller.ts /
 * settings.service.ts: mode === 'compatible' requires a non-null, non-empty baseUrl.
 */
function validateSaveRequest(request) {
  if (request.mode === 'compatible') {
    const hasBaseUrl = typeof request.baseUrl === 'string' && request.baseUrl.length > 0;
    if (!hasBaseUrl) return { ok: false, reason: 'compatible_base_url_required' };
  }
  return { ok: true };
}

/**
 * Mirrors settings.service.ts saveCredential: derives the post-save `state` for
 * a compatible credential.  `probe` is the discovery result (injected here so no
 * network call is required).
 *
 * `connected` requires a successful probe that offers the selected default model
 * (or no default model was selected).  Everything else is `not_saved`.
 */
function deriveCompatibleSaveState(plan, hasKeyCiphertext, probe) {
  if (!plan.baseUrl || !hasKeyCiphertext) {
    return (plan.baseUrl || hasKeyCiphertext) ? 'not_saved' : 'not_connected';
  }
  if (!probe || !probe.ok) return 'not_saved';
  if (plan.defaultModel && !probe.models.includes(plan.defaultModel)) return 'not_saved';
  return 'connected';
}

// ---------------------------------------------------------------------------
// S1 — Official-account mode stores connection state only
// ---------------------------------------------------------------------------
test('S1: official-account mode — plan has no base URL / key / model; read is connected, no compat fields', () => {
  // Save: switch from compatible to official with a fresh auth.json paste
  const previous = {
    mode: 'compatible',
    baseUrl: 'https://api.example.com/v1',
    hasApiKey: true,
    apiKeyLast4: 'abcd',
    defaultModel: 'gpt-4o',
    hasAuthJson: false,
  };
  const plan = projectCredentialSave({ mode: 'official', hasNewKey: false, hasNewAuthJson: true }, previous);

  // Plan must clear compatible fields
  assert.equal(plan.mode, 'official', 'plan.mode');
  assert.equal(plan.baseUrl, null, 'plan.baseUrl');
  assert.equal(plan.defaultModel, null, 'plan.defaultModel');
  assert.equal(plan.keyAction, 'clear', 'plan.keyAction');
  assert.equal(plan.authJsonAction, 'replace', 'plan.authJsonAction');

  // After persistence: simulate the official row that is stored
  const officialStoredFacts = {
    mode: 'official',
    baseUrl: null,
    hasApiKey: false,
    apiKeyLast4: null,
    defaultModel: null,
    hasAuthJson: true,
  };

  // Read: official mode with ChatGPT login present => connected; compat-only fields null
  const read = projectCredentialRead(officialStoredFacts, /* officialConnected= */ true);
  assert.equal(read.mode, 'official', 'read.mode');
  assert.equal(read.state, 'connected', 'read.state');
  assert.equal(read.baseUrl, null, 'read.baseUrl — no compat field leaks');
  assert.equal(read.hasApiKey, false, 'read.hasApiKey — no compat field leaks');
  assert.equal(read.defaultModel, null, 'read.defaultModel — no compat field leaks');
  assert.equal(read.apiKeySuffix, null, 'read.apiKeySuffix — no compat field leaks');
});

// ---------------------------------------------------------------------------
// S2 — Compatible-provider mode stores base URL, key, and default model
// ---------------------------------------------------------------------------
test('S2: compatible mode with validated key + model → state is connected', () => {
  const saveReq = {
    mode: 'compatible',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'gpt-4o',
    hasNewKey: true,
    hasNewAuthJson: false,
  };
  const validationResult = validateSaveRequest(saveReq);
  assert.ok(validationResult.ok, 'request must pass validation');

  const plan = projectCredentialSave(saveReq, /* previous= */ null);
  assert.equal(plan.mode, 'compatible');
  assert.equal(plan.baseUrl, 'https://api.example.com/v1');
  assert.equal(plan.defaultModel, 'gpt-4o');
  assert.equal(plan.keyAction, 'replace');

  // Probe confirms base URL + model
  const probe = { ok: true, models: ['gpt-4o', 'gpt-4o-mini'] };
  const state = deriveCompatibleSaveState(plan, /* hasKeyCiphertext= */ true, probe);
  assert.equal(state, 'connected', 'validated probe => connected');

  // Simulate the stored row after persistence — its persisted state IS the
  // save-derived state (here `connected`, because the probe validated it).
  const storedFacts = {
    mode: 'compatible',
    baseUrl: plan.baseUrl,
    hasApiKey: true,
    apiKeyLast4: '4444',
    defaultModel: plan.defaultModel,
    hasAuthJson: false,
    persistedState: state,
  };
  const read = projectCredentialRead(storedFacts, false);
  assert.equal(read.mode, 'compatible');
  assert.equal(read.state, 'connected');
  assert.equal(read.baseUrl, 'https://api.example.com/v1');
  assert.equal(read.hasApiKey, true);
  assert.equal(read.defaultModel, 'gpt-4o');
  // API key is NOT returned in plaintext
  assert.ok(!('apiKey' in read), 'no plaintext key in read response');
  assert.equal(read.apiKeySuffix, '4444');
});

// ---------------------------------------------------------------------------
// S3 — Compatible save without a base URL is rejected
// ---------------------------------------------------------------------------
test('S3: compatible save with no base URL is rejected server-side before any write', () => {
  // No baseUrl field at all
  const r1 = validateSaveRequest({ mode: 'compatible', apiKey: 'sk-xxx' });
  assert.equal(r1.ok, false, 'missing baseUrl rejected');
  assert.equal(r1.reason, 'compatible_base_url_required');

  // Explicitly null baseUrl
  const r2 = validateSaveRequest({ mode: 'compatible', baseUrl: null, apiKey: 'sk-xxx' });
  assert.equal(r2.ok, false, 'null baseUrl rejected');

  // Empty string baseUrl
  const r3 = validateSaveRequest({ mode: 'compatible', baseUrl: '', apiKey: 'sk-xxx' });
  assert.equal(r3.ok, false, 'empty-string baseUrl rejected');

  // Official mode never needs a baseUrl
  const r4 = validateSaveRequest({ mode: 'official' });
  assert.equal(r4.ok, true, 'official mode always ok');
});

// ---------------------------------------------------------------------------
// S4 — Compatible credential present but unvalidated reads as not_saved
// ---------------------------------------------------------------------------
test('S4: base URL + key stored but no successful validation => not_saved (not connected)', () => {
  // Scenario: a compatible row was previously saved without a successful probe
  // (or the probe result was not persisted). The read must NOT report `connected`.

  // Case 1: probe explicitly failed
  const plan = { mode: 'compatible', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o' };
  for (const probe of [
    { ok: false, error: 'provider_unreachable' },
    { ok: false, error: 'provider_auth_failed' },
    { ok: false, error: 'provider_url_blocked' },
    { ok: false, error: 'provider_bad_response' },
  ]) {
    const state = deriveCompatibleSaveState(plan, true, probe);
    assert.equal(state, 'not_saved', `failed probe (${probe.error}) must yield not_saved`);
  }

  // Case 2: no probe was run at all (undefined)
  const stateNoProbe = deriveCompatibleSaveState(plan, true, undefined);
  assert.equal(stateNoProbe, 'not_saved', 'no probe run => not_saved');

  // Case 3 (READ side): a row with baseUrl + key PRESENT but persisted state
  // 'not_saved' (no successful probe) MUST read back as 'not_saved'. The read path
  // surfaces the persisted state and does NOT re-derive `connected` from field
  // presence — this is the exact spec scenario "field presence without a
  // successful validation SHALL read as `not_saved`".
  const storedUnvalidated = {
    mode: 'compatible',
    baseUrl: 'https://api.example.com/v1',
    hasApiKey: true,
    apiKeyLast4: '1234',
    defaultModel: 'gpt-4o',
    hasAuthJson: false,
    persistedState: 'not_saved', // what the service persisted (no probe / failed probe)
  };
  const readUnvalidated = projectCredentialRead(storedUnvalidated, false);
  assert.equal(
    readUnvalidated.state,
    'not_saved',
    'baseUrl+key present but persisted not_saved must READ back as not_saved, not connected',
  );

  // And the save side still persists not_saved when no probe ran (so the read above
  // is fed the right stored value).
  const saveState = deriveCompatibleSaveState(
    { mode: 'compatible', baseUrl: storedUnvalidated.baseUrl, defaultModel: storedUnvalidated.defaultModel },
    /* hasKeyCiphertext */ true,
    /* probe */ undefined, // no validation occurred
  );
  assert.equal(saveState, 'not_saved', 'service must persist not_saved when no probe was run');

  // Positive control: a row the service VALIDATED (persisted 'connected') reads
  // back as 'connected'.
  const readValidated = projectCredentialRead(
    { ...storedUnvalidated, persistedState: 'connected' },
    false,
  );
  assert.equal(readValidated.state, 'connected', 'validated row (persisted connected) reads connected');
});

// ---------------------------------------------------------------------------
// S5 — Unsaved compatible provider (base URL entered, no key yet) reads as not_saved
// ---------------------------------------------------------------------------
test('S5: base URL present but no API key stored => not_saved (not connected)', () => {
  // The user has entered a base URL but has not yet successfully saved a key.
  // deriveCredentialState must return 'not_saved', not 'connected' or 'not_connected'.
  const facts = {
    mode: 'compatible',
    baseUrl: 'https://api.example.com/v1',
    hasApiKey: false, // key not stored yet
    apiKeyLast4: null,
    defaultModel: null,
    hasAuthJson: false,
  };
  const state = deriveCredentialState(facts, false);
  assert.equal(state, 'not_saved', 'base URL only (no key) => not_saved');

  // The read shape must propagate that state correctly
  const read = projectCredentialRead(facts, false);
  assert.equal(read.mode, 'compatible');
  assert.equal(read.state, 'not_saved', 'read API reports not_saved');

  // Also verify: neither baseUrl=null nor both null+no-key yields not_connected
  const noFields = { mode: 'compatible', baseUrl: null, hasApiKey: false };
  assert.equal(deriveCredentialState(noFields, false), 'not_connected', 'nothing at all => not_connected');

  // Only key (no base URL) is also not_saved (incoherent partial entry)
  const keyOnly = { mode: 'compatible', baseUrl: null, hasApiKey: true };
  assert.equal(deriveCredentialState(keyOnly, false), 'not_saved', 'key-only (no baseUrl) => not_saved');
});
