## MODIFIED Requirements

### Requirement: Wall-clock deadline force-fails a task
A task MAY carry a wall-clock deadline, supplied via the task create request (`deadlineMs`) and passed to concurrency admission (`admit(taskId, deadlineMs)`) so the deadline watcher arms. When a running task passes its deadline, the orchestrator SHALL transition it to `failed`, invoke `SandboxProvider.teardownSandbox()` for the task, and free its concurrency slot. Teardown is a **port-level** call: per design D9 the deferred minimal Docker provider documents it as a no-op (Docker is the deploy plane, not the per-task execution sandbox), while a future OS-isolating provider performs a real teardown through the same port. For the AIO provider, `teardownSandbox()` is STOP-ONLY (it stops and RETAINS the container, performing the pre-stop `/home/gem/.codex` trim + `auth.json` clear), so the frozen container survives for read-only session-history replay; the slot is still freed.

#### Scenario: Task exceeding its deadline is failed and torn down
- **WHEN** a running task's wall-clock deadline passes
- **THEN** the orchestrator transitions the task to `failed`, invokes `SandboxProvider.teardownSandbox()` for the task, and releases its concurrency slot

#### Scenario: Deadline teardown retains the container while freeing the slot
- **WHEN** a deadline force-fail invokes `teardownSandbox()` on the AIO provider
- **THEN** the container is stopped-and-retained (not removed) and the task's concurrency slot is still freed

#### Scenario: Task finishing before its deadline is unaffected
- **WHEN** a task reaches a terminal state before its deadline
- **THEN** no deadline-based force-fail is applied

### Requirement: Idle ceiling reclaims wedged tasks
Idle reclamation SHALL be OPT-IN PER TASK and OFF BY DEFAULT. The orchestrator SHALL track a running task's idle time (no terminal output and no agent-hook activity) and force-fail it on exceeding an idle ceiling ONLY when an idle ceiling is in effect for that task. An idle ceiling is in effect when the task carries an explicit per-task `idleTimeoutMs` (supplied via the task create request and passed through concurrency admission), OR when an operator-level global default is configured (`MAX_IDLE_MS`). When NEITHER is present — the default for a task created without an idle timeout in a deployment that has not set `MAX_IDLE_MS` — the task SHALL NOT be idle-tracked and SHALL NEVER be force-failed for idleness, so a legitimately long, quiet task is not reclaimed. The per-task `idleTimeoutMs` SHALL take precedence over the operator-level default. The idle ceiling is per task (not a single process-wide constant): when armed, the timer is sized to that task's effective ceiling and activity resets it against that same ceiling. (This remains distinct from the shorter "awaiting input" notification driven by the `Stop` hook, which does not fail the task.) When an idle force-fail tears down the sandbox, `SandboxProvider.teardownSandbox()` is STOP-ONLY for the AIO provider (the container is retained for read-only replay), and the slot is still freed.

#### Scenario: Task without an idle ceiling is never idle-reclaimed
- **WHEN** a task is created without an `idleTimeoutMs` and the deployment has no `MAX_IDLE_MS` configured, then runs silently past any prior 10-minute mark
- **THEN** the orchestrator does NOT idle-track the task and never force-fails it for idleness, holding its slot until it terminates by another path (completion, operator stop, deadline, crash)

#### Scenario: Per-task idle ceiling reclaims an idle task
- **WHEN** a task is created WITH an explicit `idleTimeoutMs` and then produces no terminal output and no hook activity for longer than that ceiling
- **THEN** the orchestrator force-fails the task, invokes `SandboxProvider.teardownSandbox()` for the task, and frees its slot

#### Scenario: Idle teardown retains the container while freeing the slot
- **WHEN** an idle force-fail invokes `teardownSandbox()` on the AIO provider
- **THEN** the container is stopped-and-retained (not removed) and the task's concurrency slot is still freed

#### Scenario: Operator-level default applies when no per-task value is given
- **WHEN** the deployment configures a global `MAX_IDLE_MS` and a task is created without a per-task `idleTimeoutMs`
- **THEN** the task is idle-tracked at the operator-level default ceiling

#### Scenario: Per-task value overrides the operator-level default
- **WHEN** a task supplies an `idleTimeoutMs` and the deployment also configures `MAX_IDLE_MS`
- **THEN** the task's idle ceiling is its own `idleTimeoutMs`, not the operator-level default

