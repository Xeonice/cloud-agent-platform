/**
 * `ApiStreamPanel` — the LIVE SSE tail for the catalog's streaming endpoint
 * (`GET /v1/tasks/:id/events`, add-api-playground Track 3, task 3.2; design D5).
 *
 * Unlike the single request/response endpoints (which run through
 * `runApiRequest`), the events endpoint is a STREAM: sending it opens a
 * credentialed fetch stream and APPENDS each parsed SSE event to a live
 * tail, with a control to STOP/abort the stream (api-playground spec "The SSE
 * events endpoint has a streaming view" → "a live tail … with a control to
 * stop/close the stream … visually + behaviorally distinct").
 *
 * Transport (design D5): native `EventSource` cannot set `Last-Event-ID`, so the
 * stream uses the shared fetch transport plus a standards-compliant SSE parser.
 * This preserves credentialed cookie auth, the optional legacy bearer, and the
 * public resume header instead of presenting a reduced browser-only contract.
 *
 * No free-form URL (design D2): the stream URL is built from the CURATED catalog
 * template (`endpoint.pathTemplate`) + the dedicated `:id` input, URL-encoded via
 * `resolvePath` — never an operator-typed host/path.
 *
 * SSR-safe: fetch is called only inside the connect handler (a client event) and
 * aborted on unmount / 停止 / a new connect, so module import and first render
 * have no browser API access. The id input and appended events are plain state.
 */
import * as React from "react";

import { cn } from "@/utils";
import { streamApiEvents } from "@/lib/api/real";
import { StatusPill } from "@/components/status-pill";
import { resolvePath, type ApiEndpoint } from "@/components/api/catalog";

/** The connection lifecycle of the SSE tail. */
type StreamPhase = "idle" | "connecting" | "open" | "closed" | "error";

/** One appended tail line (a received SSE event or a lifecycle note). */
interface StreamLine {
  /** A stable key for the list (monotonic). */
  seq: number;
  /** `event` for a received SSE message, `note` for a lifecycle/error line. */
  kind: "event" | "note";
  /** The rendered text (the event `data`, or the lifecycle message). */
  text: string;
}

export interface ApiStreamPanelProps {
  /** The streaming catalog endpoint (`GET /v1/tasks/:id/events`). */
  endpoint: ApiEndpoint;
}

/** Phase → status-pill tone + label (mirrors the request/response panel pills). */
const PHASE_META: Record<
  StreamPhase,
  { tone: "neutral" | "blue" | "green" | "danger"; label: string }
> = {
  idle: { tone: "neutral", label: "未连接" },
  connecting: { tone: "blue", label: "连接中…" },
  open: { tone: "green", label: "正在接收事件…" },
  closed: { tone: "neutral", label: "已停止" },
  error: { tone: "danger", label: "连接中断" },
};

