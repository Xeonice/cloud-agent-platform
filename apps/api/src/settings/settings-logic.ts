/**
 * Pure decision logic for account settings + the Codex execution credential
 * (account-settings, tasks 7.2 / 7.3 / 7.4).
 *
 * Everything here is a PURE function of its inputs — no NestJS, no Prisma, no
 * I/O, no `process.env`. The persistence + HTTP boundaries live in the service
 * / client; the security- and correctness-critical decisions live here so the
 * verify phase can unit-test them under plain `node`:
 *
 *   - {@link resolveAccountSettings} — composes the per-account READ shape from
 *     the OAuth-sourced (read-only) display identity + the stored row, returning
 *     DEFAULTS when nothing has been saved (7.2). Per-account scoping is enforced
 *     by the caller passing only THAT account's stored row.
 *   - {@link validateDefaultRepoSelection} — a `defaultRepoId` is accepted ONLY
 *     when it references a repo the account has imported/can see; `null` clears
 *     the selection; an un-imported / unknown id is rejected (7.3).
 *   - {@link projectCredentialMode} — the two provider modes are MUTUALLY
 *     EXCLUSIVE; switching modes is explicit and clears the other mode's fields
 *     so official↔compatible never carries stale state across (7.4).
 *   - {@link deriveCredentialState} — the shared connection state consumed by the
 *     status card / tab subtitle / provider pill.
 */

import type {
  AccountSettings,
  CodexCredential,
  CodexCredentialMode,
  CodexCredentialState,
  RetentionDays,
  UpdateSettingsRequest,
} from '@cap/contracts';

// ---------------------------------------------------------------------------
// 7.2 — Account preferences defaults + read projection
// ---------------------------------------------------------------------------

/** Default retention window applied when an account has saved no preference. */
export const DEFAULT_RETENTION_DAYS: RetentionDays = 30;
/** Default destructive-write gate: ON (stop before destructive writes) by default. */
export const DEFAULT_WRITE_CONFIRM = true;

/**
 * The stored, writable preference row for ONE account (the columns persisted in
 * `account_settings`). `null` means the account has saved nothing yet, in which
 * case {@link resolveAccountSettings} returns the documented defaults. Note this
 * intentionally has NO `allowedAccount`: that display identity is never stored.
 */
export interface StoredAccountPrefs {
  readonly defaultRepoId: string | null;
  readonly retention: RetentionDays;
  readonly writeConfirm: boolean;
}

/**
 * Composes the per-account settings READ shape (7.2).
 *
 * `allowedAccount` is sourced SOLELY from the OAuth identity (`displayAccount`,
 * e.g. the GitHub login) and is READ-ONLY — it is never read from or written to
 * storage. When `stored` is `null` (nothing saved for this account) the
 * documented defaults are returned, so a never-configured account still gets a
 * complete, valid settings object. Because the caller passes only THIS account's
 * `stored` row, the result never leaks another account's preferences.
 */
export function resolveAccountSettings(
  displayAccount: string,
  stored: StoredAccountPrefs | null,
): AccountSettings {
  return {
    allowedAccount: displayAccount,
    defaultRepoId: stored?.defaultRepoId ?? null,
    retention: stored?.retention ?? DEFAULT_RETENTION_DAYS,
    writeConfirm: stored?.writeConfirm ?? DEFAULT_WRITE_CONFIRM,
  };
}

// ---------------------------------------------------------------------------
// 7.3 — Update: default-must-be-imported + read-only allowedAccount
// ---------------------------------------------------------------------------

/** Outcome of validating a requested `defaultRepoId` against imported repos. */
export type DefaultRepoValidation =
  | { readonly ok: true; readonly defaultRepoId: string | null }
  | { readonly ok: false; readonly reason: 'not_imported' };

