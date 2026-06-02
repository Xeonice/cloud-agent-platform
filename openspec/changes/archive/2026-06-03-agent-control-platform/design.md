## Context

Today, running coding agents like the Codex CLI across many tasks means juggling raw terminals across machines. At 5–10 concurrent sessions this becomes unmanageable: there is no single place to watch what each agent is doing, approve the dangerous operations it requests, or take over its keyboard from a phone. Existing orchestrators (Cloudflare Managed Agents, rivet `sandbox-agent`, Omnara, Vibe-Kanban) render *structured event streams* and assume a hosted multi-tenant footprint — they do not stream the **real interactive agent TUI**.

This change builds the opposite: a **single-user, self-hostable control plane** that drives the real interactive Codex CLI under a PTY and streams its **byte-identical live terminal** to a browser, with remote approvals and write-takeover. It is **greenfield** — nothing exists yet (no `package.json`, `turbo.json`, apps, or configs). The whole monorepo is authored from scratch, backend-first, with a functional-minimal frontend.

Key constraints discovered during research (see `research-brief.md`) that shape the architecture:
- **Vercel categorically cannot host WebSockets**, so web and api must be separately deployable targets that talk over env-configured cross-origin URLs.
- **Only the interactive Codex path emits the TUI ANSI stream**; `exec --json`, `app-server`, and the Agent SDK are headless. Byte-identity is therefore a property of the interactive PTY path *only*.
- **WebSocket has no native flow control**, and xterm.js cannot keep pace with a GB/s PTY producer, so backpressure must be implemented at the application layer.
- **Codex hooks must live in `~/.codex/hooks.json`** (top-level); repo-local `.codex/config.toml` hook config does not fire. Hook tool coverage is *partial* (shell + apply_patch + MCP, not all shell calls).
- **Docker-as-execution forces `--sandbox danger-full-access`** because the inner Codex OS sandbox (bubblewrap/seccomp) collapses inside a container — so Docker is the platform deploy plane, not the per-task execution sandbox.

Stakeholders: a single operator (self-hosting), driving Codex from a desktop browser and a phone.

## Goals / Non-Goals

**Goals:**
- A greenfield pnpm + Turborepo monorepo with a zod `contracts` package as the single source of truth, and strict-TypeScript enforced in three independent places.
- Spawn the **real interactive** Codex CLI under node-pty in an isolated per-task workspace, with `session.log` as the append-only byte source of truth.
- Stream the terminal over a **dual-channel WebSocket** (raw bytes + structured control frames) with application-layer backpressure and snapshot + tail-replay reconnect, achieving **live-frame byte-identity** under PTY parity conditions.
- A **blocking Codex hook** that round-trips approval decisions (`allow`/`deny`/`message`) with an "any deny wins" resolution rule, plus post-hoc file-edit reporting with a git-diff fallback.
- An **application-layer single-writer/multi-reader write lock** with heartbeat, auto-release on disconnect, and preemptive takeover; lock-gated keystrokes but lock-independent one-shot approvals.
- A **runner-dials-back handshake** authenticated by a short-lived per-task `TASK_TOKEN` (no inbound port per sandbox), with ephemeral session-scoped credentials as the primary safety boundary.
- **Three independently-deployable targets**: Vercel (web-only), Fly.io / docker-compose (stateful api), with a persistent volume for `session.log`.
- A runnable `turbo typecheck lint build` so apply's build-verify and verify's dynamic checks have ground truth.
- An **operator bearer token** gating all REST + WS access (distinct from the runner `TASK_TOKEN`), refusing to start when unconfigured.
- **Safety guardrails** for 7×24 operation: a `MAX_CONCURRENT_TASKS` semaphore, wall-clock deadline + idle ceiling that force-fail and reclaim slots, and a start/turn circuit breaker.
- A **functional-minimal console** over a maintained `packages/ui` (shadcn + Tailwind + xterm `<Terminal>`): session page, fleet dashboard, and new-task creation.