#### Scenario: Activity resets the idle timer against the task's own ceiling
- **WHEN** an idle-tracked task emits terminal output or a hook event before reaching its ceiling
- **THEN** the idle timer resets and the task is not force-failed, re-armed against that task's own ceiling rather than a process-wide constant

### Requirement: A terminal sandbox exit transitions the task and frees its slot
When a running task's sandbox terminal session terminates (the connect-in terminal WebSocket closes and the orchestrator resolves an exit status), the orchestrator SHALL drive the task to a terminal lifecycle state and release its concurrency slot on that SINGLE exit — it SHALL NOT leave the task in `running` with a held slot. A resolved exit code of zero SHALL transition the task to `completed`; a resolved non-zero exit code SHALL transition the task to `failed`; an abnormal termination (the session never established, or the exit code is unresolvable) SHALL force-fail the task. In every case the orchestrator SHALL invoke `SandboxProvider.teardownSandbox()`, tear down the session-scoped credentials, and free the concurrency slot (admitting the next queued task), reusing the same terminal-teardown path as natural completion. For the AIO provider this `teardownSandbox()` is STOP-ONLY: the container is stopped and RETAINED (not removed), after the pre-stop `/home/gem/.codex` trim + `auth.json` clear, so the frozen `rollout-*.jsonl` survives for read-only session-history replay; the slot is still freed. This closes the gap whereby a cleanly-exited or single-non-zero-exit session previously remained `running` and leaked its slot until idle reclamation or a process restart — a gap that becomes a permanent leak once idle reclamation is off by default.

#### Scenario: Clean exit completes the task and frees the slot
- **WHEN** a running task's terminal session exits with a resolved code of zero
- **THEN** the orchestrator transitions the task to `completed`, tears down its sandbox and session credentials, and frees its concurrency slot

#### Scenario: Non-zero exit fails the task and frees the slot
- **WHEN** a running task's terminal session exits with a resolved non-zero code
- **THEN** the orchestrator transitions the task to `failed`, tears down its sandbox and session credentials, and frees its concurrency slot on that first exit

#### Scenario: Abnormal termination force-fails the task and frees the slot
- **WHEN** a running task's terminal session closes before being established, or its exit code cannot be resolved
- **THEN** the orchestrator force-fails the task, tears down its sandbox, and frees its concurrency slot

#### Scenario: Terminal-exit teardown retains the container while freeing the slot
- **WHEN** a terminal-exit transition invokes `teardownSandbox()` on the AIO provider for a completed, failed, or abnormally-terminated task
- **THEN** the container is stopped-and-retained (not removed) so its `rollout-*.jsonl` survives, and the task's concurrency slot is still freed

#### Scenario: Terminal teardown is idempotent under concurrent close handling
- **WHEN** the exit-driven terminal transition runs while the terminal gateway is also handling the same session's close
- **THEN** the teardown + slot release completes exactly once without error (double-calls to teardown and slot release are tolerated)

### Requirement: Startup recovery reclaims orphaned tasks and re-offers queued tasks
On application bootstrap the orchestrator SHALL perform a two-phase recovery so a process restart never strands work. Phase 1 (reclaim): every task persisted as `running` or `awaiting_input` — whose in-memory session and sandbox did not survive the restart — SHALL be transitioned to `failed`. Phase 2 (re-offer): after the persisted ceiling override has been loaded into the semaphore, every task persisted as `queued` SHALL be re-offered to the concurrency semaphore in `createdAt` ascending (FIFO) order, restoring each task's persisted per-task guardrail parameters (`deadlineMs`, `idleTimeoutMs`) from its task row; tasks within the post-reclaim capacity are admitted and the remainder stay queued in that order. A task persisted as `queued` SHALL NOT remain stranded (never re-offered) after a restart.

The bootstrap container reap SHALL remove ONLY RUNNING orphan `cap-aio-*` containers — it SHALL NOT force-remove ALL `cap-aio-*` containers. It SHALL spare STOPPED/retained history containers by filtering on container STATE (only RUNNING) together with the `cap-aio-*` identity and an age filter, so a Dokploy redeploy or api restart PRESERVES the retained stopped session-history containers rather than wiping them. A stopped retained container SHALL survive a process restart and remain available for read-only session-history replay.

