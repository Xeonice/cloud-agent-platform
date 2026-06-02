## ADDED Requirements

### Requirement: Postgres + Prisma data model for repos and tasks
The system SHALL persist repositories and tasks in Postgres via a Prisma schema, where a `Repo` record holds at least an id, a name, and a git source, and a `Task` record holds at least an id, a foreign key to a `Repo`, a prompt, a status, and a created-at timestamp.

#### Scenario: Prisma schema defines Repo and Task models
- **WHEN** the Prisma schema is inspected
- **THEN** it declares a `Repo` model with id, name, and git source fields
- **AND** it declares a `Task` model with id, a relation to `Repo`, prompt, status, and createdAt fields

#### Scenario: Migration provisions the tables
- **WHEN** the Prisma migrations are applied against an empty Postgres database
- **THEN** the `Repo` and `Task` tables exist with the declared columns

### Requirement: REST API for repos
The system SHALL expose REST endpoints to create a repo, list repos, and fetch a single repo by id, validating request and response bodies against the shared contracts schemas.

#### Scenario: Create and list repos
- **WHEN** a client POSTs a valid repo body to the create-repo endpoint and then GETs the list-repos endpoint
- **THEN** the create call returns HTTP 201 with the created repo including a generated id
- **AND** the listed repos include the newly created repo

#### Scenario: Invalid repo body is rejected
- **WHEN** a client POSTs a body that fails the repo contracts schema
- **THEN** the API responds with HTTP 400 and does not create a repo record

### Requirement: REST API for tasks
The system SHALL expose REST endpoints to create a task for a repo, list tasks, and fetch a single task by id, validating bodies against the shared contracts schemas.

#### Scenario: Create a task under a repo
- **WHEN** a client POSTs a valid task body referencing an existing repo id
- **THEN** the API returns HTTP 201 with the created task including its id and initial status
- **AND** the task is associated with the referenced repo

#### Scenario: Task for unknown repo is rejected
- **WHEN** a client POSTs a task body referencing a repo id that does not exist
- **THEN** the API responds with HTTP 404 and does not create a task record

### Requirement: Task lifecycle states with distinct failed-to-start state
The system SHALL model task status as an explicit enumerated set that includes at least `pending`, `running`, `awaiting_input`, `completed`, `failed`, and a distinct `agent_failed_to_start` state separate from `running` and from a generic `failed`, and SHALL only permit transitions defined by the lifecycle.

#### Scenario: Status enum includes a distinct failed-to-start value
- **WHEN** the task status enum in the contracts package is inspected
- **THEN** it includes a distinct `agent_failed_to_start` value that is not the same as `running` or `failed`

#### Scenario: Agent that never starts surfaces the distinct state
- **WHEN** the agent process for a task exits before reaching a running state
- **THEN** the task status is set to `agent_failed_to_start` rather than remaining `pending` or `running` indefinitely

#### Scenario: Illegal transition is rejected
- **WHEN** a transition not permitted by the lifecycle (for example `completed` back to `pending`) is requested
- **THEN** the transition is rejected and the persisted status is unchanged
