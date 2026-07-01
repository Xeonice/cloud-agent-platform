## MODIFIED Requirements

### Requirement: Session page design-revision layout
The `/tasks/$taskId` page SHALL adopt the COCKPIT layout as a MARKUP/LAYOUT/STYLE-ONLY reorganization: toolbar action behavior, input semantics, connection semantics, AND the approval surface SHALL NOT change — there is NO WebSocket-path delta in this change. The page body SHALL be composed as: (1) a THREE-SEGMENT header and (2) a single self-contained dark terminal window. The permission-request APPROVAL surface SHALL stay rendered INSIDE the terminal `<article>` exactly as it shipped previously; the page-level amber approval banner + the lift of `pending`/`decide` to the route are DEFERRED to a follow-up approval change (alongside the real `permission_request` flow + payload).

The THREE-SEGMENT header SHALL render, in this order:
- a TASK-STATUS H1 rendered as a dot+text Badge where the state is conveyed by BOTH the dot color AND the text label (never color-alone). The route drives the task LIFECYCLE states 运行中 / 已停止 / 失败 (all static dots) this phase; the Badge primitive also supports an in-flight 等待审批 state (animated pulse), reserved for the follow-up approval change that lifts the pending request;
- a TAG RAIL folding the deleted context strip into NON-INTERACTIVE chips for 分支 / {agent-runtime} / {sandbox-provider} / 守护栏, each rendered with a white background and a 1px ring. The agent chip SHALL render the task's PERSISTED `runtime` as a human-readable label (`codex` → `Codex`, `claude-code` → `Claude Code`, absent/null → `Codex`) via a SINGLE shared runtime-label helper that is also used by the history page, so the agent label cannot drift between the two surfaces; it SHALL NOT be a hardcoded `Codex` literal. The sandbox-provider chip SHALL render from the task response's public `sandboxProvider.label` when present (for example `AIO Sandbox` or `BoxLite Sandbox`) and SHALL render an honest pending/unassigned fallback when `sandboxProvider` is null or absent; it SHALL NOT hardcode `AIO Sandbox`, infer the provider from frontend environment variables, or treat AIO as the sole provider. The tag rail SHALL NOT render a platform-arch (`linux-amd64`) chip, because no task field backs it (D5.5 — never render an unsent field); the 守护栏 chip is computed from the task's `idleTimeoutMs`/`deadlineMs`. (the amber 写入前确认 chip is DEFERRED to the follow-up approval change);
- a SINGLE 停止 action as the only header action, retaining the existing two-step (explicit confirm) stop semantics that POST to `POST /tasks/:taskId/stop`; the former 返回任务 / 复制会话记录 / 暂停输出 buttons SHALL NOT appear in the header (they fold into the terminal ⋯ menu or are dropped).

The permission-request APPROVAL surface SHALL remain INSIDE the terminal `<article>` exactly as it shipped previously (an in-terminal panel offering 允许 / 拒绝, resolved lock-independently). The page-level amber banner restyle + the lift of `pending`/`decide` to the route so deciding flips the page-level H1/statusline are DEFERRED to a follow-up approval change (which also wires the real `permission_request` flow + the diffstat/commits payload).

The self-contained dark TERMINAL WINDOW SHALL render inside a single `<article>` with: a three-segment dark terminal header keeping the `{agent} · {repo}#{branch}` label (the `{agent}` segment SHALL use the SAME shared runtime-derived label as the tag rail agent chip, not a hardcoded `Codex`), a ⋯ overflow menu offering 复制 and 暂停滚动, and a 全屏 button that requests fullscreen via the element's `requestFullscreen` API; a full-width PTY scrollback region (the scrollback is intentionally NOT prose-width-constrained because it is log-scanning content); and a STATUSLINE footer appended inside the same `<article>` showing CPU·内存 plus a degraded phase. The terminal-head SHALL NOT display the hardcoded `pty: /dev/pts/4` line (or any pty path): no backend field backs it. The statusline phase SHALL degrade honestly to the task lifecycle label (a generic 运行中 for a live task) because the raw PTY exposes no semantic phase to parse (the 等待审批 phase lands with the follow-up approval change); CPU·内存 SHALL reuse the established 未运行/未采样 honest-render pattern rather than fabricating zeros.

