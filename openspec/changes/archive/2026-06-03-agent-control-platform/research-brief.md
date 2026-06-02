# Research Brief: agent-control-platform

This brief synthesizes the deep-research fan-out across three routes (Web / Codebase / Archive)
for the `agent-control-platform` change. Each finding is attributed to its route below, followed
by a consolidated **Implications for the proposal** section that the proposal, design, and specs
should ground themselves in.

This is a side-car artifact: it lives in the change directory but is intentionally OUTSIDE the
OpenSpec artifact dependency graph and must not be wired into it.

---

## Web Route

External documentation, source repos, and prior-art orchestrators that validate (or refine) the
platform's hard architectural decisions.

### 1. Codex hooks support a synchronous BLOCKING decision round-trip
The Codex `PermissionRequest` hook returns JSON with `decision.behavior: "allow" | "deny"` (plus an
optional `message`); when multiple matching hooks return decisions, **any `deny` wins**. `PreToolUse`
can block via `permissionDecision: "deny"` / exit code 2 and can rewrite input via `updatedInput` +
`permissionDecision: "allow"`. `PostToolUse` runs **after** execution and cannot undo a command.
`SessionStart`/`Stop` support continuation decisions.
- Evidence: https://developers.openai.com/codex/hooks (verified via WebFetch); corroborated by
  https://github.com/openai/codex/issues/15311 (Add blocking PermissionRequest hook for external approval UIs)
- Relevance: Directly validates the `agent-events-and-approvals` core mechanism — the blocking hook
  forwards the event, blocks, and prints the user's `{decision}` to stdout. The "any deny wins" rule
  and the allow/deny/message JSON shape should be encoded **literally** in the runner's hook-forwarder
  contract and the `ApprovalRequest` model. Confirms `PostToolUse` is post-hoc, so file-edit
  **reporting** (not gating) is its role.

### 2. Bug #17532 is real and current: repo-local `.codex/config.toml` hook config does not fire
Repo-local `.codex/config.toml` loads for normal project config, but its **hook** config does NOT fire
for interactive `SessionStart`/`Stop` hooks (reported v0.120.0, macOS, Apr 2026). Hooks must be placed
**top-level** (not under `[features]`, which throws a TOML type error). Separately, #19199 reports
codex-cli 0.124.0 can **FAIL TO START** when hook config is present and `codex_hooks` is enabled.
- Evidence: https://github.com/openai/codex/issues/17532 ; https://github.com/openai/codex/issues/19199
- Relevance: Confirms the hard decision to configure hooks via `~/.codex/hooks.json` baked into the
  runner image rather than repo-local config. The #19199 startup-failure regression is new risk: the
  runner image should **pin a known-good Codex version**, and the runner must surface
  "agent failed to start" as a **distinct task state**, not hang.

### 3. Codex hook tool coverage is partial: shell + apply_patch + MCP, but not all shell calls
`PreToolUse` fires before Bash, `apply_patch` (file edits), AND MCP tool calls — but the docs
explicitly state "This doesn't intercept all shell calls yet, only the simple ones" and note
limitations for newer shell mechanisms and tools like WebSearch.
- Evidence: https://developers.openai.com/codex/hooks (verified via WebFetch)
- Relevance: Refines the stated **known coverage hole**. The danger-command `PreToolUse` policy engine
  must NOT be the sole safety boundary (reinforces "sandbox isolation is primary"), and the git-diff
  fallback for file-edit reporting should stay regardless of hook coverage.

### 4. Codex Agent SDK / exec / app-server emit structured JSONL events, never the TUI byte stream
The Codex Agent SDK spawns the CLI and exchanges JSONL events over stdin/stdout, emitting structured
`ThreadEvent`/`ThreadItem` (`thread.started`, `turn.*`, `item.*` including agent messages, reasoning,
`command_execution`, `file_change`, MCP calls). Two transports exist: `codex exec --json` (JSONL) and
a stateful `codex app-server` speaking newline-delimited JSON-RPC. **Neither emits the TUI ANSI byte stream.**
- Evidence: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md ;
  https://developers.openai.com/codex/noninteractive ; hexdocs.pm/codex_sdk architecture guide
- Relevance: Confirms the non-negotiable interaction-model decision: **only interactive `codex` is
  byte-identical**; exec/app-server/SDK are headless and structured. Validates running the REAL
  interactive CLI under node-pty for the terminal channel, with app-server JSON-RPC as a possible
  (deferred) alternative source for structured events if hook coverage proves insufficient.

### 5. xterm.js has a hardcoded ~50MB write buffer and needs app-level backpressure
xterm.js has a hardcoded ~50MB input write buffer (excess discarded) and processes only 5-35 MB/s vs
GB/s producers. Recommended backpressure: `term.write(chunk, callback)` + `pty.pause()`/`resume()`; for
efficiency use high/low watermarks (HIGH should stay <= 500K bytes to keep keystrokes snappy; an
advanced variant tracks pending callbacks, pause >5, resume <2). WebSocket has **no native flow-control
hooks**, so app-level ACK pause/resume messages are required across the socket. Coalescing via
`requestAnimationFrame` cuts `term.write()` calls from hundreds/s to ~60/s.
- Evidence: https://xtermjs.org/docs/guides/flowcontrol/ (verified via WebFetch); corroborated
  https://github.com/xtermjs/xterm.js/issues/2077
- Relevance: Gives concrete, citable numbers for the `realtime-terminal` backpressure / coalescing /
  pause-output requirements. The control channel needs explicit ACK-based pause/resume frames, and the
  runner byte-pump must respect a server-side high-water mark. The 500K cap and rAF coalescing are
  testable acceptance conditions.

