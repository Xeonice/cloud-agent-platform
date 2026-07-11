/**
 * TanStack Query mutation factories (rebuild-console-tanstack-start D5.3;
 * task 10.5).
 *
 * Each factory takes the per-request `QueryClient` (from router context — never
 * a module singleton, D3.2) and returns `useMutation` options. `createTaskMutation`
 * is REAL today (`POST /repos/:repoId/tasks`). The import / set-default / save-
 * settings / save-credential mutations WRITE the local persisted store and then
 * `invalidateQueries` the affected keys, so the mock reads re-derive and the UI
 * re-renders — reproducing the prototype's read-state/render loop. As the real
 * endpoints land (and their capability flag flips), each `mutationFn` swaps its
 * store-write for the real POST/PUT with no change to the calling component.
 *
 * Invalidation always targets the SAME `queryKeys` the read factories register
 * under (queries.ts), so a real/mock flip never orphans an invalidation.
 */
import type { QueryClient, UseMutationOptions } from "@tanstack/react-query";
import type {
  CreateTaskRequest,
  CreateRepoRequest,
  ConnectForgeCredentialRequest,
  ForgeCredential,
  ForgeKind,
  TaskResponse,
  ImportRepoRequest,
  RepoResponse,
  SetDefaultRepoRequest,
  DefaultRepoResponse,
  UpdateSettingsRequest,
  AccountSettings,
  SaveCodexCredentialRequest,
  CodexCredential,
  SaveClaudeCredentialRequest,
  ClaudeCredential,
  AvailableGithubRepo,
  DiscoverModelsRequest,
  DiscoverModelsResponse,
  ApiKeyMintRequest,
  ApiKeyMintResponse,
  AdminAccountListItem,
  AdminCreateAccountRequest,
  Role,
  CreateSandboxEnvironmentRequest,
  SandboxEnvironmentResponse,
  ValidateSandboxEnvironmentResponse,
  CreateScheduleRequest,
  DispatchScheduleRequest,
  UpdateScheduleRequest,
  ScheduleResponse,
} from "@cap/contracts";
import { isCapable } from "./capabilities";
import * as real from "./real";
import * as mock from "./mock";
import type {
  SelfUpdateRequest,
  SelfUpdateAck,
  MintMcpTokenRequest,
  MintMcpTokenResponse,
  SmtpConfigRead,
  SaveSmtpConfigRequest,
  TestSmtpConfigRequest,
  TestSmtpConfigResponse,
} from "./real";
import { queryKeys } from "./queries";
import { setState, upsertImportedRepo } from "../store";

// ---------------------------------------------------------------------------
// Create task (REAL today)
// ---------------------------------------------------------------------------

/** Variables for {@link createTaskMutation}: the target repo + the create body. */
export interface CreateTaskVars {
  repoId: string;
  body: CreateTaskRequest;
}

/**
 * Create a task under a repo. REAL `POST /repos/:repoId/tasks`. On success
 * invalidates `['tasks']` so the dashboard queue re-fetches and shows the new
 * task. (`createTask` capability is `true`; there is no mock branch — the four
 * core endpoints are always real.)
 */
export function createTaskMutation(
  queryClient: QueryClient,
): UseMutationOptions<TaskResponse, Error, CreateTaskVars> {
  return {
    mutationFn: ({ repoId, body }) => real.createTask(repoId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  };
}

/**
 * Register a repo by gitSource + forge (the GitLab/Gitee picker + by-URL import
 * path, add-multi-forge-task-delivery). REAL today (`POST /repos`). Invalidates
 * the repo list so the new repo appears in the new-task form + the repo list.
 */
export function createRepoMutation(
  queryClient: QueryClient,
): UseMutationOptions<RepoResponse, Error, CreateRepoRequest> {
  return {
    mutationFn: (body) => real.createRepo(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repos });
    },
  };
}

/**
 * Connect a forge by pasting a PAT (the settings "code-hosting connection" card,
 * add-forge-credentials). REAL today (`PUT /settings/forges`). Invalidates the
 * connected-forges list so the card reflects the new connection.
 */
export function connectForgeMutation(
  queryClient: QueryClient,
): UseMutationOptions<ForgeCredential, Error, ConnectForgeCredentialRequest> {
  return {
    mutationFn: (body) => real.connectForge(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.forgeCredentials });
    },
  };
}

