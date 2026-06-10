# guardrails Spec Delta — configurable-task-slots

## MODIFIED Requirements

### Requirement: Concurrency semaphore bounds running tasks
The orchestrator SHALL enforce a maximum number of concurrently running tasks (the slot ceiling). The effective ceiling SHALL resolve as `persisted system setting ?? env MAX_CONCURRENT_TASKS ?? 5`: the persisted system-level setting (see `account-settings`) is authoritative once saved; the env variable `MAX_CONCURRENT_TASKS` is only the first-boot seed used when no persisted value exists. The ceiling SHALL be runtime-mutable without a process restart via a semaphore setter: a non-integer or non-positive value SHALL be rejected without changing the current ceiling; RAISING the ceiling SHALL immediately admit queued tasks in FIFO order until the new capacity is filled or the queue empties (no waiting for the next slot release); LOWERING the ceiling SHALL NOT interrupt, evict, or kill any running task — it SHALL only stop admitting new tasks while the running count exceeds the new ceiling, so the running count converges naturally as tasks release. When the limit is reached, newly created tasks SHALL remain queued rather than provisioning a sandbox, and when a running task reaches a terminal state (completed/failed/cancelled) the orchestrator SHALL admit the next queued task in FIFO order only while the running count is below the ceiling. The admission hot path SHALL NOT read the database: the in-memory ceiling is authoritative and is written only at bootstrap load and on a settings-save push.

#### Scenario: Task over the limit stays queued
- **WHEN** the effective ceiling of tasks are already running and a new task is created
- **THEN** the new task remains in the queued state and no sandbox is provisioned for it

#### Scenario: Freeing a slot admits the next queued task
- **WHEN** a running task reaches a terminal state while at least one task is queued and the running count is below the ceiling after release
- **THEN** the orchestrator provisions the oldest queued task, bringing the running count back to at most the effective ceiling

#### Scenario: Persisted setting overrides the env value
- **WHEN** the process boots with a persisted slot ceiling of N while `MAX_CONCURRENT_TASKS` is set to a different value M
- **THEN** the effective ceiling after bootstrap is N (the persisted value), not M

#### Scenario: Env seeds the ceiling only when no persisted value exists
- **WHEN** the process boots with no persisted slot ceiling
- **THEN** the effective ceiling is the value of `MAX_CONCURRENT_TASKS`, or 5 when the env variable is also unset

#### Scenario: Raising the ceiling promotes queued tasks immediately
- **WHEN** the ceiling is raised from N to N+k while the semaphore holds N running tasks and at least k queued tasks
- **THEN** the k oldest queued tasks are admitted in FIFO order immediately upon the raise, without waiting for any running task to release its slot

#### Scenario: Lowering the ceiling never evicts running tasks
- **WHEN** the ceiling is lowered below the current running count
- **THEN** no running task is interrupted, evicted, or transitioned by the resize; no new task is admitted while the running count exceeds the new ceiling; and as running tasks reach terminal states the running count converges down to the new ceiling, after which FIFO admission resumes

#### Scenario: Invalid ceiling value is rejected without effect
- **WHEN** the semaphore setter is invoked with zero, a negative number, or a non-integer
- **THEN** the call is rejected and the current ceiling, running set, and queue are unchanged

## ADDED Requirements

### Requirement: Startup recovery reclaims orphaned tasks and re-offers queued tasks
On application bootstrap the orchestrator SHALL perform a two-phase recovery so a process restart never strands work. Phase 1 (reclaim): every task persisted as `running` or `awaiting_input` — whose in-memory session and sandbox did not survive the restart — SHALL be transitioned to `failed`. Phase 2 (re-offer): after the persisted ceiling override has been loaded into the semaphore, every task persisted as `queued` SHALL be re-offered to the concurrency semaphore in `createdAt` ascending (FIFO) order, restoring each task's persisted per-task guardrail parameters (`deadlineMs`, `idleTimeoutMs`) from its task row; tasks within the post-reclaim capacity are admitted and the remainder stay queued in that order. A task persisted as `queued` SHALL NOT remain stranded (never re-offered) after a restart.

#### Scenario: Orphaned running tasks are failed at startup
- **WHEN** the process restarts while the database holds tasks in `running` or `awaiting_input`
- **THEN** bootstrap transitions each of those tasks to `failed` before any queued task is re-offered

#### Scenario: Queued tasks are re-offered in FIFO order at startup
- **WHEN** the process restarts while the database holds K tasks in `queued` and the effective ceiling is M
- **THEN** bootstrap re-offers all K tasks to the semaphore in `createdAt` ascending order, the oldest min(K, M) begin admission, and the remaining K − min(K, M) stay `queued` in that order rather than being lost

#### Scenario: Persisted guardrail parameters are restored on re-offer
- **WHEN** a re-offered queued task was created with a `deadlineMs` and/or `idleTimeoutMs` persisted on its task row
- **THEN** once that task is admitted after the restart, its deadline watcher and idle ceiling arm with those persisted values, identical to a task admitted before the restart

#### Scenario: The persisted ceiling is loaded before queued re-offer
- **WHEN** the process restarts with a persisted ceiling of 2, `MAX_CONCURRENT_TASKS=5`, and 3 queued tasks in the database
- **THEN** the re-offer admits exactly 2 tasks (the persisted ceiling), not 5, proving the DB override is applied before the queued re-offer runs