/**
 * Validates a requested default-repo selection against the set of repo ids the
 * account has imported / can see (7.3).
 *
 *   - `undefined` (key omitted) ⇒ leave the existing selection unchanged.
 *   - `null` ⇒ explicitly clear the selection (always allowed).
 *   - a string id ⇒ accepted ONLY when it is in `importedRepoIds`; an
 *     un-imported / unknown id is rejected (`not_imported`) so the caller can
 *     return a 4xx WITHOUT mutating any stored preference.
 *
 * `currentDefaultRepoId` is returned for the omitted case so the caller can
 * compute the effective post-update value in one place. The check is a pure set
 * membership test; the caller supplies the imported-id set scoped to the account.
 */
export function validateDefaultRepoSelection(
  requested: string | null | undefined,
  importedRepoIds: ReadonlySet<string> | readonly string[],
  currentDefaultRepoId: string | null,
): DefaultRepoValidation {
  if (requested === undefined) {
    return { ok: true, defaultRepoId: currentDefaultRepoId };
  }
  if (requested === null) {
    return { ok: true, defaultRepoId: null };
  }
  const imported =
    importedRepoIds instanceof Set
      ? importedRepoIds
      : new Set(importedRepoIds as readonly string[]);
  if (!imported.has(requested)) {
    return { ok: false, reason: 'not_imported' };
  }
  return { ok: true, defaultRepoId: requested };
}

/**
 * Applies a validated {@link UpdateSettingsRequest} onto the current stored
 * prefs, producing the next persisted preference row (7.3). The `allowedAccount`
 * identity is intentionally absent from both the request and the result here:
 * it is READ-ONLY and not part of the persisted prefs, so there is no path by
 * which an update mutates it. `resolvedDefaultRepoId` is the already-validated
 * default from {@link validateDefaultRepoSelection}; only the keys present in
 * the request mutate, everything else is carried from `current`.
 */
export function applySettingsUpdate(
  current: StoredAccountPrefs,
  patch: UpdateSettingsRequest,
  resolvedDefaultRepoId: string | null,
): StoredAccountPrefs {
  return {
    defaultRepoId: resolvedDefaultRepoId,
    retention: patch.retention ?? current.retention,
    writeConfirm: patch.writeConfirm ?? current.writeConfirm,
  };
}

// ---------------------------------------------------------------------------
// 7.4 — Codex credential: mutually-exclusive modes + connection state
// ---------------------------------------------------------------------------

/**
 * The persisted, secret-free view of a stored Codex credential row. The API key
 * is represented ONLY by `hasApiKey` + `apiKeyLast4`; the ciphertext/iv/authTag
 * never appear in this projection input (the service strips them before calling
 * the pure projector). `null` means no credential has ever been saved.
 */
export interface StoredCredentialFacts {
  readonly mode: CodexCredentialMode;
  readonly baseUrl: string | null;
  readonly hasApiKey: boolean;
  readonly apiKeyLast4: string | null;
  readonly defaultModel: string | null;
}

/**
 * Derives the shared connection state (7.4) consumed identically by the status
 * card, the active-tab subtitle, and the provider pill:
 *
 *   - `not_connected`: nothing connected for this mode.
 *   - `connected`: official mode that is connected, OR compatible mode with both
 *     a base URL AND a stored key.
 *   - `not_saved`: compatible-mode details partially entered (a base URL but no
 *     stored key yet) — "未保存".
 *
 * It is a pure function of the persisted facts so the three UI surfaces cannot
 * drift on what "connected" means.
 */
export function deriveCredentialState(
  facts: Pick<StoredCredentialFacts, 'mode' | 'baseUrl' | 'hasApiKey'>,
  officialConnected: boolean,
): CodexCredentialState {
  if (facts.mode === 'official') {
    return officialConnected ? 'connected' : 'not_connected';
  }
  // compatible mode
  const hasBaseUrl = typeof facts.baseUrl === 'string' && facts.baseUrl.length > 0;
  if (hasBaseUrl && facts.hasApiKey) {
    return 'connected';
  }
  if (hasBaseUrl || facts.hasApiKey) {
    return 'not_saved';
  }
  return 'not_connected';
}

