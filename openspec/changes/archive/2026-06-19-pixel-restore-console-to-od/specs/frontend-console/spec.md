## ADDED Requirements

### Requirement: Session transcript (会话记录) view
The console SHALL provide a read-only session-transcript view for a task, reached from the history list's 「查看会话」 entry, rendering the persisted session transcript (from `session-transcript-persistence`) as a vertical timeline of typed events: operator input, reasoning summary, tool call (command/patch with a collapsible output and diff stat), final agent answer, and system events (created/ready/completed). The view SHALL provide a type filter (全部/我的输入/工具/回答) and a text search that filter the timeline together, an empty state when nothing matches, and a link to the task's terminal record. It SHALL be SSR-safe and read-only (no terminal/WebSocket).

#### Scenario: Transcript renders typed events
- **WHEN** the operator opens a task's 会话记录
- **THEN** the timeline renders operator input, reasoning, tool calls with collapsible output, the final answer, and system events in chronological order

#### Scenario: Type filter and search narrow the timeline
- **WHEN** the operator selects 工具 or types a search term
- **THEN** only matching events remain and an empty state shows when nothing matches

### Requirement: API debug (API 调试) console view
The console SHALL provide an authenticated API debug view at `/api`, with a sidebar and mobile-nav entry "API 调试", visible only to a logged-in operator, for exercising the platform v1 API (`public-v1-api`). It SHALL render a resource-grouped endpoint collection (tasks/repos/sessions/system, each item a method badge + path), a request region with a read-only method+host+path bar (the endpoint is selected from the collection, not free-typed) and Request tabs (Body/参数/Headers), and a Response region with status/time/size plus Body/Headers tabs. Credentials SHALL be presented as auto-injected from the current operator session (no manual token field). The Request and Response regions SHALL be explicitly labeled and visually distinct.

#### Scenario: API debug view is gated and reachable
- **WHEN** an authenticated operator activates the "API 调试" nav entry
- **THEN** the `/api` view opens within the app shell, and an unauthenticated visitor is gated like other `_app` routes

#### Scenario: Endpoint selection drives a read-only request line
- **WHEN** the operator selects an endpoint from the collection
- **THEN** the method + host + path bar reflects it as read-only text (not an editable URL field), and the Request and Response regions are separately labeled

### Requirement: Settings model credentials organized by Agent runtime
The settings model-credential section SHALL be organized by Agent runtime and expose both runtimes the platform supports: a Codex group (官方 Codex 账号 / 兼容模型提供方) and a Claude Code group (Claude 订阅 setup-token / Anthropic API Key). Each runtime SHALL show its own connection status, and the Claude Code group SHALL provide an entry to configure a `claude setup-token` subscription token and an Anthropic API Key. Saved secrets SHALL be masked (suffix only) and never re-displayed in plaintext.

#### Scenario: Claude Code credential entry is present
- **WHEN** the operator opens the Agent model-credential section
- **THEN** a Claude Code runtime group is shown with a setup-token entry and an Anthropic API Key entry, alongside the Codex group

#### Scenario: Saved Claude credential is masked
- **WHEN** a Claude setup-token or Anthropic API Key has been saved
- **THEN** it is not shown again in plaintext

### Requirement: Geist typeface and flattened card surfaces
The console design tokens SHALL adopt the prototype's Geist Sans / Geist Mono typefaces for `--font-sans` / `--font-mono` (bundled as app assets with a `system-ui` / monospace fallback, not a render-blocking external import), and card surfaces SHALL use the flattened single-ring shadow the finalized baseline uses rather than a multi-layer drop shadow.

#### Scenario: Console renders in Geist
- **WHEN** any console page renders
- **THEN** sans text resolves to Geist Sans and mono text to Geist Mono, falling back gracefully if a face fails to load

### Requirement: Console restored to the finalized design baseline
The console screens SHALL match the finalized Open Design baseline frozen at `openspec/changes/pixel-restore-console-to-od/design-baseline/` (10 screens + `platform.css`). Per-page pixel comparison SHALL use this frozen snapshot — including the two added screens (transcript, api) — as the oracle, superseding the earlier 2026-06-11 baseline. A screen is considered restored only when it visually matches its frozen baseline at a fixed viewport.

#### Scenario: Screens are verified against the frozen baseline
- **WHEN** a restored console screen is compared to its `design-baseline/` reference at a matched viewport
- **THEN** it visually matches, and the comparison target is the frozen 2026-06-19 snapshot rather than the prior baseline

## MODIFIED Requirements

### Requirement: History audit page
The `/history` page SHALL render a screen-header and a single "运行记录" panel containing an audit-toolbar (search Input + a status SegmentedControl 全部/运行中/等待输入/排队/已完成/失败 + a CountChip "N 条记录") and a Vercel-style task-row list sourced from the tasks query. Each row SHALL render the task's result as a status pill in a kicker line with the task id, the task title, the repo·branch (mono), the Agent runtime, the elapsed time, and a single dark "查看会话" action linking to that task's 会话记录 (queued tasks show a disabled "等待接入" instead). The client-side filter (search + status) SHALL drive the list and update the CountChip live, with an empty state when nothing matches. The page SHALL NOT render the former ACTIVE WINDOW/ATTENTION/RETENTION summary tiles or the right-hand audit event-stream. It SHALL be read-only (no terminal/WebSocket) and SSR-friendly.

#### Scenario: History renders as a single task-row list
- **WHEN** the operator opens `/history`
- **THEN** it shows the 运行记录 panel with task rows (status pill + title + repo·branch + Agent + 耗时 + 查看会话), and no summary tiles or audit event-stream

#### Scenario: Status filter and search narrow the list
- **WHEN** the operator types a search term or selects a status segment
- **THEN** the task-row list filters and the CountChip updates to the visible count, with an empty state when nothing matches

#### Scenario: View-session navigates from history
- **WHEN** the operator activates a row's 查看会话 action
- **THEN** the console navigates to that task's 会话记录 (transcript) view

#### Scenario: History is read-only and SSR-rendered
- **WHEN** `/history` is server-rendered
- **THEN** it renders without any terminal/WebSocket connection and hydrates without errors

## REMOVED Requirements

### Requirement: The dormant stopOnWrite checkbox no longer over-promises
**Reason**: The write-gate / approval surface is removed product-wide — the agent runs ungated inside the sandbox (the trust boundary), so there is no stopOnWrite affordance left to relabel. The create-task dialog and the session view no longer present any write-before-stop control or approval banner; safety is communicated as "沙箱即信任边界" copy.
**Migration**: None for operators. The create-task control and the session approval surface (`approval-surface.tsx`) are removed entirely; their removal is covered in this change's tasks.
