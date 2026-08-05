# Adjudication — the nine `this.audit` symbol references in `guardrails.service.ts`

> The durable artifact required by `guardrails/Every guardrails audit symbol reference is adjudicated
> in a durable artifact`. One row per **symbol reference** measured live on this change's tree — nine
> rows, not "four call sites": a guard (`if (this.audit)` / `if (!this.audit)`) is a reference and is
> adjudicated with the collaboration it guards.
>
> The tier names `batch` and `blocking-strict` and the three refusal criteria
> (`acknowledgement-required` / `information-missing` / `no-decoupling-gain`) are **normatively defined
> in the `domain-event-bus` capability spec**. This file references them; it does not restate or
> rename them (spec: exactly one file defines them).
>
> This artifact is deliberately NOT source comments. `guardrails-domain-event-publishing.spec.ts`
> counts quoted catalog event names over the whole text of `guardrails.service.ts` and asserts exact
> occurrence counts, so a verdict written as a comment next to a publish point would turn an unrelated
> test red (design D2).

## 0. Provenance — what was measured, and how

| What | Command / source | Result |
|---|---|---|
| The nine references | `grep -n 'this\.audit' apps/api/src/guardrails/guardrails.service.ts` | `1197, 2063, 2067, 2770, 3529, 3778, 3787, 3806, 3815` |
| Recorded budget | `scripts/ratchets/r11.json` → `guardrails-symbol-reference:this.audit` | `count: 9` (matches); its `samples` line numbers are two generations stale (`988/1794/2483/3204/3453/3462/3481/3490`) and are refreshed by track 5 |
| Declared return types | `apps/api/src/audit/audit-recorder.port.ts:31-109` | `Promise<void>` for the five best-effort methods; `Promise<boolean>` for `recordProvisioningFailure` (`:57-62`) and `recordTaskCancellation` (`:68`) |
| Per-stage ownership proof | `apps/api/src/task-admission/provisioning-stage-ownership.spec.ts` (track 1) | see §2.5 |
| Event catalog checked against | `packages/contracts/src/domain-event.ts` — envelope `:129-134`, five payloads `:258-334` | envelope carries exactly `eventId`, `occurredAt`, `type`, `taskId` |

The five published payloads, in full, because every `information-missing` verdict below is decided
field-by-field against this list and nothing else:

| Event type | Payload fields beyond the envelope |
|---|---|
| `task.admitted` | `admissionMode`, `outcome`, `fenceToken` |
| `sandbox.provisioned` | `admissionMode`, `providerFamily`, `sandbox{baseUrl,wsUrl,providerId?,providerSandboxId?}`, `environment{runtimeId,executionMode,…}` |
| `task.run_started` | `startPoint`, `admissionMode?` |
| `task.settled` | `status` (terminal statuses only) |
| `task.superseded` | `observationPoint`, `fenceToken?`, `observedStatus?` |

## 1. The nine rows

`R#` is a stable handle for the detail section below. "Reads result?" is about the **caller**, not
about whether the promise is awaited: `await` for ordering is not the same as branching on a value.