/** Disconnect a connected forge (`DELETE /settings/forges`). */
export function disconnectForgeMutation(
  queryClient: QueryClient,
): UseMutationOptions<void, Error, { kind: ForgeKind; host: string }> {
  return {
    mutationFn: ({ kind, host }) => real.disconnectForge(kind, host),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.forgeCredentials });
    },
  };
}

/**
 * Operator-initiated stop of a task (REAL `POST /tasks/:taskId/stop`,
 * task-guardrail-controls). The variable is the target task id. On success
 * reconciles the cached single-task entry AND the task list so the session view
 * and the dashboard queue both reflect the `cancelled` terminal. Like
 * `createTask`, this core endpoint is always real (no mock branch).
 */
export function stopTaskMutation(
  queryClient: QueryClient,
): UseMutationOptions<TaskResponse, Error, string> {
  return {
    mutationFn: (taskId) => real.stopTask(taskId),
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  };
}

export function createScheduleMutation(
  queryClient: QueryClient,
): UseMutationOptions<ScheduleResponse, Error, CreateScheduleRequest> {
  return {
    mutationFn: (body) => real.createSchedule(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  };
}

export function updateScheduleMutation(
  queryClient: QueryClient,
): UseMutationOptions<
  ScheduleResponse,
  Error,
  { id: string; body: UpdateScheduleRequest }
> {
  return {
    mutationFn: ({ id, body }) => real.updateSchedule(id, body),
    onSuccess: (schedule) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.scheduleRuns(schedule.id),
      });
    },
  };
}

export function pauseScheduleMutation(
  queryClient: QueryClient,
): UseMutationOptions<ScheduleResponse, Error, string> {
  return {
    mutationFn: (id) => real.pauseSchedule(id),
    onSuccess: (schedule) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.scheduleRuns(schedule.id),
      });
    },
  };
}

export function resumeScheduleMutation(
  queryClient: QueryClient,
): UseMutationOptions<ScheduleResponse, Error, string> {
  return {
    mutationFn: (id) => real.resumeSchedule(id),
    onSuccess: (schedule) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.scheduleRuns(schedule.id),
      });
    },
  };
}

export function dispatchScheduleMutation(
  queryClient: QueryClient,
): UseMutationOptions<
  ScheduleResponse,
  Error,
  { id: string; expectedPeriodKey?: DispatchScheduleRequest["expectedPeriodKey"] }
> {
  return {
    mutationFn: ({ id, expectedPeriodKey }) =>
      real.dispatchSchedule(id, expectedPeriodKey),
    onSuccess: (schedule) => {
      queryClient.setQueryData<ScheduleResponse[]>(queryKeys.schedules, (current) =>
        current?.map((item) => (item.id === schedule.id ? schedule : item)),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.schedules,
        exact: true,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.scheduleRuns(schedule.id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
    onError: async (error, { id }) => {
      if (!(error instanceof real.ApiError) || error.status !== 409) return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.schedules,
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.scheduleRuns(id),
        }),
      ]);
    },
  };
}

export function deleteScheduleMutation(
  queryClient: QueryClient,
): UseMutationOptions<void, Error, string> {
  return {
    mutationFn: (id) => real.deleteSchedule(id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      void queryClient.invalidateQueries({ queryKey: queryKeys.scheduleRuns(id) });
    },
  };
}

// ---------------------------------------------------------------------------
// API keys (api-key-machine-identity) — mint show-once / revoke
// ---------------------------------------------------------------------------

/**
 * Mint an API key (`POST /api-keys`). Resolves with the show-once raw key +
 * metadata — the SERVER's one-time response on the real seam (a fabricated mock
 * key only on the mock seam). On success invalidates `queryKeys.apiKeys` so the
 * settings card's list re-derives. Gated by `apiKeys`.
 */
