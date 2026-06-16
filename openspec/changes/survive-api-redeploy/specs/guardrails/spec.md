## MODIFIED Requirements

### Requirement: Startup recovery reclaims orphaned tasks and re-offers queued tasks
On application bootstrap the orchestrator SHALL perform a THREE-phase recovery so a process restart never strands work AND never needlessly kills a still-running task. Phase 0 (re-adopt): every task persisted as `running` or `awaiting_input` whose `cap-aio-<taskId>` container is still RUNNING AND whose detached codex tmux session (`task<taskId>`) is still alive SHALL be RE-ADOPTED — its provider/connection tracking re-registered, its terminal re-attached, its concurrency slot re-accounted in the semaphore, and its deadline/idle watchers re-armed from the persisted `deadlineMs`/`idleTimeoutMs` — and the task SHALL be KEPT in its current state (NOT transitioned to `failed`). Phase 1 (reclaim): every `running`/`awaiting_input` task that was NOT re-adopted in Phase 0 (its session/sandbox did not survive) SHALL be transitioned to `failed`. Phase 2 (re-offer): after the persisted ceiling override has been loaded into the semaphore, every task persisted as `queued` SHALL be re-offered to the concurrency semaphore in `createdAt` ascending (FIFO) order, restoring each task's persisted per-task guardrail parameters (`deadlineMs`, `idleTimeoutMs`) from its task row; tasks within the remaining capacity (after re-adopted tasks hold their slots) are admitted and the remainder stay queued in that order. A task persisted as `queued` SHALL NOT remain stranded after a restart.

The bootstrap container reap SHALL remove ONLY RUNNING `cap-aio-*` containers that were NOT re-adopted in Phase 0 (i.e. have no matching live task) — it SHALL NOT force-remove re-adopted running containers and SHALL NOT force-remove ALL `cap-aio-*` containers. It SHALL spare STOPPED/retained history containers by filtering on container STATE together with the `cap-aio-*` identity and an age filter, so a Dokploy redeploy or api restart PRESERVES both the re-adopted running task containers and the retained stopped session-history containers rather than wiping them.

#### Scenario: A still-running task is re-adopted, not failed
- **WHEN** the process restarts while the database holds a task in `running` whose `cap-aio-*` container and detached `task<taskId>` tmux session are still alive
- **THEN** bootstrap re-adopts the task (re-attaches its terminal, re-accounts its slot, re-arms its timers) and KEEPS it `running`, rather than transitioning it to `failed`

#### Scenario: A truly-dead running task is failed
- **WHEN** the process restarts while the database holds a `running`/`awaiting_input` task whose detached session did NOT survive (container gone or tmux session dead)
- **THEN** bootstrap transitions that task to `failed` before any queued task is re-offered

#### Scenario: Bootstrap reap spares re-adopted and stopped-retained containers
- **WHEN** the process restarts while RUNNING re-adopted `cap-aio-*` containers, RUNNING orphan `cap-aio-*` containers with no live task, and STOPPED retained history containers all exist
- **THEN** the bootstrap reap removes only the RUNNING orphans with no live task, and does NOT remove the re-adopted running containers or the stopped retained history containers

#### Scenario: Retained stopped containers survive a redeploy
- **WHEN** the api process is redeployed or restarted while stopped retained `cap-aio-*` containers from terminal tasks exist
- **THEN** those stopped containers are still present after bootstrap and remain readable for read-only session-history replay

#### Scenario: Queued tasks are re-offered in FIFO order at startup
- **WHEN** the process restarts while the database holds K tasks in `queued` and the effective post-re-adopt capacity is M
- **THEN** bootstrap re-offers all K tasks to the semaphore in `createdAt` ascending order, the oldest min(K, M) begin admission, and the remaining stay `queued` in that order rather than being lost

#### Scenario: Persisted guardrail parameters are restored on re-offer
- **WHEN** a re-offered queued task was created with a `deadlineMs` and/or `idleTimeoutMs` persisted on its task row
- **THEN** once that task is admitted after the restart, its deadline watcher and idle ceiling arm with those persisted values, identical to a task admitted before the restart

#### Scenario: The persisted ceiling is loaded before queued re-offer
- **WHEN** the process restarts with a persisted ceiling of 2, `MAX_CONCURRENT_TASKS=5`, and 3 queued tasks in the database
- **THEN** the re-offer admits up to the persisted ceiling of 2 (minus any slots held by re-adopted running tasks), not 5, proving the DB override is applied before the queued re-offer runs