### 6. xterm.js SerializeAddon + headless client enable snapshot-and-tail reconnect
`@xterm/addon-serialize` (v4+) serializes the terminal framebuffer to a string (or HTML) that can be
written back to restore visible state with correct cursor position — best restored **before**
`Terminal.open()` into a terminal of the **SAME size**. xterm.js also supports a headless (no-renderer)
client for server-side state; the canonical reconnect pattern is: server stores session data, on
reconnect creates a new Terminal and streams stored data.
- Evidence: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize ;
  https://github.com/xtermjs/xterm.js/discussions/4467 ; https://github.com/xtermjs/xterm.js/issues/595
- Relevance: Validates the WS-native snapshot+tail replay design — periodic headless-serialize snapshots
  + a raw append-only `session.log`. The "same-size restore" constraint means snapshots must record
  cols/rows and reconnect must reconcile resize. Confirms scrollback never byte-matches (client keeps
  its own buffer), supporting speccing byte-identity as **live-frame-only under PTY parity**, not a total promise.

### 7. asciicast v2 is an append-only, interruption-safe, HTTP-seekable recording format
asciicast v2 (`.cast`, media type `application/x-asciicast`) is a JSON header line + append-only event
stream (3-element arrays), written incrementally so long sessions cost only disk and survive interruption
without losing the recording. asciinema can play from HTTP(S) URLs; `m` marker events act as navigation breakpoints.
- Evidence: https://docs.asciinema.org/manual/asciicast/v2/ ; https://docs.asciinema.org/manual/player/loading/
- Relevance: Confirms using asciinema `.cast` over HTTP for seekable archival/history replay (WS can't
  seek). The append-only incremental write model mirrors the `session.log` source-of-truth design, and
  `.cast` is a near-drop-in serialization of the same raw byte stream the PTY emits — low implementation
  cost for the (deferred-polish) history page.

### 8. Vercel serverless functions categorically cannot host WebSocket connections
Vercel serverless functions cannot host WebSocket connections (each invocation terminates after
responding; no persistent process) — true even with Fluid Compute. Vercel's own KB recommends offloading
WS to Ably/Pusher/Partykit/etc. OR hosting the WS server on a dedicated container/VM/managed server while
Next.js stays on Vercel.
- Evidence: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections ;
  https://ably.com/topic/ai-stack/websockets-on-vercel-why-serverless-functions-cant-host-them
- Relevance: Hard-confirms the deployment decision — Vercel hosts **web only**, pointing at a Fly/VPS
  backend; the stateful NestJS WS+PTY orchestrator cannot run serverless. Reinforces that web and api
  must be independently deployable with env-configurable `API_BASE_URL` and `WS_URL` (never same-origin).

### 9. Fly.io supports the stateful-orchestrator profile (persistent Machines, WS, volumes, Postgres)
Fly.io supports persistent Machine instances, WebSocket servers, in-memory state between requests,
background workers, persistent volumes ($0.15/GB/mo), and managed/Fly Postgres. Their guidance: choose
Fly when you need persistent connections, WebSockets, long-running processes, or stateful workloads
serverless cannot serve.
- Evidence: https://fly.io/docs/blueprints/work-queues/ ;
  https://community.fly.io/t/deploying-a-nestjs-app-with-postgres/19080 ;
  https://www.13labs.au/compare/fly-io-vs-vercel
- Relevance: Validates Fly.io as the api/orchestrator target (api + Fly Postgres). The persistent-volume
  note matters: `session.log` lives on disk and must survive orchestrator restart — Fly volumes are the
  mechanism, and the multi-target spec should require a volume mount for `workspaces/<id>/session.log`
  on Fly (and a named volume in docker-compose).

### 10. Codex sandbox inside Docker commonly fails — Docker becomes the deploy plane, not the per-task sandbox
Codex sandbox is `read-only | workspace-write (default) | danger-full-access`, via macOS Seatbelt
(`sandbox-exec`) / Linux `bwrap`+seccomp. Inside Docker the inner sandbox commonly FAILS: Docker's
default seccomp blocks bubblewrap `pivot_root` even with `CAP_SYS_ADMIN`; default AppArmor blocks
"make / slave"; Ubuntu 24.04 AppArmor blocks unprivileged namespaces for bwrap. Documented remedy: let
the container provide isolation and run `codex --sandbox danger-full-access` (or
`seccomp=unconfined` + setuid bwrap).
- Evidence: https://developers.openai.com/codex/concepts/sandboxing ;
  https://github.com/openai/codex/issues/16076 ;
  https://codex.danielvaughan.com/2026/04/20/codex-cli-devcontainers-docker-sandboxes-secure-containerised-agents/
- Relevance: Confirms the security-semantics divergence to call out and supports keeping the execution
  sandbox a separate, **deferred `SandboxProvider` port**. The minimal first impl must document that
  Docker-as-execution forces `danger-full-access` (collapsing the inner sandbox) — which is exactly why
  Docker is the **platform deploy plane**, not the per-task execution sandbox. The port should expose
  sandbox-mode as a capability so the deferred Claude Code sandbox-runtime impl can restore OS-level isolation.