export function mintApiKeyMutation(
  queryClient: QueryClient,
): UseMutationOptions<ApiKeyMintResponse, Error, ApiKeyMintRequest> {
  return {
    mutationFn: (body) =>
      isCapable("apiKeys") ? real.mintApiKey(body) : mock.mockMintApiKey(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  };
}

/**
 * Revoke an API key by id (`DELETE /api-keys/:id`, idempotent). Discards the
 * revoked view and invalidates `queryKeys.apiKeys` so the list reflects the
 * `revokedAt` timestamp. Gated by `apiKeys`.
 */
export function revokeApiKeyMutation(
  queryClient: QueryClient,
): UseMutationOptions<void, Error, string> {
  return {
    mutationFn: async (id) => {
      if (isCapable("apiKeys")) await real.revokeApiKey(id);
      else await mock.mockRevokeApiKey(id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  };
}

// ---------------------------------------------------------------------------
// Import repo (store-write today; real POST once githubImport flips)
// ---------------------------------------------------------------------------

/**
 * Import a GitHub repo into the platform. When `githubImport` is on, calls the
 * real import endpoint; otherwise writes the imported repo into the local store
 * (de-duplicated by id). Either way invalidates the repo list + GitHub list so
 * the repositories page reflects the new import.
 */
export function importRepoMutation(
  queryClient: QueryClient,
): UseMutationOptions<RepoResponse | void, Error, AvailableGithubRepo> {
  return {
    mutationFn: async (repo) => {
      if (isCapable("githubImport")) {
        const body: ImportRepoRequest = {
          id: repo.id,
          full_name: repo.full_name,
          defaultBranch: repo.defaultBranch,
          description: repo.description ?? null,
        };
        return real.importRepo(body);
      }
      // Mock path: persist into the local imported set (unique by id).
      setState((prev) => ({
        importedRepos: upsertImportedRepo(prev.importedRepos, {
          // Stand-in platform id derived from the GitHub numeric id (stable,
          // uuid-shaped) so dedup and default-selection are deterministic.
          id: githubIdToRepoId(repo.id),
          name: repo.name,
          fullName: repo.full_name,
          defaultBranch: repo.defaultBranch,
          description: repo.description ?? null,
        }),
        githubConnected: true,
      }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repos });
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubRepos });
    },
  };
}

// ---------------------------------------------------------------------------
// Set default repo (store-write today; real POST once githubImport flips)
// ---------------------------------------------------------------------------

/**
 * Designate one imported repo as the default (at most one ever). Real
 * `POST /repos/default` when capable; else writes `selectedRepo` +
 * `settings.defaultRepoId` to the store. Invalidates the repo list, the default,
 * and settings so every default-aware view re-derives.
 */
export function setDefaultRepoMutation(
  queryClient: QueryClient,
): UseMutationOptions<DefaultRepoResponse | void, Error, SetDefaultRepoRequest> {
  return {
    mutationFn: async ({ repoId }) => {
      if (isCapable("githubImport")) {
        return real.setDefaultRepo({ repoId });
      }
      setState((prev) => ({
        selectedRepo: repoId,
        settings: { ...prev.settings, defaultRepoId: repoId },
      }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repos });
      void queryClient.invalidateQueries({ queryKey: queryKeys.defaultRepo });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  };
}

// ---------------------------------------------------------------------------
// Save settings (store-write today; real PATCH once settings flips)
// ---------------------------------------------------------------------------

/**
 * Update writable account preferences. Real `PATCH /settings` when capable; else
 * merges the supplied keys into the store `settings` draft. Invalidates settings
 * (and the repo list when the default selection changed), PLUS the metrics key:
 * a saved system-level slot ceiling (`maxConcurrentTasks`) must reflect on the
 * dashboard capacity surfaces immediately, not after the next 5-second poll.
 */
export function saveSettingsMutation(
  queryClient: QueryClient,
): UseMutationOptions<AccountSettings | void, Error, UpdateSettingsRequest> {
  return {
    mutationFn: async (body) => {
      if (isCapable("settings")) {
        return real.saveSettings(body);
      }
      // Structural read: `maxConcurrentTasks` is optional on the wire.
      const ceiling = (body as { maxConcurrentTasks?: number })
        .maxConcurrentTasks;
      setState((prev) => ({
        selectedRepo:
          body.defaultRepoId !== undefined
            ? body.defaultRepoId
            : prev.selectedRepo,
        settings: {
          defaultRepoId:
            body.defaultRepoId !== undefined
              ? body.defaultRepoId
              : prev.settings.defaultRepoId,
          defaultSandboxEnvironmentId:
            body.defaultSandboxEnvironmentId !== undefined
              ? body.defaultSandboxEnvironmentId
              : prev.settings.defaultSandboxEnvironmentId,
          retention: body.retention ?? prev.settings.retention,
          writeConfirm: body.writeConfirm ?? prev.settings.writeConfirm,
          maxConcurrentTasks: ceiling ?? prev.settings.maxConcurrentTasks,
        },
      }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.repos });
      // Refresh capacity surfaces (slot meter, RUNNERS tile) before the next
      // 5s metrics poll so a changed slot ceiling shows up immediately.
      void queryClient.invalidateQueries({ queryKey: queryKeys.metrics });
    },
  };
}

export function createSandboxEnvironmentMutation(
  queryClient: QueryClient,
): UseMutationOptions<
  SandboxEnvironmentResponse,
  Error,
  CreateSandboxEnvironmentRequest
> {
  return {
    mutationFn: (body) =>
      isCapable("settings")
        ? real.createSandboxEnvironment(body)
        : mock.mockCreateSandboxEnvironment(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sandboxEnvironments });
    },
  };
}