| # | `file:line` | Collaborator method (or the guard it forms) | Declared return type | Caller reads / branches on result | Tier | Verdict | Covering event type (EVENT only) | Refusal criterion (CALL only) | Proven other owner (REMOVED only) | Inbound dependents (who depends on this write's timing or result) |
|---|---|---|---|---|---|---|---|---|---|---|
| R1 | `guardrails.service.ts:1197` | `recordProvisioningProgress(taskId, event.stage, claim.attempt)` — the provider-composite `onProvisioningProgress` hint | `Promise<void>` | no (`void this.recordAudit(…)`) | `batch` | **CALL** | — | `information-missing` | — | `guardrails-durable-launch-decision.spec.ts:1804-1859` (pins both in-provision rows); the durable provisioning timeline rows under `task.provisioning:{taskId}:{attempt}:{stage}`; track 1's proof spec |
| R2 | `guardrails.service.ts:2063` | `if (this.audit) {` — the guard around the exit-detail write in `recordExitDetail` | n/a (guard) | no | `batch` | **CALL** | — | `no-decoupling-gain` | — | same as R3 (the guard exists only to hold R3) |
| R3 | `guardrails.service.ts:2067` | `recordExited(taskId, status.code, status.abnormal, tail)` | `Promise<void>` | no (`void this.recordAudit(…)`) | `batch` | **CALL** | — | `no-decoupling-gain` | — | `guardrails.service.spec.ts:2830` (`auditStarted`: the structured failure must persist without waiting on this write); `terminal/owner-recovery-gateway.spec.ts:316`; the `task.exited` row written at `audit.service.ts:288` |
| R4 | `guardrails.service.ts:2770` | `recordChangeRequest(taskId, {url, number, reused})` | `Promise<void>` | no (awaited for ordering; value never read) | `batch` | **CALL** | — | `information-missing` | — | `delivery-results-surfaced-and-audited.test.mjs` — hand-written inline mirror (`:192`) plus T3/T4/T5/T8 (`:287`, `:319`, `:345`, `:422`); **cannot fail on its own** if this call's handling changes |
| R5 | `guardrails.service.ts:3529` | `recordForceFailed(taskId, cause)` | `Promise<void>` | no (awaited for ordering; value never read) | `batch` | **CALL** | — | `information-missing` | — | `guardrails.service.spec.ts:1367` and `:2302` — two **negative** assertions (`forceFailureAuditCalls === 0`, `forceFailAudits === 0`) that depend on the local-CAS attribution guard at `:3523` |
| R6 | `guardrails.service.ts:3778` | `if (!this.audit) { throw … }` — the recorder-availability guard in `requireProvisioningFailureAudit` | n/a (guard) | yes — absence is a failure, not a skip | `blocking-strict` | **CALL** | — | `acknowledgement-required` | — | same as R7 |
| R7 | `guardrails.service.ts:3787` | `recorded = await this.audit.recordProvisioningFailure(taskId, stage, attempt, failure)` | `Promise<boolean>` | **yes** — `if (recorded) return;` else throw | `blocking-strict` | **CALL** | — | `acknowledgement-required` | — | `task-admission.worker.spec.ts:1099-1128`; terminal admission recovery at `guardrails.service.ts:1529` → `TaskAdmissionCoordinationError('checkpoint')` → work row stays leased and reclaimable |
| R8 | `guardrails.service.ts:3806` | `if (!this.audit) { throw … }` — the recorder-availability guard in `requireTaskCancellationAudit` | n/a (guard) | yes — absence is a failure, not a skip | `blocking-strict` | **CALL** | — | `acknowledgement-required` | — | same as R9 |
| R9 | `guardrails.service.ts:3815` | `recorded = await this.audit.recordTaskCancellation(taskId)` | `Promise<boolean>` | **yes** — `if (recorded) return;` else throw | `blocking-strict` | **CALL** | — | `acknowledgement-required` | — | `task-admission.worker.spec.ts:1099-1128` (`pending cancellation audit leaves terminal work leased and reclaimable`); terminal admission recovery at `guardrails.service.ts:1459` |

**Counts.** Rows: 9. `EVENT`: 0. `REMOVED`: 0. `CALL`: 9. `blocking-strict`: 4 (R6–R9). `batch`: 5
(R1–R5). Rows not marked `REMOVED`: 9 — which is the live `this.audit` count and the `count` field
`scripts/ratchets/r11.json` carries.

## 2. Row detail

### 2.1 R6–R9 — the two acknowledgement collaborations (`blocking-strict` / `CALL` / `acknowledgement-required`)

Four of the nine references belong to two methods that return a **durability acknowledgement**:

```
recordProvisioningFailure(taskId, stage, attempt, failure): Promise<boolean>   // port :57-62
recordTaskCancellation(taskId, userId?): Promise<boolean>                      // port :68
```

Both call sites read the value into `recorded` and branch on it (`guardrails.service.ts:3787-3801`
and `:3815-3824`): on `false` — and on a rejection, which is caught and folded into `false` so no raw
provider/Git text reaches durable state or logs — they throw
`TaskAdmissionCoordinationError('checkpoint', taskId, …)`. The two `if (!this.audit)` guards (R6, R8)
are part of the same collaboration and are adjudicated with it: with no recorder bound they throw the
**same** coordination error rather than skipping the write, which is exactly what makes this tier
different from `batch` (a `batch` site with no recorder silently records nothing).

