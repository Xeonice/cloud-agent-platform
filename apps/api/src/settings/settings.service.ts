import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  AccountSettingsSchema,
  ClaudeCredentialSchema,
  CodexCredentialSchema,
  DEFAULT_MCP_SERVER_ENABLED,
  McpServerSettingsSchema,
  type AccountSettings,
  type ClaudeCredential,
  type CodexCredential,
  type McpServerSettings,
  type RetentionDays,
  type SaveClaudeCredentialRequest,
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
import { ClaudeCredentialProbe } from './claude-credential-probe';
import {
  applySettingsUpdate,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_WRITE_CONFIRM,
  isValidMaxConcurrentTasks,
  projectCredentialRead,
  projectCredentialSave,
  resolveAccountSettings,
  resolveMaxConcurrentTasks,
  validateDefaultSandboxEnvironmentSelection,
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
    /**
     * Save-time Claude credential verification probe
     * (fix-claude-onboarding-and-token-verify): a newly pasted secret must
     * survive a live Anthropic auth check before it can reach `connected`.
     */
    private readonly claudeProbe: ClaudeCredentialProbe,
  ) {}

  /**
   * 7.2 — Reads the current account's preferences, scoped to that account.
   * `allowedAccount` is the read-only session-sourced display identity, never
   * stored; the rest comes from the account's own
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
          defaultSandboxEnvironmentId: row.defaultSandboxEnvironmentId,
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
          defaultSandboxEnvironmentId: existing.defaultSandboxEnvironmentId,
          retention: this.coerceRetention(existing.retention),
          writeConfirm: existing.writeConfirm,
        }
      : {
          defaultRepoId: null,
          defaultSandboxEnvironmentId: null,
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

    const environmentDecision = validateDefaultSandboxEnvironmentSelection(
      patch.defaultSandboxEnvironmentId,
      await this.loadReadySandboxEnvironmentIds(),
      current.defaultSandboxEnvironmentId,
    );
    if (!environmentDecision.ok) {
      throw new BadRequestException({
        error: 'sandbox_environment_not_selectable',
        message:
          'defaultSandboxEnvironmentId must reference a ready sandbox environment; ' +
          'the supplied environment is missing, failed, stale, or not selectable.',
      });
    }

    const next = applySettingsUpdate(
      current,
      patch,
      decision.defaultRepoId,
      environmentDecision.defaultSandboxEnvironmentId,
    );
    await this.prisma.accountSettings.upsert({
      where: { userId },
      create: {
        userId,
        defaultRepoId: next.defaultRepoId,
        defaultSandboxEnvironmentId: next.defaultSandboxEnvironmentId,
        retention: next.retention,
        writeConfirm: next.writeConfirm,
      },
      update: {
        defaultRepoId: next.defaultRepoId,
        defaultSandboxEnvironmentId: next.defaultSandboxEnvironmentId,
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

    // The write above is the commit boundary. Build the secret-free response
    // from the exact persisted projection instead of issuing a second database
    // read that could fail after commit and make callers believe the previous
    // credential was preserved when the new one was already stored.
    return CodexCredentialSchema.parse(
      projectCredentialRead(
        {
          mode: plan.mode,
          baseUrl: plan.baseUrl,
          hasApiKey: apiKeyCiphertext !== null && apiKeyCiphertext.length > 0,
          apiKeyLast4,
          defaultModel: plan.defaultModel,
          hasAuthJson:
            authJsonCiphertext !== null && authJsonCiphertext.length > 0,
          persistedState: state,
        },
        plan.mode === 'official' && Boolean(authJsonCiphertext),
      ),
    );
  }

  /**
   * pixel-restore-console-to-od Track 3 — reads the account's Claude Code
   * runtime credential as the secret-free READ shape (mode + state + presence
   * booleans + masked suffixes). Neither the setup-token nor the API key is ever
   * returned; only their `*Last4` suffix is surfaced for display.
   */
  async readClaudeCredential(operator: SessionUser): Promise<ClaudeCredential> {
    const userId = await this.requireUserId(operator);
    const row = await this.prisma.claudeCredential.findUnique({
      where: { userId },
    });
    if (!row) {
      return ClaudeCredentialSchema.parse({
        mode: 'subscription',
        state: 'not_connected',
        hasSetupToken: false,
        hasApiKey: false,
      });
    }
    const persistedState =
      row.state === 'not_connected' ||
      row.state === 'not_saved' ||
      row.state === 'connected'
        ? row.state
        : 'not_connected';
    return ClaudeCredentialSchema.parse({
      mode: row.mode === 'api_key' ? 'api_key' : 'subscription',
      state: persistedState,
      hasSetupToken:
        row.setupTokenCiphertext !== null && row.setupTokenCiphertext.length > 0,
      setupTokenSuffix: row.setupTokenLast4,
      hasApiKey: row.apiKeyCiphertext !== null && row.apiKeyCiphertext.length > 0,
      apiKeySuffix: row.apiKeyLast4,
      defaultModel: row.defaultModel,
    });
  }

  /**
   * pixel-restore-console-to-od Track 3 — saves the Claude Code credential. The
   * two modes are MUTUALLY EXCLUSIVE: saving one clears the other mode's secret.
   * The active mode's secret is encrypted at rest (AES-256-GCM, reusing the
   * codex credential server key); with no server key configured this FAILS CLOSED
   * (no row written). Secrets are preserved-by-omission on a re-save of the same
   * mode. Returns the secret-free read shape.
   *
   * fix-claude-onboarding-and-token-verify — a NEWLY SUPPLIED secret is verified
   * against Anthropic BEFORE anything is persisted (a zero-cost auth-only probe,
   * single attempt): a definitive 401/403 rejection refuses the save with the
   * `claude_credential_rejected` error and leaves any prior credential state
   * untouched; an accepted probe persists as `connected` with
   * `verification: 'verified'`; an unreachable probe persists as `connected`
   * with `verification: 'indeterminate'` so restricted-egress self-hosts are
   * never blocked from saving. Preserved-by-omission re-saves (no new secret)
   * skip the probe — the stored secret was verified when first saved, and the
   * task-time output classifier remains the backstop.
   */
  async saveClaudeCredential(
    operator: SessionUser,
    request: SaveClaudeCredentialRequest,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ClaudeCredential> {
    const userId = await this.requireUserId(operator);
    const existing = await this.prisma.claudeCredential.findUnique({
      where: { userId },
    });

    // Verify a newly supplied active-mode secret before any persistence.
    const newSecret =
      request.mode === 'subscription' ? request.setupToken : request.apiKey;
    let verification: 'verified' | 'indeterminate' | undefined;
    if (typeof newSecret === 'string' && newSecret.length > 0) {
      const outcome = await this.claudeProbe.probe(request.mode, newSecret);
      if (outcome === 'rejected') {
        throw new BadRequestException({
          error: 'claude_credential_rejected',
          message:
            request.mode === 'subscription'
              ? 'Anthropic rejected this setup-token (authentication_error). Re-mint one with `claude setup-token` and paste it again.'
              : 'Anthropic rejected this API key (authentication_error). Check the key and paste it again.',
        });
      }
      verification = outcome === 'accepted' ? 'verified' : 'indeterminate';
    }

    // Encrypt a plaintext secret into the joined `ciphertext.iv.authTag` storage
    // string. FAIL CLOSED when no server key is configured — a secret is never
    // stored unencrypted.
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

    // Subscription secret (setup-token): set/keep in subscription mode, cleared
    // when the saved mode is api_key.
    let setupTokenCiphertext: string | null;
    let setupTokenLast4: string | null;
    if (request.mode === 'subscription') {
      if (typeof request.setupToken === 'string' && request.setupToken.length > 0) {
        setupTokenCiphertext = encryptToStored(request.setupToken);
        setupTokenLast4 = maskApiKeySuffix(request.setupToken);
      } else {
        setupTokenCiphertext = existing?.setupTokenCiphertext ?? null;
        setupTokenLast4 = existing?.setupTokenLast4 ?? null;
      }
    } else {
      setupTokenCiphertext = null;
      setupTokenLast4 = null;
    }

    // API-key secret (Anthropic key): set/keep in api_key mode, cleared when the
    // saved mode is subscription.
    let apiKeyCiphertext: string | null;
    let apiKeyLast4: string | null;
    if (request.mode === 'api_key') {
      if (typeof request.apiKey === 'string' && request.apiKey.length > 0) {
        apiKeyCiphertext = encryptToStored(request.apiKey);
        apiKeyLast4 = maskApiKeySuffix(request.apiKey);
      } else {
        apiKeyCiphertext = existing?.apiKeyCiphertext ?? null;
        apiKeyLast4 = existing?.apiKeyLast4 ?? null;
      }
    } else {
      apiKeyCiphertext = null;
      apiKeyLast4 = null;
    }

    const activeSecretStored =
      request.mode === 'subscription'
        ? Boolean(setupTokenCiphertext)
        : Boolean(apiKeyCiphertext);
    const state: 'not_connected' | 'connected' = activeSecretStored
      ? 'connected'
      : 'not_connected';
    const defaultModel = request.defaultModel ?? existing?.defaultModel ?? null;

    await this.prisma.claudeCredential.upsert({
      where: { userId },
      create: {
        userId,
        mode: request.mode,
        state,
        setupTokenCiphertext,
        setupTokenLast4,
        apiKeyCiphertext,
        apiKeyLast4,
        defaultModel,
      },
      update: {
        mode: request.mode,
        state,
        setupTokenCiphertext,
        setupTokenLast4,
        apiKeyCiphertext,
        apiKeyLast4,
        defaultModel,
      },
    });

    const saved = await this.readClaudeCredential(operator);
    return verification === undefined ? saved : { ...saved, verification };
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

  /**
   * remote-mcp-server 5.2 — Reads the SYSTEM-LEVEL `mcpServerEnabled` flag from
   * the single shared `SystemSettings` row (the same row that carries
   * `maxConcurrentTasks`). When no row has been persisted the flag resolves to
   * {@link DEFAULT_MCP_SERVER_ENABLED} (false) so the `/mcp` surface ships inert
   * until an operator deliberately enables it. This is an instance-wide flag, NOT
   * a per-account preference, so no operator scoping is applied here; the
   * controller admin-gates the read.
   */
  async readMcpServerSettings(): Promise<McpServerSettings> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { id: SYSTEM_SETTINGS_ROW_ID },
    });
    return McpServerSettingsSchema.parse({
      mcpServerEnabled: row?.mcpServerEnabled ?? DEFAULT_MCP_SERVER_ENABLED,
    });
  }

  /**
   * remote-mcp-server 5.2 — Persists the SYSTEM-LEVEL `mcpServerEnabled` flag via
   * the fixed-id upsert on the single `SystemSettings` row, beside
   * `maxConcurrentTasks`. The `update` branch touches ONLY the flag, leaving any
   * persisted concurrency ceiling intact; the `create` branch (first write to the
   * row) seeds `maxConcurrentTasks` from the effective env/default ceiling so a
   * fresh row carries the correct concurrency value rather than an arbitrary one.
   * Turning the flag off never deletes any minted token — it only stops new
   * `/mcp` use. The controller admin-gates the write; the value is read straight
   * from the request (no operator scoping — it is instance-wide).
   */
  async setMcpServerEnabled(enabled: boolean): Promise<McpServerSettings> {
    await this.prisma.systemSettings.upsert({
      where: { id: SYSTEM_SETTINGS_ROW_ID },
      create: {
        id: SYSTEM_SETTINGS_ROW_ID,
        maxConcurrentTasks: await this.readSystemCeiling(),
        mcpServerEnabled: enabled,
      },
      update: { mcpServerEnabled: enabled },
    });
    return McpServerSettingsSchema.parse({ mcpServerEnabled: enabled });
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
   * Resolves the OWNING user row id from the operator principal — the single
   * per-account scoping key is the account primary key `operator.id`
   * (fix-local-account-settings-scope), which is present for BOTH local and GitHub
   * accounts. No GitHub identity is required and no reverse lookup is performed
   * (the credential/settings rows are already FK `User.id`).
   *
   * `account_scope_required` is retained ONLY as the defensive "no authenticated
   * account at all" case — an identity-less machine/legacy principal that has no
   * per-account settings. The controller's `requireOperator` already rejects a
   * null user, so this is belt-and-braces.
   */
  private requireUserId(operator: SessionUser): string {
    const userId = operator?.id;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new BadRequestException({
        error: 'account_scope_required',
        message: 'Account settings are per-account and require an authenticated account.',
      });
    }
    return userId;
  }

  /**
   * The read-only display identity for `allowedAccount`. For a legacy GitHub row
   * this is the stored login; a LOCAL account (password/OTP) has no github
   * handle (`login === null` — add-private-account-identity), so it falls back to
   * the always-present display name (which for a local account is its email).
   */
  private displayAccount(operator: SessionUser): string {
    return operator.login ?? operator.name;
  }

  /** Loads the set of imported repo ids (a non-null githubId) for default validation. */
  private async loadImportedRepoIds(): Promise<Set<string>> {
    const rows = await this.prisma.repo.findMany({
      where: { githubId: { not: null } },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** Loads ready sandbox environment ids selectable as a user default image. */
  private async loadReadySandboxEnvironmentIds(): Promise<Set<string>> {
    const rows = await this.prisma.sandboxEnvironment.findMany({
      where: { status: 'ready' },
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
