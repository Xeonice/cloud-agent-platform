# frontend-console

## ADDED Requirements

### Requirement: Task detail renders a provisioning timeline with live transfer progress

The task-detail page SHALL render a provisioning stage checklist derived from
the shared `TASK_PROVISIONING_STAGES` order compared against the summary's
current `provisioning.stage` — completed, current, and pending stages are each
visually distinct — using the existing stage vocabulary and labels with no new
backend vocabulary. During the workspace-transfer stage the page SHALL render a
live progress bar fed by the summary's transfer-progress object over the
existing task-detail poll cadence with no new transport: known percent renders
as a determinate bar with the numeric facts (percent, objects, bytes or
throughput as available), while unknown progress renders as an indeterminate
indicator and SHALL NOT be rendered as 0%. When the summary is null/absent
(legacy tasks or closed capability gate) the page SHALL degrade to the existing
state/stage presentation without error.

#### Scenario: Timeline reflects the current stage

- **WHEN** the poll returns a provisioning summary whose stage is workspace_transfer
- **THEN** stages ordered before it render completed, workspace_transfer renders as the active stage, and later stages render pending
- **AND** the checklist ordering matches `TASK_PROVISIONING_STAGES`

#### Scenario: Live percent updates over the existing poll

- **WHEN** consecutive polls return progress percent 30 then 55
- **THEN** the progress bar advances from 30% to 55% without any new transport, socket, or endpoint being introduced
- **AND** the displayed numbers come from the summary's numeric progress fields

#### Scenario: Unknown progress renders indeterminate

- **WHEN** the summary reports the transfer stage with unknown percent (pre-transfer clone phase)
- **THEN** the UI shows an indeterminate progress indicator
- **AND** it does not display 0%

#### Scenario: Missing summary degrades gracefully

- **WHEN** a task response carries a null/absent provisioning summary or a summary without a progress object
- **THEN** the task-detail page renders without error using the existing state/stage presentation
- **AND** no progress bar is fabricated

### Requirement: The provisioning status card surfaces transfer progress

The existing provisioning status card (`TaskProvisioningStatus`) SHALL be
upgraded to display the transfer-progress percent alongside its current
state/stage/attempt presentation whenever the summary carries a known percent
during the workspace-transfer stage, so compact surfaces (task list rows,
dense views) convey clone progress without requiring the full timeline. The
card SHALL follow the same indeterminate rule as the timeline — unknown
progress is never rendered as 0% — and SHALL render unchanged when the
progress object is absent.

#### Scenario: Card shows percent during transfer

- **WHEN** the summary reports the workspace-transfer stage with percent 47
- **THEN** the provisioning status card displays 47% alongside the existing stage label
- **AND** the state pill and attempt presentation remain unchanged

#### Scenario: Card stays unchanged without progress

- **WHEN** the summary carries no progress object (legacy backend or non-transfer stage)
- **THEN** the card renders exactly its existing state/stage presentation
- **AND** no percent or progress affordance is fabricated