export function validateSandboxEnvironmentMutation(
  queryClient: QueryClient,
): UseMutationOptions<ValidateSandboxEnvironmentResponse, Error, string> {
  return {
    mutationFn: (id) =>
      isCapable("settings")
        ? real.validateSandboxEnvironment(id)
        : mock.mockValidateSandboxEnvironment(id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sandboxEnvironments });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxEnvironmentValidations(id),
      });
    },
  };
}

export function setDefaultSandboxEnvironmentMutation(
  queryClient: QueryClient,
): UseMutationOptions<SandboxEnvironmentResponse, Error, string> {
  return {
    mutationFn: (id) =>
      isCapable("settings")
        ? real.setDefaultSandboxEnvironment(id)
        : mock.mockSetDefaultSandboxEnvironment(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sandboxEnvironments });
    },
  };
}

export function retireSandboxEnvironmentMutation(
  queryClient: QueryClient,
): UseMutationOptions<SandboxEnvironmentResponse, Error, string> {
  return {
    mutationFn: (id) =>
      isCapable("settings")
        ? real.retireSandboxEnvironment(id)
        : mock.mockRetireSandboxEnvironment(id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sandboxEnvironments });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sandboxEnvironmentValidations(id),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Save Codex credential (store-write today; real PUT once settings flips)
// ---------------------------------------------------------------------------

/**
 * Save the Codex execution credential. Real `PUT /settings/codex` when capable;
 * else writes a NON-SECRET projection into the store: the plaintext `apiKey` is
 * dropped (never persisted client-side), recorded only as `hasApiKey` + a masked
 * suffix, exactly as the read contract exposes. Invalidates the credential read.
 */
export function saveCodexCredentialMutation(
  queryClient: QueryClient,
): UseMutationOptions<CodexCredential | void, Error, SaveCodexCredentialRequest> {
  return {
    mutationFn: async (body) => {
      if (isCapable("settings")) {
        return real.saveCodexCredential(body);
      }
      setState({ codexCredential: projectCodexCredential(body) });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.codexCredential });
    },
  };
}

/**
 * Save the Claude Code execution credential. Real `PUT /settings/claude` when
 * capable; else writes a NON-SECRET projection into the store (the plaintext
 * setup-token / API key are dropped, recorded only as presence + masked suffix).
 */
export function saveClaudeCredentialMutation(
  queryClient: QueryClient,
): UseMutationOptions<
  ClaudeCredential | void,
  Error,
  SaveClaudeCredentialRequest
> {
  return {
    mutationFn: async (body) => {
      if (isCapable("settings")) {
        return real.saveClaudeCredential(body);
      }
      setState({ claudeCredential: projectClaudeCredential(body) });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.claudeCredential,
      });
    },
  };
}

/**
 * Project a write-only Claude save request into the NON-SECRET read shape (the
 * mock-store fallback): the active mode's secret presence + masked suffix, with
 * the OTHER mode's secret cleared (the modes are mutually exclusive).
 */