#### Scenario: Orphaned running tasks are failed at startup
- **WHEN** the process restarts while the database holds tasks in `running` or `awaiting_input`
- **THEN** bootstrap transitions each of those tasks to `failed` before any queued task is re-offered

#### Scenario: Bootstrap reap removes only running orphan containers
- **WHEN** the process restarts while both RUNNING orphan `cap-aio-*` containers and STOPPED retained `cap-aio-*` history containers exist
- **THEN** the bootstrap reap removes only the RUNNING orphan containers and does NOT remove the stopped retained history containers

#### Scenario: Retained stopped containers survive a redeploy
- **WHEN** the api process is redeployed or restarted while stopped retained `cap-aio-*` containers from terminal tasks exist
- **THEN** those stopped containers are still present after bootstrap and remain readable for read-only session-history replay

#### Scenario: Queued tasks are re-offered in FIFO order at startup
- **WHEN** the process restarts while the database holds K tasks in `queued` and the effective ceiling is M
- **THEN** bootstrap re-offers all K tasks to the semaphore in `createdAt` ascending order, the oldest min(K, M) begin admission, and the remaining K − min(K, M) stay `queued` in that order rather than being lost

#### Scenario: Persisted guardrail parameters are restored on re-offer
- **WHEN** a re-offered queued task was created with a `deadlineMs` and/or `idleTimeoutMs` persisted on its task row
- **THEN** once that task is admitted after the restart, its deadline watcher and idle ceiling arm with those persisted values, identical to a task admitted before the restart

#### Scenario: The persisted ceiling is loaded before queued re-offer
- **WHEN** the process restarts with a persisted ceiling of 2, `MAX_CONCURRENT_TASKS=5`, and 3 queued tasks in the database
- **THEN** the re-offer admits exactly 2 tasks (the persisted ceiling), not 5, proving the DB override is applied before the queued re-offer runs

## ADDED Requirements

### Requirement: Retention cleaner reaps stopped retained sandbox containers
The orchestrator SHALL run a periodic, unref'd retention cleaner (modeled on the existing `CodexDeviceLoginService` sweep) wired in the guardrails layer that removes STOPPED `cap-aio-*` containers under MULTIPLE simultaneous policies, removing a container when ANY policy trips. Policy 1 (age): a stopped `cap-aio-*` container whose stopped age exceeds the configured retention window SHALL be removed, where the retention window is read from account settings (the persisted retention-days value, default 30 days when unset). Policy 2 (free-disk high-water-mark): when host free disk drops below a configured floor, the cleaner SHALL evict OLDEST-stopped `cap-aio-*` containers FIRST until free disk recovers above the floor, even if those containers are younger than the retention window. The cleaner SHALL only remove containers that are STOPPED and carry the `cap-aio-*` identity, and SHALL NEVER remove a RUNNING container. The cleaner SHALL carry an in-process `isRunning` overlap guard so a slow sweep never overlaps the next tick; the single-instance assumption SHALL be stated explicitly (no distributed lock).

#### Scenario: A stopped container past the retention window is reaped
- **WHEN** the cleaner sweeps and finds a stopped `cap-aio-*` container whose stopped age exceeds the configured retention window
- **THEN** the cleaner removes that container

#### Scenario: Retention window is read from settings with a 30-day default
- **WHEN** the cleaner resolves the retention window and no retention-days value is persisted in account settings
- **THEN** it uses a default of 30 days, and when a value IS persisted it uses that persisted value instead

#### Scenario: Low free disk evicts the oldest stopped containers first
- **WHEN** host free disk is below the configured high-water-mark floor and stopped `cap-aio-*` containers younger than the retention window exist
- **THEN** the cleaner removes the OLDEST-stopped containers first until free disk recovers above the floor

#### Scenario: Running containers are never reaped
- **WHEN** the cleaner sweeps while a `cap-aio-*` container is RUNNING, regardless of age or free-disk level
- **THEN** the cleaner does not remove that running container

#### Scenario: Overlapping sweeps are prevented by the in-process guard
- **WHEN** a cleaner sweep is still in progress and the next scheduled tick fires
- **THEN** the second tick is skipped by the `isRunning` guard and only one sweep runs at a time