**Non-Goals (explicitly out of scope):**
- Multi-user / multi-tenant. This is single-operator by design.
- Token budgeting / cost accounting.
- Seekable `.cast` history playback (kept as a deferred-polish page; only live + tail-replay reconnect is in scope).
- A concrete OS-isolating execution sandbox — deferred behind the `SandboxProvider` port; the first impl is the minimal Docker one (`danger-full-access`).
- A polished frontend. The web app is intentionally functional-minimal; this change is backend-first.
- Byte-identical **scrollback**. Only the **live frame** is byte-identical; scrollback is explicitly permitted to diverge.

## Decisions

### D1. Interactive Codex under node-pty (not a headless transport)
We spawn the interactive `codex` binary attached to a node-pty PTY with `TERM=xterm-256color`, and pump its raw byte stream. **Why not `codex exec --json` / `app-server` / Agent SDK?** Those are headless and emit structured JSONL — they never produce the TUI ANSI stream that makes the browser terminal *look like the real thing*. Byte-identity is the product differentiator, and it only exists on the interactive path. The trade-off is that we lose the convenience of structured output for the terminal channel (we recover structure via the separate hook/event channel).

### D2. Byte-identity is spec'd as observable conditions, not a total promise
Live-frame parity is required **only when** the browser terminal uses `TERM=xterm-256color` and matching cols/rows. Scrollback is explicitly excluded. **Why:** terminal serialization (xterm `SerializeAddon`) reconstructs the *visible frame* deterministically under matched geometry, but historical scrollback can never be guaranteed byte-for-byte across resize/serialize boundaries. Over-promising scrollback parity would make the spec un-satisfiable. We make the conditions observable so verify can actually check them.

### D3. Application-layer backpressure with an ACK protocol (WS has no flow control)
The orchestrator tracks un-acknowledged bytes per client against a **500 000-byte high-water mark**; at the mark it calls `pty.pause()`, and resumes via `pty.resume()` once the client drains below a low-water mark. Client→server **ACK control frames** advance the drained counter; the browser uses `term.write(chunk, callback)` + `requestAnimationFrame` coalescing to throttle render. **Why application-layer:** WebSocket exposes no native backpressure, and `ws`'s `bufferedAmount` alone does not protect xterm.js, which is the real bottleneck (it cannot render at PTY speed). **Alternative considered:** rely on TCP/WS buffering — rejected because it stalls the event loop and OOMs under a fast producer.

### D4. Dual logical channels over one WebSocket
One WS carries two logically distinct channels: a **raw byte stream** (PTY output, never parsed as control) and a **structured control-frame** channel (every frame validates against a contracts zod schema). **Why one socket, two channels:** simplifies reconnect/auth and keeps ordering, while still letting us validate control frames strictly and keep raw bytes opaque. Frame discrimination is encoded in contracts so a raw frame can never be misread as a control frame.

### D5. Reconnect = headless snapshot + raw tail-replay
On reconnect the client gets a periodic headless `SerializeAddon` snapshot (recording the cols/rows it was taken at) followed by an append-only `session.log` raw tail replay. **Why both:** the snapshot restores the live frame cheaply; the tail replay fills the gap since the snapshot without replaying the entire (potentially huge) log. `session.log` on a **persistent volume** is what makes this survive an orchestrator restart.

### D6. Blocking hook forwarder for approvals; "any deny wins"
A blocking Codex `PermissionRequest`/`PreToolUse` hook forwards the event to the orchestrator, **blocks** until the operator decides, and prints the resulting `{decision}` JSON to stdout for Codex to consume. The contracts package encodes `decision.behavior ∈ {allow, deny}` + optional `message`, and the runner resolves multiple contributing decisions with **any-deny-wins** (deny if any deny; allow only if all allow). `PostToolUse` is post-hoc, used only for **file-edit reporting** (never gating/undo), with a **git-diff fallback** because hook tool coverage is partial. **Why a blocking hook rather than the policy engine as the boundary:** since hook coverage is partial, the PreToolUse policy engine cannot be the security boundary — sandbox isolation + ephemeral creds are. The hook is for *human-in-the-loop approval*, not enforcement.

