## MODIFIED Requirements

### Requirement: Settings page with account, GitHub, and Codex sections
The `/settings` page SHALL render its content as a **single, top-to-bottom vertical column** of cards (a `max-width`-constrained stack, roughly 640px wide, centered/left within the main content area), with **one setting per card** following the Vercel settings pattern. The page SHALL NOT render an in-page secondary anchor navigation and SHALL NOT render a decorative system-strip of summary stat cards; navigation is provided solely by the outer app shell. The column SHALL contain, in order: (1) a **read-only identity card** (Avatar + the read-only allowlisted account display identity) with **no footer action**; (2) a card for the read-only allowed GitHub account; (3) a default-repository card (selection from the repos query); (4) a history/audit retention card; (5) a write-confirm / destructive-action gate card; (6) a task-slot-ceiling card bound to the system-level `maxConcurrentTasks` setting, client-validated as an integer in the range 1–20 with default 5, presented as a system-wide value shared by all allowlisted operators (not a per-account preference) such that a value outside 1–20 or a non-integer SHALL NOT be submitted; and (7) a single Codex credential card. Every **editable** card (cards 2–7) SHALL carry its own footer action bar (`.panel-foot`: a top border, a `--subtle`/secondary background, helper text on the left and a primary save action on the right) that saves that card's setting; the read-only identity card SHALL NOT present a save action. The Codex credential card SHALL present the credential as a single card containing the status, a segmented control switching between 官方 Codex / 兼容提供方, and the selected mode's status row and configure action — NOT a side-by-side two-column intro+activation layout and NOT tabs nested inside a card inside a card. The Codex card SHALL provide two dialogs — a direct authorize dialog (scope list + connect/connected states) and an api-key dialog (Base URL + API Key as a password field + fetch-available-models → model-picker → select default model → save/test). Both Codex dialogs SHALL use a **compact dialog shell** (a narrower fixed width than the content-rich 新建任务/导入仓库 dialogs, with no marketing eyebrow kicker) whose action buttons live in a dedicated **footer action bar** (top border + `--subtle` background) presenting a right-aligned cancel + primary pair, rather than a body-embedded full-width button; this scoping SHALL NOT alter the shared dialog shell used by other dialogs. The api-key (compatible-provider) dialog SHALL gate persistence behind a **connection-verification step**: the primary save action SHALL be disabled until a successful 测试连接 (which validates the candidate Base URL + API Key against the model-discovery probe WITHOUT persisting), and a successful test SHALL surface the discovered-model count and reveal the default-model picker for selection before save is enabled. The credential status (未连接/未保存/已连接) SHALL stay synchronized across the status card/pill, the segmented-control subtitle, and the provider row; a saved API key SHALL NOT be re-displayed in plaintext. Saving SHALL run `saveSettingsMutation` (write store + invalidate the settings query, ADDITIONALLY invalidating the metrics query on success so a changed slot ceiling is reflected on the dashboard capacity surfaces before the next 5-second poll); a reset action SHALL restore defaults (including the slot ceiling default of 5). The page SHALL keep GitHub OAuth (who may enter the console) and Codex credentials (which model runs tasks) as two distinct concepts and SHALL NOT conflate Codex credentials with console login.

#### Scenario: Settings renders as a single vertical card column
- **WHEN** the operator opens `/settings`
- **THEN** the page renders one top-to-bottom column of cards (one setting per card) and renders neither an in-page secondary anchor navigation nor a decorative system-strip of summary stat cards
- **AND** no two settings cards are placed side by side in a multi-column grid

#### Scenario: Each editable card has its own save footer; identity card does not
- **WHEN** the operator views the settings column
- **THEN** the default-repository, retention, write-confirm, slot-ceiling, and Codex cards each display a footer action bar with helper text and a save/primary action for that card's setting
- **AND** the read-only identity card displays no save action

#### Scenario: Codex credential is one card with a segmented switch
- **WHEN** the operator views the Codex credential card
- **THEN** it presents the credential as a single card with a segmented 官方 Codex / 兼容提供方 control and the selected mode's status row and configure action
- **AND** it does not render a side-by-side two-column intro+activation layout or tabs nested inside a card inside a card

#### Scenario: Saving settings persists and re-renders
- **WHEN** the operator edits a settings card and saves via its footer action
- **THEN** `saveSettingsMutation` writes the store and invalidates the settings query so the UI reflects the new values, and a reset restores defaults

#### Scenario: Codex credential status stays synchronized
- **WHEN** the operator connects or saves a Codex credential
- **THEN** the status card/pill, the segmented-control subtitle, and the provider row all reflect the same 未连接/未保存/已连接 state

#### Scenario: Codex dialogs use the compact shell with a footer action bar
- **WHEN** the operator opens the official-authorize or the api-key Codex dialog
- **THEN** the dialog renders in a compact (narrower) shell with no eyebrow kicker and its actions in a footer action bar as a right-aligned cancel + primary pair
- **AND** the shared dialog shell used by the 新建任务 / 导入仓库 dialogs is unchanged

#### Scenario: Compatible-provider save is gated on a successful connection test
- **WHEN** the operator opens the api-key dialog and has not yet run a successful 测试连接
- **THEN** the save action is disabled and the default-model picker is not yet available
- **WHEN** the operator runs 测试连接 and it succeeds (candidate Base URL + API Key validated via model discovery, nothing persisted)
- **THEN** the discovered-model count is shown, the default-model picker is revealed for selection, and the save action becomes enabled

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