### 11. Production-grade prior-art orchestrators mirror this design's shape
Multiple production orchestrators exist: Cloudflare+Anthropic "Claude Managed Agents" (control plane with
built-in UI tracking sandbox state, SSH into machines, observability/log shipping); rivet-dev/sandbox-agent
("Run Coding Agents in Sandboxes, Control Them Over HTTP" — Claude Code, Codex, OpenCode, Amp);
Omnara / Vibe-Kanban / Conductor / Claude Squad / Composio AO (parallel agents, isolated git worktrees
per task, single dashboard). Anthropic's "managed agents" post describes "decoupling the brain from the
hands" and pulling pending events from a session log.
- Evidence: https://blog.cloudflare.com/claude-managed-agents/ ; https://github.com/rivet-dev/sandbox-agent ;
  https://www.anthropic.com/engineering/managed-agents ; https://amux.io/blog/best-multi-agent-orchestrators-2026/
- Relevance: Establishes the competitive/prior-art landscape and validates core architectural choices
  (session-log as source of truth; isolated workspace per task; agent-agnostic-by-protocol control plane).
  The differentiator to emphasize: **PURE-TERMINAL byte-identity** (most prior art renders structured
  events, not the raw TUI) plus a **single-user, self-hostable** footprint — "we are not reinventing; we
  are the byte-identical, single-user, self-hosted point in this space."

### 12. Dial-back / reverse-connection runner with short-lived per-sandbox tokens is established prior art
Infisical agent-vault mints short-lived vault-scoped tokens and passes proxy config into a sandboxed
agent; rivet sandbox-agent connects via base URL + token over HTTP and deploys to E2B/Daytona/Vercel/custom.
Anthropic's managed-agents architecture provisions containers on demand and pulls events from the session
log so no inbound port per sandbox is needed.
- Evidence: https://github.com/Infisical/agent-vault ; https://github.com/rivet-dev/sandbox-agent ;
  https://www.anthropic.com/engineering/managed-agents
- Relevance: Validates the runner-dials-back + `TASK_TOKEN`-auth design (no inbound ports per sandbox).
  Confirms ephemeral, sandbox-scoped credentials as the established safety pattern — directly supporting
  that ephemeral creds destroyed with the session are the **primary** boundary. The contracts package
  should define the dial-back handshake (`TASK_TOKEN`) as a first-class WS frame type.

### 13. tmux validates single-writer/multi-reader but has no lease/heartbeat/takeover primitive
tmux offers read-only attach (`mode-readonly` / `-r`) and shared sessions, but standard tmux has NO
lease/heartbeat/preemptive-takeover primitive — those are custom application-layer mechanisms. Running
5-10 Claude Code sessions across machines with raw terminals is reported as unmanageable, motivating dashboards.
- Evidence: https://www.fosslinux.com/106791/collaborating-in-real-time-using-tmux-with-multiple-users.htm ;
  https://blog.marcnuri.com/ai-coding-agent-dashboard
- Relevance: Confirms write-lock + preemptive takeover (lease + heartbeat + auto-release on disconnect)
  must be built at the **application layer** in the orchestrator (the in-memory
  `Map<sessionId,{writerClientId,leaseExpiry}>`), not delegated to tmux. Reinforces the distinction that
  raw keystrokes need the lock but structured one-shot approvals are lock-independent — a design point
  with no off-the-shelf equivalent, needing explicit spec/test coverage.

### 14. pnpm workspace + Turborepo + shared zod "contracts" package is the established monorepo pattern
`packages/contracts` (zod schemas + inferred TS) as single source of truth, consumed via `workspace:*` by
api/web/worker; Turborepo orders builds with `dependsOn: ["^build"]` and caches (30s -> 0.2s on cache hit).
Zod gives runtime validation + TS inference of the same API contract.
- Evidence: https://medium.com/@TheblogStacker/2025-monorepo-that-actually-scales-turborepo-pnpm-for-next-js-ab4492fbde2a ;
  https://dev.to/yasinatesim/monorepo-architecture-with-pnpm-workspace-turborepo-changesets-g0j
- Relevance: Validates the `monorepo-foundation` spec. Actionable: enforce build ordering with
  `dependsOn: ["^build"]` so `packages/contracts` always builds before api/web/runner; the
  zod-as-runtime-validator point means REST DTOs and WS frames should be **parsed** (not just typed) at
  the boundary on both api and runner sides — a testable strict-mode requirement.

### 15. Notification adapters (ntfy / Telegram / Bark) split into one-way push vs round-trip decision
ntfy is an open-source PUT/POST push server (simple REST, native iOS app, apt-installable, self-hostable),
commonly paired with Telegram bot alerts (BotFather token + chat_id). Telegram inline approve/deny buttons
require the Bot API callback/webhook mechanism (not a turnkey ntfy feature).
- Evidence: https://ntfy.sh/ ;
  https://medium.com/linux-shots/setup-telegram-bot-to-get-alert-notifications-90be7da4444 ;
  https://github.com/Tokagero13/server-ntfy
- Relevance: Supports the notification-adapter design in `agent-events-and-approvals`. Actionable:
  ntfy/Bark are one-way push (good for "awaiting input" Stop signals), but the real remote approve/deny
  **round-trip** requires Telegram inline-button callbacks routed back through a REST endpoint (the
  lock-independent approval path). Spec the adapter port with two capabilities: `notify` (one-way) and
  `request-decision` (round-trip), since not all channels support the latter.

---

## Codebase Route

The state of THIS repository and the OpenSpec/workflow machinery that the change must conform to.

### 1. The repo is greenfield for application code
There is NO `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig*.json`, lockfile,
`docker-compose.yml`, `Dockerfile`, `fly.toml`, or `vercel.json` anywhere, and no `apps/` or `packages/`
directories. The entire monorepo (pnpm+turbo, `apps/api|web|runner`,
`packages/contracts|ui|eslint-config|tsconfig`) must be created from scratch by the `monorepo-foundation` capability.
- Evidence: `find .` for build/config files returned empty; `ls -d apps packages` => none; `git ls-files`
  shows only `.claude/`, `openspec/`, `.gitignore` (26 tracked files)
