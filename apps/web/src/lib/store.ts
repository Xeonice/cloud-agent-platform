/**
 * Lightweight persisted UI store (rebuild-console-tanstack-start D5.3; task 10.6).
 *
 * Holds the WRITABLE client-side UI state the prototype kept in `localStorage`:
 * GitHub connection flag, the imported-repo set, the selected/default repo, the
 * account settings draft, and the Codex credential draft. Mutations (10.5) write
 * this store and then `invalidateQueries` so the affected queries re-derive and
 * re-render — reproducing the prototype's read-state/render loop. As real
 * endpoints land, those mutations become real POST/PUTs and these slices become
 * server-derived; until then the store is the source of truth for mock reads.
 *
 * Implemented with `useSyncExternalStore` + `localStorage` (no store dependency
 * added). It is intentionally tiny: a single snapshot object, a subscriber set,
 * and a `localStorage`-backed read/write. SSR-safe: the server snapshot is the
 * in-memory default (never touches `window`), and hydration reads `localStorage`
 * once on the client.
 *
 * KEY DISCIPLINE: the persistence key REUSES the prototype's
 * `agent-control-plane-state` (research-brief risk #12), so a malformed or
 * stale stored shape is defensively normalized on load (unknown keys dropped,
 * imported set de-duplicated by repo id, at most one default) rather than
 * trusted verbatim.
 */
import { useSyncExternalStore } from "react";
import type { CodexCredential, RetentionDays } from "@cap/contracts";

/** The `localStorage` key, reused from the prototype (research-brief risk #12). */
export const STORE_KEY = "agent-control-plane-state";

/**
 * A repo the operator has imported into the platform, as held in local UI
 * state. Mirrors the fields the prototype's import flow tracked; once the real
 * import endpoint is wired this is replaced by the server `Repo` list.
 */
export interface ImportedRepo {
  /** Platform repo id (uuid) once imported, or the GitHub slug as a stand-in. */
  id: string;
  /** Display name (`owner/name` or short name). */
  name: string;
  /** Canonical `owner/name` slug, the de-duplication key. */
  fullName: string;
  /** GitHub default branch captured at import time. */
  defaultBranch: string;
  /** GitHub description, when one was reported. */
  description?: string | null;
}

/** The settings slice the prototype let the operator edit locally. */
export interface SettingsDraft {
  /** Selected default repo id (FK into `importedRepos`), or null when unset. */
  defaultRepoId: string | null;
  /** Audit/history retention window in days. */
  retention: RetentionDays;
  /** Destructive-write gate ("破坏性写入前停止"). */
  writeConfirm: boolean;
}

/** The full persisted store shape. */
export interface PersistedState {
  /** Whether the operator has connected GitHub (mock OAuth handshake). */
  githubConnected: boolean;
  /** The set of repos imported into the platform (de-duplicated by `id`). */
  importedRepos: ImportedRepo[];
  /** The currently selected/default repo id, or null. */
  selectedRepo: string | null;
  /** The editable account-settings draft. */
  settings: SettingsDraft;
  /** The Codex execution-credential draft (never holds a plaintext key). */
  codexCredential: CodexCredential;
}

/** The default snapshot used on the server and as the first-load baseline. */
export const DEFAULT_STATE: PersistedState = {
  githubConnected: false,
  importedRepos: [],
  selectedRepo: null,
  settings: {
    defaultRepoId: null,
    retention: 30,
    writeConfirm: true,
  },
  codexCredential: {
    mode: "official",
    state: "not_connected",
    hasApiKey: false,
  },
};

// ---------------------------------------------------------------------------
// Pure normalization (unit-testable; no `window`, no React)
// ---------------------------------------------------------------------------

const RETENTION_VALUES: readonly RetentionDays[] = [7, 30, 90, 180];

/** Coerce an arbitrary value to a valid `RetentionDays`, falling back to 30. */
function normalizeRetention(value: unknown): RetentionDays {
  return RETENTION_VALUES.includes(value as RetentionDays)
    ? (value as RetentionDays)
    : 30;
}

/**
 * Defensively normalize an unknown (possibly stale prototype) stored value into
 * a valid {@link PersistedState}: unknown keys are dropped, the imported set is
 * de-duplicated by `id` (first occurrence wins), and `selectedRepo` is cleared
 * unless it still points at an imported repo so "unique default" holds. PURE —
 * safe to unit-test directly.
 */
