/**
 * `ApiRequestPanel` — the request editor of the `/api` Playground page
 * (add-api-playground Track 2, task 2.3).
 *
 * The prototype `.api-main` request region (`screens/api.html`): a request bar
 * (`.api-reqbar`) with a colored method tag + the resolved path (host prefix
 * muted) + a 发送 button; a `.api-base` line stating the request is
 * session-signed ("会话已签名 · OAuth 自动注入") — there is NO token field
 * (design D1 / spec "No manual token entry"); then a tabbed card with:
 *  - Body — a JSON editor (`<textarea>`) + a 格式化 action (write endpoints),
 *  - 参数 — the query params (e.g. `limit`/`cursor`) as labeled inputs,
 *  - Headers — the READ-ONLY auto-injected `Authorization` (masked) +
 *    `Content-Type` (api-playground spec "Request editor with Body / Params /
 *    Headers").
 *
 * Per the spec, the path is RESOLVED from the curated template + dedicated
 * `:id`-style param inputs (no free-form URL field, design D2); a path param is
 * substituted into the path before the request is emitted ("A path parameter is
 * filled before sending"). A 发送 on a `destructive` endpoint (`POST /v1/tasks`,
 * stop) shows a lightweight inline confirm first (design "Risks" → destructive
 * confirm); the SEND itself is the page's job — the panel raises {@link onSend}
 * with the fully-resolved request.
 *
 * Editor state (path params, query values, body, active tab) is LOCAL `useState`
 * re-seeded whenever the selected endpoint changes (a `useEffect` keyed on the
 * endpoint id), so switching endpoints in the rail loads a fresh editor while a
 * given endpoint's edits persist as long as it stays selected.
 *
 * SSR-safe: pure render seeded deterministically from the endpoint (the default
 * endpoint's sample body renders identically server + client for the pixel
 * baseline, design D6). No window/clock/random read.
 */
import * as React from "react";

import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import {
  resolvePath,
  type ApiEndpoint,
  type ApiMethod,
} from "@/components/api/catalog";

/** Per-method ink for the request-bar method tag (`.api-method-tag.{verb}`). */
const METHOD_COLOR: Record<ApiMethod, string> = {
  GET: "text-info",
  POST: "text-success",
  PATCH: "text-warning",
  DELETE: "text-danger",
};

/** The fully-resolved request the panel emits on 发送 (consumed by the page). */
export interface ApiResolvedRequest {
  /** The endpoint this request was built from (e.g. to route the SSE stream). */
  endpoint: ApiEndpoint;
  /** The HTTP method. */
  method: ApiMethod;
  /** The resolved path, with `:id`-style params already substituted. */
  path: string;
  /** Non-empty query params, as a key→value record (omitted when none). */
  query: Record<string, string>;
  /** The JSON request body text for write endpoints, or `undefined` for reads. */
  body?: string;
}

/** The three request tabs, in display order. */
type RequestTab = "body" | "params" | "headers";

export interface ApiRequestPanelProps {
  /** The selected catalog endpoint (drives the editor's seed + which tabs show). */
  endpoint: ApiEndpoint;
  /** Whether a send is currently in flight (disables 发送, shows pending copy). */
  pending?: boolean;
  /** Fired with the fully-resolved request when 发送 is confirmed. */
  onSend: (request: ApiResolvedRequest) => void;
}

/** Seed the per-param input map from an endpoint (each param starts empty). */
function seedPathParams(endpoint: ApiEndpoint): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const param of endpoint.pathParams) seed[param.name] = "";
  return seed;
}

/** Seed the query-value map from an endpoint's declared defaults. */
function seedQuery(endpoint: ApiEndpoint): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const param of endpoint.queryParams) seed[param.name] = param.defaultValue;
  return seed;
}

