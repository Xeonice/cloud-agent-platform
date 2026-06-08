# repo-and-task-management Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Postgres + Prisma data model for repos and tasks
The system SHALL persist repositories and tasks in Postgres via a Prisma schema, where a `Repo` record holds at least an id, a name, a git source, a created-at timestamp, and OPTIONAL GitHub-import metadata (`description`, `defaultBranch`, `branchCount`, `updatedAt`), and a `Task` record holds at least an id, a foreign key to a `Repo`, a prompt, a status, a created-at timestamp, and the OPTIONAL run parameters `branch`, `strategy`, and `skills`. The `Task.branch`, `Task.strategy`, and `Task.skills` columns MUST persist the values accepted by the create-task request body so they can be read back on every task read path (the prior model dropped branch/strategy). `Task.skills` is the operator's selected skill ids (an optional list); it is an inert run parameter exactly like `branch`/`strategy`. The GitHub-import metadata on `Repo` is nullable so that repos created without GitHub import (plain `gitSource` only) remain valid.

#### Scenario: Prisma schema defines Repo and Task models with the new fields
- **WHEN** the Prisma schema is inspected
- **THEN** it declares a `Repo` model with id, name, git source, and createdAt fields
- **AND** the `Repo` model declares nullable `description`, `defaultBranch`, `branchCount`, and `updatedAt` GitHub-import metadata columns
- **AND** it declares a `Task` model with id, a relation to `Repo`, prompt, status, and createdAt fields
- **AND** the `Task` model declares nullable `branch` and `strategy` columns and a `skills` list column

#### Scenario: Migration provisions the tables with the new columns
- **WHEN** the Prisma migrations are applied against an empty Postgres database
- **THEN** the `repos` and `tasks` tables exist with the declared columns
- **AND** the `repos` table includes the `description`, `default_branch`, `branch_count`, and `updated_at` columns
- **AND** the `tasks` table includes the `branch`, `strategy`, and `skills` columns

#### Scenario: Task branch, strategy, and skills survive a write/read round trip in the database
- **WHEN** a task row is written with a non-null `branch`, `strategy`, and `skills`, then re-read from Postgres
- **THEN** the persisted row returns the same `branch`, `strategy`, and `skills` values that were written
- **AND** they are not silently coerced to null or dropped

#### Scenario: Repo without GitHub metadata remains valid
- **WHEN** a `Repo` row is created with only id, name, gitSource, and createdAt and no GitHub-import metadata
- **THEN** the row persists with `description`, `defaultBranch`, `branchCount`, and `updatedAt` all null
- **AND** the record is still a valid `Repo`

### Requirement: REST API for repos
The system SHALL expose REST endpoints to create a repo, list repos, and fetch a single repo by id, validating request and response bodies against the shared contracts schemas. Repo read responses (list and fetch-by-id) SHALL include the OPTIONAL GitHub-import metadata fields `description`, `defaultBranch`, `branchCount`, and `updatedAt` when present on the record, so the repository console page can render the imported repo's description, default branch, branch count, and last-updated time without fabricating them. A repo created from a plain git source without GitHub metadata SHALL remain valid, with those fields returned as null/absent. Validation behavior for the create body is unchanged: an invalid repo body is rejected with HTTP 400 and no record is created.

#### Scenario: Create and list repos
- **WHEN** a client POSTs a valid repo body to the create-repo endpoint and then GETs the list-repos endpoint
- **THEN** the create call returns HTTP 201 with the created repo including a generated id
- **AND** the listed repos include the newly created repo

#### Scenario: Invalid repo body is rejected
- **WHEN** a client POSTs a body that fails the repo contracts schema
- **THEN** the API responds with HTTP 400 and does not create a repo record

#### Scenario: Repo read responses carry GitHub-import metadata when present
- **WHEN** a client GETs a repo (by id or via the list) that was imported from GitHub with metadata persisted
- **THEN** the response includes the repo's `description`, `defaultBranch`, `branchCount`, and `updatedAt`
- **AND** these values match what was persisted on the record

#### Scenario: Repo without GitHub metadata returns null fields
- **WHEN** a client GETs a repo created from a plain `gitSource` with no GitHub-import metadata
- **THEN** the response is a valid repo
- **AND** its `description`, `defaultBranch`, `branchCount`, and `updatedAt` are null or absent rather than fabricated