### D7. Approvals are lock-independent; keystrokes are lock-gated
The write lock is an **application-layer** single-writer/multi-reader lease (`Map<sessionId, {writerClientId, leaseExpiry}>`) with heartbeat renewal, auto-release on disconnect, and preemptive takeover. **Raw keystrokes require the lock**; **structured one-shot approvals do not**. **Why not delegate to tmux:** tmux has no single-writer-lease primitive and cannot express preemptive takeover or phone-friendly lock-independent approvals. **Why approvals are lock-independent:** the operator must be able to approve a dangerous op from a phone without first wresting the keyboard lock away from a desktop session.

### D8. Runner dials back; `TASK_TOKEN` authenticates; ephemeral creds are the boundary
The runner opens an **outbound** WS to the orchestrator (no inbound port per sandbox). Its first frame is a **dial-back handshake** (a first-class contracts frame type) carrying a short-lived, per-task, single-task-scoped `TASK_TOKEN`; the orchestrator rejects missing/malformed/expired/mismatched tokens. **Sandbox-scoped ephemeral credentials destroyed at session end are the primary safety boundary** — not the hook policy engine. **Why dial-back:** it removes any inbound attack surface on the sandbox and works behind NAT; the orchestrator is the only listener.

### D9. Execution sandbox deferred behind a `SandboxProvider` port
`SandboxProvider` exposes the sandbox mode (`read-only` | `workspace-write` | `danger-full-access`) as a capability; callers depend on the port, not a concrete impl. The first impl is the **minimal Docker** one, which documents that running Codex inside Docker forces `danger-full-access` (inner bubblewrap/seccomp sandbox collapses in a container) and that **Docker is the deploy plane, not the per-task execution sandbox**. A future OS-isolating impl (e.g. a Claude Code sandbox-runtime) can satisfy the same port with no consumer changes. **Why a port now:** it draws the boundary explicitly so the weak first impl is an honest, swappable placeholder rather than a baked-in assumption.

### D10. Three deploy targets; web and api never same-origin
`apps/web` → Vercel (`vercel.json`, **no** WS server). `apps/api` → Fly.io (`fly.toml`) **or** docker-compose (`docker-compose.yml`), same NestJS WS+PTY orchestrator both ways. Web reaches api only via env-configured `API_BASE_URL` / `WS_URL`, allowed to be a different origin. A **persistent volume** backs `workspaces/<id>/session.log` (Fly volume / named compose volume) so it survives restart. **Why:** Vercel's serverless model cannot hold long-lived WS connections, forcing the split; making cross-origin a first-class assumption avoids same-origin coupling that would break the split deploy.

### D11. contracts package as single source of truth; strict-TS in three places
`packages/contracts` exports zod schemas + their `z.infer` types; `apps/{api,web,runner}` depend on it via `workspace:*` and never re-declare shared shapes. Strict TS is enforced at (1) a `strict: true` base tsconfig, (2) repo Claude Code hooks in `.claude/settings.json` that typecheck + lint edited TS, and (3) a husky pre-commit running lint-staged. Build ordering uses Turborepo `dependsOn: ["^build"]`. **Why three enforcement points:** they catch drift at edit-time (hooks), commit-time (husky), and CI/build-time (tsconfig) — defense in depth against the contract drifting from its consumers.

### D12. Operator auth is a distinct trust domain from the runner token
A single operator bearer token (`AUTH_TOKEN`) gates every REST endpoint (except `/health`) and every client WebSocket connect, compared in constant time; the orchestrator refuses to start if it is unset. This is **separate** from the per-task runner `TASK_TOKEN` (D8): the operator token authenticates the human driving the console; `TASK_TOKEN` authenticates a sandbox dialling back. **Why two tokens, not one:** they have different lifetimes (long-lived operator secret vs. short-lived per-task), different blast radius, and different issuance — collapsing them would let a leaked task token drive the whole console. **Why refuse-to-start:** a pure-terminal control plane is effectively remote code execution into a credentialed sandbox; silently serving it unauthenticated is the worst failure mode, so an unconfigured token is fatal, not a warning. Tailscale/private-network deployment is complementary, not a substitute.