Why this cannot become an event, stated as a property of the collaboration rather than as a property
of the word "audit": the bus's `publish` returns `void` and, by the port's CONTRACT, dispatches each
subscriber inside its own error boundary and swallows failures. **An acknowledgement therefore cannot
physically survive the hop** — a subscriber that failed to persist has no channel back to the caller,
and the caller would proceed as if the row were durable. The industry term for that shape is a
***passive-aggressive event***: an "event" whose publisher actually needs the consumer's answer, so the
consumer's silence gets encoded as success. `@TransactionalEventListener` in Spring behaves the same
way (a listener failure is logged, not returned), which closes the "let the subscriber throw back" escape.

The upgrade condition is stated, not implied: re-homing a `blocking-strict` site requires a durable
**publication registry** — one row per `(event, listener)` pair written in the originating transaction
and replayed on restart — which requires its own change with a schema migration. Until such a change
exists, the migration is refused rather than approximated.

**Inbound direction (task 3.3), for all four rows.** The dependent is not a test-only concern; it is
the durable terminal recovery path:

- `guardrails.service.ts:1459` — a `cancelled` terminal claim calls `requireTaskCancellationAudit(taskId)`
  **before** `continueDurableTerminalCleanup(...)`, so cleanup never runs ahead of a confirmed central
  cancellation row.
- `guardrails.service.ts:1529` — a `provisioning`-classified failed terminal claim calls
  `requireProvisioningFailureAudit(taskId, claim.stage, claim.attempt, failure)` before its cleanup.
- Either throw propagates out of `recoverTerminal`, and the admission worker then **does not settle**
  the durable work row: it stays `running`, still leased, so lease expiry recovery reclaims it and
  retries the audit boundary. Nothing is lost, and nothing is force-settled on an unconfirmed row.
- Existing test that asserts exactly this, located by grep and cited by line:
  **`apps/api/src/task-admission/task-admission.worker.spec.ts:1099`** —
  `test('pending cancellation audit leaves terminal work leased and reclaimable')`, whose processor
  throws `TaskAdmissionCoordinationError('checkpoint', …)` from `recoverTerminal` (`:1116-1120`) and
  which then asserts `assert.rejects(worker.runOnce(), TaskAdmissionCoordinationError)` (`:1125`),
  `row.state === 'running'`, `row.leaseToken === 'worker:1'`, `row.settlement === null` (`:1126-1128`).
- Reinforcing dependent: `task-admission.worker.spec.ts:1342` —
  `test('manual checkpoint coordination failure is not downgraded to lease-lost or swallowed')`.

This is also why these four rows carry the compiler-enforced boundary rather than a new gate:
`apps/api/src/domain-events/domain-event-bus.typecheck.ts` already holds both methods as
`@ts-expect-error` negatives against `VoidOnlyDomainEventHandler`, and the fixture is self-invalidating
— if the guard ever stops rejecting them, the unused `@ts-expect-error` itself fails the typecheck.

### 2.2 R2–R3 — `recordExited` (`batch` / `CALL` / `no-decoupling-gain`)

`recordExitDetail` (`guardrails.service.ts:2043-2071`) samples the transcript tail first:

```ts
tail = (await this.gateway?.readSessionLogTail(taskId)) ?? '';   // :2049 — producer-side I/O
…
if (this.audit) {                                                 // :2063 (R2)
  void this.recordAudit(() =>
    this.audit?.recordExited(taskId, status.code, status.abnormal, tail),  // :2067 (R3)
  );
}
```

The consumed fields are `code`, `abnormal` and `tail`; no catalog payload carries any of them
(`task.settled` carries `status` and nothing else). But the decisive criterion is not the missing
field — it is **where the field comes from**. `tail` is produced by a `gateway.readSessionLogTail(taskId)`
call **at the producer**. Fattening a payload with `tail` would require guardrails to keep performing
that same I/O before publishing, so the guardrails→gateway coupling stays exactly where it is and the
orchestrator additionally acquires a contracts dependency for the enlarged payload: the coupling moves,
it does not disappear, and the dependency budget does not fall. That is `no-decoupling-gain`, and it is
recorded as a property of the collaboration (I/O ownership), not as an exemption for "audit".