export function projectClaudeCredential(
  body: SaveClaudeCredentialRequest,
): ClaudeCredential {
  if (body.mode === "subscription") {
    const has = typeof body.setupToken === "string" && body.setupToken.length > 0;
    return {
      mode: "subscription",
      state: has ? "connected" : "not_connected",
      hasSetupToken: has,
      setupTokenSuffix: has && body.setupToken ? body.setupToken.slice(-4) : undefined,
      hasApiKey: false,
      apiKeySuffix: undefined,
      defaultModel: body.defaultModel ?? undefined,
    };
  }
  const has = typeof body.apiKey === "string" && body.apiKey.length > 0;
  return {
    mode: "api_key",
    state: has ? "connected" : "not_connected",
    hasSetupToken: false,
    setupTokenSuffix: undefined,
    hasApiKey: has,
    apiKeySuffix: has && body.apiKey ? body.apiKey.slice(-4) : undefined,
    defaultModel: body.defaultModel ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Discover compatible-provider models (REAL — probe before persist)
// ---------------------------------------------------------------------------

/**
 * Probe a CANDIDATE compatible provider for its available models
 * (`POST /settings/codex/models`, wire-compatible-provider-execution). The
 * variable is the operator-supplied `{baseUrl, apiKey}`; the api validates it
 * (SSRF guard + timeout + body bound) and reports the available model ids WITHOUT
 * persisting anything — so the dialog can populate its default-model picker from a
 * REAL probe and reflect the actual outcome class (success vs auth-failure vs
 * unreachable), rather than a hardcoded list or a client-side non-empty check.
 *
 * Like `createTask`/`stopTask`, this is ALWAYS real (no mock branch): discovery is
 * an imperative probe of an operator-supplied provider — there is no meaningful
 * mock outcome, and the dialog only invokes it while configuring a real compatible
 * credential. The `{ ok: false }` provider-level outcome resolves NORMALLY (it is
 * the probe's distinguishable result the dialog renders, not a thrown error); only
 * a transport/HTTP failure rejects.
 *
 * No cache is invalidated: the probe has no persistent read — its result feeds the
 * dialog's transient picker state directly. The credential read is invalidated
 * separately by `saveCodexCredentialMutation` once a probed credential is saved.
 */
export function discoverCodexModelsMutation(): UseMutationOptions<
  DiscoverModelsResponse,
  Error,
  DiscoverModelsRequest
> {
  return {
    mutationFn: (body) => real.discoverCodexModels(body),
  };
}

// ---------------------------------------------------------------------------
// Self-update (self-update-action, Phase 3) — gated, admin-confirmed upgrade
// ---------------------------------------------------------------------------

/**
 * Trigger the gated, bounded, host-root self-update (`POST /self-update`,
 * self-update-action). Real when `selfUpdate` is on (the api enforces the
 * `SELF_UPDATE_ENABLED` env gate + admin check + the target cross-check against
 * `/update-status` — design D1/D2/D3); the mock ack is used otherwise (the
 * shipped posture keeps `selfUpdate` off, so the banner hides the action and this
 * is never invoked). The variable is the validated target version the banner read
 * from `UpdateStatus.latestVersion` — never free-form client input.
 *
 * On success the api has launched the DETACHED updater and is about to recreate
 * itself (design D4), so we invalidate `updateStatus` (the cross-checked source)
 * so the banner re-derives once the new api is up and the WS reconnects; the
 * caller surfaces the "updating… reconnecting" state from the pending mutation.
 */
export function selfUpdateMutation(
  queryClient: QueryClient,
): UseMutationOptions<SelfUpdateAck, Error, SelfUpdateRequest> {
  return {
    mutationFn: (body) =>
      isCapable("selfUpdate")
        ? real.postSelfUpdate(body)
        : mock.mockPostSelfUpdate(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.updateStatus });
    },
  };
}

// ---------------------------------------------------------------------------
// MCP server (remote-mcp-server) — mint / revoke token + enable toggle
// ---------------------------------------------------------------------------

/**
 * Mint an MCP token (`POST /mcp-tokens` real, or the mock server stand-in). The
 * returned {@link MintMcpTokenResponse} carries the raw `mcp_…` token EXACTLY
 * ONCE — the SERVER's one-time response, never client-fabricated — which the card
 * surfaces transiently in its show-once dialog. On success invalidates the token
 * list so the new (non-secret) row appears. Rides the `mcpServer` seam.
 */
export function mintMcpTokenMutation(
  queryClient: QueryClient,
): UseMutationOptions<MintMcpTokenResponse, Error, MintMcpTokenRequest> {
  return {
    mutationFn: (body) =>
      isCapable("mcpServer") ? real.mintMcpToken(body) : mock.mockMintMcpToken(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcpTokens });
    },
  };
}

