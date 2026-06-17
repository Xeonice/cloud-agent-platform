import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountSettingsSchema,
  CodexCredentialSchema,
  type AccountSettings,
  type CodexCredential,
  type RetentionDays,
  type SaveCodexCredentialRequest,
  type SessionUser,
  type UpdateSettingsRequest,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { GuardrailsService } from '../guardrails/guardrails.service';
import {
  ModelDiscoveryClient,
  type ModelDiscoveryResult,
} from './model-discovery.client';
import {
  applySettingsUpdate,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_WRITE_CONFIRM,
  isValidMaxConcurrentTasks,
  projectCredentialRead,
  projectCredentialSave,
  resolveAccountSettings,
  resolveMaxConcurrentTasks,
  validateDefaultRepoSelection,
  type StoredAccountPrefs,
  type StoredCredentialFacts,
} from './settings-logic';
import {
  decryptSecret,
  encryptSecret,
  EncryptionKeyUnavailableError,
  maskApiKeySuffix,
  resolveEncryptionKey,
  type EncryptedSecret,
} from './settings-crypto';

/** Env var carrying the AES-256-GCM server key for the compatible-provider API key. */
export const CODEX_CRED_ENC_KEY_ENV = 'CODEX_CRED_ENC_KEY';

/**
 * Fixed primary key of the single `SystemSettings` row (configurable-task-slots
 * 5.1). The system-level slot ceiling is one shared value for the whole
 * deployment, so every read/write addresses this one row via upsert — at most
 * one row ever exists.
 */
export const SYSTEM_SETTINGS_ROW_ID = 'system';