export function normalizeState(raw: unknown): PersistedState {
  if (typeof raw !== "object" || raw === null) return DEFAULT_STATE;
  const r = raw as Record<string, unknown>;

  // De-duplicate imported repos by id, first occurrence wins.
  const seen = new Set<string>();
  const importedRepos: ImportedRepo[] = [];
  if (Array.isArray(r.importedRepos)) {
    for (const entry of r.importedRepos) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : undefined;
      const name = typeof e.name === "string" ? e.name : undefined;
      const fullName = typeof e.fullName === "string" ? e.fullName : name;
      if (!id || !name || !fullName || seen.has(id)) continue;
      seen.add(id);
      importedRepos.push({
        id,
        name,
        fullName,
        defaultBranch:
          typeof e.defaultBranch === "string" ? e.defaultBranch : "main",
        description:
          typeof e.description === "string" ? e.description : null,
      });
    }
  }

  // `selectedRepo` must reference an imported repo or be null (unique default).
  const selectedRaw =
    typeof r.selectedRepo === "string" ? r.selectedRepo : null;
  const selectedRepo =
    selectedRaw && seen.has(selectedRaw) ? selectedRaw : null;

  const settingsRaw =
    typeof r.settings === "object" && r.settings !== null
      ? (r.settings as Record<string, unknown>)
      : {};
  const settingsDefaultRepoId =
    typeof settingsRaw.defaultRepoId === "string" &&
    seen.has(settingsRaw.defaultRepoId)
      ? settingsRaw.defaultRepoId
      : null;

  const credRaw =
    typeof r.codexCredential === "object" && r.codexCredential !== null
      ? (r.codexCredential as Record<string, unknown>)
      : {};
  const mode = credRaw.mode === "compatible" ? "compatible" : "official";
  const validStates = ["not_connected", "not_saved", "connected"] as const;
  const state = validStates.includes(
    credRaw.state as (typeof validStates)[number],
  )
    ? (credRaw.state as CodexCredential["state"])
    : "not_connected";

  return {
    githubConnected: r.githubConnected === true,
    importedRepos,
    selectedRepo,
    settings: {
      defaultRepoId: settingsDefaultRepoId,
      retention: normalizeRetention(settingsRaw.retention),
      writeConfirm: settingsRaw.writeConfirm !== false,
    },
    codexCredential: {
      mode,
      state,
      baseUrl: typeof credRaw.baseUrl === "string" ? credRaw.baseUrl : undefined,
      hasApiKey: credRaw.hasApiKey === true,
      apiKeySuffix:
        typeof credRaw.apiKeySuffix === "string"
          ? credRaw.apiKeySuffix
          : undefined,
      defaultModel:
        typeof credRaw.defaultModel === "string"
          ? credRaw.defaultModel
          : undefined,
    },
  };
}

/**
 * Pure de-duplicating insert of an imported repo (first id wins). Returns a new
 * array; the input is not mutated. Extracted so the import mutation's set-union
 * is unit-testable independent of `localStorage`/React.
 */
export function upsertImportedRepo(
  list: readonly ImportedRepo[],
  repo: ImportedRepo,
): ImportedRepo[] {
  if (list.some((r) => r.id === repo.id)) return [...list];
  return [...list, repo];
}

// ---------------------------------------------------------------------------
// External store (useSyncExternalStore)
// ---------------------------------------------------------------------------

let memoryState: PersistedState = DEFAULT_STATE;
let hydrated = false;
const listeners = new Set<() => void>();

function readPersisted(): PersistedState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULT_STATE;
    return normalizeState(JSON.parse(raw));
  } catch {
    return DEFAULT_STATE;
  }
}

function persist(next: PersistedState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Ignore quota / unavailable storage; in-memory state still drives the UI.
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(onChange: () => void): () => void {
  // Lazily hydrate from localStorage on first client subscription so the SSR
  // snapshot (DEFAULT_STATE) and the first client snapshot stay reference-equal
  // until real hydration completes, avoiding a tearing warning.
  if (!hydrated && typeof window !== "undefined") {
    hydrated = true;
    const fromStorage = readPersisted();
    if (fromStorage !== DEFAULT_STATE) {
      memoryState = fromStorage;
    }
  }
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): PersistedState {
  return memoryState;
}

function getServerSnapshot(): PersistedState {
  return DEFAULT_STATE;
}

/**
 * Read the current store snapshot directly (outside React) — used by mock
 * queryFns so a mock read reflects the latest written UI state.
 */
export function getState(): PersistedState {
  if (typeof window !== "undefined" && !hydrated) {
    hydrated = true;
    memoryState = readPersisted();
  }
  return memoryState;
}

/**
 * Apply a partial update (or updater fn), persist it, and notify subscribers.
 * Mutations (10.5) call this then invalidate the affected queries.
 */
export function setState(
  patch:
    | Partial<PersistedState>
    | ((prev: PersistedState) => Partial<PersistedState>),
): void {
  const prev = getState();
  const delta = typeof patch === "function" ? patch(prev) : patch;
  memoryState = { ...prev, ...delta };
  persist(memoryState);
  emit();
}

/** Reset to the default snapshot (used by logout / test teardown). */
export function resetState(): void {
  memoryState = DEFAULT_STATE;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      // Ignore.
    }
  }
  emit();
}

/** React hook: subscribe to the whole snapshot. */
export function useStore(): PersistedState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** React hook: subscribe to a derived slice with a custom selector. */
export function useStoreSelector<T>(selector: (state: PersistedState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getSnapshot()),
    () => selector(getServerSnapshot()),
  );
}
