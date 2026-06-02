"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  Task,
  ControlFrame,
  PermissionRequestFrame,
  WriteLease,
  DecisionBehavior,
} from "@cap/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Terminal,
  statusBadgeVariant,
  type TerminalHandle,
} from "@cap/ui";
import { getTask, ApiError } from "@/lib/api-client";
import { TerminalSocket, decodeTailReplay } from "@/lib/ws-client";
import { getClientId } from "@/lib/client-id";

const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * `/tasks/[id]` — the session page (frontend-console spec 13.3).
 *
 * Mounts the shared `<Terminal>`, opens the authenticated WebSocket (over the
 * env-configured cross-origin `WS_URL`), renders the live raw byte stream and
 * the task status, wires keystroke input through the write-lock, and shows a
 * lock-INDEPENDENT approval surface for pending `PermissionRequest` decisions.
 *
 * Live rendering uses `requestAnimationFrame` write coalescing: incoming raw
 * frames are buffered and flushed at most once per animation frame via
 * `term.write(chunk, callback)`, and the flush callback drives the ACK frame
 * back to the server (the client side of the backpressure protocol, D3).
 */
export default function SessionPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const taskId = params.id;
  const sessionId = taskId; // one session per task on this surface
  const clientIdRef = React.useRef<string>("");
  if (clientIdRef.current === "") clientIdRef.current = getClientId();
  const clientId = clientIdRef.current;

  const [task, setTask] = React.useState<Task | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [connected, setConnected] = React.useState(false);
  const [lease, setLease] = React.useState<WriteLease | null>(null);
  const [pending, setPending] = React.useState<PermissionRequestFrame[]>([]);

  const socketRef = React.useRef<TerminalSocket | null>(null);
  const handleRef = React.useRef<TerminalHandle | null>(null);

  // rAF write-coalescing buffer + the highest seq we have buffered/flushed.
  const pendingBytesRef = React.useRef<Uint8Array[]>([]);
  const pendingSeqRef = React.useRef<number>(-1);
  const rafRef = React.useRef<number | null>(null);
  // Highest session.log byte offset this client holds (live frames + reconnect
  // snapshot/tail). Drives the `reconnect` request so a refresh resumes from here.
  const heldSeqRef = React.useRef<number>(0);

  const holdsLease = lease?.writerClientId === clientId;

  // --- poll task status (running / awaiting-input / completed / failed …) ---
  React.useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await getTask(taskId);
        if (active) setTask(next);
      } catch (err) {
        if (!active) return;
        if (err instanceof ApiError && err.status === 404) {
          setError("Task not found.");
        } else if (err instanceof ApiError && err.status === 401) {
          setError("Unauthorized — check the operator token (AUTH_TOKEN).");
        } else {
          setError(err instanceof Error ? err.message : "Failed to load task.");
        }
      }
    };
    void load();
    const interval = setInterval(() => void load(), 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [taskId]);

  const flushFrame = React.useCallback(() => {
    rafRef.current = null;
    const handle = handleRef.current;
    const socket = socketRef.current;
    const chunks = pendingBytesRef.current;
    const seq = pendingSeqRef.current;
    pendingBytesRef.current = [];
    if (chunks.length === 0 || !handle) return;

    // Concatenate all buffered chunks into a single term.write per frame.
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    // term.write(chunk, callback): the flush callback acks the drained seq.
    handle.write(merged, () => {
      if (seq >= 0) {
        if (seq > heldSeqRef.current) heldSeqRef.current = seq;
        socket?.sendAck(seq);
      }
    });
  }, []);

  const scheduleFlush = React.useCallback(() => {
    if (rafRef.current !== null) return;
    if (typeof requestAnimationFrame === "undefined") {
      flushFrame();
      return;
    }
    rafRef.current = requestAnimationFrame(flushFrame);
  }, [flushFrame]);

  // --- WebSocket lifecycle ---
  React.useEffect(() => {
    const socket = new TerminalSocket(taskId, {
      onOpen: () => {
        setConnected(true);
        // 5.5 — on (re)connect, request snapshot + tail-replay restoration from
        // the highest byte offset we already hold, carrying current geometry so a
        // differently-sized client reconciles. A fresh connection (held seq 0)
        // gets the full snapshot + tail.
        const geo = handleRef.current?.geometry() ?? undefined;
        socketRef.current?.sendReconnect(
          heldSeqRef.current,
          geo?.cols,
          geo?.rows,
        );
      },
      onClose: () => setConnected(false),
      onError: () => setConnected(false),
      onRaw: (bytes, seq) => {
        pendingBytesRef.current.push(bytes);
        if (seq > pendingSeqRef.current) pendingSeqRef.current = seq;
        scheduleFlush();
      },
      onControl: (frame: ControlFrame) => {
        switch (frame.type) {
          case "snapshot":
            // 5.5 — render the latest SerializeAddon snapshot (serialized ANSI
            // reconstructing the visible frame); record its byte offset.
            handleRef.current?.write(frame.data);
            if (frame.seq > heldSeqRef.current) heldSeqRef.current = frame.seq;
            break;
          case "tail_replay":
            // 5.5 — replay the session.log tail appended after the snapshot.
            handleRef.current?.write(decodeTailReplay(frame.data), () => {
              if (frame.seq > heldSeqRef.current) heldSeqRef.current = frame.seq;
            });
            break;
          case "permission_request":
            setPending((prev) =>
              prev.some((p) => p.requestId === frame.requestId)
                ? prev
                : [...prev, frame],
            );
            break;
          case "decision":
            // A decision resolved a request (possibly from another client).
            setPending((prev) =>
              prev.filter((p) => p.requestId !== frame.requestId),
            );
            break;
          case "lease_state":
            setLease(frame.lease);
            break;
          default:
            // pause/resume are driven by the backpressure protocol; nothing for
            // the UI to do here.
            break;
        }
      },
    });
    socketRef.current = socket;
    socket.connect();

    return () => {
      if (rafRef.current !== null && typeof cancelAnimationFrame !== "undefined")
        cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      socket.close();
      socketRef.current = null;
    };
  }, [taskId, scheduleFlush]);

  // --- heartbeat renewal while holding the lease ---
  React.useEffect(() => {
    if (!holdsLease) return;
    const interval = setInterval(() => {
      socketRef.current?.sendHeartbeat(sessionId, clientId);
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [holdsLease, sessionId, clientId]);

  const onTerminalReady = React.useCallback((handle: TerminalHandle) => {
    handleRef.current = handle;
  }, []);

  // VR.8 — terminal geometry sync: send a resize frame to the server whenever
  // the browser terminal is resized (initial fit + container resize). The
  // server dispatches it to the runner PTY so cols/rows stay in sync, making
  // the "identical cols and rows" live-frame parity precondition reachable.
  const onTerminalResize = React.useCallback(
    ({ cols, rows }: { cols: number; rows: number }) => {
      socketRef.current?.sendResize(cols, rows);
    },
    [],
  );

  // Keystrokes are LOCK-GATED: only forwarded when this client holds the lease.
  const onTerminalData = React.useCallback(
    (data: string) => {
      if (!holdsLease) return;
      socketRef.current?.sendKeystroke(sessionId, data);
    },
    [holdsLease, sessionId],
  );

  const requestTakeover = React.useCallback(() => {
    socketRef.current?.sendTakeover(sessionId, clientId);
  }, [sessionId, clientId]);

  // Approvals are LOCK-INDEPENDENT (D7): submit regardless of lease ownership.
  const decide = React.useCallback(
    (requestId: string, behavior: DecisionBehavior) => {
      socketRef.current?.sendDecision(requestId, { behavior });
      setPending((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [],
  );

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-muted-foreground underline">
            ← Fleet
          </Link>
          <h1 className="font-mono text-sm">{taskId}</h1>
          {task ? (
            <Badge variant={statusBadgeVariant(task.status)}>
              {task.status}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{connected ? "● connected" : "○ disconnected"}</span>
          <span>
            {holdsLease
              ? "you hold the write lock"
              : lease
                ? "read-only (another writer holds the lock)"
                : "read-only (no writer)"}
          </span>
          {!holdsLease ? (
            <Button size="sm" variant="outline" onClick={requestTakeover}>
              Take over
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <div className="h-[28rem] w-full bg-black p-2">
            <Terminal
              className="h-full w-full"
              onReady={onTerminalReady}
              onData={onTerminalData}
              onResize={onTerminalResize}
            />
          </div>
        </CardContent>
      </Card>

      <ApprovalSurface requests={pending} onDecide={decide} />
    </main>
  );
}

/**
 * The lock-independent approval surface. Renders each pending
 * `PermissionRequest` with allow/deny actions that resolve it independently of
 * the write lock — so the operator can approve from a phone without holding the
 * keyboard lease (D7).
 */
function ApprovalSurface({
  requests,
  onDecide,
}: {
  requests: PermissionRequestFrame[];
  onDecide: (requestId: string, behavior: DecisionBehavior) => void;
}): React.ReactElement | null {
  if (requests.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Pending approvals ({requests.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {requests.map((req) => (
          <div
            key={req.requestId}
            className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{req.toolName}</p>
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {safeStringify(req.toolInput)}
              </pre>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => onDecide(req.requestId, "deny")}
              >
                Deny
              </Button>
              <Button size="sm" onClick={() => onDecide(req.requestId, "allow")}>
                Allow
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
