/**
 * `ApiRail` — the LEFT endpoint rail of the `/api` Playground page
 * (add-api-playground Track 2, task 2.2).
 *
 * The prototype `.api-rail` (`screens/api.html`): a sticky white card with a
 * search field at the top, then the curated `/v1` catalog grouped by domain
 * (任务 / 仓库 / 文档). Each row (`.api-ep`) shows a colored method tag
 * (`.api-method`) + the mono path; the selected row carries `.is-active`.
 * Selecting a row raises {@link onSelect} so the page can load it into the
 * request editor (api-playground spec "Selecting an endpoint loads it into the
 * request editor"). The list is the curated surface only — there is NO
 * free-form URL field here (design D2 / spec "no open fetch box").
 *
 * The search filter narrows BY method + path (client-only view state); a domain
 * group with no surviving rows is hidden so the rail never shows an empty
 * heading. Filtering never changes the selection — the page owns that.
 *
 * SSR-safe: pure, controlled render. The selected id is owned by the caller
 * (`selectedId` + `onSelect`); the search term is local `useState` seeded empty,
 * so the server render is deterministic (full catalog, default selection).
 *
 * Fidelity (`.api-rail` cascade): sticky top 18; white card radius + ring + 12px
 * pad + 14px row gap; `.search-field` 36px mono-leading search; per-group an
 * 11/600 muted label + 2px-gap rows; `.api-ep` flex 5/8 pad radius 6, hover
 * `--subtle`, active `--secondary`; method tag 36px mono 10/600 colored by verb;
 * path mono 11.5 truncating.
 */
import * as React from "react";

import { cn } from "@/utils";
import {
  API_DOMAINS,
  API_CATALOG,
  type ApiEndpoint,
  type ApiMethod,
} from "@/components/api/catalog";

/** Per-method ink color (the prototype `.api-method.{get,post,patch,delete}`). */
const METHOD_COLOR: Record<ApiMethod, string> = {
  GET: "text-info",
  POST: "text-success",
  PATCH: "text-warning",
  DELETE: "text-danger",
};

export interface ApiRailProps {
  /** The id of the currently-selected endpoint (controlled). */
  selectedId: string;
  /** Fired with an endpoint when its row is clicked. */
  onSelect: (endpoint: ApiEndpoint) => void;
  /** Optional extra classes (forwarded to the rail `<aside>`). */
  className?: string;
}

/** Case-insensitive match of the search term against the method + path. */
function matches(endpoint: ApiEndpoint, term: string): boolean {
  if (!term) return true;
  const haystack = `${endpoint.method} ${endpoint.pathTemplate} ${endpoint.title}`;
  return haystack.toLowerCase().includes(term.toLowerCase());
}

/** The searchable, domain-grouped endpoint rail (LEFT column of `/api`). */
export function ApiRail({ selectedId, onSelect, className }: ApiRailProps) {
  const [search, setSearch] = React.useState("");
  const term = search.trim();

  return (
    <aside
      aria-label="接口集合"
      className={cn(
        "grid gap-3.5 self-start rounded-lg bg-card p-3 shadow-ring",
        "sticky top-[18px]",
        className,
      )}
    >
      <label className="grid min-h-9 grid-cols-[32px_minmax(0,1fr)] items-center rounded-md bg-card shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]">
        <span aria-hidden="true" className="grid place-items-center font-mono text-muted-foreground">
          ⌕
        </span>
        <input
          type="search"
          aria-label="筛选接口"
          placeholder="筛选接口"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-h-9 min-w-0 border-0 bg-transparent pr-2.5 text-sm text-foreground outline-none"
        />
      </label>

      {API_DOMAINS.map((domain) => {
        const rows = API_CATALOG.filter(
          (endpoint) => endpoint.domain === domain && matches(endpoint, term),
        );
        if (rows.length === 0) return null;
        return (
          <div key={domain} className="grid gap-0.5">
            <div className="mx-1 my-1 text-[11px] font-semibold text-muted-foreground">
              {domain}
            </div>
            {rows.map((endpoint) => {
              const active = endpoint.id === selectedId;
              return (
                <button
                  key={endpoint.id}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelect(endpoint)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-[5px] text-left text-xs text-foreground transition-colors",
                    active ? "bg-secondary" : "hover:bg-[#fafafa]",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "w-9 flex-none font-mono text-[10px] font-semibold tracking-[0.02em]",
                      METHOD_COLOR[endpoint.method],
                    )}
                  >
                    {endpoint.method}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                    {endpoint.pathTemplate}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}
