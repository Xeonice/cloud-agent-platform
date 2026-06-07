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
  TaskResponse,
  ImportRepoRequest,
  RepoResponse,
  SetDefaultRepoRequest,
  DefaultRepoResponse,
  UpdateSettingsRequest,
  AccountSettings,
  SaveCodexCredentialRequest,
  CodexCredential,
  AvailableGithubRepo,
} from "@cap/contracts";
import { isCapable } from "./capabilities";
import * as real from "./real";
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
 * (and the repo list when the default selection changed).
 */
export function saveSettingsMutation(
  queryClient: QueryClient,
): UseMutationOptions<AccountSettings | void, Error, UpdateSettingsRequest> {
  return {
    mutationFn: async (body) => {
      if (isCapable("settings")) {
        return real.saveSettings(body);
      }
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
          retention: body.retention ?? prev.settings.retention,
          writeConfirm: body.writeConfirm ?? prev.settings.writeConfirm,
        },
      }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.repos });
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
