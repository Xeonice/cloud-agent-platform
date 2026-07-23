# repo-and-task-management Specification (delta)

## ADDED Requirements

### Requirement: Repo carries a content-copy status and task creation gates on copy readiness

The `Repo` model SHALL carry a content-copy status of at least `ready`, `missing`, `refreshing`, and `failed`, plus a last-updated timestamp for the copy, persisted via Prisma migration and exposed on repo read APIs. Task creation SHALL be rejected with an actionable error (naming the refresh/re-import path) when the selected Repo's copy is not `ready`. Pre-existing Repos SHALL surface as `missing` after upgrade until an operator triggers acquisition. Already-running tasks SHALL be unaffected by their Repo's copy status changing.

#### Scenario: Task creation blocked on missing copy
- **WHEN** an operator creates a task for a Repo whose copy status is `missing`
- **THEN** the request is rejected with an error directing them to refresh/re-import the Repo

#### Scenario: Repo reads expose copy status
- **WHEN** the console lists repos
- **THEN** each repo's copy status and copy timestamp are available to render readiness and a refresh affordance

#### Scenario: Upgrade surfaces legacy repos as missing
- **WHEN** the system starts after upgrade with Repos imported before this change
- **THEN** those Repos read as copy status `missing` and remain listed and editable