### D13. Guardrails degrade from tokens to wall-clock, and reclaim slots
Because pure-terminal execution exposes no token metering (the SDK structured channel is not the render path), budget guardrails are **wall-clock and concurrency**, not cost. A `MAX_CONCURRENT_TASKS` semaphore bounds running sandboxes with FIFO admission; a per-task wall-clock deadline and an idle ceiling (`MAX_IDLE`, distinct from the shorter `Stop`-hook "awaiting input" notification) **force-fail and reclaim the slot**; a circuit breaker trips a task to `failed` after N consecutive start/turn failures. **Why force-fail rather than just alert:** on a 7×24 box a wedged or runaway task otherwise holds a scarce slot and burns provider quota indefinitely. **Alternative considered:** scrape token usage from the terminal stream — rejected as fragile and agent-version-specific; wall-clock is observable and agent-agnostic.

### D14. Functional-minimal console over a maintained `packages/ui`
The frontend is intentionally thin but real: `packages/ui` holds the shadcn + Tailwind components (including the xterm `<Terminal>` wrapper with fit/serialize/unicode11 addons) consumed by `apps/web`; the console ships a session page (live terminal + keystroke input + lock-independent approval surface), a fleet dashboard, and new-task creation, all over env-configurable cross-origin `API_BASE_URL`/`WS_URL`. **Why a shared `ui` package rather than inlining components in `web`:** the requirement is to *maintain a component library*, and a separate package keeps the xterm wrapper and design-system primitives reusable and independently typecheckable. **Why minimal:** this change is backend-first; history/settings polish and the seekable `.cast` replay page are deferred to a follow-up, but the terminal must be drivable end-to-end now.

## Risks / Trade-offs

- **Live-frame byte-identity is fragile across terminal versions** → Pin a known-good Codex version baked into the runner image; spec parity only under matched `TERM`/geometry; treat scrollback divergence as allowed, not a bug.
- **Partial Codex hook coverage means the policy engine is not a security boundary** → Make ephemeral session-scoped creds + sandbox isolation the documented primary boundary; use hooks for human approval only; add a git-diff fallback for file-edit reporting.
- **Docker-as-execution forces `danger-full-access` (no OS isolation per task)** → Isolate behind `SandboxProvider`, document the trade-off in the impl, and keep the path to an OS-isolating impl open with no consumer changes.
- **Fast PTY producer can OOM/stall the orchestrator** → Bounded 500K high-water mark, `pty.pause()/resume()`, ACK-based draining, rAF render coalescing.
- **`session.log` lost on restart breaks reconnect/replay** → Require a persistent volume in both Fly and compose; spec a restart-survival scenario.
- **Large single change risks merge-hell during parallel apply** → Partition into ~9–12 tracks with `monorepo-foundation` as the `depends: none` root; route all `packages/contracts` edits to a serial integration track; make `realtime-terminal` and `agent-events-and-approvals` depend on `terminal-execution`. A runnable `turbo typecheck lint build` gives post-merge build-verify (bounded `MAX_REPAIR_ROUNDS=3`) ground truth.
- **Cross-origin web↔api can hit CORS/WS-origin issues** → Treat cross-origin as the default assumption; configure CORS and WS origin allow-listing from env, never assume same-origin.

## Migration Plan

Not applicable in the usual sense — this is greenfield with no existing system to migrate from or data to convert. Deployment ordering instead:

1. Scaffold `monorepo-foundation` first (root configs, `packages/contracts`, strict-TS, build graph). This is the `depends: none` root all other tracks build on.
2. Stand up `repo-and-task-management` (Postgres + Prisma migrations) and `terminal-execution` (PTY spawn).
3. Layer `realtime-terminal`, `agent-events-and-approvals`, `write-lock-and-takeover`, `runner-dialback-and-creds` on top.
4. Provision `multi-target-deploy`: api to Fly.io / compose with the persistent `workspaces` volume; web to Vercel with `API_BASE_URL`/`WS_URL` pointed at the api origin.
5. `sandbox-provider-port` lands the port + minimal Docker impl.

**Rollback:** because targets are independently deployable, a bad api deploy is rolled back on Fly/compose without touching web; a bad web deploy is rolled back on Vercel without touching the stateful api or any live `session.log`.

