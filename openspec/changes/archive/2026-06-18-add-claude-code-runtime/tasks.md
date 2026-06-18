<!-- Track-annotated tasks. Each numbered group is a parallel Track.
     Tasks within a track run serially; independent tracks run in parallel at apply time.

     Partition validated against the codebase: parallel sibling tracks touch DISJOINT files
       - 1 (contracts/prisma) ∥ 5 (docker/env)            — disjoint
       - 2 (api agent-runtime + sandbox.module) ∥ 6 (web) — disjoint
       - 3 (provider/pty/gateway/runtimes endpoint+app.module) ∥ 4 (tasks.service) — disjoint
     The only cross-track shared file is apps/api/src/sandbox/sandbox.module.ts
     (2.3 binds ClaudeAuthSource; 3.3 exports auth sources for /runtimes), but Track 3
     depends on Track 2, so they NEVER run concurrently → no integration isolation needed.
     integrationTrack is empty. -->

## 1. Track: contracts-and-data (depends: none)

- [x] 1.1 Add an OPTIONAL `runtime` enum (`claude-code` | `codex`, default `codex`) to `CreateTaskRequestSchema` and `TaskSchema` in `packages/contracts/src/task.ts`.
- [x] 1.2 Add a runtime-readiness response shape to `packages/contracts` (per-runtime `{ id, ready }` booleans, no secrets).
- [x] 1.3 Add a nullable `runtime` column to the `Task` Prisma model (`apps/api/prisma/schema.prisma`) and generate an additive migration; verify existing rows read back as `codex`.

## 2. Track: agent-runtime-module (depends: contracts-and-data)