- Relevance: Confirms "greenfield" framing for the proposal Impact section. Capability #1
  (`monorepo-foundation`) is the true root track everything else depends on — there is no existing
  scaffolding to extend, only to author.

### 2. The strict-TS / ESLint enforcement Claude Code hooks do NOT yet exist in this repo
`.claude/` contains only `commands/`, `skills/`, `workflows/`, `worktrees/` — there is no `settings.json`
or `settings.local.json`. The demanded PostToolUse `tsc --noEmit` + eslint and Stop/pre-commit gating
hooks are net-new.
- Evidence: `ls -la .claude/` shows only commands skills workflows worktrees; `find .claude -name 'settings*.json'` returned nothing
- Relevance: The "Claude Code hooks in THIS repo" enforcement layer (place #2 of the three strict-TS
  places) is net-new work — `monorepo-foundation` must author `.claude/settings.json` hooks plus
  husky+lint-staged, not assume any exist.

### 3. tasks.md MUST use the Track format the apply workflow parses
`## N. Track: <kebab-name> (depends: <track>|none)` headers and `- [ ] N.Y <task>` checkboxes;
cross-track deps go ONLY in the header's depends list, never in a task line; tasks within a track run
serially in declared order; the apply phase corrects the draft partition against real file coupling.
- Evidence: `openspec/schemas/spec-driven/schema.yaml:214-235` (tasks instruction);
  `openspec/schemas/spec-driven/templates/tasks.md:5-13`; `.claude/workflows/opsx-apply-tracks.js:60-69`
  (Correct phase rewrites headers); `.claude/workflows/README.md:35-46`
- Relevance: This change ships in ONE OpenSpec change absorbed by track-based parallel apply — the 9
  suggested capabilities must be expressed as Tracks with correct `depends` edges (e.g.
  contracts/foundation as a `depends: none` root, api/web/runner tracks depending on it) for the parallel
  worktree apply to work.

### 4. Apply gates parallel execution on APPLY_PARALLEL_THRESHOLD=12 and requires a runnable build
The apply workflow gates parallelism on `APPLY_PARALLEL_THRESHOLD=12` pending tasks; a large 9-capability
change far exceeds it, triggering opsx-apply-tracks: topological waves by `depends`, each track in an
isolated git worktree (concurrency cap 16), merge, then a build/test verify with a bounded repair loop
(`MAX_REPAIR_ROUNDS=3`), reporting success ONLY on green build + no track failures + empty `[x]` ledger.
- Evidence: `.claude/workflows/opsx-apply-tracks.js:17-18, :72-90` (toWaves), `:106-123` (worktree
  isolation), `:139-162` (build verify loop), `:205-218` (honest success gate)
- Relevance: Design/tasks must supply a runnable `buildCmd` (e.g. `turbo build` / `turbo typecheck lint`)
  because the apply verify-build step discovers and runs the project build — a monorepo with no working
  build script would make apply report `success:false`. The track partition must keep capabilities on
  disjoint files so worktrees don't collide.

### 5. Worktree isolation requires git-init at SESSION START; this repo already satisfies it
Worktree isolation requires the repo to be git-initialized at session start (mid-session `git init` is NOT
picked up); merged worktrees land under `.claude/worktrees/` with `worktree-*` branches and are pruned by
a Cleanup phase. The repo is already a git repo (branch main, commit dea5928); `.claude/worktrees/` exists but is empty.
- Evidence: `openspec/changes/archive/2026-05-31-enhance-openspec-with-workflows/tasks.md:59`;
  `git worktree list` shows only the main tree; `ls .claude/worktrees/` empty;
  `.claude/workflows/opsx-apply-tracks.js:176-203` (Cleanup phase)
- Relevance: Apply-time parallelism for this large change will actually use worktrees — the precondition
  is already met (git repo exists), and the author should not be surprised by `.claude/worktrees/` entries
  appearing during apply.

### 6. opsx-verify enumerates every Requirement and gates the change on pass:true
After apply, opsx-verify enumerates every `### Requirement:` across `specs/**/spec.md`, statically triages
each (met/confidence/risk + file:line evidence), escalates high-risk/low-confidence ones to a 5-lens
refutation panel plus a dynamic run-a-test check, and routes findings: unmet -> reopened tasks in tasks.md,
spec-defect -> design Open Questions, met -> verification-report.md. The change is NOT done while verify
returns `pass:false`.
- Evidence: `.claude/workflows/opsx-verify.js:53-60` (enumerate), `:64-114` (triage+escalate), `:119-148`
  (three-way route), `:150-159` (pass gate); schema apply.instruction STAGE 2 at
  `openspec/schemas/spec-driven/schema.yaml:283-291`
- Relevance: Specs must be written as testable Given-When-Then scenarios with observable criteria
  (exactly 4-hashtag `#### Scenario:` blocks). Vague requirements like "byte-identical terminal" or
  "effectively remote RCE" will be flagged as spec-defects unless phrased with explicit, checkable
  conditions — aligning with the proposal's own instruction to spec byte-identity as conditions, not promises.