/**
 * Revoke an MCP token (`DELETE /mcp-tokens/:id` real, or mock). Idempotent. The
 * variable is the target token id. On success invalidates the token list so the
 * row re-derives into its revoked lifecycle state. Rides the `mcpServer` seam.
 */
export function revokeMcpTokenMutation(
  queryClient: QueryClient,
): UseMutationOptions<void, Error, string> {
  return {
    mutationFn: (id) =>
      isCapable("mcpServer") ? real.revokeMcpToken(id) : mock.mockRevokeMcpToken(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcpTokens });
    },
  };
}

/**
 * Flip the system-wide `mcpServerEnabled` flag (`PUT /settings/mcp-server` real,
 * or mock). The write is ADMIN-gated server-side — the card only renders the
 * toggle as operable for an admin session, and the api re-enforces a 403 for a
 * non-admin even if the affordance is forced (defense in depth). On success
 * invalidates the flag read so the toggle reflects the persisted state. Rides the
 * `mcpServer` seam.
 */
export function setMcpServerEnabledMutation(
  queryClient: QueryClient,
): UseMutationOptions<boolean, Error, boolean> {
  return {
    mutationFn: (enabled) =>
      isCapable("mcpServer")
        ? real.setMcpServerEnabled(enabled)
        : mock.mockSetMcpServerEnabled(enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mcpServerEnabled,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// SMTP configuration (add-smtp-config-ui) — admin-only save + test
// ---------------------------------------------------------------------------

/**
 * Save the SMTP config (`PUT /settings/smtp` real, or the mock store stand-in).
 * The write is ADMIN-gated server-side — the card only renders the management
 * controls for an admin session, and the api re-enforces a 403 for a non-admin
 * even if the affordance is forced (defense in depth). The plaintext API Key is
 * write-only (an empty `pass` keeps the stored key); the mock seam stores ONLY
 * the masked projection (the key is never persisted client-side).
 *
 * On success invalidates `queryKeys.smtpConfig` (so the card re-derives the
 * masked status) AND `queryKeys.authSession` — enabling SMTP via the UI flips
 * `otpAuthEnabled` true once the session capabilities re-resolve (design D7), so
 * the login modal offers email-OTP without an env change or reload. Rides the
 * `settings` seam.
 */
export function saveSmtpConfigMutation(
  queryClient: QueryClient,
): UseMutationOptions<SmtpConfigRead, Error, SaveSmtpConfigRequest> {
  return {
    mutationFn: (body) =>
      isCapable("settings")
        ? real.saveSmtpConfig(body)
        : mock.mockSaveSmtpConfig(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.smtpConfig });
      // Enabling SMTP advertises email-OTP availability (D7) — refresh the
      // session capabilities so the login methods re-resolve.
      void queryClient.invalidateQueries({ queryKey: queryKeys.authSession });
    },
  };
}

/**
 * Send a test email through the SUBMITTED (or saved) config to verify
 * connectivity BEFORE/independent of saving (`POST /settings/smtp/test` real, or
 * the mock stand-in). Admin-gated server-side; nothing is persisted on failure.
 * Resolves the discriminated `{ ok, message }` outcome the dialog's 发送测试 row
 * reflects — NEVER the password. No cache is invalidated: the test has no
 * persistent read (it feeds the dialog's transient status directly). Rides the
 * `settings` seam.
 */
export function testSmtpConfigMutation(): UseMutationOptions<
  TestSmtpConfigResponse,
  Error,
  TestSmtpConfigRequest
> {
  return {
    mutationFn: (body) =>
      isCapable("settings")
        ? real.testSmtpConfig(body)
        : mock.mockTestSmtpConfig(body),
  };
}

// ---------------------------------------------------------------------------
// Account administration (account-administration) — admin-only.
// Each writes through the real (admin-gated) endpoint or the mock store, then
// invalidates the account list so the table re-reads the source of truth. The api
// 403s a non-admin regardless of the UI affordance (defense in depth).
// ---------------------------------------------------------------------------

/** Create a local account (`POST /accounts`). */
export function createAdminAccountMutation(
  queryClient: QueryClient,
): UseMutationOptions<AdminAccountListItem, Error, AdminCreateAccountRequest> {
  return {
    mutationFn: (body) =>
      isCapable("accounts")
        ? real.createAdminAccount(body)
        : mock.mockCreateAdminAccount(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminAccounts });
    },
  };
}

