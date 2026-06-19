/**
 * `ApiResponsePanel` — the response viewer of the `/api` Playground page
 * (add-api-playground Track 2, task 2.4).
 *
 * The prototype `.api-res-section` + `.api-card.api-res` (`screens/api.html`): a
 * section head ("响应" + a status pill + a `.api-res-meta` "142 ms · 312 B"
 * line), then a tabbed card with a Body tab (a `<pre>` rendering the response
 * body, pretty-printed when JSON) and a Headers tab (the response headers as a
 * `.api-kv` grid). Per the api-playground spec ("Request editor … and response
 * viewer"), the status pill tone reflects the outcome (2xx green / 4xx warn /
 * 5xx or transport-error danger) and the page stays usable on a failed send
 * ("A failed send surfaces an error, not a crash").
 *
 * Four explicit states (spec "an in-flight send SHALL show a pending state; a
 * failed send … SHALL render the error … rather than crashing"):
 *  - EMPTY   — no send yet (`result == null` && !pending): a neutral placeholder.
 *  - PENDING — a send in flight (`pending`): a "请求执行中…" state.
 *  - ERROR   — a transport failure (`result.status === 0`): the error message,
 *              not a crash.
 *  - RESULT  — a real HTTP response (2xx or non-2xx): status pill + meta + tabs.
 *
 * The JSON pretty-print uses the result's parsed `json` when the api returned a
 * JSON content-type; otherwise the raw `body` text is shown verbatim (never a
 * forced re-parse that could throw on non-JSON).
 *
 * SSR-safe: pure render from props; the active tab is local `useState`. No
 * window/clock/random read (timing/size come from the result the page passes).
 */
import * as React from "react";

import { cn } from "@/utils";
import { StatusPill, type StatusPillVariant } from "@/components/status-pill";
import type { ApiSendResult } from "@/components/api/catalog";

/** The two response tabs, in display order. */
type ResponseTab = "body" | "headers";

export interface ApiResponsePanelProps {
  /** The last send's result, or `null` when nothing has been sent yet. */
  result: ApiSendResult | null;
  /** `true` while a send is in flight (renders the pending state). */
  pending?: boolean;
}

/** Pick the status-pill tone for an HTTP status (transport error = danger). */
function statusVariant(status: number): StatusPillVariant {
  if (status === 0) return "danger";
  if (status >= 500) return "danger";
  if (status >= 400) return "warn";
  if (status >= 200 && status < 300) return "green";
  return "neutral";
}

/** Render the body text — pretty-printed from `json` when present, else raw. */
function bodyText(result: ApiSendResult): string {
  if (result.json !== undefined) {
    try {
      return JSON.stringify(result.json, null, 2);
    } catch {
      // A non-serializable parsed value (shouldn't happen) → fall back to raw.
    }
  }
  return result.body;
}

/** Format the elapsed-time + size meta line ("142 ms · 312 B"). */
function metaLine(result: ApiSendResult): string {
  return `${Math.round(result.durationMs)} ms · ${result.sizeBytes} B`;
}

/** The response viewer (status + meta + Body/Headers tabs, with all states). */
export function ApiResponsePanel({ result, pending = false }: ApiResponsePanelProps) {
  const [tab, setTab] = React.useState<ResponseTab>("body");

  const head = (
    <div className="mt-1.5 flex items-center gap-2.5">
      <span className="text-sm font-semibold text-foreground">响应</span>
      {result && (
        <>
          <StatusPill variant={statusVariant(result.status)}>
            {result.status === 0
              ? "请求失败"
              : `${result.status} ${result.statusText}`.trim()}
          </StatusPill>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {metaLine(result)}
          </span>
        </>
      )}
    </div>
  );

  // PENDING — a send is in flight.
  if (pending) {
    return (
      <div className="grid min-w-0 gap-3">
        <div className="mt-1.5 flex items-center gap-2.5">
          <span className="text-sm font-semibold text-foreground">响应</span>
          <StatusPill variant="blue">请求执行中…</StatusPill>
        </div>
        <section className="block rounded-lg bg-card p-[18px] shadow-card">
          <p className="m-0 text-[13px] text-muted-foreground">
            正在以当前会话身份执行请求…
          </p>
        </section>
      </div>
    );
  }

  // EMPTY — nothing has been sent yet.
  if (!result) {
    return (
      <div className="grid min-w-0 gap-3">
        {head}
        <section className="block rounded-lg bg-card p-[18px] shadow-card">
          <p className="m-0 text-[13px] text-muted-foreground">
            选择左侧接口并点击「发送」，响应将显示在这里。
          </p>
        </section>
      </div>
    );
  }

  // ERROR — a transport failure (never reached the api): show the message.
  if (result.status === 0) {
    return (
      <div className="grid min-w-0 gap-3">
        {head}
        <section className="block rounded-lg bg-card p-[18px] shadow-card">
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-danger-soft p-3 font-mono text-[12.5px] leading-[1.55] text-danger shadow-[inset_0_0_0_1px_var(--border)]">
            {result.body || result.statusText || "请求未能送达 API。"}
          </pre>
        </section>
      </div>
    );
  }

  // RESULT — a real HTTP response (2xx or non-2xx).
  const headerEntries = Object.entries(result.headers);
  return (
    <div className="grid min-w-0 gap-3">
      {head}
      <section className="block rounded-lg bg-card p-[18px] shadow-card">
        <div
          role="tablist"
          aria-label="响应"
          className="-mx-[18px] mb-3 flex gap-1 border-b border-border px-3"
        >
          {(["body", "headers"] as const).map((id) => {
            const selected = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(id)}
                className={cn(
                  "border-b-2 px-2 py-2.5 text-xs font-medium transition-colors",
                  selected
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground",
                )}
              >
                {id === "body" ? "Body" : "Headers"}
              </button>
            );
          })}
        </div>

        {tab === "body" ? (
          <pre className="m-0 overflow-x-auto rounded-lg bg-[#fafafa] p-3 font-mono text-[12.5px] leading-[1.55] text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
            {bodyText(result) || "（空响应体）"}
          </pre>
        ) : headerEntries.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">（无响应头）</p>
        ) : (
          <div className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
            {headerEntries.map(([key, value]) => (
              <React.Fragment key={key}>
                <span className="font-mono">{key}</span>
                <span className="font-mono break-all text-muted-foreground">{value}</span>
              </React.Fragment>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
