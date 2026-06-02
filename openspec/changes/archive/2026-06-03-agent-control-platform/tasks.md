<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.

     PARTITION NOTE (corrected after codebase scan):
     - Greenfield repo: file paths inferred from the prescribed monorepo layout
       (apps/{api,web,runner}, packages/{contracts,ui,tsconfig,eslint-config}) + the
       design's D1-D14 module boundaries.
     - Each parallel track below now CREATES a disjoint set of new modules. Tasks that
       EDIT a file another track creates were pulled into Track 14 (orchestrator-integration),
       which runs serially after all parallel tracks. Specifically:
         * apps/api/src/main.ts + app.module.ts (DI/bootstrap wiring) — touched by api,
           realtime-terminal, agent-events, auth, guardrails.
         * apps/api/src/terminal/*.gateway.ts — created by realtime-terminal, then edited by
           write-lock (keystroke gating), runner-dialback (handshake-on-WS), auth (WS connect).
         * apps/api/src/tasks/* service + lifecycle state-machine — created by
           repo-and-task-management, then edited by runner-dialback (token issuance at create),
           guardrails (admit/force-fail transitions).
         * SandboxProvider port refactor (9.1) — rewrites api+runner provisioning callers
           written by terminal-execution / agent-events / runner-dialback / guardrails.
         * apps/web/** + packages/ui/** — realtime-terminal (terminal scaffold), write-lock
           (web lock controls), multi-target-deploy (web env), frontend-console (ui pkg +
           pages + central client) all converge here.
         * packages/contracts late-add (11.1 operator-auth shapes) lands after the contracts
           track has closed, so it is serialized.
-->

## 1. Track: monorepo-foundation (depends: none)
<!-- files: package.json, pnpm-workspace.yaml, turbo.json, pnpm-lock.yaml, .claude/settings.json,
     .husky/**, packages/tsconfig/**, packages/eslint-config/**, and the INITIAL scaffold shells of
     apps/{api,web,runner}/package.json+tsconfig.json and packages/{contracts,ui}/package.json+tsconfig.json -->


- [x] 1.1 Initialize the pnpm + Turborepo workspace root: create `package.json`, `pnpm-workspace.yaml` with globs resolving `apps/api`, `apps/web`, `apps/runner`, `packages/contracts`, `packages/ui`, `packages/tsconfig`, `packages/eslint-config`, and `turbo.json`.
- [x] 1.2 Author `turbo.json` pipeline with `build` declaring `dependsOn: ["^build"]` and `typecheck`/`lint`/`build` tasks wired so `turbo typecheck lint build` runs across the workspace.
- [x] 1.3 Create `packages/tsconfig` shared base config with `compilerOptions.strict: true`, plus per-target presets (node/library/next) that extend it.
- [x] 1.4 Create `packages/eslint-config` shared ESLint config consumed by all apps and packages.
- [x] 1.5 Scaffold each workspace member's `package.json` and `tsconfig.json` extending the shared base, with `typecheck`/`lint`/`build` scripts and `workspace:*` dependency wiring (apps depend on `packages/contracts`).
- [x] 1.6 Add `.claude/settings.json` repo hooks that run a TypeScript typecheck and ESLint check on edited `.ts`/`.tsx` files.
- [x] 1.7 Install and configure husky pre-commit hook running lint-staged against staged files; add the `lint-staged` config.
- [x] 1.8 Run `pnpm install` to produce the root lockfile and verify `pnpm -r ls` lists all members with no unmet dependencies; verify `turbo typecheck lint build` exits 0 on the empty scaffold.

## 2. Track: contracts (depends: monorepo-foundation)
<!-- files: packages/contracts/** (single source of truth; all other tracks only IMPORT) -->

- [x] 2.1 Set up `packages/contracts` entry point exporting zod schemas alongside their `z.infer` types from a single index; add `zod` dependency and build/typecheck scripts.
- [x] 2.2 Define the `Repo` and `Task` domain schemas plus the task-status enum including `pending`, `running`, `awaiting_input`, `completed`, `failed`, and a distinct `agent_failed_to_start` value; export request/response body schemas for the repo and task REST APIs.
- [x] 2.3 Define the dual-channel WebSocket frame protocol: a raw-byte frame variant and a discriminated control-frame union, with explicit `pause`, `resume`, and `ack` (acknowledgement) frame variants, encoded so a raw frame can never be misread as a control frame.
- [x] 2.4 Define the SerializeAddon snapshot frame schema recording cols and rows, and the reconnect/tail-replay control frames.
- [x] 2.5 Define the approval contract: `decision.behavior` constrained to the literal set `{ allow, deny }` with an optional `message` string, plus the `PermissionRequest`/`PreToolUse` forward-event frame and the `PostToolUse` file-edit report shape.
- [x] 2.6 Define the write-lock control frames: lease state shape (`sessionId` -> `{ writerClientId, leaseExpiry }`), heartbeat, takeover-request, and keystroke frames.
- [x] 2.7 Define the runner dial-back handshake as a first-class frame type carrying a `TASK_TOKEN` field, plus the notification adapter payload schemas (`notify` and `request-decision`) and the `SandboxProvider` sandbox-mode enum (`read-only`, `workspace-write`, `danger-full-access`).
- [x] 2.8 Build `packages/contracts` and confirm all schemas and inferred types are importable from the package entry point.

## 3. Track: repo-and-task-management (depends: contracts)
<!-- files: apps/api/prisma/**, apps/api/src/prisma/** (client module), apps/api/src/repos/**,
     apps/api/src/tasks/** (controller+service+lifecycle state-machine). CREATES tasks service +
     state-machine; later EDITS by runner-dialback (token issuance) and guardrails (transitions)
     are isolated in Track 14. Also CREATES apps/api/src/main.ts + app.module.ts; cross-track
     DI/bootstrap edits are in Track 14. -->

- [x] 3.1 Add Prisma to `apps/api`; author the Prisma schema with a `Repo` model (id, name, git source) and a `Task` model (id, relation to `Repo`, prompt, status, createdAt) using the contracts task-status enum.
- [x] 3.2 Generate and add the initial Prisma migration that provisions the `Repo` and `Task` tables; wire a Prisma client/module into the NestJS app.
- [x] 3.3 Implement the repos REST controller/service: create, list, and fetch-by-id, validating request and response bodies against the contracts repo schemas (201 on create, 400 on invalid body).
- [x] 3.4 Implement the tasks REST controller/service: create-under-repo, list, and fetch-by-id, validating against contracts task schemas (201 on create, 404 when the referenced repo does not exist).
- [x] 3.5 Implement the task lifecycle state machine enforcing only permitted transitions (rejecting e.g. `completed` -> `pending` and leaving persisted status unchanged) and exposing a transition into the distinct `agent_failed_to_start` state.

## 4. Track: terminal-execution (depends: contracts)
<!-- files: apps/runner/src/task-entry.ts, apps/runner/src/pty/**, apps/runner/src/session-log.ts,
     apps/runner/src/startup-window.ts. Disjoint from agent-events (runner hooks) and runner-dialback
     (runner dialback) by sub-module. The 9.1 port refactor of these provisioning callers is in Track 14. -->

- [x] 4.1 Scaffold `apps/runner` task entry: accept a task id/config and create the isolated `workspaces/<id>` directory, distinct per task.
- [x] 4.2 Spawn the interactive `codex` CLI as a child under node-pty with `cwd` set to the task's `workspaces/<id>` and `TERM=xterm-256color`; do not use the headless `exec --json`/`app-server` subcommands for the terminal channel.
- [x] 4.3 Pump raw PTY bytes and append them in emission order to an append-only `workspaces/<id>/session.log` (never overwriting prior content), treating the file as the authoritative replay source.
- [x] 4.4 Implement the bounded startup window: detect early non-zero process exit or no first interactive frame within the window and report a distinct agent-failed-to-start condition to the orchestrator rather than hanging.

## 5. Track: realtime-terminal (depends: terminal-execution)
<!-- files: apps/api/src/terminal/*.gateway.ts (CREATES the gateway), apps/api/src/terminal/backpressure.ts,
     apps/api/src/terminal/snapshot.ts. The gateway is later EDITED by write-lock, runner-dialback, and
     auth — those edits are isolated in Track 14. Original 5.5/5.6 (apps/web terminal scaffold + rAF
     coalescing) collided with frontend-console's apps/web + packages/ui surface and were moved to Track 14. -->

- [x] 5.1 Implement the NestJS WebSocket gateway in `apps/api` streaming a task's terminal over a single socket with two logical channels (raw byte stream + structured control frames), validating every control frame against contracts and never parsing a raw frame as a control frame.
- [x] 5.2 Implement server-side application-layer backpressure: track un-acknowledged bytes per client against a high-water mark not exceeding 500 000 bytes, call `pty.pause()` at the mark and `pty.resume()` after the client drains below the low-water mark.
- [x] 5.3 Implement the ACK protocol: consume client acknowledgement control frames to advance the drained-output counter; emit explicit `pause`/`resume` frames per the contracts schema.
- [x] 5.4 Implement periodic headless `SerializeAddon` snapshotting (recording cols/rows at capture) and snapshot-plus-tail-replay reconnect that delivers the latest snapshot then replays `session.log` bytes appended after it, reconciling size differences.

## 6. Track: agent-events-and-approvals (depends: terminal-execution)
<!-- files: apps/runner/src/hooks/** (hook scripts), apps/runner/src/notify/** (notification adapter port).
     Disjoint runner sub-modules. Original 6.5 (orchestrator-side event ingestion + approval routing)
     edits apps/api gateway/module wiring shared with realtime-terminal and auth; moved to Track 14. -->

- [x] 6.1 Implement the blocking Codex `PermissionRequest`/`PreToolUse` hook script in `apps/runner` that forwards the event to the orchestrator, blocks until a decision returns, and prints the `{decision}` JSON to stdout for Codex; reject decisions whose `behavior` is outside `allow`/`deny` before emitting.
- [x] 6.2 Implement any-deny-wins resolution: when multiple matching decisions are produced for one permission request, resolve to `deny` if any contributing decision is `deny`, and to `allow` only when all are `allow`.
- [x] 6.3 Implement the `PostToolUse` hook for post-hoc file-edit reporting only (never gating/undo), plus a workspace git-diff fallback that surfaces file changes not reported by a `PostToolUse` event, merged into the file-edit report.
- [x] 6.4 Implement the two-capability notification adapter port (`notify` one-way; `request-decision` round-trip) with adapters that may implement `notify` without `request-decision`; route round-trip approvals only to adapters supporting `request-decision`.

## 7. Track: write-lock-and-takeover (depends: realtime-terminal)
<!-- files: apps/api/src/write-lock/** (lease map, heartbeat/expiry, auto-release, takeover) — a
     self-contained orchestrator module. Original 7.5 both EDITS the realtime-terminal gateway
     (keystroke gating on the shared *.gateway.ts) and EDITS apps/web client controls (shared with
     frontend-console); moved to Track 14. -->

- [x] 7.1 Implement the application-layer single-writer/multi-reader lease in the orchestrator: `Map<sessionId, { writerClientId, leaseExpiry }>`, granting raw write to at most one client while all others remain readers receiving the stream.
- [x] 7.2 Implement heartbeat renewal that advances `leaseExpiry`, and expiry release when `leaseExpiry` passes without a renewing heartbeat so a new writer may acquire it.
- [x] 7.3 Implement immediate auto-release of the lease on writer disconnect, without waiting for `leaseExpiry`.
- [x] 7.4 Implement preemptive takeover: a reader can take over the lease, demoting the previous holder to reader who can no longer send raw keystrokes.

## 8. Track: runner-dialback-and-creds (depends: realtime-terminal)
<!-- files: apps/runner/src/dialback/** (outbound WS + handshake frame), apps/api/src/creds/**
     (ephemeral session-scoped credential provider — new module). Original 8.2 (orchestrator
     handshake verifier) associates the connection on the shared gateway/connection path, and 8.3
     (TASK_TOKEN issuance) edits the repo-and-task-management tasks service; both moved to Track 14.
     8.4's teardown CALL SITES in the tasks lifecycle are wired in Track 14; the provider module itself
     is created here. -->

- [x] 8.1 Implement the runner outbound dial-back: open an outbound WebSocket to the orchestrator and never bind/listen on an inbound port; send the dial-back handshake frame carrying the `TASK_TOKEN` as the first frame.
- [x] 8.4 Implement provisioning and teardown of ephemeral session-scoped credentials destroyed when the session ends (completion/failure/teardown), documented and treated as the primary safety boundary, never persisted beyond the session.

## 9. Track: sandbox-provider-port (depends: contracts)
<!-- files: apps/api/src/sandbox/sandbox-provider.port.ts (port interface — new),
     apps/api/src/sandbox/docker-sandbox.provider.ts (Docker impl — new). The port DEFINITION and
     Docker impl are disjoint new files. The caller-refactor half of the original 9.1 (rewriting
     terminal-execution / agent-events / runner-dialback / guardrails provisioning callers to the port)
     touches files those tracks own and was split out to Track 14 as task 14.x. -->

- [x] 9.1 Define the `SandboxProvider` port interface exposing sandbox mode (`read-only`, `workspace-write`, `danger-full-access`) as an explicit capability, preserving a path for a future OS-isolating impl with no consumer changes. (Caller refactor is isolated in Track 14.)
- [x] 9.2 Implement the minimal Docker `SandboxProvider` reporting `danger-full-access`, with documentation stating Docker-as-execution forces `danger-full-access` because the inner Codex bubblewrap/seccomp sandbox collapses inside the container and that Docker is the platform deploy plane, not the per-task execution sandbox.

## 10. Track: multi-target-deploy (depends: realtime-terminal)
<!-- files: apps/web/vercel.json (new), apps/api/Dockerfile + apps/api/fly.toml (new),
     docker-compose.yml (new), apps/runner/Dockerfile (new), plus api-side CORS/WS-origin allow-listing
     in apps/api/src/main.ts (DI/bootstrap — that main.ts edit is shared, see Track 14). 10.1 owns the
     vercel.json + deploy-time env; the apps/web CLIENT reading of API_BASE_URL/WS_URL is owned by
     frontend-console 13.6 (do not double-write apps/web client here). 10.4's runner Dockerfile SHIPS the
     hooks.json authored by agent-events; it does not edit those hook scripts. -->

- [x] 10.1 Add `apps/web` `vercel.json` for a Vercel web-only deploy with no WebSocket server bundled or run; the web app's reading of `API_BASE_URL`/`WS_URL` (cross-origin, never same-origin) is centralized by frontend-console 13.6, and api-side CORS/WS-origin allow-listing is wired in Track 14.
- [x] 10.2 Add `apps/api` `Dockerfile` and `fly.toml` running the NestJS WS+PTY orchestrator with a Fly persistent volume mounted at the `workspaces` path that holds `session.log` and survives restart.
- [x] 10.3 Add `docker-compose.yml` running the same orchestrator (plus Postgres) with a named volume mounted at the `workspaces` path so `session.log` survives an orchestrator restart.
- [x] 10.4 Add the version-pinned runner `Dockerfile` that installs a specific pinned Codex version and ships the hook configuration at top-level `~/.codex/hooks.json` (not repo-local `.codex/config.toml`).

## 11. Track: single-user-auth (depends: realtime-terminal, repo-and-task-management)
<!-- files: apps/api/src/auth/** (guard class + constant-time compare helper — new module).
     Original 11.1 edits packages/contracts AFTER the contracts track closed (late add → serialized);
     11.2's GLOBAL guard registration + 11.3's refuse-to-boot edit apps/api/src/main.ts+app.module.ts
     (shared bootstrap); 11.4 edits the shared realtime-terminal gateway (WS connect auth). The guard
     CLASS + constant-time helper are built here (11.2 core, 11.3 helper); their wiring into the shared
     bootstrap/gateway and the contracts add are isolated in Track 14. -->

- [x] 11.2 Implement a NestJS auth guard class requiring an `Authorization: Bearer <token>` matching the configured `AUTH_TOKEN`, returning 401 on missing/malformed/non-matching tokens and performing no state change; exempt `/health`. (Global registration is wired in Track 14.)
- [x] 11.3 Implement the constant-time comparison helper for token checks. (The refuse-to-boot bootstrap guard editing main.ts is wired in Track 14.)

## 12. Track: guardrails (depends: repo-and-task-management, terminal-execution)
<!-- files: apps/api/src/guardrails/** (semaphore, deadline-watcher, idle-tracker, circuit-breaker as
     self-contained classes — new). These INVOKE the repo-and-task-management lifecycle state-machine
     (admit-queued / force-fail / slot-release transitions) and the runner-dialback creds teardown; those
     cross-track CALL SITES in apps/api/src/tasks/** + creds are wired in Track 14. Build the guardrail
     logic classes here. -->

- [x] 12.1 Implement the concurrency semaphore: cap running tasks at `MAX_CONCURRENT_TASKS`, hold excess in `queued`, and on any task reaching a terminal state admit the oldest queued task (FIFO) up to the cap.
- [x] 12.2 Implement the per-task wall-clock deadline watcher: when a running task passes its deadline, transition it to `failed`, tear down its sandbox, and release its slot; leave tasks that finish before the deadline untouched.
- [x] 12.3 Implement per-task idle tracking (no terminal output and no hook activity) and force-fail + teardown + slot-release when idle exceeds `MAX_IDLE`; reset the idle timer on any terminal output or hook event. Keep this distinct from the shorter `Stop`-hook "awaiting input" notification.
- [x] 12.4 Implement the circuit breaker: count consecutive agent-failed-to-start/turn-failure events per task, trip to `failed` (no auto-retry) at the configured threshold, and reset the counter on a success.

## 13. Track: frontend-console (depends: realtime-terminal, repo-and-task-management)
<!-- files: packages/ui/** (shadcn+Tailwind primitives, <Terminal> wrapper — new), apps/web/**
     (pages /tasks/[id], /, new-task form, central API/WS client — new). This track is the SOLE owner of
     apps/web + packages/ui among the PARALLEL tracks. The web-side tasks that originated in other tracks
     (realtime-terminal 5.5/5.6 terminal scaffold+rAF, write-lock 7.5 web controls, multi-target 10.1 web
     env) are deferred to Track 14 so they run AFTER this track lands the apps/web surface, never
     concurrently with it. 13.6 is the single owner of the env-configured API_BASE_URL/WS_URL client. -->

- [x] 13.1 Set up `packages/ui` with Tailwind CSS + shadcn/ui primitives consumed by `apps/web` via `workspace:*`; export the base components and confirm `apps/web` imports them rather than redefining them.
- [x] 13.2 Implement the `<Terminal>` component in `packages/ui` wrapping xterm.js with the fit, serialize, and unicode11 addons configured, exposing read-stream rendering and a keystroke input callback.
- [x] 13.3 Build the `/tasks/[id]` session page: mount `<Terminal>`, open the authenticated WebSocket (using `WS_URL`), render the live byte stream and task status, wire keystroke input through the write-lock, and show a lock-independent approval surface for pending `PermissionRequest` decisions.
- [x] 13.4 Build the `/` fleet dashboard listing tasks with status (running/queued/awaiting-input) and an action navigating into each task's session.
- [x] 13.5 Build new-task creation (page or modal) that selects a registered repo + branch and a prompt/strategy and POSTs to the tasks REST API (via `API_BASE_URL`), surfacing the created task and a link into its session.
- [x] 13.6 Centralize the web app's API/WebSocket client on env-configured `API_BASE_URL`/`WS_URL` (cross-origin, never same-origin), attaching the operator bearer token to REST and WS calls.

## 14. Track: orchestrator-integration (depends: realtime-terminal, agent-events-and-approvals, write-lock-and-takeover, runner-dialback-and-creds, sandbox-provider-port, multi-target-deploy, single-user-auth, guardrails, frontend-console)
<!-- INTEGRATION TRACK — runs serially AFTER all parallel tracks. Every task here EDITS a file that
     more than one track created (a shared file per the spec's "shared-file tasks are isolated" rule).
     The shared files are: apps/api/src/main.ts, apps/api/src/app.module.ts, apps/api/src/terminal/*.gateway.ts,
     apps/api/src/tasks/** (lifecycle state-machine), the runner/api provisioning callers, apps/web/**,
     and packages/contracts (late operator-auth add). Tasks keep their ORIGINAL ids so the [x] resume
     ledger is unaffected; they are merely relocated out of their parallel tracks. -->

- [x] 6.5 Wire the orchestrator side: receive forwarded hook events, route them to the approval/notification path, and return the resolved decision back to the blocking runner hook. (Edits the shared apps/api gateway/event-ingestion + app.module wiring.)
- [x] 8.2 Implement the orchestrator handshake verifier: accept a valid unexpired token bound to the claimed task and associate the connection with it; reject missing/malformed/expired/mismatched tokens (including a token issued for task A claiming task B) and do not associate the connection. (Edits the shared realtime-terminal gateway connection path.)
- [x] 8.3 Implement per-task `TASK_TOKEN` issuance at task creation, scoped to exactly one task and non-reusable across tasks, with a bounded TTL. (Edits the shared apps/api/src/tasks/** service created by repo-and-task-management.)
- [x] 9.1b Refactor orchestrator/runner execution-provisioning callers (terminal-execution, agent-events, runner-dialback, guardrails) to depend on the `SandboxProvider` port rather than a concrete impl, with no consumer changes required for a future OS-isolating impl. (Touches files those four tracks own.)
- [x] 10.1b Wire api-side CORS / WebSocket-origin allow-listing into apps/api/src/main.ts so the cross-origin Vercel web target reaches the api (never assuming same-origin). (Edits the shared bootstrap.)
- [x] 11.1 Define the operator-auth shapes in `packages/contracts`: the WebSocket connect-auth field/frame and the shared `AUTH_TOKEN` config contract, distinct from the runner `TASK_TOKEN` handshake. (Late add to packages/contracts after the contracts track closed.)
- [x] 11.2b Register the auth guard globally on all REST endpoints (exempting `/health`) in apps/api/src/main.ts + app.module.ts. (Shared bootstrap edit.)
- [x] 11.3b Make the orchestrator refuse to boot (clear error, non-zero exit) when `AUTH_TOKEN` is unset or empty, using the constant-time helper from 11.3. (Edits apps/api/src/main.ts bootstrap.)
- [x] 11.4 Authenticate client WebSocket connections at connect time against `AUTH_TOKEN`, closing unauthenticated/invalid connections before they join any task stream; reject a runner `TASK_TOKEN` presented as the operator token. (Edits the shared realtime-terminal gateway connect path.)
- [x] 7.5 Gate raw keystroke forwarding to the PTY on holding the lease while accepting structured one-shot approval decisions independently of the lease (edits the shared gateway keystroke path); wire the apps/web client controls for heartbeat, takeover, and lock-independent approvals (edits the apps/web surface owned by frontend-console).
- [x] 12.1b Wire the concurrency semaphore, deadline watcher, idle tracker, and circuit breaker into the apps/api/src/tasks/** lifecycle state-machine (admit-queued / force-fail / slot-release transitions) and into the runner-dialback creds teardown at session end. (Cross-track call sites into shared tasks service + creds.)
- [x] 5.5 Scaffold `apps/web` (Next.js + xterm.js) terminal view configured with `TERM=xterm-256color` and matching cols/rows for live-frame parity; render the read stream and consume snapshots/tail-replay on reconnect. (Lands on the apps/web surface owned by frontend-console; runs after 13.x.)
- [x] 5.6 Implement browser `requestAnimationFrame` write coalescing: buffer incoming raw byte messages and issue at most one concatenated `term.write()` per animation frame, with `term.write(chunk, callback)` driving the ACK frames back to the server. (Edits the apps/web terminal client owned by frontend-console.)

## Track: verify-reopened (depends: none)
<!-- Reopened by adversarial verify (three-way routing). Each task below is a verify
     UNMET finding: the capability's core logic exists but is not wired end-to-end (or a
     validation boundary is broken). These re-open work that 12.1b/14 marked [x] but did
     not actually land. SPEC-DEFECT findings are recorded in design.md "Open Questions"
     instead and intentionally have no task here. -->

- [x] VR.1 [guardrails] Wire the concurrency semaphore into the tasks lifecycle: call `GuardrailsService.admit()` on task creation (from `TasksService.create` / `TasksController`) and `GuardrailsService.onTerminal()` when a task reaches a terminal state. Today `admit`/`onTerminal` (guardrails.service.ts:93-129) have zero callers outside `guardrails/`, so the FIFO semaphore (semaphore.ts:34-161) never bounds running tasks. Re-opens 12.1b. (Requirement: "Concurrency semaphore bounds running tasks".)
- [x] VR.2 [guardrails] Make the wall-clock deadline actually arm and tear down: ensure `admit()` is invoked so `startRunning → deadlines.armAfter` runs, and add a real sandbox teardown to the `SandboxProvider` port (sandbox-provider.port.ts:49-56 only exposes `getSandboxMode()`) so `forceFail/teardownSession` (guardrails.service.ts:154-178) stops/kills the running sandbox container, not just creds+token. Without this the deadline is never armed and the sandbox is never torn down. (Requirement: "Wall-clock deadline force-fails a task".)
- [x] VR.3 [guardrails] Wire the idle ceiling: call `GuardrailsService.recordActivity()` from the PTY-output path (terminal.gateway.ts:626-646) and from runner hook events (runner/src/hooks/**), call `admit()` on create and `onTerminal()` on completion. Currently the `IdleTracker` (idle-tracker.ts:58-179) is armed inside guardrails but no external caller ever feeds it activity, so wedged tasks are never reclaimed. Re-opens 12.1b. (Requirement: "Idle ceiling reclaims wedged tasks".)
- [x] VR.4 [guardrails] Route start/turn failure and success signals into the circuit breaker: call `GuardrailsService.recordFailure()` on agent-failed-to-start / turn failure (e.g. from `OrchestratorReporter.reportAgentFailedToStart`, task-entry.ts:195-205, and terminal-gateway dial-back events) and `recordSuccess()` on a successful start/turn. Today `recordFailure`/`recordSuccess` (guardrails.service.ts:109-114) have zero external callers, so the breaker counter never increments and a burn loop is never stopped. Re-opens 12.1b. (Requirement: "Circuit breaker on repeated start/turn failure".)
- [x] VR.5 [guardrails/runner-dialback-and-creds] Wire natural-completion credential teardown: call `GuardrailsService.onTerminal()` (guardrails.service.ts:124-129) on normal task completion/failure so `creds.destroyForSession` + `taskTokens.revokeForTask` run on the happy path. Today only the forced-failure paths (deadline/idle/circuit-breaker → `forceFail`) destroy creds; the natural-completion path is dead code, so credentials and TASK_TOKENs leak on every cleanly-completing task. Re-opens 12.1b. (Requirement: "Ephemeral credentials destroyed with the session".)
- [x] VR.6 [monorepo-foundation] Replace the runner's local contract mirrors with `@cap/contracts`: delete the duplicated schema declarations in `apps/runner/src/hooks/contract.ts` (DecisionBehaviorSchema/DecisionSchema/DecisionEnvelopeSchema/FileEditSchema) and `apps/runner/src/notify/contract.ts` (NotifyPayloadSchema/RequestDecisionPayloadSchema) and import from `@cap/contracts` in the 7 consuming runner files. Fix the enum drift: runner uses `'post-tool-use'`/`'git-diff'` vs contracts-authoritative `'post_tool_use'`/`'git_diff'` (approvals.ts:81). (Requirement: "contracts package is the single source of truth".)
- [x] VR.7 [repo-and-task-management] Resolve the CUID/UUID mismatch that throws `ZodError` at the service-validation boundary: `schema.prisma` uses `@default(cuid())` for `Repo.id`/`Task.id` while contracts `task.ts:41,58,60` validates id/repoId as `z.string().uuid()`. Either switch Prisma to UUID defaults or relax the contract id schema to accept CUID — then verify `repoResponseSchema.parse()` / `taskResponseSchema.parse()` no longer throw. (Requirement: "Postgres + Prisma data model for repos and tasks".)
- [x] VR.8 [realtime-terminal/frontend-console] Add terminal geometry synchronization so the "identical cols and rows" parity precondition is reachable at runtime: define a `ResizeFrame` in `packages/contracts`, pass `onResize` from the session page (`apps/web/.../tasks/[id]/page.tsx`) through the WS, dispatch it in `terminal.gateway.ts` to `CodexPtyHandle.resize()` (spawn-codex.ts:104). Without a geometry round-trip the runner PTY stays fixed at 80x24 while the browser auto-fits, so live-frame byte-identity is not guaranteed. (Requirement: "Live-frame parity under PTY parity conditions".)
- [x] VR.9 [realtime-terminal] Inject the real PTY into the backpressure controller so `pty.pause()`/`pty.resume()` actually halt the producer: `terminal.gateway.ts:200` constructs `new BackpressureController()` with no pty arg, so `pty?.pause()`/`pty?.resume()` (backpressure.ts:122,147) silently no-op and `emitFlowSignal` (terminal.gateway.ts:649-663) only sends client control frames. Pass the session's `PausablePty` and verify the producer halts at the 500k HWM. (Requirement: "Server-side backpressure with bounded high-water mark".)
- [x] VR.10 [realtime-terminal] Wire the SnapshotManager lifecycle: instantiate `new SnapshotManager(...)`, call `registerSession()` to populate the gateway sessions Map, and call `snapshots.start()` + `snapshots.feed()` with PTY bytes from the orchestrator integration. Today none of these are called outside the definition files, so `terminal.gateway.ts:689` always hits `if (!session) return` and neither snapshot nor tail-replay frames are ever sent on reconnect. Re-opens 5.4/5.5. (Requirement: "Snapshot plus tail-replay reconnect".)

## Track: verify-reopened (depends: none)
<!-- Reopened by a SECOND adversarial verify pass (three-way routing). Each task below is a
     verify UNMET finding: the capability's core logic exists but a wiring/impl gap (or a
     validation-boundary violation) prevents the requirement from being satisfied end-to-end.
     MET requirements from this pass were folded into verification-report.md; SPEC-DEFECT
     findings (none in this pass) would go to design.md "Open Questions" with no task here. -->

- [x] VR.11 [guardrails] Make the wall-clock deadline arm and the sandbox actually tear down. GAP 1: no task can ever carry a deadline — `tasks.service.ts:86` calls `guardrails.admit(task.id)` with no `deadlineMs`, and `CreateTaskBody` (`packages/contracts/src/task.ts:110-123`) has no `deadline` field, so `startRunning → deadlines.armAfter` (guardrails.service.ts:144-146) never arms a timer. Add a deadline input (contract field + admit() argument) so the deadline scenario is reachable at runtime. GAP 2: `DockerSandboxProvider.teardownSandbox()` (`apps/api/src/sandbox/docker-sandbox.provider.ts:51-54`) is a documented no-op, so `forceFail → sandbox.teardownSandbox()` (guardrails.service.ts:155-175) never stops the running container. Implement a real teardown so the "tear down its sandbox" clause is satisfied. (Requirement: "Wall-clock deadline force-fails a task".)
- [x] VR.12 [monorepo-foundation] Collapse the api-side local `SandboxMode` redeclaration onto `@cap/contracts`. `apps/api/src/sandbox/sandbox-provider.port.ts:28` declares `export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'` as a local literal union even though `packages/contracts/src/sandbox.ts:17` already exports the identical type (re-exported via `packages/contracts/src/index.ts`). This breaks the "no app re-declares a shared schema type that already exists in `packages/contracts`" scenario. Import `SandboxMode` from `@cap/contracts` (as the runner port already does at `apps/runner/src/sandbox/sandbox-provider.port.ts:1`) and delete the local union. (Requirement: "contracts package is the single source of truth".)
- [x] VR.13 [multi-target-deploy/realtime-terminal] Fix the workspace-path env-var mismatch so `session.log` actually lands on the persistent volume. `apps/api/src/terminal/terminal.gateway.ts:980` reads `process.env.WORKSPACES_ROOT`, but no deploy config sets `WORKSPACES_ROOT` — only `WORKSPACES_DIR` is set (`docker-compose.yml:28`, `apps/api/fly.toml:24`, `apps/api/Dockerfile:51`). In production the gateway falls back to `path.resolve(process.cwd(), 'workspaces')` inside the ephemeral container layer, so `session.log` is written/read off-volume and does NOT survive a restart. Make the gateway read `WORKSPACES_DIR` (or align the deploy configs to also export `WORKSPACES_ROOT`) so the persistent-volume path is used. (Requirement: "Persistent volume for session.log survives restart".)

## Track: verify-reopened (depends: none)
<!-- Reopened by a THIRD adversarial verify pass (three-way routing). Each task below is a
     verify UNMET finding: the capability's core logic exists but the last wiring hop is
     dead code, so the requirement is not satisfied end-to-end. MET requirements from this
     pass were folded into verification-report.md; this pass produced no SPEC-DEFECT findings
     (no design.md "Open Questions" entry added). -->

- [x] VR.14 [realtime-terminal/runner-dialback-and-creds/frontend-console] Close the terminal-geometry round-trip so the "identical cols and rows" parity precondition is reachable at runtime. The signal travels browser → `ws-client.ts` `sendResize()` → `terminal.gateway.ts:432-433` (dispatch) → `:844-853` `onResize() → session.pty.resize()` → `RunnerPtyProxy.resize()` (`:1029-1037`, forwards a `ResizeFrame` over the runner WS) → `DialBackClient.onControl` (`apps/runner/src/dialback/dialback-client.ts:159-166`, validates inbound resize), but the LAST hop is dead code: `DialBackClient.onControl` has no concrete wiring to `CodexPtyHandle.resize()` (`apps/runner/src/pty/spawn-codex.ts:104`), and `apps/runner/src/task-entry.ts` never instantiates `DialBackClient` at all, so the `onControl` callback is optional and never provided. The runner PTY therefore stays at its spawn default 80x24 regardless of browser resize, making live-frame byte-identity unverifiable. Instantiate `DialBackClient` in the runner integration path and wire its `onControl` resize callback to `CodexPtyHandle.resize(cols, rows)`. (Requirement: "Live-frame parity under PTY parity conditions".)
