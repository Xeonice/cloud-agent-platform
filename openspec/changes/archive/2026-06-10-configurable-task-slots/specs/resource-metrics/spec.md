# resource-metrics Spec Delta — configurable-task-slots

## MODIFIED Requirements

### Requirement: Derived capacity metrics are exact projections of semaphore state

The orchestrator SHALL expose runtime capacity metrics that are EXACT, point-in-time projections of the in-memory `ConcurrencySemaphore` state — never sampled, estimated, or cached. The derived capacity set SHALL include: the configured slot ceiling (`maxConcurrentTasks` — the live, runtime-configurable ceiling read from the semaphore at request time; its persisted source is defined in `guardrails`, and env `MAX_CONCURRENT_TASKS` is only a first-boot seed, no longer an equivalent name for this figure), the active running-task count (`runningCount`), the number of free slots (`maxConcurrentTasks - runningCount`), and the queue depth (`queuedCount`). These values SHALL be read from the live semaphore at request time so that, whenever `active <= ceiling`, the reported `active + free` equals the ceiling; `free` SHALL never be reported as negative. Because the ceiling is runtime-mutable with shrink-without-eviction semantics, a TRANSITIONAL OVERAGE state (`active > ceiling`, occurring after the ceiling is lowered below the current running count) SHALL be reported honestly rather than masked: `ceiling` reports the new lowered value, `active` reports the real running count (which MAY temporarily exceed `ceiling`), and `free` clamps to 0; the `active + free === ceiling` identity is suspended during overage and resumes once running tasks release down to the ceiling. Because the semaphore is the single source of truth for admission, the derived metrics endpoint SHALL NOT maintain a parallel counter that could drift from the semaphore; if a derived figure cannot be read from the semaphore it SHALL be reported as such rather than fabricated.

The console prototype surfaces these as the capacity readouts on the workspace launcher and dashboard (e.g. `RUNNERS 7/10`, `QUEUE`, free-slot pills, the 4 metric tiles 活跃 / 待处理 / 空闲槽位). Those readouts are the product surface for this requirement; the values they show SHALL be the live derived figures defined here, replacing the prototype's hardcoded mock numbers.

#### Scenario: Active, free, and queue counts are read live from the semaphore

- **WHEN** the metrics endpoint is queried while the semaphore holds N running tasks, a ceiling of M slots (with N ≤ M), and Q queued tasks
- **THEN** it reports `active = N`, `ceiling = M`, `free = M - N`, and `queueDepth = Q` read from the live semaphore at request time
- **AND** `active + free` equals `ceiling` and `free` is never negative

#### Scenario: Derived counts change immediately as slots are taken and freed

- **WHEN** a task is admitted to a running slot (or a running task reaches a terminal state and frees its slot) between two metrics requests
- **THEN** the second response reflects the new `active`/`free`/`queueDepth` without lag, because the figures are projected from the semaphore rather than from a periodically sampled snapshot

#### Scenario: Derived metrics never drift from admission state

- **WHEN** the metrics endpoint computes the capacity figures
- **THEN** it derives them solely from the `ConcurrencySemaphore` (`runningCount`, `queuedCount`, `maxConcurrentTasks`) and maintains no independent counter that could disagree with actual admission decisions

#### Scenario: A runtime ceiling change is visible on the next metrics read

- **WHEN** the slot ceiling is changed at runtime through the settings surface between two metrics requests
- **THEN** the second response reports the new `ceiling` value read live from the semaphore, with no restart and no cached stale ceiling

#### Scenario: Shrink overage reports real active and clamped free

- **WHEN** the ceiling is lowered to M while N > M tasks are running and the metrics endpoint is queried before convergence
- **THEN** it reports `ceiling = M`, `active = N` (the real running count, exceeding the ceiling), and `free = 0` (clamped, never negative)
- **AND** once running tasks release down to at most M, subsequent reads satisfy `active + free === ceiling` again

### Requirement: Slot occupancy table enumerates the running set and the queue

The orchestrator SHALL expose a slot occupancy table that enumerates, per slot, whether it is occupied and by which task. The table SHALL be derived from `ConcurrencySemaphore.snapshotRunning()` and `snapshotQueue()`: it SHALL list exactly `maxConcurrentTasks` slots, each marked `busy` (carrying the occupying `taskId`) or `idle` (free), and SHALL additionally report the queued task ids in FIFO order so the console can render the backlog distinctly from free slots. Whenever `active <= ceiling`, the number of `busy` entries SHALL equal the derived `active` count and the number of `idle` entries SHALL equal the derived `free` count, so the table and the scalar capacity metrics are internally consistent. During the TRANSITIONAL OVERAGE state (running count above a freshly lowered ceiling), the table SHALL still list exactly `maxConcurrentTasks` slots — all `busy`, zero `idle` — and the surplus running task ids that no longer fit SHALL be omitted from the slot table (the queued id list remains complete); the `busy === active` identity is suspended during overage rather than the table growing beyond the ceiling. The table SHALL NOT invent slot identities beyond the configured ceiling.

The prototype's `SlotMeter` (the 10-segment busy/warn/idle meter) and the free-slot pills render this table; the segments SHALL map to real slot occupancy, not to a static decorative count.

#### Scenario: Occupancy table lists ceiling-many slots with real occupants

- **WHEN** the slot table is requested while the semaphore reports a ceiling of M with running task ids `[t1, t2]`
- **THEN** the table contains exactly M slot entries, two of them `busy` carrying `t1` and `t2`, and the remaining `M - 2` entries `idle`

#### Scenario: Queue backlog is enumerated separately from free slots

- **WHEN** the semaphore is at capacity with a non-empty FIFO backlog
- **THEN** every slot entry is `busy`, the `idle` count is zero, and the queued task ids are reported separately in FIFO order rather than being shown as free slots

#### Scenario: Table and scalar metrics agree

- **WHEN** both the slot occupancy table and the scalar capacity metrics are read from the same request while `active <= ceiling`
- **THEN** the count of `busy` slots equals `active`, the count of `idle` slots equals `free`, and the queued id list length equals `queueDepth`

#### Scenario: Shrink overage keeps the table at ceiling width

- **WHEN** the slot table is requested while the ceiling was lowered to M and N > M tasks are still running
- **THEN** the table contains exactly M slot entries, all `busy`, with zero `idle` entries, and the N − M surplus running task ids are omitted from the slot table rather than rendered as extra slots