## Open Questions

- Snapshot cadence for the `SerializeAddon` reconnect snapshot — fixed interval vs. byte-threshold — to balance reconnect latency against snapshot cost.
- Concrete `TASK_TOKEN` TTL and the renewal/issuance flow at task creation.
- Heartbeat interval and `leaseExpiry` window for the write lock (responsiveness of auto-release vs. churn on flaky connections).
- Notification adapter selection at runtime (ntfy/Bark for `notify` one-way; Telegram inline buttons for `request-decision` round-trip) and how the REST callback is secured.
- Default low-water mark relative to the 500K high-water mark (resume hysteresis).

### Spec-defect notes surfaced by adversarial verify (three-way routing)

These are requirement-level ambiguities raised during verification. They are intentionally *not* re-opened as implementation tasks (no `verify-reopened` task exists for them); resolve the spec wording first, then decide whether code work follows.

- **Deadline/idle "tear down its sandbox" refined to a port-level call (VR.11 GAP2 resolution).** The guardrails deadline + idle-ceiling requirements originally said the orchestrator "tears down its sandbox". Per the deferred-sandbox decision (D9), there is no concrete per-task execution sandbox in this change — `SandboxProvider` is a port with a minimal Docker placeholder whose `teardownSandbox()` is a documented no-op (Docker is the deploy plane, not the per-task execution sandbox). The requirements were therefore refined to a **port-level** obligation: `forceFail` SHALL invoke `SandboxProvider.teardownSandbox()`, which the placeholder no-ops and a future OS-isolating provider implements for real. Forcing a real container teardown now would contradict D9, so it is intentionally NOT implemented. The companion code gap (no way to set a deadline) was real and fixed: `deadlineMs` was added to the task create contract and plumbed to `admit(taskId, deadlineMs)` so the deadline watcher can arm.
- **Circuit-breaker `turn_failure` signal lacks a runner→orchestrator transport (deferred).** The circuit breaker counts both `agent_failed_to_start` and `turn_failure` (`FailureKind`), and the `agent_failed_to_start` path is fully wired (`tasks.service.ts` → `recordFailure`). The `turn_failure` path, however, has no reliable producer: the runner's `reportExited` is currently local-only, there is no contracts frame for a runner→orchestrator exit/turn-status report, and inferring failure from "runner WS dropped while its session is still registered" is unsound because the natural-completion path does not call `unregisterSession` (so a clean completion would be misreported as a failure). Wiring `turn_failure` correctly requires a small new design: (a) a `runner_exit`/`turn_status` control frame in `@cap/contracts` carrying the exit code, (b) the runner sending it on PTY exit, (c) the gateway routing a non-zero exit to `recordFailure(taskId, 'turn_failure')` and a clean exit to `recordSuccess` + `unregisterSession`. This is deferred to a follow-up change rather than bolted on here; the requirement's two scenarios remain satisfiable today through the `agent_failed_to_start` path. (Gap 1 of the same finding — a queued-then-admitted task not arming its wall-clock deadline — WAS fixed: deadlines are now parked at `admit()` and consumed in `onAdmit()`.)
- **Write-lock "Expired lease without heartbeat is released" — lazy vs. proactive release is underspecified.** The requirement (write-lock-and-takeover/spec.md "Heartbeat renewal and expiry") says the orchestrator "releases the lease" when `leaseExpiry` passes without a renewing heartbeat, but does not state *whether release must be observable to connected clients at expiry time*. The implementation releases lazily — `getLease()`/`isWriter()` purge the expired lease only on the next read (acquire / heartbeat / keystroke check), and no background timer fires a `lease_state` broadcast when a lease silently lapses between interactions. This satisfies the scenario semantically (any later `acquire` sees the slot free; keystrokes from the lapsed holder are denied) but leaves connected observers unaware until the next interaction. The requirement is therefore *met-as-written but ambiguous*: it should explicitly state either (a) lazy release with no proactive broadcast is sufficient, or (b) a proactive `lease_state` broadcast is required on expiry — the latter would imply a timer-driven sweep that the current spec does not mandate.