### Requirement: REST API for tasks
The system SHALL expose REST endpoints to create a task for a repo, list tasks, and fetch a single task by id, validating bodies against the shared contracts schemas. The create-task endpoint SHALL accept the OPTIONAL `branch`, `strategy`, and `skills` run parameters in the request body, and SHALL persist them on the created `Task` record. Every task read path — the create response, the list-tasks response, and the fetch-by-id response — SHALL include the persisted `branch`, `strategy`, and `skills` (echoing whatever was supplied, or null/empty when omitted), so that values submitted by the console are always readable back rather than silently dropped. When a `branch` is supplied, clone/provision behavior is unchanged: the runner checks out that branch from the repo's `gitSource`. The `skills` value selects which server-side allowlisted skills are preinstalled into the task workspace at provision time (see `aio-sandbox-execution`); it does NOT alter task lifecycle.

#### Scenario: Create a task under a repo
- **WHEN** a client POSTs a valid task body referencing an existing repo id
- **THEN** the API returns HTTP 201 with the created task including its id and initial status
- **AND** the task is associated with the referenced repo

#### Scenario: Task for unknown repo is rejected
- **WHEN** a client POSTs a task body referencing a repo id that does not exist
- **THEN** the API responds with HTTP 404 and does not create a task record

#### Scenario: Branch, strategy, and skills are persisted and read back
- **WHEN** a client POSTs a task body that includes a `branch`, a `strategy`, and `skills`
- **THEN** the create response (HTTP 201) includes the same `branch`, `strategy`, and `skills` values
- **AND** a subsequent GET of that task by id returns the same `branch`, `strategy`, and `skills`
- **AND** the task appears in the list-tasks response carrying the same values

#### Scenario: Omitted branch, strategy, and skills read back as null/empty
- **WHEN** a client POSTs a task body that omits `branch`, `strategy`, and `skills`
- **THEN** the create response and the fetch-by-id response both return `branch` and `strategy` as null (or absent) and `skills` as empty/absent, never as a stale or fabricated value

#### Scenario: Task response schema exposes branch, strategy, and skills
- **WHEN** the task response schema in the contracts package is inspected
- **THEN** the `Task`/`TaskResponse` schema declares optional `branch`, `strategy`, and `skills` fields
- **AND** the create-task request schema and the task response schema agree on their shapes so a sent value is a readable value

### Requirement: Task lifecycle states with distinct failed-to-start state
The system SHALL model task status as an explicit enumerated set that includes at least `pending`, `queued`, `running`, `awaiting_input`, `completed`, `failed`, and a distinct `agent_failed_to_start` state separate from `running` and from a generic `failed`, and SHALL only permit transitions defined by the lifecycle. Persisting and reading back `branch`, `strategy`, and `skills` on a `Task` (see the tasks REST and data-model requirements) SHALL NOT alter the lifecycle: those fields are inert run parameters and MUST NOT add, remove, or gate any status transition.

#### Scenario: Status enum includes a distinct failed-to-start value
- **WHEN** the task status enum in the contracts package is inspected
- **THEN** it includes a distinct `agent_failed_to_start` value that is not the same as `running` or `failed`

#### Scenario: Agent that never starts surfaces the distinct state
- **WHEN** the agent process for a task exits before reaching a running state
- **THEN** the task status is set to `agent_failed_to_start` rather than remaining `pending` or `running` indefinitely

#### Scenario: Illegal transition is rejected
- **WHEN** a transition not permitted by the lifecycle (for example `completed` back to `pending`) is requested
- **THEN** the transition is rejected and the persisted status is unchanged

#### Scenario: Branch and strategy do not affect lifecycle transitions
- **WHEN** a task is created with a `branch` and `strategy` and then progresses through its lifecycle
- **THEN** the same status transitions are permitted and rejected as for a task created without those fields
- **AND** the persisted `branch` and `strategy` remain unchanged across status transitions

#### Scenario: Skills do not affect lifecycle transitions
- **WHEN** a task carries any `skills` selection and progresses through its lifecycle
- **THEN** its permitted and rejected status transitions are identical to a task without `skills` set
- **AND** the persisted `skills` remain unchanged across status transitions