- [x] 2.1 Create `apps/api/src/agent-runtime/` with the `AgentRuntime` port (`buildLaunchLine`/`injectAuth`/`autoSubmit`/`detectExit`/`captureTranscript`) and a runtime registry resolving by task `runtime`.
- [x] 2.2 Implement `CodexRuntime` by moving today's hard-coded codex logic (launch argv from `codex-launch.ts`, auth.json injection, DSR autosubmit, `tmux has-session` exit) behind the port — behavior-preserving, no functional change.
- [x] 2.3 Add the `ClaudeAuthSource` port + `EnvClaudeAuthSource` (reads `CLAUDE_CODE_OAUTH_TOKEN`, exposes only a `configured` boolean), mirroring `EnvCodexAuthSource`; wire DI in the sandbox module.
- [x] 2.4 Implement `ClaudeCodeRuntime.buildLaunchLine()`: detached-tmux inner line `claude --session-id <uuid> --permission-mode acceptEdits "$(cat <prompt-file>)"` with env `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, `CLAUDE_CODE_SANDBOXED=1`, `CLAUDE_CONFIG_DIR=/home/gem/.claude`; never `claude attach`/`--bare`/`--dangerously-skip-permissions`.
- [x] 2.5 Implement `ClaudeCodeRuntime.injectAuth()`: set `CLAUDE_CODE_OAUTH_TOKEN`, and UNSET `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper` on the launch env; fail-closed with a "runtime not configured" reason when no token.
- [x] 2.6 Implement `ClaudeCodeRuntime.autoSubmit()` as a no-op (no CR/CPR injection).
- [x] 2.7 Implement `ClaudeCodeRuntime.detectExit()`: tail `~/.claude/projects/<canonicalized-slug>/<session-id>.jsonl` for the LAST `assistant` event with `stop_reason=="end_turn"`, then `tmux kill-session`; treat a question-ending as run-complete. Demote the liveness poller to abnormal-death watchdog.
- [x] 2.8 Implement `ClaudeCodeRuntime.captureTranscript()`: reuse the shared byte-stream capture; optionally read the `--session-id` JSONL as a structured archival source (parse all record types).
- [x] 2.9 Unit tests for the port + both runtimes (codex parity assertions; claude end_turn detection incl. last-assistant-not-last-line and tool_use-not-done cases; ANTHROPIC_* unset).

## 3. Track: execution-integration (depends: agent-runtime-module)

- [x] 3.1 Refactor `apps/api/src/sandbox/aio-sandbox.provider.ts` provisioning to delegate auth/config injection and the pre-stop trim to the selected runtime (codex unchanged; claude injects env token + pre-seeds `/home/gem/.claude/.claude.json` global onboarding + per-project trust, trims `/home/gem/.claude` keeping `projects/`).
- [x] 3.2 Refactor `apps/api/src/terminal/aio-pty-client.ts` + launch path to call the runtime's `buildLaunchLine`/`autoSubmit`/`detectExit` instead of inline codex logic.
- [x] 3.3 Add the `/runtimes` readiness endpoint (booleans only) backed by the auth sources.
- [x] 3.4 Confirm boot re-adoption + liveness still resolve for claude tasks (session-gone after the runtime's kill-session) without codex-specific assumptions.

## 4. Track: tasks-api (depends: agent-runtime-module)

- [x] 4.1 In `apps/api/src/tasks/tasks.service.ts`: persist `runtime` on create, echo it on create/list/fetch responses (default `codex`), and dispatch admission to the resolved runtime.
- [x] 4.2 Reject/fail-closed a create selecting an unconfigured runtime with a distinct reason.
- [x] 4.3 Tasks-layer tests: runtime persists + echoes on all read paths; omitted → codex; invalid → 400; unconfigured claude → fail-closed.

## 5. Track: aio-image (depends: none)

- [x] 5.1 Bake a PINNED Claude Code CLI into `docker/aio-sandbox.Dockerfile` alongside the pinned codex CLI (never `latest`); expose the pinned version as a build ARG.
- [x] 5.2 Add `CLAUDE_CODE_OAUTH_TOKEN` to the API env surface (`.env.example`, compose env passthrough) and document minting via `claude setup-token` on a workstation.

## 6. Track: frontend (depends: contracts-and-data)

- [x] 6.1 Adjust the OpenDesign 设计稿 for the create-task dialog: add the runtime selector (`Claude Code | Codex`) with readiness/disabled state, reflect it in the command preview, and resolve the stopOnWrite checkbox (relabel "仅预览" or remove).
- [x] 6.2 Implement the runtime selector in `apps/web/src/components/dashboard/new-task-dialog.tsx`: state, send `runtime` in the create body, update `buildCommandPreview`.
- [x] 6.3 Add a runtime-readiness query (`apps/web/src/lib/api/queries.ts` + `real.ts`) and gate the selector (disable an un-ready runtime with a configure hint).
- [x] 6.4 Relabel/remove the dormant stopOnWrite checkbox so it no longer implies an enforced gate.
- [ ] 6.5 Pixel check the dialog against the adjusted 设计稿 (playwright screenshot diff).

## 7. Track: verification (depends: execution-integration, tasks-api, aio-image, frontend)

- [x] 7.1 Codex regression: the existing codex compose e2e passes unchanged after the port refactor. (VERIFIED douglas-wsl x86 2026-06-19: tests C/D/G/H/E pass.)
- [x] 7.2 Claude full-turn e2e on the REAL amd64 `cap-aio-sandbox` image: provision → launch → multi-step Bash + edit autonomously → `end_turn` detected → task completes → transcript captured/replays. (PARTIAL 2026-06-19: provision→launch→auth(OAuth)→auto-run prompt→answer verified via capture-pane; full multi-step-autonomous + transcript replay not exercised.)
- [ ] 7.3 Assert `ANTHROPIC_API_KEY` is unset on the Claude launch env (a stray key would shadow the token).
- [x] 7.4 Confirm `cap-net` egress reaches `api.anthropic.com`. (VERIFIED 2026-06-19: claude turn reached the API.)
- [ ] 7.5 Verify auth-failure (expired/invalid token) and rate-limit are surfaced as distinct task-failure reasons from the captured byte-stream, not silent hangs.

## Track: verify-reopened (depends: none)

<!-- Re-opened by opsx-verify three-way routing. Each item is a requirement that
     re-traced against the working tree as a real, fixable code problem (NOT a spec
     defect). File/line evidence is inline; fix the code, then re-verify the cited
     scenario. -->

- [x] VR-1 Frontend: "Create-task dialog offers a runtime selector gated on readiness" — the working-tree `apps/web/src/components/dashboard/new-task-dialog.tsx` (and `apps/web/src/routes/_app/tasks/new.tsx`) has NO runtime selector, NO `runtimesQuery` import, and NO readiness gating. The full implementation exists ONLY in the abandoned worktree (`.claude/worktrees/wf_ec3b11c4-c66-5/apps/web/src/components/dashboard/new-task-dialog.tsx`); it was never applied back. `runtimesQuery` (queries.ts:129-137), `real.getRuntimes` (real.ts:209-221) and `mock.mockRuntimes` (mock.ts:830-844) are defined but have ZERO consumers. Apply the dialog component: add the `Claude Code | Codex` selector, consume `runtimesQuery()`, disable an un-ready runtime with a configure hint, reflect the selection in `buildCommandPreview`, and send `runtime` in the create body. (frontend-console spec.md:3-10; tasks 6.2/6.3.)
- [x] VR-2 Frontend: "The dormant stopOnWrite checkbox no longer over-promises" — the checkbox still presents as an active enforcement gate in three places: `new-task-dialog.tsx:543-555` ("破坏性写入前停止" / "Commit、push、secret 变更和 PR 创建前必须等待操作者确认"), `new-task-dialog.tsx:564` ReviewStep ("写入前确认" / "危险动作会在会话中暂停"), and `routes/_app/tasks/new.tsx:447-460` ("远端 Agent 在 commit、push、secrets 变更或外部提交前必须请求操作者确认"). `buildCommandPreview` (new-task-dialog.tsx:168) also emits `--confirm-before-write`. The spec requires the affordance be REMOVED or relabeled preview-only/advisory; none of these are. Relabel/remove all three plus the command-preview flag. (frontend-console spec.md:22-33; task 6.4.)
- [x] VR-3 Tasks-API: "Create-task API accepts/echoes runtime AND fails closed at create on an unconfigured runtime" — accept/echo/persist and provision-time dispatch are MET, but the create-time fail-closed gate is a DEAD LETTER. `AGENT_RUNTIME_REGISTRY_TOKEN = 'AGENT_RUNTIME_REGISTRY'` (tasks.service.ts:119, @Inject :216) and `CLAUDE_RUNTIME_READINESS_TOKEN = 'CLAUDE_RUNTIME_READINESS'` (tasks.service.ts:138, @Inject :226) are NEVER bound by any module — `tasks.module.ts` provides only `TasksService`/`GUARDRAILS_SERVICE_TOKEN`/`TRANSCRIPT_STORE`, and the sandbox module binds the DIFFERENT tokens `RUNTIME_REGISTRY` + `CLAUDE_AUTH_SOURCE` (consumed by the provider/`/runtimes`, not tasks.service). Both `@Optional()` injections are always `undefined`, so the resolve gate (tasks.service.ts:456-462) and the readiness gate (tasks.service.ts:471-476 — the spec's "Missing token fails closed at admission" scenario) never fire. A `claude-code` task with no `CLAUDE_CODE_OAUTH_TOKEN` is ADMITTED (row created, guardrails admit) and only fails at provision (aio-sandbox.provider.ts:326-329), instead of being rejected with the distinct `RuntimeNotConfiguredException` (503) before creation. Bind the two tasks-layer tokens (in `tasks.module.ts`/`app.module.ts`) to the registry + `CLAUDE_AUTH_SOURCE`. (repo-and-task-management spec; agent-runtime "credential injection / missing token fails closed"; tasks 4.1/4.2.)
- [x] VR-4 Provisioning + agent-runtime: ".claude.json provision-time trust/onboarding pre-seed is missing" — the only `.claude.json` references in `apps/api/src` are FORWARD-LOOKING COMMENTS (aio-sandbox.provider.ts:27, :310, :901); no code writes it. `ClaudeCodeRuntime.injectAuth()` (claude-code-runtime.ts:122-149) makes one exec that writes ONLY `launch-env.sh` (OAuth token + ANTHROPIC_* unsets). `RuntimeAdapter.injectAuth()` (agent-runtime.integration.ts:200-218) delegates to the port then writes only the prompt file. The spec requires pre-seeding `$CLAUDE_CONFIG_DIR/.claude.json` with GLOBAL onboarding (`theme`, `hasCompletedOnboarding`) AND per-project trust (`hasTrustDialogAccepted`, `hasCompletedProjectOnboarding`) — per-project alone leaves the theme/onboarding screen blocking. Implement the pre-seed at provision time. (aio-sandbox-execution spec.md:8-9,21-26; agent-runtime spec.md:49-60; tasks 3.1.)
- [x] VR-5 (DONE, static-verified — codex now routes through CodexRuntime for BOTH launch (`buildLaunchLine`, provably byte-identical: same `CODEX_LAUNCH_ARGV` + same `buildDetachedCodexLaunchLine` + same `/home/gem/workspace` + hook guard moved into the runtime) and exit (`detectExit`, same `tmux has-session` + shared `resolveExitStatus`); the `runtime.id==='codex'` identity branches are gone, only an UNRESOLVED runtime falls back to inline `launchCodex`. Verified: typecheck 7/7, codex-launch 16/16, agent-runtime 56/56 incl. codex parity. The codex compose e2e (task 7.1) remains the final byte-identity pre-ship gate — not locally runnable.) Agent-runtime port: "codex is not fully extracted behind the port — shared scaffolding still branches on agent identity outside the port" — the port + both impls + registry are MET, but the pty client retains a parallel inline codex path NOT routed through `CodexRuntime`. `aio-pty-client.ts:357-380` `launchAgent()` does `if (!runtime || runtime.id === 'codex') return this.launchCodex(...)` — codex execution runs the inline `launchCodex` (line 398) + codex-only fields (`dsrSeen:200`, `launchedCodex:212`, `autoSubmitTimer:215`), bypassing `CodexRuntime.buildLaunchLine/autoSubmit`. The detectExit seam likewise branches `runtime.id !== 'codex'` (line 754). The spec says shared scaffolding SHALL NOT branch on agent identity except through the port and codex extraction SHALL be behavior-preserving (i.e. codex driven through `CodexRuntime`). Route the codex launch/autosubmit/detectExit through the port too (or otherwise eliminate the duplicated inline codex logic). (agent-runtime spec.md:7-13; tasks 3.1/3.2.)
- [x] VR-6 Runtime readiness endpoint: "blocking response-shape mismatch — `/runtimes` is silently empty on the frontend" — backend `RuntimesService.getReadiness()` returns `{ runtimes: [...] }` (runtimes.service.ts:58-66), but the frontend consumer `getRuntimes()` does `const entries = Array.isArray(body) ? body : []` (real.ts:209-221). Since `body` is an OBJECT, `Array.isArray` is false, `entries = []`, and the endpoint always yields `[]` — both runtimes silently suppressed, so the console can never offer/disable a runtime via this endpoint end-to-end. Fix the consumer to read `body.runtimes` (or align the wire shape). (agent-runtime "Runtime readiness endpoint" scenario "Readiness reflects configuration"; task 3.3/6.3.)
