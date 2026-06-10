# frontend-console Spec Delta — configurable-task-slots

## MODIFIED Requirements

### Requirement: Settings page with account, GitHub, and Codex sections
The `/settings` page SHALL render a left secondary anchor navigation grouping account/github/codex/safety, a system-strip of 3 cards, and a settings grid: an identity card (Avatar) and an access-and-defaults form (`allowedAccount`, default repo from the repos query, `retention`, `writeConfirm`, and a task slot ceiling numeric control bound to the system-level `maxConcurrentTasks` setting, client-validated as an integer in the range 1–20 with default 5), plus a Codex login section (status card + Tabs: 官方 Codex / 兼容提供方). The slot ceiling control SHALL be presented as a system-wide value shared by all allowlisted operators (not a per-account preference), and a value outside 1–20 (or a non-integer) SHALL NOT be submitted. The Codex section SHALL provide two dialogs — a direct authorize dialog (scope list + connect/connected states) and an api-key dialog (Base URL + API Key as a password field + fetch-available-models → model-picker → select default model → save/test). The credential status (未连接/未保存/已连接) SHALL stay synchronized across the status card, the tab subtitle, and the provider pill; a saved API key SHALL NOT be re-displayed in plaintext. Saving SHALL run `saveSettingsMutation` (write store + invalidate the settings query, ADDITIONALLY invalidating the metrics query on success so a changed slot ceiling is reflected on the dashboard capacity surfaces before the next 5-second poll); a reset action SHALL restore defaults (including the slot ceiling default of 5). The page SHALL keep GitHub OAuth (who may enter the console) and Codex credentials (which model runs tasks) as two distinct concepts and SHALL NOT conflate Codex credentials with console login.

#### Scenario: Saving settings persists and re-renders
- **WHEN** the operator edits the access-and-defaults form and saves
- **THEN** `saveSettingsMutation` writes the store and invalidates the settings query so the UI reflects the new values, and a reset restores defaults

#### Scenario: Codex credential status stays synchronized
- **WHEN** the operator connects or saves a Codex credential
- **THEN** the status card, tab subtitle, and provider pill all reflect the same 未连接/未保存/已连接 state

#### Scenario: Saved API key is masked
- **WHEN** an API key has been saved
- **THEN** it is not shown again in plaintext in the api-key dialog

#### Scenario: Console login and Codex credential are not conflated
- **WHEN** the settings copy describes GitHub OAuth and Codex credentials
- **THEN** GitHub OAuth is presented as console access identity and Codex credentials as the task model credential, as two separate concerns

#### Scenario: Slot ceiling field accepts only integers in 1–20
- **WHEN** the operator enters 0, 21, a negative number, or a non-integer in the slot ceiling control and attempts to save
- **THEN** client-side validation blocks the submission (no save request carries the invalid value) and the stored ceiling is unchanged
- **AND** entering an integer between 1 and 20 and saving persists that value and a reload reads it back

#### Scenario: Saving the slot ceiling refreshes capacity surfaces
- **WHEN** the operator saves a changed slot ceiling and the save succeeds
- **THEN** the mutation invalidates both the settings query and the metrics query, so the dashboard capacity aside and slot meter reflect the new ceiling without waiting for the next 5-second metrics poll

### Requirement: Dashboard lists tasks as a fleet
The `/dashboard` page (mounted under the authenticated app-shell layout) SHALL be the post-login default landing surface, list tasks read from `GET /tasks` via TanStack Query as a fleet with their status, surface running/needs-input/queued states (sorting needs-input rows to the top), and provide an action to enter a task's `/tasks/$taskId` session (queued rows SHALL be `aria-disabled` until connectable). It SHALL provide a client-side search and a status SegmentedControl (全部/等待输入/排队中) with a live visible CountChip, an operations status bar of metric tiles, and an Agent-capacity aside (slot meter + CPU/memory resource meters + scheduling config). The Agent-capacity aside's slot meter SHALL derive its rendered slot count and grid layout from the live metrics slot occupancy list (`occupancy.slots.length`) rather than a hardcoded ten-column/ten-segment layout, so it renders one segment per slot for any configured ceiling in 1–20; the mock metrics path SHALL use the same default ceiling as the backend default (5) so the mock and real renders agree. The task loader SHALL prefetch tasks and repos via `ensureQueryData` to avoid request waterfalls, and the task list query SHALL poll on a 5-second `refetchInterval` (with `refetchIntervalInBackground: true` if continuous background polling is required).

#### Scenario: Dashboard shows tasks and links to sessions
- **WHEN** the operator opens `/dashboard`
- **THEN** the page lists existing tasks from `GET /tasks` with their status and each connectable row offers an action navigating to its `/tasks/$taskId` session

#### Scenario: Needs-input tasks are prioritized
- **WHEN** the task list contains a task awaiting input
- **THEN** that row is sorted to the top and rendered with the needs-input status indicator, and queued rows that are not yet connectable are marked `aria-disabled`

#### Scenario: Client-side status filter updates the visible count
- **WHEN** the operator types in the task search or selects a status in the SegmentedControl
- **THEN** the list filters client-side (derived via `useMemo`, not cached) and the CountChip reflects the visible row count

#### Scenario: Task list polls for fresh status
- **WHEN** the dashboard is mounted
- **THEN** the task query refetches every 5 seconds so statuses stay current without a manual reload

#### Scenario: Slot meter sizes to the live ceiling
- **WHEN** the dashboard renders while the metrics occupancy reports a ceiling of M slots (any M in 1–20)
- **THEN** the capacity aside renders exactly M slot segments derived from the occupancy slot list, with no hardcoded ten-segment grid, and the ceiling captions show M