### 7. Specs use OpenSpec delta format; every capability here is purely ADDED
Specs use `## ADDED/MODIFIED/REMOVED Requirements`, each `### Requirement:` with SHALL/MUST normative
language and >= 1 `#### Scenario:` (EXACTLY 4 hashtags — 3 fails silently). Since `openspec/specs/`
currently holds only the three workflow-tooling specs and this change adds 9 unrelated platform
capabilities, every capability spec will be `## ADDED Requirements` (no MODIFIED).
- Evidence: `openspec/schemas/spec-driven/schema.yaml:75-99, :96-97` (4-hashtag rule); `openspec/specs/`
  contains only adversarial-spec-verify, deep-research-proposal, parallel-track-apply; demo example
  `openspec/changes/demo-workflow-smoketest/specs/contributor-docs/spec.md:1-53`
- Relevance: Provides the exact spec authoring contract and confirms the proposal's "Modified
  Capabilities" section will be empty (purely additive), since no existing spec covers
  cloud-agent-platform concerns.

### 8. The archived workflows change is the canonical multi-capability, multi-track exemplar
The archived `enhance-openspec-with-workflows` change is one change with multiple capability specs (3 under
`specs/`) and a tasks.md with 7 numbered Tracks wired by `depends` (scaffolding as the `depends: none`
root; downstream tracks depending on it; a final validation/docs track depending on multiple).
Capabilities map 1:1 to spec folders and to tracks.
- Evidence: `openspec/changes/archive/2026-05-31-enhance-openspec-with-workflows/` (proposal.md, design.md,
  tasks.md, specs/{3 capabilities}); `tasks.md:4-60` shows the 7-track depends-graph
- Relevance: Directly reusable structural template for packaging 9 capabilities into ONE change — one
  spec per capability, tracks mirroring capabilities, a foundation root track, integration/docs as a
  dependent tail track.

### 9. Per-change directory anatomy is fixed; this change dir is already scaffolded
A change lives at `openspec/changes/<change-name>/` with `.openspec.yaml` (`schema: spec-driven` +
created date), proposal.md, design.md, tasks.md, and `specs/<capability>/spec.md` per capability. Side-car
files research-brief.md and verification-report.md are intentionally OUTSIDE the schema dependency graph.
`openspec/changes/agent-control-platform/.openspec.yaml` already exists with
`schema: spec-driven, created: 2026-05-31`.
- Evidence: `openspec/changes/demo-workflow-smoketest/` full tree; existing
  `openspec/changes/agent-control-platform/.openspec.yaml`; README boundary note `.claude/workflows/README.md:56-59`
- Relevance: The change dir is already scaffolded with `.openspec.yaml`; proposal/specs/design/tasks just
  need authoring into it following this fixed anatomy, and any research-brief.md/verification-report.md
  must stay side-car.

### 10. The propose phase runs opsx-propose-deep — this very task is its codebase route
opsx-propose-deep does a parallel research fan-out over three routes (web / codebase / archive) merged into
research-brief.md before the proposal is written; the proposal then grounds its Capabilities section (each
capability => a new `specs/<name>/spec.md`, kebab-case) in that brief.
- Evidence: `.claude/workflows/opsx-propose-deep.js:42-60` (parallel routes incl. the verbatim codebase
  prompt at `:46`); schema proposal.instruction `openspec/schemas/spec-driven/schema.yaml:9-55`
- Relevance: Confirms the workflow context: the 9 suggested capabilities should become 9 kebab-case spec
  folders named in the proposal's New Capabilities list, and design.md should capture the HARD DECISIONS
  (PTY byte-identity conditions, SandboxProvider port, WS dual-channel, write-lock, Postgres+Prisma, 3
  deploy targets) as Decisions with rationale/alternatives.

---

## Archive Route

The single prior change in the archive, mined for structural/process conventions (not domain content).

### 1. The archive holds exactly ONE prior change; the new domain is greenfield in subject matter
The archive contains only `2026-05-31-enhance-openspec-with-workflows`. There is no prior
cloud/agent/sandbox/orchestrator change to mine for domain content. The only similarity is STRUCTURAL
(how to author a large multi-capability OpenSpec change) plus the fact that the archived change IS the
tooling the new proposal's apply phase will run on.
- Evidence: `openspec/changes/archive/` contains only `2026-05-31-enhance-openspec-with-workflows/` (find -maxdepth 2)
- Relevance: Set expectations — there is no precedent for the cloud-agent domain itself. Reuse the
  archived change purely as a structural/process template and as a manual for the workflow machinery, not
  as a source of cloud-agent design content.

### 2. Standard artifact layout to mirror: one spec.md per capability
`changeDir/` holds proposal.md, design.md, tasks.md, `.openspec.yaml` (just `schema: spec-driven` +
`created:`), and `specs/<capability>/spec.md` — ONE spec.md per capability. The 9 suggested capabilities
map cleanly (`specs/monorepo-foundation/spec.md`, `specs/repo-and-task-management/spec.md`, etc.).
- Evidence: archived change tree: proposal.md, design.md, tasks.md, .openspec.yaml,
  specs/{deep-research-proposal,parallel-track-apply,adversarial-spec-verify}/spec.md
- Relevance: Confirms the directory shape and the one-spec-per-capability convention for the 9 capability specs.