/** Enable/disable any account (`PATCH /accounts/:id/enabled`). */
export function setAdminAccountEnabledMutation(
  queryClient: QueryClient,
): UseMutationOptions<
  AdminAccountListItem,
  Error,
  { id: string; allowed: boolean }
> {
  return {
    mutationFn: ({ id, allowed }) =>
      isCapable("accounts")
        ? real.setAdminAccountEnabled(id, allowed)
        : mock.mockSetAdminAccountEnabled(id, allowed),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminAccounts });
    },
  };
}

/** Reset a local account's password (`PATCH /accounts/:id/password`). */
export function resetAdminAccountPasswordMutation(
  queryClient: QueryClient,
): UseMutationOptions<
  AdminAccountListItem,
  Error,
  { id: string; password: string }
> {
  return {
    mutationFn: ({ id, password }) =>
      isCapable("accounts")
        ? real.resetAdminAccountPassword(id, password)
        : mock.mockResetAdminAccountPassword(id, password),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminAccounts });
    },
  };
}

/** Assign an account's role (`PATCH /accounts/:id/role`). */
export function setAdminAccountRoleMutation(
  queryClient: QueryClient,
): UseMutationOptions<AdminAccountListItem, Error, { id: string; role: Role }> {
  return {
    mutationFn: ({ id, role }) =>
      isCapable("accounts")
        ? real.setAdminAccountRole(id, role)
        : mock.mockSetAdminAccountRole(id, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminAccounts });
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable; no QueryClient, no store)
// ---------------------------------------------------------------------------

/**
 * Derive a stable, uuid-shaped platform repo id from a GitHub numeric id, so a
 * mock import dedups deterministically against repeat imports of the same repo.
 * PURE.
 */
export function githubIdToRepoId(githubId: number): string {
  // Derive a deterministic, syntactically valid UUID v4 from the GitHub numeric
  // id so mock-imported repos are stable and dedup-safe. The full 128-bit value
  // is produced by zero-padding the id's hex representation into 32 nibbles,
  // then fixing nibble 12 to "4" (version) and forcing nibble 16 into the
  // variant-1 range (8–b) so `z.string().uuid()` accepts it end-to-end.
  const raw = githubId.toString(16).padStart(32, "0").slice(-32);
  // Replace version nibble (position 12) with '4', variant nibble (position 16)
  // with '8' (0b1000 — variant 1, MSB preserved as 0).
  const r =
    raw.slice(0, 12) +
    "4" +
    raw.slice(13, 16) +
    "8" +
    raw.slice(17);
  return `${r.slice(0, 8)}-${r.slice(8, 12)}-${r.slice(12, 16)}-${r.slice(16, 20)}-${r.slice(20)}`;
}

/**
 * Project a write-only save request into the NON-SECRET `CodexCredential` read
 * shape the store persists: the plaintext key is dropped and recorded only as
 * `hasApiKey` + a masked suffix. PURE — the central secret-discipline rule, so
 * it is unit-testable in isolation ("apiKey never persisted as plaintext").
 */
export function projectCodexCredential(
  body: SaveCodexCredentialRequest,
): CodexCredential {
  const hasApiKey = typeof body.apiKey === "string" && body.apiKey.length > 0;
  const apiKeySuffix =
    hasApiKey && body.apiKey ? body.apiKey.slice(-4) : undefined;
  if (body.mode === "official") {
    // Official "connected" now means a ChatGPT login (authJson) was actually
    // supplied — mirrors the backend, which only marks connected once the
    // encrypted auth.json is stored. (A re-save with no new authJson preserves a
    // prior login server-side; the mock has no prior state so treats it as kept.)
    const hasAuthJson = typeof body.authJson === "string" && body.authJson.length > 0;
    return {
      mode: "official",
      state: hasAuthJson ? "connected" : "not_connected",
      hasApiKey: false,
      apiKeySuffix: undefined,
    };
  }
  // compatible: a base URL but no key yet is "not_saved"; key present is connected.
  const state = hasApiKey ? "connected" : body.baseUrl ? "not_saved" : "not_connected";
  return {
    mode: "compatible",
    state,
    baseUrl: body.baseUrl ?? null,
    hasApiKey,
    apiKeySuffix,
    defaultModel: body.defaultModel ?? null,
  };
}