/** The live SSE tail view for the events endpoint. */
export function ApiStreamPanel({ endpoint }: ApiStreamPanelProps) {
  const [params, setParams] = React.useState<Record<string, string>>({});
  const [headers, setHeaders] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      endpoint.headerParams.map((header) => [header.name, header.defaultValue]),
    ),
  );
  const [phase, setPhase] = React.useState<StreamPhase>("idle");
  const [lines, setLines] = React.useState<StreamLine[]>([]);
  const controllerRef = React.useRef<AbortController | null>(null);
  const seqRef = React.useRef(0);

  // Re-seed (and tear down any open stream) when the selected endpoint changes.
  React.useEffect(() => {
    closeStream();
    setParams({});
    setHeaders(
      Object.fromEntries(
        endpoint.headerParams.map((header) => [header.name, header.defaultValue]),
      ),
    );
    setPhase("idle");
    setLines([]);
  }, [endpoint]);

  // Always abort the stream on unmount.
  React.useEffect(() => closeStream, []);

  const resolvedPath = resolvePath(endpoint, params);
  // The id is "filled" only when every declared path param has a value (so we
  // never open a stream against an unresolved `:id` template).
  const ready = endpoint.pathParams.every((p) => (params[p.name] ?? "").trim());

  function appendLine(kind: StreamLine["kind"], text: string) {
    setLines((prev) => [...prev, { seq: ++seqRef.current, kind, text }]);
  }

  function closeStream() {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }

  function handleStop() {
    if (!controllerRef.current) return;
    closeStream();
    setPhase("closed");
    appendLine("note", "— 已停止 —");
  }

  function handleConnect() {
    if (!ready) return;
    // Close any prior stream before opening a fresh one.
    closeStream();
    setLines([]);
    setPhase("connecting");

    const controller = new AbortController();
    controllerRef.current = controller;
    void streamApiEvents({
      path: resolvedPath,
      lastEventId: headers["Last-Event-ID"],
      signal: controller.signal,
      onOpen: () => {
        if (controllerRef.current !== controller) return;
        setPhase("open");
        appendLine("note", "— 连接已建立 —");
      },
      onEvent: (event) => {
        if (controllerRef.current !== controller) return;
        if (event.id) {
          setHeaders((current) => ({
            ...current,
            "Last-Event-ID": event.id!,
          }));
        }
        appendLine("event", event.data);
      },
    }).then(
      () => {
        if (controllerRef.current !== controller) return;
        controllerRef.current = null;
        setPhase("closed");
        appendLine("note", "— 服务端已关闭事件流 —");
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (controllerRef.current === controller) controllerRef.current = null;
        setPhase("error");
        appendLine("note", error instanceof Error ? error.message : String(error));
      },
    );
  }

  const meta = PHASE_META[phase];
  const streaming = phase === "connecting" || phase === "open";

  return (
    <div className="grid min-w-0 gap-3">
      {/* Section head — distinct STREAM label, not 请求/响应. */}
      <div className="flex items-center gap-2.5">
        <span className="text-sm font-semibold text-foreground">事件流</span>
        <span className="font-mono text-[11px] tracking-[0.06em] text-muted-2">
          STREAM · SSE
        </span>
        <StatusPill variant={meta.tone} className="ml-auto">
          {meta.label}
        </StatusPill>
      </div>

      {/* Resolved path bar (method tag + curated path) — read-only, no URL box. */}
      <div className="flex min-w-0 items-center overflow-hidden rounded-lg bg-card shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="inline-flex min-h-10 flex-none items-center border-r border-border px-3 font-mono text-xs font-semibold text-info">
          {endpoint.method}
        </span>
        <span className="min-w-0 flex-1 truncate px-3 font-mono text-[13px] text-foreground">
          {resolvedPath}
        </span>
      </div>

      {/* The `:id` input(s) for the curated template. */}
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
                value={params[param.name] ?? ""}
                placeholder={param.placeholder}
                onChange={(event) =>
                  setParams((prev) => ({ ...prev, [param.name]: event.target.value }))
                }
                className="min-h-9 rounded-md border-0 bg-card px-3 font-mono text-[13px] text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-[inset_0_0_0_1px_var(--foreground)]"
              />
            </label>
          ))}
        </div>
      )}

      {endpoint.headerParams.length > 0 && (
        <div className="grid gap-2 rounded-lg bg-[#fafafa] p-3 shadow-[inset_0_0_0_1px_var(--border)]">
          {endpoint.headerParams.map((header) => (
            <label key={header.name} className="grid gap-1">
              <span className="font-mono text-[11px] font-medium text-muted-foreground">
                {header.name}
              </span>
              <input
                type="text"
                value={headers[header.name] ?? ""}
                placeholder={header.hint}
                onChange={(event) =>
                  setHeaders((current) => ({
                    ...current,
                    [header.name]: event.target.value,
                  }))
                }
                className="min-h-9 rounded-md border-0 bg-card px-3 font-mono text-[13px] text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-[inset_0_0_0_1px_var(--foreground)]"
              />
            </label>
          ))}
        </div>
      )}

      {/* Same credential transport as request/response calls. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <StatusPill variant="blue">SSE · 会话已签名</StatusPill>
        <span className="text-xs text-muted-foreground">
          自动携带会话 Cookie；配置 legacy token 时同时附带 Bearer
        </span>
      </div>

      {/* Connect / Stop controls. */}
      <div className="flex gap-2">
        <button
          type="button"
          data-api-stream-connect
          disabled={!ready || streaming}
          onClick={handleConnect}
          className="inline-flex min-h-10 flex-none items-center justify-center rounded-md bg-primary px-[18px] text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          {streaming ? "接收中…" : "开始接收"}
        </button>
        <button
          type="button"
          data-api-stream-stop
          disabled={!streaming}
          onClick={handleStop}
          className="inline-flex min-h-10 flex-none items-center justify-center rounded-md bg-secondary px-[18px] text-sm font-medium text-foreground shadow-ring transition-colors hover:bg-secondary/80 disabled:pointer-events-none disabled:opacity-50"
        >
          停止
        </button>
      </div>

      {/* The live tail. */}
      <section className="block rounded-lg bg-card p-[18px] shadow-card">
        {lines.length === 0 ? (
          <p className="m-0 text-[13px] text-muted-foreground">
            填入任务 ID 并点击「开始接收」，事件将实时追加到这里。
          </p>
        ) : (
          <pre className="m-0 max-h-[360px] overflow-auto rounded-lg bg-[#fafafa] p-3 font-mono text-[12.5px] leading-[1.55] text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
            {lines.map((line) => (
              <div
                key={line.seq}
                className={cn(
                  line.kind === "note" && "text-muted-foreground",
                )}
              >
                {line.text}
              </div>
            ))}
          </pre>
        )}
      </section>
    </div>
  );
}