/**
 * Projects the stored credential facts into the secret-free READ shape (7.4 /
 * 7.5). The API key is NEVER returned: only `hasApiKey` and the masked
 * `apiKeySuffix` (last 4) are exposed. For official mode the compatible-only
 * fields are nulled so a stale base URL/model from a previous compatible
 * configuration never bleeds into an official read.
 *
 * `null` stored facts project to a default `not_connected` official credential,
 * so a never-configured account still gets a complete, valid credential object.
 */
export function projectCredentialRead(
  facts: StoredCredentialFacts | null,
  officialConnected: boolean,
): CodexCredential {
  if (facts === null) {
    return {
      mode: 'official',
      state: 'not_connected',
      baseUrl: null,
      hasApiKey: false,
      apiKeySuffix: null,
      defaultModel: null,
    };
  }
  const state = deriveCredentialState(facts, officialConnected);
  if (facts.mode === 'official') {
    return {
      mode: 'official',
      state,
      baseUrl: null,
      hasApiKey: false,
      apiKeySuffix: null,
      defaultModel: null,
    };
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
 * The next persisted credential row computed from a save request and the
 * previously stored row, enforcing MUTUAL EXCLUSIVITY between the two modes
 * (7.4).
 *
 * Switching modes is EXPLICIT (the request names the target `mode`) and clears
 * the other mode's fields:
 *   - Selecting `official` drops any base URL, stored key, and model — the
 *     compatible secret is cleared so it can never linger encrypted-at-rest for
 *     a mode that does not use it.
 *   - Selecting `compatible` keeps/sets the base URL + model; the key is only
 *     replaced when a new one was supplied (the caller passes the freshly
 *     encrypted envelope), otherwise the PREVIOUS encrypted key is preserved on
 *     a same-mode update and CLEARED on a switch INTO compatible from official
 *     (there is no compatible key to preserve across a mode switch).
 *
 * The `previous` facts carry whether a key already existed; `newSecret`
 * indicates a key was supplied on this request. This function decides the next
 * row's non-secret shape and which of {keep|replace|clear} applies to the key,
 * leaving the actual ciphertext handling to the service (which alone touches
 * encryption).
 */
export type CredentialKeyAction = 'clear' | 'keep' | 'replace';

export interface NextCredentialPlan {
  readonly mode: CodexCredentialMode;
  readonly baseUrl: string | null;
  readonly defaultModel: string | null;
  /** What to do with the stored ciphertext: clear it, keep the prior one, or replace. */
  readonly keyAction: CredentialKeyAction;
}

export function projectCredentialSave(
  request: {
    mode: CodexCredentialMode;
    baseUrl?: string;
    defaultModel?: string;
    /** True when a plaintext apiKey was supplied on this request. */
    hasNewKey: boolean;
  },
  previous: StoredCredentialFacts | null,
): NextCredentialPlan {
  if (request.mode === 'official') {
    // Official mode is connection-state only: no base URL, no key, no model.
    // Always clear any compatible secret so it never lingers for an unused mode.
    return {
      mode: 'official',
      baseUrl: null,
      defaultModel: null,
      keyAction: 'clear',
    };
  }

  // compatible mode
  const baseUrl = request.baseUrl ?? null;
  const defaultModel = request.defaultModel ?? null;

  if (request.hasNewKey) {
    return { mode: 'compatible', baseUrl, defaultModel, keyAction: 'replace' };
  }
  // No new key supplied. Preserve the previous compatible key ONLY on a
  // same-mode (compatible -> compatible) update; switching IN from official has
  // no compatible key to preserve, so the key stays absent (clear).
  const switchingIntoCompatible = previous === null || previous.mode !== 'compatible';
  return {
    mode: 'compatible',
    baseUrl,
    defaultModel,
    keyAction: switchingIntoCompatible ? 'clear' : 'keep',
  };
}
