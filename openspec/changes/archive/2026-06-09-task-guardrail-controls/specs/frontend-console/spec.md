## MODIFIED Requirements

### Requirement: New task creation from the console
The console SHALL provide BOTH a modal (on `/dashboard`) and a full-page form (`/tasks/new`) to create a task, sharing the same form, live command preview, and submit logic. The form SHALL select a registered repo (options from `GET /repos`, restricted to imported repos as the security scope), a branch, an execution strategy, an OPTIONAL multi-select of SKILLS to preinstall (e.g. OpenSpec, BMAD — options from a static catalog matching the server-side skill allowlist), an OPTIONAL idle-timeout control ("空闲自动回收") that DEFAULTS TO OFF, an OPTIONAL deadline control ("运行时限") that DEFAULTS TO none, and a prompt/description (with a live client-side word count), default the "破坏性写入前停止" checkbox to checked, and render a side preflight (3 ReviewStep cards complete/warn) plus a live `agentctl` `CommandPreview` derived from form state (including the selected skills, idle timeout, and deadline). The idle-timeout and deadline controls SHALL offer human-friendly choices (e.g. off/none plus preset durations and/or a custom value) and submit their values as integer milliseconds (`idleTimeoutMs`, `deadlineMs`); selecting "off"/"none" SHALL submit no value for that field so the task is created with no idle ceiling / no deadline. Submission SHALL POST to `POST /repos/:repoId/tasks` via a `createTaskMutation`, sending the selected skill ids and the `idleTimeoutMs`/`deadlineMs` values when set; on success it SHALL NAVIGATE the operator directly into the created task's session (`/tasks/$taskId`) using the `id` from the create response — rather than only surfacing a deep link the operator must click — persist `selectedRepo`/`branch`/`latestRunId` to local store, invalidate the tasks query, and emit a Sonner toast as a transient confirmation. On navigation the dashboard modal SHALL close (it unmounts with the route change). The console SHALL render branch and strategy controls even though the current backend treats them as inert run parameters; the page SHALL NOT misrepresent unsent/unread fields as confirmed task state. An empty skill selection submits no `skills` and preserves the no-preinstall behavior; an off idle control and a none deadline preserve the no-reclaim / no-deadline behavior.

#### Scenario: Operator creates a task from the dashboard modal
- **WHEN** the operator submits the new-task modal with a repo, branch, strategy, and prompt
- **THEN** the console POSTs to `POST /repos/:repoId/tasks` and, on success, navigates directly into the created task's `/tasks/$taskId` session (the modal closing as it unmounts) and invalidates the task list

#### Scenario: Full-page create mirrors the modal
- **WHEN** the operator opens `/tasks/new` and submits the form
- **THEN** it uses the same shared form, command preview, and `createTaskMutation` as the dashboard modal and, on success, navigates directly into the created task's `/tasks/$taskId` session

#### Scenario: Operator selects skills to preinstall
- **WHEN** the operator selects one or more skills (e.g. OpenSpec) in the create form and submits
- **THEN** the create body includes the selected skill ids in its `skills` field, and the command preview reflects the selected skills
- **AND** an empty skill selection submits no `skills` (or an empty list) and preserves the prior no-preinstall behavior

#### Scenario: Idle-timeout control defaults to off and is opt-in
- **WHEN** the operator opens the create form without touching the idle-timeout control and submits
- **THEN** the create body sends no `idleTimeoutMs` and the task is created with no idle reclamation
- **AND** when the operator instead chooses an idle-timeout value, the create body sends that value as integer milliseconds in `idleTimeoutMs` and the command preview reflects it

#### Scenario: Deadline control defaults to none and is opt-in
- **WHEN** the operator opens the create form without touching the deadline control and submits
- **THEN** the create body sends no `deadlineMs` and the task is created with no deadline
- **AND** when the operator instead chooses a deadline value, the create body sends that value as integer milliseconds in `deadlineMs` and the command preview reflects it

#### Scenario: Skill options come from the allowlisted catalog
- **WHEN** the skill multi-select is populated
- **THEN** its options come from a static catalog matching the server-side skill allowlist, so the operator cannot select a skill the orchestrator would not execute

#### Scenario: Command preview reacts to form state
- **WHEN** the operator edits any field of the create form (including the idle timeout or deadline)
- **THEN** the `CommandPreview` recomputes the `agentctl` command from form state and the word count updates, both as `useMemo`-derived values not stored in the query cache

#### Scenario: Repo options are scoped to imported repos
- **WHEN** the repo select is populated
- **THEN** its options come from `GET /repos` (the imported set) and no repo outside the imported scope is selectable

