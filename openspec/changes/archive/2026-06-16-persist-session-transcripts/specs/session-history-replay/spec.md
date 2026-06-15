## MODIFIED Requirements

### Requirement: Read-only session-history endpoint reads the frozen rollout from the stopped container
The system SHALL expose a read-only `GET /tasks/:id/session-history` endpoint, following the existing `GET /tasks/:taskId/metrics` controller convention (covered by the global `APP_GUARD` authentication, returning a discriminated response). The endpoint SHALL resolve the rollout DURABLE-FIRST: it SHALL read the persisted transcript archive (the index record plus the gzip-compressed raw `rollout-*.jsonl` on the durable workspace volume) FIRST and, on a hit, decompress and parse it WITHOUT touching the container. ONLY when no durable archive exists SHALL the endpoint FALL BACK to reading the codex `rollout-*.jsonl` out of the task's STOPPED `cap-aio-<taskId>` container via the dockerode `getContainer(id).getArchive()` (docker-cp) API, which reads the frozen container layer directly without restarting the container and is reliable BECAUSE the container was retained with `AutoRemove: false`. On a successful container fallback the endpoint SHALL read-through BACKFILL the durable archive and index so the next read is a durable hit. The endpoint SHALL be a SEPARATE REST surface that NEVER touches the live WebSocket / PTY / write-lease pipeline. The endpoint SHALL glob `rollout-*.jsonl` (the per-session conversation record), NOT `history.jsonl` (the global user-input log). The endpoint SHALL NOT export `/home/gem/.codex/auth.json` or any credential file.

#### Scenario: Endpoint reads the durable archive first
- **WHEN** an authenticated operator requests `GET /tasks/:id/session-history` for a task that has a persisted transcript archive
- **THEN** the endpoint reads, decompresses, and parses the durable archive and returns the transcript WITHOUT reading from or depending on the container

#### Scenario: Endpoint falls back to the container and backfills
- **WHEN** the endpoint is requested for a task that has NO durable archive yet but whose `cap-aio-<id>` container is stopped-and-retained with a rollout
- **THEN** the endpoint reads `rollout-*.jsonl` out of the stopped container via dockerode `getArchive` (docker-cp) without restarting the container
- **AND** it read-through backfills the durable archive and index so a subsequent request resolves as a durable hit
- **AND** it parses the per-session `rollout-*.jsonl` record, not `history.jsonl`

#### Scenario: Endpoint requires authentication
- **WHEN** an unauthenticated request hits `GET /tasks/:id/session-history`
- **THEN** the global `APP_GUARD` rejects it, identically to the existing `GET /tasks/:taskId/metrics` endpoint

#### Scenario: Endpoint never exports credentials
- **WHEN** the endpoint reads the durable archive or files out of the stopped container
- **THEN** it does not include `/home/gem/.codex/auth.json` or any credential file in its response

#### Scenario: Endpoint stays off the live terminal pipeline
- **WHEN** the session-history read executes
- **THEN** it operates as a standalone REST read and does not open, mutate, or depend on the task's live WebSocket / PTY / write-lease path

### Requirement: Session-history response is a discriminated honest 5-state contract
The endpoint SHALL return a DISCRIMINATED response mapping each terminal task status to one of five honest states, and a not-running / expired / no-rollout condition SHALL be an explicit STATE, never an error. The states are: (1) `completed` task → the parsed rollout transcript; (2) `cancelled` task → the parsed rollout transcript plus an interrupted-terminal indication; (3) `failed` task → the parsed rollout transcript up to the failure point; (4) `agent_failed_to_start` (and `provision_failed`, which lands the task in `failed`) → an EMPTY state carrying the failure reason and no fabricated transcript; (5) expired/reaped → an EMPTY state indicating the record has aged out, returned ONLY when NEITHER a durable transcript archive NOR the container holds the rollout (going forward this is limited to sessions that were reaped BEFORE transcript persistence existed, since new terminal tasks are archived durably). The endpoint SHALL NEVER fabricate transcript content for an empty state. A schema for this discriminated response (`SessionHistoryResponse`) SHALL be added to `@cap/contracts` and used to validate the response on the client with a Zod `.parse`.

#### Scenario: Completed task returns the rollout transcript
- **WHEN** the endpoint is requested for a `completed` task whose rollout is present (durable archive or container)
- **THEN** the response discriminates to the rollout-transcript state carrying the parsed conversation items

#### Scenario: Cancelled task returns rollout plus interrupted indication
- **WHEN** the endpoint is requested for a `cancelled` task
- **THEN** the response carries the parsed rollout transcript AND an interrupted-terminal indication so the terminal-replay source can be shown as a mid-run interrupted frame

#### Scenario: Failed task returns the rollout up to the failure
- **WHEN** the endpoint is requested for a `failed` task that produced a rollout before failing
- **THEN** the response carries the parsed rollout transcript up to the failure point

#### Scenario: No-rollout failure returns an empty state with the reason
- **WHEN** the endpoint is requested for an `agent_failed_to_start` task, or a `failed` task whose cause was `provision_failed` and codex never produced a rollout
- **THEN** the response discriminates to an empty state carrying the failure reason and no fabricated transcript

#### Scenario: Expired/reaped record returns an empty aged-out state only when both sources are gone
- **WHEN** the endpoint is requested for a task that has NO durable transcript archive AND whose retained container has already been removed by the retention cleaner (no rollout can be read from either source)
- **THEN** the response discriminates to an empty state indicating the session record has aged out, not an error

#### Scenario: Not-running is a state, never an error
- **WHEN** the endpoint cannot read a rollout for any honest reason (no archive, no container, no rollout)
- **THEN** it returns a discriminated empty/degraded state rather than throwing an error response

#### Scenario: Response is schema-validated on the client
- **WHEN** the console receives the session-history response
- **THEN** it validates the payload against the `@cap/contracts` `SessionHistoryResponse` schema via Zod `.parse` before rendering
