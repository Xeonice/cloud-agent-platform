## ADDED Requirements

### Requirement: The create rate-limit tier applies only to task creation

The stricter `create` rate-limit tier SHALL be enforced ONLY on the task-creation route
(`POST /v1/tasks`), NOT on other authenticated requests. The broad `default` tier SHALL bound all
other authenticated traffic. A high-frequency authenticated request to a non-creation route (e.g.
`GET /tasks`, `/metrics`, `/auth/session`) SHALL NOT be rejected by the create tier.

#### Scenario: Create cap does not land on non-creation routes

- **WHEN** an authenticated principal sends many non-creation requests within the window
- **THEN** they are bounded only by the broad default tier and never receive a create-tier 429 on those routes

#### Scenario: Task creation is still create-capped

- **WHEN** an authenticated principal exceeds the create cap on `POST /v1/tasks`
- **THEN** that route is throttled by the create tier

### Requirement: Rate-limit buckets are per-account by account id

The per-principal rate-limit bucket SHALL be keyed by the account primary key (`user.id`) for an
authenticated account — local OR GitHub — so each account has its OWN bucket; a machine api-key
principal keys by its key id. A local account SHALL NOT share a single bucket with other local
accounts.

#### Scenario: Local account gets its own bucket

- **WHEN** two distinct local accounts (githubId=null) make requests
- **THEN** they are tracked under separate per-account buckets, not one shared `kind:session` bucket

#### Scenario: API-key principal keys by key id

- **WHEN** a machine api-key principal makes requests
- **THEN** its bucket is keyed by the key id (unchanged)