Inbound: `guardrails.service.spec.ts:2830`
(`classified exit persists one structured failure without waiting for audit`) wires a
`recordExited` that never settles and asserts the structured failure is still persisted — i.e. the
test depends on this write being *fire-and-forget* relative to the failure persistence. That
interleaving is behaviour, and it is pinned; a subscriber whose dispatch is synchronous before
`publish` returns would change it.

### 2.3 R5 — `recordForceFailed` (`batch` / `CALL` / `information-missing`)

Field-by-field against **all five** catalog payloads, which is what the criterion requires:

| Field the write consumes | Where it comes from | `task.admitted` | `sandbox.provisioned` | `task.run_started` | `task.settled` | `task.superseded` |
|---|---|---|---|---|---|---|
| `taskId` | envelope | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cause` (`deadline` \| `idle` \| `circuit_breaker`), persisted as the row kind `force_failed:${cause}` (`audit-mapping.ts:234-236`) | `forceFail(taskId, cause)` argument | ❌ | ❌ | ❌ | ❌ | ❌ |
| "this replica's own CAS won" attribution — the write happens **only** when `this.terminalTaskStatuses.get(taskId) === terminal` (`guardrails.service.ts:3523`) | process-local control flow | ❌ | ❌ | ❌ | ❌ | ❌ |

The second missing item is not data, it is **control flow**. `task.settled` is published from
`fenceTerminal` (`:2321`) for the first terminal status a task reaches, whoever observed it; the
force-fail row is written only from the locally confirmed CAS callback. A subscriber of `task.settled`
would therefore write the cause row for a remote observation and for a cancelled winner as well —
turning two existing **negative behavioural assertions** red:
`guardrails.service.spec.ts:1367` (`assert.equal(forceFailureAuditCalls, 0, variant)`) and
`guardrails.service.spec.ts:2302` (`assert.equal(forceFailAudits, 0)`). Those two assertions are the
inbound dependents of this row: they depend on the write *not* happening on the non-owning path.

Adding `cause` to `task.settled` would fix the data gap and still leave the attribution gap, which is
why this row is `information-missing` and not "needs a bigger payload".

### 2.4 R4 — `recordChangeRequest` (`batch` / `CALL` / `information-missing`)

Consumed fields are `url`, `number`, `reused` (`audit-recorder.port.ts:105-108`), producing either
`task.change_request_opened` or `task.change_request_reused` (`audit.service.ts:255-261`). None of the
five payloads carries any of the three; more fundamentally the catalog has **no delivery event at
all** — result delivery is not in the published vocabulary, so there is no subscriber path to reach.
Per the user's Q3 decision this cut retains the call; re-homing it belongs to the separate
catalog-extension change, which must pass the same schema review the original five events received.

**Inbound dependent, and the reason it is called out explicitly:**
`apps/api/src/guardrails/delivery-results-surfaced-and-audited.test.mjs` is a **hand-written inline
mirror** — it re-implements `deliverResult` line by line inside the test (`:192` reproduces the very
`this.audit?.recordChangeRequest(taskId, { url: ref.url, number: ref.number, reused })` shape) instead
of importing the real method, then asserts per-argument on the mirror (T3 `:287-299` new CR, T4
`:319-329` reused, T5 `:345` branch-only ⇒ not called, T8 `:422-439` a throwing recorder must not break
teardown/release). Consequence, recorded here so no later cut has to rediscover it: **this file cannot
fail on its own if the handling of the real call changes.** Its 61 audit assertions would stay green
while asserting about a call site that no longer exists — assertion strength intact, subject gone. Any
change to this call's handling MUST update the mirror in the same commit, preserving its per-argument
assertions rather than relaxing them.

### 2.5 R1 — `recordProvisioningProgress` (`batch` / `CALL` / `information-missing`)

This is the one reference this change had standing permission to remove, and it is **retained**. Both
halves of that sentence are evidence-backed, so both are recorded.

**What track 1's executable proof established**
(`apps/api/src/task-admission/provisioning-stage-ownership.spec.ts`, design D5/D6). The proof reads the
reported-stage census out of the real provider sources (rather than restating a list), drives the
production admission chain — real `TaskAdmissionWorker` → real `FencedTaskAdmissionProcessor` → real
`GuardrailsService.processDurableAdmission` → real lease controls, with only the provider stubbed —
and gives the two writers **separate** recorders so every row is attributed to the writer that produced
it. Measured result, on a run **to completion**:

| family:stage | reported at | worker checkpoint that owns the row | owned *during* `provision(...)`? |
|---|---|---|---|
| `aio:readiness` | `aio-provider.ts:401` | `guardrails.service.ts:1247` → `task-admission.worker.ts:612` | **no** — projected only after `provision(...)` returned |
| `aio:runtime_setup` | `aio-provider.ts:413` | `guardrails.service.ts:1245` → `task-admission.worker.ts:612` | **no** |
| `boxlite:readiness` | `boxlite-provider.ts:900` | `guardrails.service.ts:1247` → `task-admission.worker.ts:612` | **no** |
| `boxlite:runtime_setup` | `boxlite-provider.ts:1001` (boundary at `:998`) | `beforeProvisioningBoundary` → `lease.checkpoint` → `task-admission.worker.ts:612` | **yes** |

So design D5's prediction — "`readiness` probably has no worker owner" — was **refuted**: on a
completed run every reported stage does have a worker-written row under the same dedupe identity
`task.provisioning:{taskId}:{attempt}:{stage}` (`audit.service.ts:120`), and the two writers collapse
into one row (proof's last test; the second write reaches the same identity, and a different `attempt`
is correctly a different identity).

**Why the hint is nevertheless retained.** The proof's fourth test pins, as a measured residual rather
than a remembered one, that for `aio:readiness`, `aio:runtime_setup` and `boxlite:readiness` the **only
in-provision writer is this hint** — their worker rows exist only because guardrails projects the two
stages after `provision(...)` returned (`:1245`/`:1247`). Two consequences, either of which alone
blocks the removal:

1. **Ownership is conditional on the attempt succeeding.** An attempt that throws inside
   `provision(...)`, is cancelled, unwinds for a detaching workspace transfer, or loses the post-provision
   ownership re-check never reaches `:1245`/`:1247`. With the hint gone, those three family:stage pairs
   leave **no row at all** for such an attempt — exactly the "silently drop out of the task history
   timeline" outcome the `audit-history` requirement exists to prevent. The failed attempt is precisely
   the case an operator reads the provisioning timeline for.
2. **An untouchable hotspot assertion pins the in-provision rows.**
   `apps/api/src/guardrails/guardrails-durable-launch-decision.spec.ts:1804`
   (`test('provider-composite progress reaches audit without blocking provisioning')`) asserts, while
   `provision(...)` is still suspended, `assert.deepEqual(auditCalls, [[TASK_ID,'readiness',1],[TASK_ID,'runtime_setup',1]])`
   (`:1851-1854`) against a recorder whose promise never settles — i.e. it pins both that the rows are
   written *inside* provisioning and that provisioning does not block on them. Deleting `:1197` empties
   `auditCalls` and turns that file red. It is one of the three named audit hotspots the `guardrails`
   characterization requirement orders to pass **unmodified**, with the explicit rule that if one of
   them requires an edit, *the change is what is wrong, not the test*.

**Verdict recorded: `CALL`, criterion `information-missing`** — the criterion is the one that would
block an EVENT re-homing on its own merits: no catalog payload carries `stage` or `attempt`
(`sandbox.provisioned` carries `providerFamily`/`sandbox`/`environment`, never a stage), so there is no
subscriber path that could produce these rows even if removal were otherwise safe. The retention
reason above is recorded on top of it, not instead of it.

**Consequences to be carried by the other tracks:** the hint stays in the tree byte-identical (track 4
records "retained, 9→9" and makes no source edit); `scripts/ratchets/r11.json` keeps `count: 9` with
refreshed samples (track 5); `deploy/DEPLOY.md` §14's "removes zero existing direct calls" and its
byte-identical claim both remain true and need no withdrawal.

**Reconciliation instruction for integration (task 6.10).** This row and the tree must agree. If the
integrated tree still contains `guardrails.service.ts:1197`, everything above stands: rows = 9,
`REMOVED` = 0, live count = 9 = `r11.json.count`. If — and only if — track 4 lands a removal *with all
three hotspots green and unmodified*, then this row flips to `REMOVED` / proven other owner = the
admission worker checkpoint (`task-admission.worker.ts:612`, fed by `guardrails.service.ts:1245`/`:1247`),
its criterion cell empties, the `REMOVED` count becomes 1 and `r11.json.count` must become 8 in the same
commit. The artifact is wrong before the ratchet is, in that order.

## 3. Assertion-rewrite ledger

**Zero entries.** No assertion anywhere in the repository was rewritten, weakened, deleted, relaxed
into a count, or made order-insensitive by this change. The three named audit hotspots
(`guardrails-durable-launch-decision.spec.ts`, `delivery-results-surfaced-and-audited.test.mjs`,
`guardrails.service.spec.ts`) are untouched, and the guardrails characterization baseline is unchanged
— re-counted live while writing this artifact rather than copied from the spec:
`guardrails.service.spec.ts` 57 + `guardrails-durable-launch-decision.spec.ts` 54 +
`guardrails-domain-event-publishing.spec.ts` 15 + `guardrails-branch-policy.spec.ts` 3 +
`semaphore-restore.spec.ts` 3 + `transfer-progress-throttle.spec.ts` 3 = **135 `test()` across 6
`*.spec.ts`**, plus **8 `.test.mjs`** counted separately.

Any future entry MUST be filled in with all three of the required facts and one classification — the
template is kept here so a later cut has no excuse to improvise it:

| # | File:line | (a) implementation detail / (b) real requirement | The order the original assertion pinned | Why that order no longer holds | The invariant the replacement pins |
|---|---|---|---|---|---|
| — | *(no entries)* | — | — | — | — |

(a) is replaced by a result assertion over the set of audit rows the completed operation produced;
(b) is re-expressed against the new seam and never relaxed. A rewrite with no entry here is a
re-baseline, not a rewrite.

## 4. Self-check against the specs

| Check (spec source) | Result |
|---|---|
| Exactly one row per measured `this.audit` symbol reference | 9 rows / 9 references ✅ |
| Every row carries a verdict | 9/9, zero blank ✅ |
| Every row carries exactly one tier | 9/9 (`batch` 5, `blocking-strict` 4), zero rows with both or neither ✅ |
| Every `CALL` row cites **exactly one** of `acknowledgement-required`, `information-missing`, `no-decoupling-gain` | 9/9 cite exactly one; zero cite none or more than one ✅ |
| The `blocking-strict` set is exactly the four references of the two acknowledgement methods | R6/R7 (`recordProvisioningFailure`) + R8/R9 (`recordTaskCancellation`) = 4 ✅ |
| No `batch` row returns a value the caller reads | R1–R5 all `Promise<void>`, none branched on ✅ |
| Zero rows are `EVENT` | 0 ✅ — each `information-missing` row names the field no payload carries (`cause`, `stage`/`attempt`, `url`/`number`/`reused`), and the `no-decoupling-gain` row names the producer-side I/O (`tail`) |
| Both directions recorded per row (outbound collaborator **and** inbound dependents) | 9/9 ✅ |
| Tier names referenced, not redefined | ✅ — normative definition stays in the `domain-event-bus` capability spec |
| **Row count for task 6.10** | **9** |
| **`REMOVED` count for task 6.10** | **0** (rows not marked `REMOVED` = 9 = live `this.audit` count = `r11.json` `count`) |

Track 5 takes its own `REMOVED` count from track 1's verdict via track 4's actual edit, not from this
table; §2.5's reconciliation instruction is what makes a disagreement visible at integration instead
of silently splitting the artifact from the tree.

## 5. 阶段 4 剩余三组预扫（路线校准）

> 【用户拍板新增】本节是**初判，不是裁定**：它不对应任何 spec requirement，只作为第 3–5 刀 propose
> 的证据输入。判据沿用同一套三条（需要回执 / 信息缺失 / 事件化不减耦），逐组按 ①调用点与返回类型
> ②所需字段在五个已发布 payload 中是否存在 ③是否存在控制流归属或 IO 依赖导致"补齐字段也不减耦"
> ④初判结论 记录。

### 5.1 `this.runnerMinutes`（R11 记 6 处）

**① 现场调用点与返回类型**

| `file:line` | 调用 | 返回类型 | 调用方读结果 |
|---|---|---|---|
| `guardrails.service.ts:1824` | `recordStart(taskId)`（readoption 恢复路径，紧邻 `task.run_started` 发布点 1/3） | `void` | 否 |
| `guardrails.service.ts:2917` | `recordStart(taskId)`（legacy `startRunningAfterCapacity`，紧邻发布点 2/3） | `void` | 否 |
| `guardrails.service.ts:3286` | `recordStart(taskId)`（`armDurableRuntime`，紧邻发布点 3/3） | `void` | 否 |
| `guardrails.service.ts:2319` | `recordEnd(taskId)`（`fenceTerminal`） | `void` | 否 |
| `guardrails.service.ts:3264` | `recordEnd(taskId)`（`clearAdmissionRuntime`） | `void` | 否 |
| `guardrails.service.ts:3880` | `intervals()`（`runnerMinuteIntervals()` 的实现体） | `RunningInterval[]` | **是**（返回给 `metrics.service.ts:74` 的 `deriveRunnerMinutes(...)`） |

**② 字段充分性**：`recordStart/recordEnd` 只消费 `taskId` 与"发生时刻"，二者都在信封里
（`taskId` + `occurredAt`）。**这是三组里唯一字段不缺的一组**——三个 `recordStart` 与
`task.run_started` 的三个发布点是 1:1 贴着写的。

**③ 控制流归属 / IO 依赖**：两条硬阻塞。
(a) `recordEnd` 是 **2 个调用点对 1 个 `task.settled`**，而且这个不对称是被刻意写进代码注释并要求
spec 保护的：`clearAdmissionRuntime` 的 `recordEnd`（`:3264`）发生在任务**还活着**的时候，在那里发
`TaskSettled` 属于伪造结算；`fenceTerminal` 的 `recordEnd`（`:2319`）则**无条件**执行，而
`task.settled` 只在首次拿到终态时才发（`settledStatus !== undefined`），teardown-only 的无状态围栏
与重复围栏都不发事件。订阅 `task.settled` 去做 `recordEnd`，必然漏掉这两类，计费区间不闭合 = 漏账。
(b) 账本是 guardrails 的**进程内私有状态**（`:593 private readonly runnerMinutes = new RunnerMinutesLedger()`），
它的读取面 `runnerMinuteIntervals()`（`:3879-3881`）是 guardrails 对外暴露的公开方法，被
`metrics.service.ts:74` 直接拉取。只把写改成订阅、账本与读取面留在 guardrails，等于把同一个内存对象
的所有权劈成两半，guardrails→metrics 的拉取耦合原样留着，预算最多降 3/6 而耦合一分不降。

**④ 初判：LIKELY-CALL**（三个 `recordStart` 单看可事件化，但 `recordEnd` 的 2:1 不对称无事件覆盖，
且账本与其拉取读取面留在 guardrails，属"补齐字段也不减耦"——真正的解法是把账本连同读取面整体搬出去）。

### 5.2 `provisioningDiagnosticRecorder`（4）+ `provisioningDiagnosticWriteGate`（4）

**① 现场调用点与返回类型**

| `file:line` | 调用 | 返回类型 | 调用方读结果 |
|---|---|---|---|
| `guardrails.service.ts:654` / `:657` | 构造函数注入声明（各 1 处引用） | — | — |
| `guardrails.service.ts:731` / `:732` | 透传给 inline-admission 适配器 | — | — |
| `guardrails.service.ts:2949` / `:2950` | `tryBeginProvisioningDiagnostics`：`gate.isEnabled()` + `tryBegin…(recorder, input)` | `boolean` / `Promise<BegunTaskProvisioningDiagnosticObserver \| undefined>` | **是** |
| `guardrails.service.ts:3017` / `:3018` | `tryResumeProvisioningDiagnostics`：同上 resume 形态 | `boolean` / `Promise<Resumed… \| undefined>` | **是** |

**② 字段充分性**：不适用——这一组要的不是字段，是**返回物**。`gate.isEnabled()` 返回布尔并被直接分支
（`if (!enabled) return undefined`）；recorder 返回的是一个**活的 attempt 句柄**，随后被一路带着走
（`inlineAdmission.rememberBegunAttempt`、`runWithTaskProvisioningAttemptLog`、
`continueDurableTerminalCleanup`，最终 `attempt.settlement.settlePrimary(...)`）。`publish` 返回
`void`，物理上交不回布尔，更交不回句柄。

**③ 控制流归属 / IO 依赖**：8 处引用里有 4 处是构造声明与透传（`:654/:657/:731/:732`），任何"把写
改订阅"的做法都删不掉它们——它们只在整个诊断观察者**搬出 guardrails**时才归零。

**④ 初判：LIKELY-CALL**（`acknowledgement-required` 的最强形态：一个返回布尔并分支，一个返回后续
必须结算的句柄；且半数引用是注入面，事件化对预算几乎无效）。

### 5.3 `this.transcripts`（2）

**① 现场调用点与返回类型**：`guardrails.service.ts:2110` `if (!this.transcripts) return;`（守卫）与
`:2112` `await this.transcripts.capture(taskId)`，声明为 `capture(taskId: string): Promise<unknown>`
（`:287`）。调用方**不读返回值**，但**必须等它完成**。

**② 字段充分性**：只消费 `taskId`，信封已有——**字段不缺**。

**③ 控制流归属 / IO 依赖**：阻塞点是**完成时序**而不是数据。方法注释把要求写死了：capture 之所以被
`await`，是为了保证归档写在 stop-only `teardownSandbox` **之前**完成（容器还在）。而 `publish` 返回
`void`：即便派发是同步的，发布方也拿不到订阅者的 promise，无法在容器销毁前等它落盘。另外两个调用点
（`:2368` 终态收口、`:2616` durable 终态恢复的 `plan.captureTranscript`）里，后者根本不在
`fenceTerminal` 那个 `task.settled` 发布接缝上，订阅者也就接不到。

**④ 初判：LIKELY-CALL，并附一条给下一刀的词表缺口**：本组的拒绝理由是"调用方依赖协作者的**完成**"，
而现有三条判据里最接近的 `acknowledgement-required` 字面写的是"读取返回值并分支"。第 3–5 刀要么把
判据 1 的表述扩成"依赖返回值**或其完成时序**"，要么补第四条判据；在此之前，本组按 `LIKELY-CALL` 记，
理由字段留"完成时序，不在现有三判据字面内"。

### 5.4 路线结论（本刀交付即可见）

三组初判：`this.runnerMinutes` = LIKELY-CALL、`provisioningDiagnosticRecorder` +
`provisioningDiagnosticWriteGate` = LIKELY-CALL、`this.transcripts` = LIKELY-CALL——**三组全部为
LIKELY-CALL，满足"两组或以上"的条件**。

据此记载路线结论：

> **阶段 4 达成 guardrails <2,000 行与解 forwardRef 环的路径，应从「事件化」改为「直接抽 application
> service」；第 3–5 刀的 propose 必须以本节为输入。** 依据是本节测出的共同形状：剩余三组缺的基本不是
> payload 字段（`runnerMinutes` 与 `transcripts` 的字段在信封里就齐了），而是**回执/完成时序**
> （diagnostics 的布尔与句柄、transcript 的落盘先于 teardown）与**状态所有权**（runner 账本与它的拉取
> 读取面留在 guardrails）。这三样都不是"把 payload 做胖"能解决的：把写改成订阅而把状态、读取面与注入面
> 留在原地，只会让所有权跨两个模块劈开，行数与 forwardRef 环一分不降。把这三组连同它们的状态整体抽成
> application service（或把账本/观察者搬到各自的上下文里）才同时降行数、降依赖预算并解环。

本节不写进任何 spec requirement（初判不是裁定）；`docs/refactor-master-plan.md` 阶段 4 段落已加一行
指针指向本节。