### 3. proposal.md uses a fixed section order with bold-led decision bullets and explicit boundaries
Section order: `## Why` (the pain) -> `## What Changes` (bulleted, bold lead-ins + an explicit
boundary/non-goal bullet) -> `## Capabilities` with `### New Capabilities` / `### Modified Capabilities`
(each capability one bullet: `` - `name`: one-line scope ``) -> `## Impact` (New files, dependencies,
constraints). Hard architectural decisions are stated as bold-led bullets; explicitly-rejected
alternatives are called out so they are not re-litigated.
- Evidence: `openspec/changes/archive/2026-05-31-enhance-openspec-with-workflows/proposal.md` lines 1-31
- Relevance: Directly reusable skeleton. The new proposal's "HARD DECISIONS ALREADY MADE (do not
  re-litigate)" block maps onto this bold-bullet + explicit-boundary style; list the 9 capabilities under
  `### New Capabilities` and put `### Modified Capabilities` as a `<!-- None -->` comment (greenfield).

### 4. specs/<cap>/spec.md uses a strict, machine-parsed Requirement/Scenario format
Top-level `## ADDED Requirements`, then `### Requirement: <imperative SHALL/MUST sentence>`, then one or
more `#### Scenario: <name>` each with `- **WHEN** ... - **THEN** ... - **AND** ...` bullets. Every
requirement has >= 1 scenario; scenarios avoid non-observable terms ("fast", "clean") without a measurable
criterion. The verify workflow ENUMERATES these headers, so the format is load-bearing, not cosmetic.
- Evidence: `specs/parallel-track-apply/spec.md` (### Requirement / #### Scenario / WHEN-THEN-AND);
  enforced by `opsx-verify.js` REQ_LIST schema requiring `{capability,name,scenarios}` and
  `opsx-propose-deep.js` rejecting non-observable criteria
- Relevance: For byte-identity, PTY-parity, write-lock, approval round-trip, etc., scenarios MUST be
  written as observable WHEN/THEN with measurable criteria (e.g. "`TERM=xterm-256color` is set" not
  "terminal looks right"), or the adversarial verify phase flags them as spec-defects and routes them back to design.

### 5. tasks.md Track format is the single most reusable mechanical convention
A leading HTML comment explaining the convention, then `## N. Track: <kebab-name> (depends:
<track-name>|none)` headers, with `- [ ] N.Y <task>` checkboxes. Tasks within a track run SERIALLY;
independent tracks (disjoint files) run in PARALLEL worktrees. `depends:` lists prerequisite TRACKS by
name (never inline). Each task line can carry a trailing `— satisfies "<scenario phrase>"` to trace it to a spec scenario.
- Evidence: `.claude/workflows/README.md` "Track format" section; archived tasks.md lines 1-9
  (`## 1. Track: scaffolding (depends: none)`); demo tasks.md (`## 1. Track: contributing-guide (depends: none)`)
- Relevance: The 9 capabilities should become ~9-12 tracks with explicit depends edges (e.g. everything
  depends on `monorepo-foundation`; `realtime-terminal` and `agent-events-and-approvals` depend on
  `terminal-execution`). Get the partition and depends edges right at propose time so apply's correction
  step has a good draft.

### 6. APPLY_PARALLEL_THRESHOLD=12 will be crossed; size to K <= ~12 tracks
`APPLY_PARALLEL_THRESHOLD = 12` pending tasks triggers parallel; below it apply runs serially (the
always-correct fallback). Concurrency is capped at 16 tracks / 1000 total agents. The number is duplicated
in `opsx-apply-tracks.js` AND mirrored in the schema's apply.instruction text (no shared import in workflow scripts).
- Evidence: `opsx-apply-tracks.js` line ~16 `const APPLY_PARALLEL_THRESHOLD = 12`;
  `.claude/workflows/README.md` "Threshold & fallback"; design.md D2 (~8-12 tracks for 60-80 tasks)
- Relevance: This change is explicitly large ("absorb the size" via track-based parallel apply), so it
  WILL run parallel. Size tracks so total count K <= ~12 and keep tasks-per-track serial; the 9
  capabilities are already a near-ideal partition granularity (one track per capability).

### 7. Avoid shared/cross-cutting files in parallel tracks — route them to a serial integration track
Shared files in two parallel tracks cause merge conflicts. The design forces shared-file tasks into a
single serial "integration track"; apply runs a correction agent that scans real file coupling and
rebalances. The biggest verified failure mode is bad partition -> merge hell.
- Evidence: design.md D3/D4 and Risks section ("Bad track partition -> merge hell"); spec "Shared-file
  tasks are isolated"; `opsx-apply-tracks.js` TRACKS_SCHEMA requires per-track `files` list + an `integrationTrack`
- Relevance: For this monorepo, `packages/contracts` (zod schemas / shared DTOs / WS frame protocol) is
  the canonical shared file touched by api, web, AND runner. Make `monorepo-foundation` (which establishes
  contracts) a `depends: none` FOUNDATION track that everything else depends on, and keep contracts edits
  OUT of the parallel feature tracks (or route them to the serial integration track) to avoid the
  documented merge-hell failure mode.

### 8. design.md follows a documented section order with named, rebutted alternatives
Order: `## Context` -> `## Goals / Non-Goals` -> `## Decisions` (numbered D1..Dn, each: decision +
"Why over <rejected alternative>" + "Trade-off") -> `## Risks / Trade-offs` (risk -> mitigation,
cross-referencing the D-numbers) -> `## Migration Plan` -> `## Open Questions`. Decisions explicitly name
and rebut the rejected alternative.
- Evidence: design.md lines 1-94 (Context, Goals/Non-Goals, D1-D11 with "Why over", Risks, Migration Plan, Open Questions)
- Relevance: Reusable design.md skeleton. The new proposal already supplies the decisions (PTY
  byte-identity vs SDK, WS uplink vs REST, Postgres vs SQLite, sandbox-as-deferred-port, Vercel web-only)
  and their rejected alternatives — slot them in as numbered D-decisions with the "Why over X" rebuttal so
  they read as settled, matching the "do not re-litigate" instruction.

### 9. Use side-car files for non-schema artifacts; design.md must exist before tasks.md
Side-car files (research-brief.md by propose-deep, verification-report.md by verify) live in the change
dir but are intentionally OUTSIDE the artifact dependency graph, so adding them never retroactively
invalidates other changes. Conversely, the artifact graph requires design.md before tasks.md (tasks
depends on design).
- Evidence: design.md D9 (side-car, not schema artifacts) and dry-run "Bug D — propose-deep skipped
  design (fixed); tasks requires design"
- Relevance: Do NOT invent new required artifacts for this large change (e.g. an architecture.md as a
  schema artifact) — it would break the graph. Keep deep research output as research-brief.md side-car, and
  ensure design.md is actually generated before tasks.md.

### 10. Operational gotchas for parallel-worktree apply (this repo avoids the worst one)
(1) The repo MUST be git-initialized at Claude Code SESSION START — a mid-session `git init` is NOT picked
up and worktree isolation silently degrades to serial. (2) Merged worktrees and `worktree-*` branches are
NOT auto-cleaned by default; a Cleanup phase prunes them only when no track failed and the ledger is clean.
(3) `success` is gated on green build AND zero track failures AND empty `[x]` ledger (the dry-run found a
false-success bug where files existed but tasks.md showed 0 done).
- Evidence: design.md "Dry-run findings" Run 1 (worktree-needs-git-at-session-start, Bug B false-success,
  Bug C stale ledger) and Finding F (worktree cleanup); this repo IS already a git repo (gitStatus shows branch main)
- Relevance: This repo is already git-initialized, so the worst gotcha is avoided. But because the new
  change builds a REAL build pipeline (strict tsc + eslint + turbo), the post-merge build-verify + bounded
  repair loop (`MAX_REPAIR_ROUNDS=3`) will actually run — write a runnable build/test command
  (turbo typecheck/lint/build) so apply's integration barrier and verify's dynamic checks have ground
  truth, otherwise verify degrades to static-only.

### 11. The archived change deliberately scoped tight with explicit Non-Goals and a throwaway dry-run
It scoped tightly, declared `### Modified Capabilities` as None, listed explicit Non-Goals to bound the
change, and used a throwaway `demo-workflow-smoketest` change to dry-run the full propose->apply->verify
loop before trusting it.
- Evidence: proposal.md "### Modified Capabilities <!-- None -->"; design.md "Non-Goals"; tasks.md 7.1
  dry-run on demo-workflow-smoketest
- Relevance: Mirrors the new proposal's "backend-first, keep frontend functional-minimal" and explicit
  NON-GOALS list (no multi-user, no token budget, sandbox impl deferred). Reuse this discipline: state the
  deferred items as Non-Goals and as a documented follow-up (the `SandboxProvider` port), exactly as the
  archive deferred the concrete impl behind a port-and-fallback pattern.

---

## Implications for the proposal

Synthesizing across all three routes, the following are settled, evidence-backed positions the proposal,
design.md, and capability specs should adopt.

### A. Interaction model — pure-terminal byte-identity is the differentiator, spec it as conditions
- Run the **real interactive Codex CLI under node-pty**; exec/app-server/SDK are headless and emit
  structured JSONL, never the TUI ANSI stream (Web 4). Byte-identity is therefore a property of the
  interactive path only.
- Spec byte-identity as **observable conditions, not a promise**: live-frame parity under PTY with
  `TERM=xterm-256color` and matching cols/rows (Web 6); scrollback is explicitly NOT guaranteed to byte-match.
  Phrase every such requirement as a checkable WHEN/THEN or opsx-verify will flag it a spec-defect (Codebase 6, Archive 4).
- The differentiator vs prior art (Cloudflare Managed Agents, rivet, Omnara, etc., Web 11) is **raw TUI
  byte-identity + single-user self-hostable**, not structured-event rendering. Say so explicitly.

### B. Events & approvals — encode the Codex hook contract literally; two-capability adapter port
- The `agent-events-and-approvals` runner forwards the blocking `PermissionRequest`/`PreToolUse` event,
  blocks, and prints the user's decision to stdout. Encode the `decision.behavior: allow|deny` + optional
  `message` shape and the **"any deny wins"** rule literally in the contracts package and `ApprovalRequest`
  model (Web 1).
- `PostToolUse` is post-hoc: use it for **file-edit reporting**, never gating; keep the **git-diff
  fallback** because hook tool coverage is partial (shell + apply_patch + MCP, but "not all shell calls", Web 3).
- The danger-command PreToolUse policy engine is NOT the sole safety boundary — **sandbox isolation is
  primary** (Web 3, Web 10).
- Configure hooks via `~/.codex/hooks.json` **baked into the runner image**, top-level (not under
  `[features]`); repo-local `.codex/config.toml` hook config does not fire (Web 2). **Pin a known-good
  Codex version** in the image and surface "agent failed to start" as a **distinct task state**, not a
  hang (Web 2, #19199).
- The notification-adapter port needs **two capabilities**: `notify` (one-way: ntfy/Bark, good for Stop
  "awaiting input") and `request-decision` (round-trip: Telegram inline buttons via a REST callback, the
  lock-independent approval path) — not all channels support the latter (Web 15).

### C. Realtime terminal — concrete, testable backpressure and reconnect numbers
- The `realtime-terminal` spec gets citable acceptance conditions: server-side high-water mark with a
  **<= 500K** cap, `requestAnimationFrame` coalescing (hundreds/s -> ~60/s), `term.write(chunk, callback)`
  + `pty.pause()/resume()` (Web 5).
- WebSocket has **no native flow control** — the control channel needs explicit **ACK-based pause/resume
  frames** defined in contracts (Web 5).
- Reconnect = periodic **headless SerializeAddon snapshot (recording cols/rows) + raw append-only
  `session.log` tail replay**; "same-size restore" means reconnect must reconcile resize (Web 6).
- History/archival uses **asciinema `.cast` over HTTP** for seekable replay (WS can't seek); append-only,
  interruption-safe, a near-drop-in serialization of the same raw byte stream — keep it a deferred-polish
  page (Web 7).

### D. Concurrency control — application-layer write-lock, not tmux
- Build write-lock + preemptive takeover (**lease + heartbeat + auto-release on disconnect**) at the
  application layer in the orchestrator (`Map<sessionId,{writerClientId,leaseExpiry}>`); tmux has no such
  primitive (Web 13).
- Spec the crucial distinction with its own scenario: **raw keystrokes require the lock; structured
  one-shot approvals are lock-independent** — no off-the-shelf equivalent, so it needs explicit spec/test coverage (Web 13).

### E. Sandbox & security — deferred SandboxProvider port; ephemeral creds are the primary boundary
- Keep the execution sandbox a separate, **deferred `SandboxProvider` port** exposing sandbox-mode as a
  capability. Document that **Docker-as-execution forces `danger-full-access`** (the inner Codex sandbox
  collapses inside Docker), which is exactly why Docker is the **platform deploy plane, not the per-task
  execution sandbox** (Web 10). The deferred Claude Code sandbox-runtime impl can restore OS-level isolation.
- **Runner dials back** with a short-lived `TASK_TOKEN` (no inbound port per sandbox); ephemeral
  sandbox-scoped creds destroyed with the session are the **primary safety boundary** (Web 12). Define the
  dial-back handshake as a first-class WS frame type in contracts.

### F. Deployment — three independently-deployable targets, web never same-origin with api
- Vercel hosts **web only**; it categorically cannot host WebSockets even with Fluid Compute (Web 8). The
  stateful NestJS WS+PTY orchestrator runs on **Fly.io** (persistent Machines, WS, Fly Postgres) or via
  **docker-compose** (Web 9).
- web and api must be **independently deployable** with env-configurable `API_BASE_URL` / `WS_URL` (never
  same-origin) (Web 8).
- `session.log` lives on disk and must survive orchestrator restart — require a **volume mount** for
  `workspaces/<id>/session.log` on Fly and a named volume in docker-compose (Web 9).

### G. Foundation & data — pnpm+turbo monorepo with a zod contracts package; Postgres+Prisma
- `monorepo-foundation` authors the whole tree from scratch (greenfield: no package.json / turbo.json /
  configs / apps / packages exist, Codebase 1). It also authors `.claude/settings.json` strict-TS hooks +
  husky + lint-staged, which do not exist yet (Codebase 2).
- `packages/contracts` (zod schemas + inferred TS) is the **single source of truth** consumed via
  `workspace:*`; enforce build ordering with Turborepo `dependsOn: ["^build"]` so contracts builds before
  api/web/runner; **parse (not just type)** REST DTOs and WS frames at the boundary on both api and runner
  sides as a strict-mode requirement (Web 14).

### H. Packaging this into ONE OpenSpec change (the workflow's hard constraints)
- Express the 9 capabilities as **9 kebab-case `specs/<name>/spec.md` folders** and ~9-12 **Tracks** in
  tasks.md, mirroring the archived `enhance-openspec-with-workflows` exemplar (Codebase 3/8, Archive 2/5/8).
- All specs are **`## ADDED Requirements`** (no MODIFIED); `### Modified Capabilities` is `<!-- None -->`
  (greenfield, Codebase 7, Archive 3).
- Make **`monorepo-foundation` the `depends: none` FOUNDATION root** everything depends on; keep
  `packages/contracts` edits OUT of parallel feature tracks (route shared-file work to a serial
  **integration track**) to avoid the documented merge-hell failure mode (Archive 7). Wire dependent
  edges (e.g. `realtime-terminal`, `agent-events-and-approvals` depend on `terminal-execution`; an
  integration/docs tail track depends on multiple).
- The change is large and **will cross APPLY_PARALLEL_THRESHOLD=12**, triggering parallel-worktree apply
  (Codebase 4, Archive 6). Supply a **runnable build command** (`turbo typecheck lint build`) so the
  post-merge build-verify + bounded repair loop (`MAX_REPAIR_ROUNDS=3`) and opsx-verify's dynamic checks
  have ground truth; otherwise apply reports `success:false` and verify degrades to static-only (Codebase 4/6, Archive 10).
- The repo is already git-initialized at session start, so worktree isolation works (Codebase 5, Archive 10).
- **Every requirement must be an observable WHEN/THEN scenario** (exactly 4-hashtag `#### Scenario:`) with
  measurable criteria, or opsx-verify routes it back to design as a spec-defect (Codebase 6, Archive 4).
- Capture the HARD DECISIONS (A-G above) in design.md as numbered **D-decisions with "Why over <rejected
  alternative>"** so they read as settled and are not re-litigated (Codebase 10, Archive 8).
- Keep deferred items (no multi-user, no token budget, concrete sandbox impl behind the port) as explicit
  **Non-Goals** and documented follow-ups; keep research-brief.md / verification-report.md as **side-car**
  files outside the artifact graph; ensure design.md exists before tasks.md (Archive 9/11).