### Requirement: Session page renders the live terminal and controls
The `/tasks/$taskId` page SHALL be the ONLY client-only route (route option `ssr: false`): it SHALL render a `pendingComponent` terminal skeleton on the server (never touching `window`), and on the client mount the `<Terminal>` component, connect to the task's authenticated WebSocket via the reused `TerminalSocket`, render the raw byte stream directly to the terminal (raw bytes SHALL NOT pass through the TanStack Query cache), display the live connection status, and provide DIRECT 1:1 keystroke input typed straight into the live `<Terminal>` as the SOLE live-terminal input surface — the xterm `onData` path SHALL forward each keystroke verbatim (Enter as `\r`, arrows, Ctrl-C, backspace; clipboard pastes auto-wrapped in `ESC[200~`/`ESC[201~`) to the lease-gated keystroke channel, seizing the write lease on first input — with NO separate command-input box and NO delayed-carriage-return submit hack on the live path. The page SHALL provide a connection-state affordance so that typing while the socket is not OPEN is visibly inert rather than silently dropped, and SHALL focus the terminal on mount. The page SHALL show a live PER-TASK resource readout (this task's own CPU percent and memory) sourced from the per-task metrics read (`resource-metrics`), replacing any hard-coded placeholder, and SHALL degrade honestly to "未运行/未采样" when the task has no live sampled container rather than displaying fabricated zeros. The page SHALL surface the task's CONFIGURED GUARDRAILS read back from the task (`idleTimeoutMs`/`deadlineMs`) as an honest readout (e.g. "空闲回收: 30 分钟 / 关闭", "运行时限: 2 小时 / 无"), reflecting the persisted values rather than fabricating them. The page SHALL provide a manual "停止任务" control that, after an explicit operator confirmation, POSTs to `POST /tasks/:taskId/stop` to transition the task to `cancelled`, and on success reconciles the cached task entry; the control SHALL be inert/hidden for a task already in a terminal state. For a freshly-created task that has not yet reached `running` (status `pending`/`queued`, sandbox not yet provisioned), the page SHALL show a friendly early-state placeholder ("排队中 / 沙箱启动中…") driven by the task status, and SHALL transition to the live terminal once the task reaches `running`, so navigating into a just-created session never lands on a blank/confusing screen. The page SHALL also present an approval surface for pending `PermissionRequest` decisions. Discrete control frames (task completion, lease/write-lock changes, approval decisions) SHALL be bridged back into the query cache via `queryClient.setQueryData(['tasks', id], …)` or invalidation. The WebSocket handshake SHALL authenticate via the existing token query parameter plus `bearer.<token>` subprotocol (browsers cannot set an `Authorization` header on WS) and SHALL NOT attempt to set request headers.

#### Scenario: Session page streams the live terminal
- **WHEN** the operator opens `/tasks/$taskId` for a running task
- **THEN** the client connects the WebSocket and writes the task's live byte stream directly to the `<Terminal>` component without routing raw bytes through the query cache

#### Scenario: Session page shows the task's own CPU and memory
- **WHEN** the operator views `/tasks/$taskId` for a `running` task
- **THEN** the page shows that task's own CPU percent and memory sourced from the per-task metrics read, not a hard-coded placeholder and not the global aggregate

#### Scenario: Per-task resource degrades honestly when not running
- **WHEN** the task has no live sampled container (not running yet, or just exited)
- **THEN** the per-task resource readout shows "未运行/未采样" rather than fabricated zeros

#### Scenario: Session page shows the task's configured guardrails
- **WHEN** the operator views a task that was created with an `idleTimeoutMs` and/or `deadlineMs` (or neither)
- **THEN** the page shows the configured idle-reclaim and deadline values read back from the task (showing "关闭"/"无" when a value is absent), never fabricating a value that was not set

#### Scenario: Operator stops a task from the session page
- **WHEN** the operator activates the "停止任务" control for an active task and confirms
- **THEN** the console POSTs to `POST /tasks/:taskId/stop`, the task transitions to `cancelled`, and the cached task entry is reconciled so other views reflect the new status
- **AND** the control is inert/hidden for a task already in a terminal state

#### Scenario: Freshly created task shows a friendly pre-running placeholder
- **WHEN** the operator lands on `/tasks/$taskId` for a task still in `pending`/`queued` (sandbox not yet provisioned)
- **THEN** the page shows a friendly "排队中 / 沙箱启动中…" state and transitions to the live terminal once the task reaches `running`, instead of a blank or stuck "正在连接" screen

#### Scenario: Direct xterm typing is the sole live input and Enter submits
- **WHEN** the operator types into the live terminal and presses Enter
- **THEN** each keystroke is forwarded verbatim through the xterm `onData` path to the lease-gated keystroke channel (the write lease is seized on first input), and Enter is delivered as `\r` so the agent composer submits — with no separate command-input box and no delayed-carriage-return hack mediating the live path

#### Scenario: Typing into a non-deliverable socket is visibly inert
- **WHEN** the operator types while the WebSocket is not OPEN (closed/reconnecting/errored)
- **THEN** the page shows a connection-state affordance making the terminal visibly inert, rather than silently discarding the keystrokes

#### Scenario: Session route is server-rendered as a skeleton only
- **WHEN** the server renders `/tasks/$taskId`
- **THEN** it emits the terminal `pendingComponent` skeleton and accesses no `window`/browser-only globals, and the live terminal is constructed only after client hydration in an effect

#### Scenario: Pending approval surfaces on the session page
- **WHEN** a `PermissionRequest` is pending for the open task
- **THEN** the page shows an approval surface offering allow/deny, and submitting a decision resolves it independently of the write lock

#### Scenario: Control frame bridges back into the query cache
- **WHEN** a control frame indicating task completion or a lease change arrives over the WebSocket
- **THEN** the console updates the cached task entry via `queryClient.setQueryData`/invalidation so other views reflect the new status, while raw output bytes remain out of the cache

#### Scenario: Terminal falls back when xterm is unavailable
- **WHEN** the xterm runtime is unavailable on the client
- **THEN** the session page renders a fallback DOM line view (terminal-line dim/ok/warn) plus a command input row (the fallback path retains a line input because there is no live terminal to type into) instead of crashing