When the open task is in a TERMINAL lifecycle state (`completed`, `cancelled`, or `failed`), the terminal-state branch of this layout SHALL replace the live terminal window with a READ-ONLY structured session-history REPLAY region driven by `GET /tasks/:id/session-history` (`session-history-replay`), preserving the same three-segment header (the H1 Badge shows the terminal label 已停止/失败/完成 with a static dot, the tag rail and the inert 停止 action remain). The replay region SHALL offer exactly two tabs — 对话记录 (conversation, PRIMARY, the parsed rollout transcript) and 终端回放 (terminal, SECONDARY, `session.log` cold-replay) — and a review sidebar carrying a search input and exactly the FIVE sticky filter presets 默认 / 无工具 / 用户 / 答案 / 全部. The conversation rendering SHALL visually distinguish three item kinds: a FINAL-ANSWER assistant turn SHALL render green-tinted with a "最终回答" label; a COMMENTARY assistant turn SHALL render muted italic, visually distinct from the final answer; a TOOL-CALL SHALL render as a bordered card showing the tool badge, the command summary, and an inline token count. The replay region SHALL present NO operation controls (no resume-run, no stop on the replay surface). When the session-history response discriminates to an honest EMPTY/degraded state, the replay region SHALL render an honest empty card (e.g. "会话未能启动" with the reason, or "会话记录已过期" for an aged-out record) in place of the transcript, never a fabricated transcript.

The route SHALL preserve its established invariants — it remains the ONLY `ssr:false` route, the server renders the `pendingComponent` terminal skeleton, and raw terminal bytes continue to bypass the TanStack Query cache. This change introduces NO WebSocket input/connection/state-lift delta for non-terminal tasks, so the cockpit reorganization is layout-only on the WS path; it SHALL nonetheless be confirmed against a live running backend session that the reorganized terminal still connects. The session-history replay region is a READ-ONLY REST surface and SHALL NOT open, mutate, or depend on the live WebSocket / PTY / write-lease path.

#### Scenario: Header renders three segments in order
- **WHEN** the operator opens the session page for a running task after the cockpit redesign
- **THEN** the header shows, in order, the task-status H1 Badge, the non-interactive tag rail, and a single 停止 action
- **AND** the header shows NO 返回任务, 复制会话记录, or 暂停输出 button