/** Collapse a query map to its non-empty entries (trimmed). */
function nonEmptyQuery(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/** The request editor (request bar + auth line + Body/参数/Headers tabs). */
export function ApiRequestPanel({
  endpoint,
  pending = false,
  onSend,
}: ApiRequestPanelProps) {
  const hasBody = endpoint.sampleBody !== null;
  const [tab, setTab] = React.useState<RequestTab>(hasBody ? "body" : "params");
  const [pathParams, setPathParams] = React.useState(() => seedPathParams(endpoint));
  const [query, setQuery] = React.useState(() => seedQuery(endpoint));
  const [body, setBody] = React.useState(() => endpoint.sampleBody ?? "");
  // A destructive send awaiting the inline confirm (cleared on confirm/cancel).
  const [confirming, setConfirming] = React.useState(false);

  // Re-seed the editor whenever the SELECTED endpoint changes (rail click).
  React.useEffect(() => {
    setPathParams(seedPathParams(endpoint));
    setQuery(seedQuery(endpoint));
    setBody(endpoint.sampleBody ?? "");
    setTab(endpoint.sampleBody !== null ? "body" : "params");
    setConfirming(false);
  }, [endpoint]);

  const resolvedPath = resolvePath(endpoint, pathParams);

  function emit() {
    setConfirming(false);
    onSend({
      endpoint,
      method: endpoint.method,
      path: resolvedPath,
      query: nonEmptyQuery(query),
      body: hasBody ? body : undefined,
    });
  }

  function handleSend() {
    if (endpoint.destructive) {
      setConfirming(true);
      return;
    }
    emit();
  }

  function formatBody() {
    try {
      setBody(JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      // Leave an unparseable body untouched — the operator fixes it manually.
    }
  }

  const tabs: { id: RequestTab; label: string; show: boolean }[] = [
    { id: "body", label: "Body", show: hasBody },
    { id: "params", label: "参数", show: true },
    { id: "headers", label: "Headers", show: true },
  ];

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex items-center gap-2.5">
        <span className="text-sm font-semibold text-foreground">请求</span>
        <span className="font-mono text-[11px] tracking-[0.06em] text-muted-2">
          REQUEST
        </span>
      </div>

      {/* Request bar: method tag + resolved path + 发送. */}
      <div className="flex gap-2">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded-lg bg-card shadow-[inset_0_0_0_1px_var(--border)]">
          <span
            className={cn(
              "inline-flex min-h-10 flex-none items-center border-r border-border px-3 font-mono text-xs font-semibold",
              METHOD_COLOR[endpoint.method],
            )}
          >
            {endpoint.method}
          </span>
          <span className="min-w-0 flex-1 truncate px-3 font-mono text-[13px] text-foreground">
            {resolvedPath}
          </span>
        </div>
        <button
          type="button"
          data-api-send
          disabled={pending}
          onClick={handleSend}
          className="inline-flex min-h-10 flex-none items-center justify-center rounded-md bg-primary px-[18px] text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          {pending ? "发送中…" : "发送"}
        </button>
      </div>

      {/* Path-param inputs (only for `:id`-style templates). */}
      {endpoint.pathParams.length > 0 && (
        <div className="grid gap-2 rounded-lg bg-[#fafafa] p-3 shadow-[inset_0_0_0_1px_var(--border)]">
          {endpoint.pathParams.map((param) => (
            <label key={param.name} className="grid gap-1">
              <span className="font-mono text-[11px] font-medium text-muted-foreground">
                {param.label}
                <span className="ml-1 text-muted-2">:{param.name}</span>
              </span>
              <input
                type="text"
                value={pathParams[param.name] ?? ""}
                placeholder={param.placeholder}
                onChange={(event) =>
                  setPathParams((prev) => ({ ...prev, [param.name]: event.target.value }))
                }
                className="min-h-9 rounded-md border-0 bg-card px-3 font-mono text-[13px] text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-[inset_0_0_0_1px_var(--foreground)]"
              />
            </label>
          ))}
        </div>
      )}

      {/* Session-signed auth line — NO token field (design D1). */}
      <div className="flex flex-wrap items-center gap-2.5">
        <StatusPill variant="green">会话已签名 · OAuth 自动注入</StatusPill>
        <span className="text-xs text-muted-foreground">
          凭据来自当前操作者会话，请求以 Bearer 形式签名
        </span>
      </div>

      {/* Inline destructive-send confirm (POST /v1/tasks, stop). */}
      {confirming && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-warning-soft p-3 shadow-[inset_0_0_0_1px_var(--border)]">
          <span className="text-[13px] text-foreground">
            该请求会以你的会话身份对真实环境执行写操作，确认发送？
          </span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="inline-flex min-h-8 items-center justify-center rounded-md bg-secondary px-3 text-[13px] font-medium text-foreground shadow-ring hover:bg-secondary/80"
            >
              取消
            </button>
            <button
              type="button"
              onClick={emit}
              className="inline-flex min-h-8 items-center justify-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              确认发送
            </button>
          </div>
        </div>
      )}

      {/* Tabbed request config card. */}
      <section className="block rounded-lg bg-card p-[18px] shadow-card">
        <div
          role="tablist"
          aria-label="请求配置"
          className="-mx-[18px] mb-3 flex gap-1 border-b border-border px-3"
        >
          {tabs
            .filter((t) => t.show)
            .map((t) => {
              const selected = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "border-b-2 px-2 py-2.5 text-xs font-medium transition-colors",
                    selected
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
        </div>

        {/* Body */}
        {tab === "body" && hasBody && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">application/json</span>
              <button
                type="button"
                onClick={formatBody}
                className="inline-flex min-h-[26px] items-center justify-center rounded-md px-[9px] text-[11px] font-medium text-foreground hover:bg-accent"
              >
                格式化
              </button>
            </div>
            <textarea
              aria-label="请求体"
              spellCheck={false}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              className="min-h-[148px] w-full resize-y rounded-lg border-0 bg-[#fafafa] p-3 font-mono text-[12.5px] leading-[1.55] text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-[inset_0_0_0_1px_var(--foreground)]"
            />
          </div>
        )}

        {/* 参数 (query) */}
        {tab === "params" && (
          <div>
            {endpoint.queryParams.length === 0 ? (
              <p className="m-0 text-xs text-muted-foreground">
                该请求无查询参数。
              </p>
            ) : (
              <div className="grid gap-2.5">
                {endpoint.queryParams.map((param) => (
                  <label
                    key={param.name}
                    className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 max-[560px]:grid-cols-1 max-[560px]:gap-1"
                  >
                    <span className="font-mono text-[12.5px] text-foreground">
                      {param.name}
                    </span>
                    <input
                      type="text"
                      value={query[param.name] ?? ""}
                      placeholder={param.hint}
                      onChange={(event) =>
                        setQuery((prev) => ({ ...prev, [param.name]: event.target.value }))
                      }
                      className="min-h-9 rounded-md border-0 bg-card px-3 font-mono text-[13px] text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-[inset_0_0_0_1px_var(--foreground)]"
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Headers (read-only, auto-injected) */}
        {tab === "headers" && (
          <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
            {hasBody && (
              <>
                <span className="font-mono">Content-Type</span>
                <span className="font-mono text-muted-foreground">application/json</span>
              </>
            )}
            <span className="font-mono">Authorization</span>
            <span className="font-mono text-muted-foreground">
              Bearer ••••（会话自动注入）
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