/**
 * Account-settings + Codex-credential service (account-settings, tasks 7.2–7.6).
 *
 * Per-account scoping (7.2/7.3): every read/write is keyed on the OWNING user
 * row, resolved from the operator principal's immutable numeric `githubId`. A
 * caller can therefore only ever read or mutate THEIR OWN account's settings —
 * the user id is taken from the guard-attached principal, never from the body —
 * so settings never leak across accounts.
 *
 * EXCEPTION — the SYSTEM-LEVEL slot ceiling (configurable-task-slots 5.1–5.3):
 * `maxConcurrentTasks` is deliberately carved out of per-account scoping. It is
 * ONE shared value for the deployment, stored on the single fixed-id
 * `SystemSettings` row (NOT on the per-account `AccountSettings` row), so a
 * write by one operator is observed by every operator's subsequent read. GET
 * resolves `dbSetting ?? env MAX_CONCURRENT_TASKS ?? 5` (first boot reads the
 * env seed); a successful save pushes the new ceiling SYNCHRONOUSLY into the
 * live guardrails semaphore so it takes effect without a restart.
 *
 * Secret discipline (7.5): the compatible-provider API key is encrypted at rest
 * with AES-256-GCM under {@link CODEX_CRED_ENC_KEY_ENV}; saving a key with no
 * key configured FAILS CLOSED with a clear error and persists nothing. Reads
 * expose only `hasApiKey` + a masked last-4 suffix and NEVER the plaintext.
 *
 * The security-/correctness-critical decisions (defaults, default-must-be-
 * imported, mode mutual-exclusivity, state derivation, encryption round-trip)
 * are delegated to the pure modules ({@link settings-logic}, {@link
 * settings-crypto}, {@link model-discovery.client}) so they are unit-testable in
 * isolation; this service only composes them with Prisma + the env key.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modelDiscovery: ModelDiscoveryClient,
    /**
     * Live guardrails semaphore owner (configurable-task-slots 5.3): a
     * successful `maxConcurrentTasks` save is pushed here synchronously after
     * the upsert so the new ceiling takes effect without a process restart.
     */
    private readonly guardrails: GuardrailsService,
  ) {}

  /**
   * 7.2 — Reads the current allowlisted account's preferences, scoped to that
   * account. `allowedAccount` is the read-only OAuth-sourced display identity
   * (the GitHub login), never stored; the rest comes from the account's own
   * stored row, or the documented defaults when nothing has been saved.
   *
   * Additionally surfaces the SYSTEM-LEVEL `maxConcurrentTasks` (5.1) resolved
   * from the single shared `SystemSettings` row — the same value for every
   * operator — falling back to the env seed / default when no row exists.
   */
  async readSettings(operator: SessionUser): Promise<AccountSettings> {
    const userId = await this.requireUserId(operator);
    const row = await this.prisma.accountSettings.findUnique({ where: { userId } });
    const stored: StoredAccountPrefs | null = row
      ? {
          defaultRepoId: row.defaultRepoId,
          retention: this.coerceRetention(row.retention),
          writeConfirm: row.writeConfirm,
        }
      : null;
    return AccountSettingsSchema.parse(
      resolveAccountSettings(
        this.displayAccount(operator),
        stored,
        await this.readSystemCeiling(),
      ),
    );
  }

  /**
   * 7.3 — Updates the account's writable preferences and returns the updated
   * sanitized settings. A supplied `defaultRepoId` MUST reference a repo the
   * account has imported/can see (un-imported is rejected 4xx WITHOUT mutating
   * anything); `null` clears it. The read-only `allowedAccount` is not present
   * in the body and cannot be changed here.
   *
   * configurable-task-slots 5.1–5.3 — a supplied `maxConcurrentTasks` is the
   * SYSTEM-LEVEL slot ceiling: validated against the shared contracts range
   * (1–20, enforced by the route's `UpdateSettingsRequestSchema` pipe and
   * re-checked here) BEFORE any write, persisted via fixed-id upsert on the
   * single `SystemSettings` row, then pushed synchronously into the live
   * guardrails semaphore so the save takes effect without a restart. An
   * invalid value is rejected 400 and mutates neither the stored value nor
   * the live ceiling.
   */
  async updateSettings(
    operator: SessionUser,
    patch: UpdateSettingsRequest,
  ): Promise<AccountSettings> {
    // Slot-ceiling guard (5.2): the controller pipe already rejects an
    // out-of-range/non-integer body with 400 before this method runs; this
    // re-check keeps "invalid mutates nothing" true for any non-HTTP caller.
    if (
      patch.maxConcurrentTasks !== undefined &&
      !isValidMaxConcurrentTasks(patch.maxConcurrentTasks)
    ) {
      throw new BadRequestException({
        error: 'invalid_max_concurrent_tasks',
        message: 'maxConcurrentTasks must be an integer between 1 and 20.',
      });
    }

    const userId = await this.requireUserId(operator);
    const existing = await this.prisma.accountSettings.findUnique({ where: { userId } });
    const current: StoredAccountPrefs = existing
      ? {
          defaultRepoId: existing.defaultRepoId,
          retention: this.coerceRetention(existing.retention),
          writeConfirm: existing.writeConfirm,
        }
      : {
          defaultRepoId: null,
          retention: DEFAULT_RETENTION_DAYS,
          writeConfirm: DEFAULT_WRITE_CONFIRM,
        };

    // default-must-be-imported (7.3): reject an un-imported target with 4xx and
    // mutate nothing.
    const importedRepoIds = await this.loadImportedRepoIds();
    const decision = validateDefaultRepoSelection(
      patch.defaultRepoId,
      importedRepoIds,
      current.defaultRepoId,
    );
    if (!decision.ok) {
      throw new BadRequestException({
        error: 'repo_not_imported',
        message:
          'defaultRepoId must reference a repo this account has imported; ' +
          'the supplied repo is not imported/visible.',
      });
    }

    const next = applySettingsUpdate(current, patch, decision.defaultRepoId);
    await this.prisma.accountSettings.upsert({
      where: { userId },
      create: {
        userId,
        defaultRepoId: next.defaultRepoId,
        retention: next.retention,
        writeConfirm: next.writeConfirm,
      },
      update: {
        defaultRepoId: next.defaultRepoId,
        retention: next.retention,
        writeConfirm: next.writeConfirm,
      },
    });

    // System-level slot ceiling (5.1/5.3): persist on the single fixed-id row
    // shared by every account, then push the new value SYNCHRONOUSLY into the
    // live semaphore — read-back-after-write and immediate effect, no restart.
    // A push failure surfaces as a 5xx here; bootstrap reloads the persisted
    // value on the next restart, restoring DB/live consistency.
    let effectiveCeiling: number;
    if (patch.maxConcurrentTasks !== undefined) {
      effectiveCeiling = patch.maxConcurrentTasks;
      await this.prisma.systemSettings.upsert({
        where: { id: SYSTEM_SETTINGS_ROW_ID },
        create: {
          id: SYSTEM_SETTINGS_ROW_ID,
          maxConcurrentTasks: effectiveCeiling,
        },
        update: { maxConcurrentTasks: effectiveCeiling },
      });
      this.guardrails.setMaxConcurrentTasks(effectiveCeiling);
    } else {
      effectiveCeiling = await this.readSystemCeiling();
    }

    return AccountSettingsSchema.parse(
      resolveAccountSettings(this.displayAccount(operator), next, effectiveCeiling),
    );
  }

  /**
   * 7.4/7.5 — Reads the account's Codex execution credential as the secret-free
   * READ shape: active mode + connection state, with the API key represented
   * ONLY by `hasApiKey` + masked suffix (never the plaintext, never ciphertext).
   */
  async readCredential(operator: SessionUser): Promise<CodexCredential> {
    const userId = await this.requireUserId(operator);
    const row = await this.prisma.codexCredential.findUnique({ where: { userId } });
    const facts: StoredCredentialFacts | null = row
      ? {
          mode: row.mode === 'compatible' ? 'compatible' : 'official',
          baseUrl: row.baseUrl,
          hasApiKey: row.apiKeyCiphertext !== null && row.apiKeyCiphertext.length > 0,
          apiKeyLast4: row.apiKeyLast4,
          defaultModel: row.defaultModel,
          hasAuthJson:
            row.authJsonCiphertext !== null && row.authJsonCiphertext.length > 0,
          // Surface the state PERSISTED at save time so compatible `connected`
          // (which is written only after a successful validation probe, design
          // D5) is not re-derived from field presence on read — a stored-but-
          // unvalidated row must read `not_saved`, never `connected`.
          persistedState:
            row.state === 'not_connected' ||
            row.state === 'not_saved' ||
            row.state === 'connected'
              ? row.state
              : null,
        }
      : null;
    // Official-mode "connected" now means a ChatGPT login (auth.json) is actually
    // stored — not merely that an official row exists — so the sandbox provider
    // has real material to inject. A bare official row with no auth.json reads as
    // not_connected.
    const officialConnected = facts?.mode === 'official' && facts.hasAuthJson;
    return CodexCredentialSchema.parse(
      projectCredentialRead(facts, officialConnected),
    );
  }

  /**
   * 7.4/7.5 — Saves the Codex credential, enforcing the two MUTUALLY-EXCLUSIVE
   * modes (switching is explicit and clears the other mode's fields). For a
   * compatible-mode key, the plaintext is encrypted at rest with AES-256-GCM;
   * with no server key configured this FAILS CLOSED (no row written). Returns
   * the secret-free read shape.
   */
  async saveCredential(
    operator: SessionUser,
    request: SaveCodexCredentialRequest,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<CodexCredential> {
    const userId = await this.requireUserId(operator);

    // Task 2.3: a compatible-provider save REQUIRES a non-null base URL. Reject
    // it here BEFORE any read/write so a compatible credential is never persisted
    // without a reachable, SSRF-validatable provider endpoint. (The contract's
    // `SaveCodexCredentialRequestSchema.superRefine` already rejects this at the
    // pipe; this re-check fails closed for any caller that bypasses the pipe.)
    if (request.mode === 'compatible' && !request.baseUrl) {
      throw new BadRequestException({
        code: 'compatible_base_url_required',
        message: 'A compatible-provider save requires a base URL.',
      });
    }

    const existing = await this.prisma.codexCredential.findUnique({ where: { userId } });
    const previous: StoredCredentialFacts | null = existing
      ? {
          mode: existing.mode === 'compatible' ? 'compatible' : 'official',
          baseUrl: existing.baseUrl,
          hasApiKey:
            existing.apiKeyCiphertext !== null && existing.apiKeyCiphertext.length > 0,
          apiKeyLast4: existing.apiKeyLast4,
          defaultModel: existing.defaultModel,
          hasAuthJson:
            existing.authJsonCiphertext !== null && existing.authJsonCiphertext.length > 0,
          // Not consumed by projectCredentialSave (which re-derives the next state
          // from the probe), but required by the shared facts shape.
          persistedState:
            existing.state === 'not_connected' ||
            existing.state === 'not_saved' ||
            existing.state === 'connected'
              ? existing.state
              : null,
        }
      : null;

    const plan = projectCredentialSave(
      {
        mode: request.mode,
        baseUrl: request.baseUrl,
        defaultModel: request.defaultModel,
        hasNewKey: typeof request.apiKey === 'string' && request.apiKey.length > 0,
        hasNewAuthJson:
          typeof request.authJson === 'string' && request.authJson.length > 0,
      },
      previous,
    );

    // Encrypt a plaintext secret into the joined `ciphertext.iv.authTag` storage
    // string, resolving the server key per replace. FAIL CLOSED when no server
    // key is configured — persist nothing (a secret is never stored unencrypted).
    const encryptToStored = (plaintext: string): string => {
      let envelope: { ciphertext: string; iv: string; authTag: string };
      try {
        const key = resolveEncryptionKey(env[CODEX_CRED_ENC_KEY_ENV]);
        envelope = encryptSecret(plaintext, key);
      } catch (error) {
        if (error instanceof EncryptionKeyUnavailableError) {
          throw new InternalServerErrorException({
            error: 'encryption_key_unavailable',
            message: error.message,
          });
        }
        throw error;
      }
      return `${envelope.ciphertext}.${envelope.iv}.${envelope.authTag}`;
    };

    // Resolve the compatible apiKey fields for the planned action.
    let apiKeyCiphertext: string | null;
    let apiKeyLast4: string | null;
    if (plan.keyAction === 'clear') {
      apiKeyCiphertext = null;
      apiKeyLast4 = null;
    } else if (plan.keyAction === 'keep') {
      apiKeyCiphertext = existing?.apiKeyCiphertext ?? null;
      apiKeyLast4 = existing?.apiKeyLast4 ?? null;
    } else {
      const plaintext = request.apiKey as string;
      apiKeyCiphertext = encryptToStored(plaintext);
      apiKeyLast4 = maskApiKeySuffix(plaintext);
    }

    // Resolve the OFFICIAL ChatGPT auth.json field — encrypted at rest exactly
    // like the apiKey, so the sandbox provider can decrypt + inject it per task
    // (replacing the deployment-level env var). Only presence is ever read back.
    let authJsonCiphertext: string | null;
    if (plan.authJsonAction === 'clear') {
      authJsonCiphertext = null;
    } else if (plan.authJsonAction === 'keep') {
      authJsonCiphertext = existing?.authJsonCiphertext ?? null;
    } else {
      authJsonCiphertext = encryptToStored(request.authJson as string);
    }

    // Connection state derivation (wire-compatible-provider-execution, task 2.4
    // / design D5): for compatible mode, `connected` means VALIDATED — the saved
    // base URL + key must pass a live discovery probe (and the selected default
    // model, when present, must be in the reported list) — NOT merely that a
    // base URL and key are present. Field presence without a successful probe
    // reads as `not_saved`, so "failed discovery does not mark connected" holds.
    let state: 'not_connected' | 'not_saved' | 'connected';
    if (plan.mode === 'official') {
      state = authJsonCiphertext ? 'connected' : 'not_connected';
    } else if (plan.baseUrl && apiKeyCiphertext) {
      const probeKey = this.resolveCompatibleProbeKey(
        plan.keyAction,
        request.apiKey,
        existing?.apiKeyCiphertext ?? null,
        env,
      );
      const validated = probeKey
        ? await this.validateCompatibleProvider(
            plan.baseUrl,
            probeKey,
            plan.defaultModel,
          )
        : false;
      state = validated ? 'connected' : 'not_saved';
    } else if (plan.baseUrl || apiKeyCiphertext) {
      state = 'not_saved';
    } else {
      state = 'not_connected';
    }

    await this.prisma.codexCredential.upsert({
      where: { userId },
      create: {
        userId,
        mode: plan.mode,
        state,
        baseUrl: plan.baseUrl,
        apiKeyCiphertext,
        apiKeyLast4,
        defaultModel: plan.defaultModel,
        authJsonCiphertext,
      },
      update: {
        mode: plan.mode,
        state,
        baseUrl: plan.baseUrl,
        apiKeyCiphertext,
        apiKeyLast4,
        defaultModel: plan.defaultModel,
        authJsonCiphertext,
      },
    });

    return this.readCredential(operator);
  }

  /**
   * 7.6 — Discovers the models a CANDIDATE compatible provider exposes, using a
   * base URL + key WITHOUT persisting anything first, so a candidate can be
   * validated before save. Surfaces provider errors distinguishably (auth vs
   * unreachable vs malformed) via the client classifier. Session-gated by the
   * controller; the operator principal is required to scope the action to a real
   * account even though nothing is persisted.
   */
  async discoverModels(
    operator: SessionUser,
    baseUrl: string,
    apiKey: string,
  ): Promise<ModelDiscoveryResult> {
    await this.requireUserId(operator);
    return this.modelDiscovery.discover(baseUrl, apiKey);
  }

  // ----- internals -----------------------------------------------------------

  /**
   * Resolves the PLAINTEXT compatible API key to probe with on save (task 2.4):
   *   - `replace` ⇒ the freshly supplied request key;
   *   - `keep`    ⇒ decrypt the previously stored ciphertext (a same-mode re-save
   *                 with no new key still re-validates the carried-over key);
   *   - `clear`   ⇒ no key (returns null).
   * A decrypt failure (missing/rotated server key, tampered row) yields null so
   * the save degrades to `not_saved` rather than throwing — the credential is
   * simply not validated.
   */
  private resolveCompatibleProbeKey(
    keyAction: 'clear' | 'keep' | 'replace',
    requestApiKey: string | undefined,
    existingCiphertext: string | null,
    env: NodeJS.ProcessEnv,
  ): string | null {
    if (keyAction === 'replace') {
      return typeof requestApiKey === 'string' && requestApiKey.length > 0
        ? requestApiKey
        : null;
    }
    if (keyAction === 'keep' && existingCiphertext) {
      const envelope = this.parseStoredSecret(existingCiphertext);
      if (!envelope) {
        return null;
      }
      try {
        const key = resolveEncryptionKey(env[CODEX_CRED_ENC_KEY_ENV]);
        return decryptSecret(envelope, key);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Splits the joined `ciphertext.iv.authTag` storage string into an envelope. */
  private parseStoredSecret(stored: string): EncryptedSecret | null {
    const parts = stored.split('.');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      return null;
    }
    const [ciphertext, iv, authTag] = parts;
    return { ciphertext, iv, authTag };
  }

  /**
   * Re-probes a compatible provider on save (task 2.4 / design D5) so
   * `connected` means VALIDATED. Returns true ONLY when the provider's
   * `/models` discovery succeeds AND — when a default model was selected — that
   * model appears in the reported list. An auth/unreachable/blocked/malformed
   * outcome, or a default model not offered by the provider, returns false (the
   * save is persisted but reads as `not_saved`). The SSRF guard inside the
   * discovery client also rejects an unsafe base URL here, so a compatible save
   * can never validate against an internal host.
   */
  private async validateCompatibleProvider(
    baseUrl: string,
    apiKey: string,
    defaultModel: string | null,
  ): Promise<boolean> {
    const result = await this.modelDiscovery.discover(baseUrl, apiKey);
    if (!result.ok) {
      return false;
    }
    if (defaultModel && !result.models.includes(defaultModel)) {
      return false;
    }
    return true;
  }

  /**
   * Reads the effective SYSTEM-LEVEL slot ceiling (configurable-task-slots
   * 5.1): the single fixed-id `SystemSettings` row when one has been persisted,
   * else the env `MAX_CONCURRENT_TASKS` seed, else the default 5 — i.e.
   * `dbSetting ?? envDefault ?? 5`. The row is shared by every operator, so
   * all accounts read the same value.
   */
  private async readSystemCeiling(): Promise<number> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { id: SYSTEM_SETTINGS_ROW_ID },
    });
    return resolveMaxConcurrentTasks(
      row?.maxConcurrentTasks ?? null,
      process.env.MAX_CONCURRENT_TASKS,
    );
  }

  /**
   * Resolves the OWNING user row id from the operator principal's immutable
   * numeric `githubId` — the single per-account scoping key. A principal with no
   * GitHub identity (the legacy shared-token operator) has no per-account
   * settings, so it is rejected here rather than silently reading/writing a
   * shared row.
   */
  private async requireUserId(operator: SessionUser): Promise<string> {
    const githubId = operator?.githubId;
    if (typeof githubId !== 'number') {
      throw new BadRequestException({
        error: 'account_scope_required',
        message:
          'Account settings are per-account and require a GitHub-identity ' +
          'operator session.',
      });
    }
    const user = await this.prisma.user.findUnique({
      where: { githubId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException(`No account record for githubId ${githubId}`);
    }
    return user.id;
  }

  /** The read-only display identity for `allowedAccount`, sourced from OAuth. */
  private displayAccount(operator: SessionUser): string {
    return operator.login;
  }

  /** Loads the set of imported repo ids (a non-null githubId) for default validation. */
  private async loadImportedRepoIds(): Promise<Set<string>> {
    const rows = await this.prisma.repo.findMany({
      where: { githubId: { not: null } },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Narrows a stored retention int to the contracts {@link RetentionDays} union,
   * falling back to the default when a legacy/out-of-range value is encountered
   * so a read never throws on historical data.
   */
  private coerceRetention(value: number): RetentionDays {
    return value === 7 || value === 30 || value === 90 || value === 180
      ? (value as RetentionDays)
      : DEFAULT_RETENTION_DAYS;
  }
}