#### Scenario: Task-status H1 conveys state by dot plus text and never color alone
- **WHEN** the task is in any of the lifecycle states running / stopped / failed
- **THEN** the H1 Badge renders the matching label 运行中 / 已停止 / 失败 alongside its status dot, so the state is readable from the text even with color removed (the 等待审批 label is the Badge primitive's gate state, reserved for the follow-up approval change)

#### Scenario: Only the awaiting-input status animates (Badge primitive)
- **WHEN** the H1 Badge primitive renders the 等待审批 state (driven only by the follow-up approval change)
- **THEN** the dot pulses (animated), and for the 运行中, 已停止, and 失败 states the dot is static with no pulse animation

#### Scenario: Tag rail folds the context strip into non-interactive ring chips
- **WHEN** the header tag rail renders for a task with a selected sandbox provider summary
- **THEN** it shows the 分支 / agent-runtime / sandbox-provider / 守护栏 chips each with a white background and a 1px ring, and clicking any chip performs no navigation or action (the chips are non-interactive)
- **AND** NO platform-arch (linux-amd64) chip is rendered

#### Scenario: Sandbox provider chip reflects the task response
- **WHEN** the header tag rail renders for a task whose task response contains `sandboxProvider.label = "BoxLite Sandbox"`
- **THEN** the sandbox-provider chip reads `BoxLite Sandbox`
- **AND** the page does not render `AIO Sandbox` for that chip unless the task response selected an AIO provider

#### Scenario: Sandbox provider chip degrades honestly before provider selection
- **WHEN** the header tag rail renders for a task whose task response has `sandboxProvider = null` or no `sandboxProvider` field during a mixed deploy
- **THEN** the sandbox-provider chip renders an honest pending/unassigned sandbox label
- **AND** it does not guess `AIO Sandbox` from frontend constants, deployment env, or mock defaults

#### Scenario: Agent chip reflects the task's persisted runtime
- **WHEN** the tag rail and the terminal-head `{agent}` label render for a task persisted with `runtime = claude-code`
- **THEN** the agent chip and the terminal-head agent segment both read `Claude Code`, derived from the task's runtime via the shared runtime-label helper rather than a hardcoded literal

#### Scenario: Agent chip defaults to Codex for codex or absent runtime
- **WHEN** the tag rail renders for a task persisted with `runtime = codex` or with no runtime value
- **THEN** the agent chip reads `Codex`, derived from the runtime via the shared helper (the default), never a hardcoded literal that ignores the task's runtime

#### Scenario: Agent label helper is shared with the history page
- **WHEN** the session detail page and the history page both render an agent label for the same task
- **THEN** both derive the label from the SAME shared runtime-label helper, so a `claude-code` task reads `Claude Code` on both surfaces and the two cannot drift

#### Scenario: Single stop action keeps two-step confirm semantics
- **WHEN** the operator activates the single header 停止 action for an active task and confirms the second step
- **THEN** the console POSTs to `POST /tasks/:taskId/stop`, the task transitions to `cancelled`, and the cached task entry is reconciled
- **AND** the 停止 action is inert/hidden for a task already in a terminal state

#### Scenario: Terminal window is self-contained with menu, fullscreen, and statusline
- **WHEN** the terminal window renders for a running task
- **THEN** a single `<article>` contains a dark terminal header showing the `{agent} · {repo}#{branch}` label with a ⋯ menu (复制 / 暂停滚动) and a 全屏 button, a full-width PTY scrollback region, and a statusline footer showing CPU·内存 and a phase, all within the same `<article>`
- **AND** activating 全屏 requests fullscreen via the element's `requestFullscreen` API

#### Scenario: Fabricated pty line is removed
- **WHEN** the terminal-head renders
- **THEN** it shows the `{agent} · {repo}#{branch}` label and no pty path value appears anywhere on the session page

#### Scenario: Statusline phase degrades honestly
- **WHEN** the statusline footer renders its phase
- **THEN** it shows the task lifecycle label (a generic 运行中 for a live task), never a fabricated semantic phase parsed from the raw PTY (the 等待审批 phase lands with the follow-up approval change)
- **AND** the CPU·内存 readout shows 未运行/未采样 when no live sample exists rather than fabricated zeros

#### Scenario: Session invariants survive the reorganization
- **WHEN** the route tree is built and the session page is server-rendered
- **THEN** `/tasks/$taskId` is still the only route with `ssr: false`, the server emits the `pendingComponent` skeleton without touching `window`, and raw output bytes still write directly to the terminal without entering the query cache

#### Scenario: The cockpit reorganization is confirmed against a live backend
- **WHEN** the cockpit layout reorganization is complete (no WebSocket input/connection/state-lift delta)
- **THEN** the reorganized session page is confirmed against a live running backend session to still connect its terminal (已连接) and render the cockpit off live REST data, before being marked complete

#### Scenario: Terminal-state layout renders the structured replay with two tabs
- **WHEN** the operator opens the session page for a task in a terminal lifecycle state whose rollout is available
- **THEN** the live terminal window is replaced by the read-only replay region, which offers a 对话记录 tab (primary, the parsed rollout transcript) and a 终端回放 tab (secondary, `session.log` cold-replay), inside the same cockpit three-segment header

#### Scenario: Five filter presets and a search input render on the review sidebar
- **WHEN** the replay region renders for a terminal task with a rollout
- **THEN** the review sidebar shows a search input and exactly the five filter presets 默认 / 无工具 / 用户 / 答案 / 全部
- **AND** selecting 无工具 hides tool-call turns, 用户 shows only user turns, and 答案 shows user prompts plus final answers

#### Scenario: Final answer, commentary, and tool-call render with distinct treatments
- **WHEN** the conversation transcript renders a final-answer assistant turn, a commentary assistant turn, and a tool-call
- **THEN** the final-answer turn is green-tinted with a "最终回答" label, the commentary turn is muted italic and visually distinct from the final answer, and the tool-call is a bordered card showing the tool badge, the command summary, and an inline token count

#### Scenario: Replay region presents no operation controls
- **WHEN** the read-only replay region renders for a terminal task
- **THEN** it exposes no resume-run control and no stop control on the replay surface, consistent with the task being non-operable (`canStop` is false)

#### Scenario: Empty/aged-out session-history renders an honest empty card
- **WHEN** the session-history response for the terminal task discriminates to an empty state (agent-failed-to-start, provision-failed with no rollout, or expired/reaped)
- **THEN** the replay region renders an honest empty card (e.g. "会话未能启动" with the reason, or "会话记录已过期" for an aged-out record) instead of a fabricated transcript

#### Scenario: Replay region stays off the live terminal pipeline
- **WHEN** the read-only replay region renders and fetches session history
- **THEN** it reads only via the `GET /tasks/:id/session-history` REST endpoint and does not open, mutate, or depend on the live WebSocket / PTY / write-lease path
