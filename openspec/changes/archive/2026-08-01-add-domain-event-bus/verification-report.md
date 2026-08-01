# Verification report — `add-domain-event-bus`

Adversarial verification with three-way routing (UNMET → re-opened code task ·
SPEC-DEFECT → design.md Open Questions · MET → folded here).

## Adjudicated tally

| Route | Count | Ids |
|---|---|---|
| Re-opened as code tasks (UNMET) | 0 | — |
| Routed to design.md Open Questions (SPEC-DEFECT) | 0 | — |
| Archive-blocking spec defects | 0 | — |
| MET (re-traced end-to-end) | 24 | all requirements in both spec files |

The skeptic pass produced **zero** raw-unmet requirements and **zero** mandatory
public findings. Every one of the 24 requirements was independently re-traced
against the working tree (not rubber-stamped) and all 24 re-trace as satisfied.
`tasks.md` is 46/46 checked with zero open items, so no
`## Track: verify-reopened` section was created.

---

## Evidence actually executed on this tree

Every command below was run against the integrated working tree during
adjudication, not quoted from the apply log.

| Gate | Result |
|---|---|
| `pnpm --filter @cap-console/api typecheck` (`tsc --noEmit`) | clean — 0 errors |
| `node scripts/ratchets/r11-dependency-budget.mjs` | exit 0 — all six collaborators exactly at baseline |
| `node scripts/context-layout-check-v2.mjs` | exit 0 — 282 files scanned, every class within baseline |
| `node scripts/contracts-executed-schema-check.mjs` | exit 0 — 405 schemas, 389 executed by production code, "every schema is executed" |
| `node scripts/api-module-layout-check.mjs` | exit 0 — alias imports only, no cross-directory cycles |
| `node scripts/test-discovery-check.mjs` | exit 0 — 484 test files, **all discovered by a runner** |
| `node --test dist/domain-events/*.spec.js dist/guardrails/*.spec.js dist/tasks/tasks-domain-event-publishing.spec.js dist/inline-admission/*.spec.js` | **178 pass / 0 fail** |
| `node scripts/run-suite.mjs "src/guardrails/**/*.test.mjs"` | 8 pass / 0 fail |
| `node --test src/sandbox/sandbox-host-harness-wiring.test.mjs` | 1 pass / 0 fail (text-scanning test, unmodified) |
| `node scripts/public-surface-tests.mjs fast` | 14/14 turbo tasks successful, contracts public-surface 64 pass / 0 fail |

Diff-shape facts confirmed by `git diff --name-only main`:

- **Zero `*.spec.ts` files modified anywhere in the repository.** Not in
  `apps/api/src/guardrails/`, and not in the nine out-of-directory files that
  construct `GuardrailsService` positionally — the trailing-`@Optional()`
  placement made even the "permitted" construction-argument edit unnecessary.
- Zero edits to `apps/api/prisma/schema.prisma`, zero new migration directories.
- Zero edits to `scripts/contracts-executed-schema-check.mjs` (so
  `INDIRECTION_POINTS` gained no entry) and zero edits to
  `scripts/ratchets/r7.json` (so the layout gate produced no new key).
- Zero edits to `scripts/quick-deploy.sh` and no new deploy runbook file.

---

## Requirement-by-requirement adjudication (all MET)

### `specs/domain-event-bus/spec.md` — 17 requirements

| # | Requirement | Re-trace evidence |
|---|---|---|
| 1 | The domain event bus is a declared in-process port with synchronous dispatch | `apps/api/src/domain-events/domain-event-bus.port.ts` (interface + `DOMAIN_EVENT_BUS` string token, shaped after `audit-recorder.port.ts`, imports only `@cap-console/contracts` — nothing ending `.service.ts`); impl in `domain-event-bus.service.ts`; binding in `domain-events.module.ts` (`@Global()` + `useExisting`, same shape as `audit.module.ts`). Both publishers (`guardrails.service.ts`, `tasks.service.ts`) import `DOMAIN_EVENT_BUS` / `DomainEventBusPort` from the `.port.ts` only. `publish()` is a plain `for` loop over a filtered array with no `await`, no queue, no `setImmediate`, no persistence. |
| 2 | Subscriber failures are isolated per subscriber | `domain-event-bus.service.ts:81-96` — `try`/`catch` **inside** the loop, one boundary per subscriber. No `EventEmitter` import anywhere in the directory. `describeThrown()` handles non-`Error` throws including a value whose `String()` itself throws. |
| 3 | Swallowed subscriber failures are observable | `assertSubscriberName()` rejects empty/missing names **at construction and at `subscribe()`**, not at failure time. Each swallowed failure emits exactly one `DomainEventBusLogRecord` carrying `eventType`, `subscriberName`, and `error`, plus a human-readable `message` composed from the same facts. Two failing subscribers produce two independent `warn` calls inside the loop — neither can collapse the other. |
| 4 | A subscriber failure never escalates into a process-level failure | `DOMAIN_EVENT_TYPES` contains no `error` literal and no duplicate. The failure path calls `this.#logger.warn(...)` only — zero re-entrant `publish`. Handlers are `void`-typed and never awaited, so no `unhandledRejection` path exists. |
| 5 | Subscribers are registered explicitly and only registered subscribers run | Registration flows through the `DOMAIN_EVENT_SUBSCRIBERS` array token. No `DiscoveryService`, no `MetadataScanner`, no `@nestjs/cqrs`, no `@nestjs/event-emitter` in the change's files or in either `package.json`. `DOMAIN_EVENT_SUBSCRIBER_REGISTRATIONS` is `Object.freeze([])` — this change registers zero subscribers, so no published event has any side effect. |
| 6 | Subscriber handlers must return void, enforced at compile time | `VoidOnlyDomainEventHandler<T> = T & (ReturnType<T> extends void ? unknown : {…})` — exactly the spec-mandated shape, with the rejection type written **inline** (the port's own comment documents the measured tsc 5.9.3 behaviour: a named alias collapses the diagnostic). `domain-event-bus.typecheck.ts` pins 3 negatives (value-returning, `async`, promise-returning) and 4 positives (empty handler, delegation, `.bind()`, fire-and-forget with `.catch`). `tsc --noEmit` is clean, which is simultaneously the proof that all 11 `@ts-expect-error` directives are still firing. |
| 7 | The non-event admission rule is declared and mechanically enforced | The rule is stated in return/acknowledgement terms in `domain-event-bus.port.ts:112-128` and in `domain-events/README.md`; the three current collaborations appear as worked examples, not as the rule. The typecheck fixture rejects `audit.recordProvisioningFailure` (real method **and** parameter-adapted wrapper), `audit.recordTaskCancellation`, `writeGate.isEnabled` (real **and** adapted), `lease.authorize()`, and `lease.checkpoint(stage)`. The self-invalidation property is real: weakening the guard turns those directives unused and `tsc --noEmit` fails TS2578 — the very command that passes above. |
| 8 | Event catalog v1 declares exactly five events sharing one envelope | `DOMAIN_EVENT_TYPES` is the single declaring array; the five discriminants are destructured off it rather than retyped; `DOMAIN_EVENT_SCHEMAS` is `satisfies Record<DomainEventType, …>` (totality is a compile error) and `DomainEventSchema` reads its union members out of that map. `DomainEventEnvelopeSchema` carries `eventId` (uuid), `occurredAt` (`.datetime()`, UTC-only), `type`, `taskId`. Both publish seams mint `eventId: randomUUID()` per call via `domainEventEnvelope()`. |
| 9 | Payload validation happens inside publish and cannot fail the publisher | `#validate()` calls `DomainEventSchema.parse(event)` as the **first** statement of `publish`, before `recipients` is even computed. A failure logs one `domain_event.invalid_payload` record and returns `false`, so zero subscribers run and nothing is thrown. `contracts-executed-schema-check` passes with zero `INDIRECTION_POINTS` additions — real execution, not exemption. |
| 10 | Event payloads are fat, primitive-only, and derive shared vocabulary | Every field is a string/enum/plain object of those. `DomainEventProviderFamilySchema` spreads `SANDBOX_PROVIDER_FAMILIES` (appending a family needs zero edits here); the literals `aio`/`boxlite`/`cloud-http` appear nowhere in the catalog. `SandboxProvisionedEventSchema` carries task id + sandbox reference + provider family + environment snapshot — enough to record a provisioning without calling back into guardrails. |
| 11 | TaskSuperseded carries no superseder identity | `TaskSupersededEventSchema` fields are exactly `observationPoint`, optional `fenceToken`, optional `observedStatus`, plus the envelope. No `supersededBy`/`supersederTaskId`/`winnerToken` or equivalent exists. |
| 12 | The canonical fence token is the admission transition token | Legacy: `admitUntracked` mints `transitionToken = randomUUID()` **once** and threads it into `startRunning(...)` / `safeAdmissionTransition(...)` so the published token is literally the token that fenced the transition (`startRunning` gained it as a defaulted parameter instead of minting its own). Durable: `tasks.service.ts` publishes `fenceToken: request.transitionToken`, never `request.leaseToken` — the code comment names the substitution it refuses. `admissionMode` is a required discriminant on `TaskAdmittedEventSchema`. |
| 13 | Catalog v1 is in-process, additive-only, and declares its upgrade condition | The catalog header declares "domain events: in-process, synchronous, and not persisted", states the two upgrade triggers verbatim, and dedicates a section to distinguishing "this change introduces no outbox" from the pre-existing `TaskAdmissionWork` admission outbox. No schema uses `.strict()`, so unknown fields parse. Diff confirms zero prisma/migration edits and no code path writing an event anywhere. |
| 14 | The publish cutover toggle is snapshot-once, result-shaped, default-on, attestation-free | `EnvironmentDomainEventPublishingCutover` reads `process.env` once into a `#decision` field initialiser and returns it thereafter. `evaluate()` returns `{enabled, reason, source}` — never a bare boolean. Unset → `{enabled: true, reason: 'default', source: 'unset'}`. Escape hatch (`0`/`false`/`off`, trimmed + lower-cased) → `{enabled: false, reason: 'escape-hatch', …}`, and the composition root then omits the bus provider entirely so publishers take the same `this.bus === undefined` path the pre-change code takes. No attestation, build identity, or signature is referenced. |
| 15 | The cutover toggle is registered with an owner and a retirement condition | `deploy/DEPLOY.md` §14 adds a registry table row naming the variable, the default ("publishing ON — unset, or any unrecognised value, takes the new path"), the owner (阶段 4 event-migration track owner / owner of this change and its five follow-ons), and the retirement condition (deleted by the last 阶段 4 change, the one untying the `tasks` ↔ `guardrails` `forwardRef` cycle). Diff adds no runbook file and touches neither `scripts/quick-deploy.sh` nor the compose files. |
| 16 | The bus lands in a declared context with classified file names | `docs/refactor/contexts-manifest.json` declares `domain-events` under `platform-ops` with a rationale note in the same commit. All new source files use classified suffixes (`.port.ts` ×2, `.service.ts`, `.module.ts`, `.spec.ts` ×2, `.typecheck.ts`). `pnpm test:context-layout-v2` exits 0 with zero unmapped directories and no new `r7.json` key (that file is untouched). `crossContextRules.machineReadable` gains `domainEventSubscription` filling the slot the existing `$comment` reserved — declared as pure attribution that widens no allow-list, with `busPortFiles` asserted to end in `portFileSuffix`. `api-module-layout-check` passes with `ALLOWED_CYCLES` still empty; test-discovery reports every added test file as executed. |
| 17 | The dependency budget ratchet is seeded with measured counts | `scripts/ratchets/r11.json` records exactly the mandated seed — `this.audit` 9, `this.runnerMinutes` 6, `provisioningDiagnosticRecorder` 4, `provisioningDiagnosticWriteGate` 4, `this.transcripts` 2, metrics-projection 2 — each with line-anchored samples measured on this tree. A live re-count via `node scripts/ratchets/r11-dependency-budget.mjs` reproduces all six exactly and exits 0. `compareToBaseline` is fail-closed in both directions (above baseline **and** stale-higher baseline). Registered in CI as `Dependency budget ratchet (R11)` and in `package.json` as `test:dependency-budget`. |

### `specs/guardrails/spec.md` — 7 requirements

| # | Requirement | Re-trace evidence |
|---|---|---|
| 18 | Guardrails publishes domain events without changing lifecycle behavior | The bus is the **11th** constructor parameter, `@Optional() @Inject(DOMAIN_EVENT_BUS)`, with the preceding 10 untouched. Every publish goes through `private publishDomainEvent(event)` which is `this.bus?.publish(event)` inside a `try`/`catch` that logs and swallows — a throwing bus cannot fail a transition, teardown, runner-minutes close, or slot release. Zero existing collaborator calls were removed (R11 re-count proves it numerically: all six counts unchanged from the pre-change tree). The escape-hatch path and the no-bus path are the same code path by construction. |
| 19 | TaskRunStarted is published at exactly three declared points | Exactly three `startPoint` publishes exist: `readoption` (adjacent to `runnerMinutes.recordStart` in the readoption commit window — synchronous, so it does not violate that window's no-`await` rule; deliberately carries **no** `admissionMode` because readoption cannot know it), `legacy_capacity` (in `startRunning`, adjacent to its `recordStart`), and `durable_arm` (in `armDurableRuntime`, placed **after** both `durableRuntimeArmed` early-returns so re-arming publishes nothing). No `recordStart` call was replaced or moved. |
| 20 | TaskSettled is published only at the terminal fence | One publish site, in `fenceTerminal`. `settledStatus` is computed **before** the status map is written, via `TERMINAL_TASK_STATUSES.find(...)` — the same declaration the schema's `status` derives from — so idempotency extends to publishing (a repeat fence with the same status publishes nothing) and a status-less fence publishes nothing. `clearAdmissionRuntime` publishes nothing and carries a comment marking the 2-`recordEnd`-to-1-`TaskSettled` asymmetry as deliberate. Both `recordEnd` call sites remain unchanged (R11 count for `this.runnerMinutes` is still 6). |
| 21 | SandboxProvisioned is published on both provisioning paths after the provider boundary succeeds | Durable: published in `guardrails.service.ts` after `provider.provision(...)` returns, after the ownership re-verification (`lease.authorize()`), and after `connections.set(taskId, connection)`. Legacy: published in `inline-admission.pipeline.ts` **below** both post-provision fence checks (each of which discards the sandbox), not next to `registerConnection`. Both route through one `publishSandboxProvisioned(admissionMode, source)` builder on the orchestrator so the two payloads are identical by construction. The three builder functions (`domainEventProviderFamily`, `domainEventSandboxReference`, `domainEventEnvironmentSnapshot`) are pure functions of the provision plan and selected run already in hand — no new provider call, database read, or resolver. Failed / cancelled / detaching / superseded attempts never reach the line. |
| 22 | TaskAdmitted is published on both admission paths | Durable: `tasks.service.ts` publishes under the same committed-transition condition its audit call uses, with `outcome: result.status` and `fenceToken: request.transitionToken`. Legacy: `admitUntracked` publishes for the running half only when `started === 'transitioned'` and for the queued half only when `queuedTransition === 'transitioned'` — refused, superseded, and already-transitioned outcomes publish nothing. Concurrency: the publish sits inside the untracked admission stored in `admissionsInFlight`, so callers joining the in-flight promise publish nothing of their own. |
| 23 | TaskSuperseded is published once per observation at three declared producer boundaries | (1) `durable_capacity_reservation` — `tasks.service.ts`, `result.outcome === 'superseded'`. (2) `durable_admission_transition` — both routes to `superseded` inside `performAdmissionTransition` funnel through `observeAdmissionSupersession(...)`, which publishes then `return`s, so at most one per call, carrying the `observedStatus` it actually read. (3) `inline_pipeline_run` — `run()` was split into a thin wrapper around `runProvisioning()`, so the nine internal `superseded` early-returns are untouched and the single run exit publishes exactly once. Non-superseded outcomes publish nothing. No payload carries any superseder identity (the schema has no such field to carry). |
| 24 | Existing guardrails behavior is proven unchanged by characterization | **Zero `*.spec.ts` files modified anywhere** — verified by `git diff --name-only main -- '*.spec.ts'` returning empty. The 5 pre-existing in-directory spec files and the 8 `.test.mjs` scripts pass unmodified (178 compiled specs green across domain-events/guardrails/tasks/inline-admission; 8 guardrails `.test.mjs` green). The out-of-directory construction-argument edit the spec permitted turned out to be unnecessary, which is a strictly stronger result than the requirement asks for. The text-scanning test `sandbox-host-harness-wiring.test.mjs` needed no update and still passes with its per-file assertions intact. Each declared publish point carries its own new test in `guardrails-domain-event-publishing.spec.ts`, `tasks-domain-event-publishing.spec.ts`, and `inline-admission-domain-event-publishing.spec.ts`. The bus is absent from the characterization baseline: the in-directory specs run with no bus injected and pass, proving the publish calls are conditional on the injected collaborator. |

---

## Public-surface adjudication

`surface-impact.json` declares `publicV1` / `mcp` / `openapi` / `apiPlayground`
as **`derived`** — the conservative `CLASSIFIER_SURFACE_MAP.contracts` mapping
triggered by `packages/contracts/src/domain-event.ts` being re-exported from
`packages/contracts/src/index.ts` — with `internalOnly` as `changed`.

Re-traced and upheld:

- The impact **is declared**, not undeclared. There is no undeclared public
  impact to route to `blockingSpecDefects`.
- The declaration's substance holds: the bus is in-process, publishes nothing to
  any transport, persists nothing, and adds no operation, tool, or projection.
  `node scripts/public-surface-tests.mjs fast` is green (14/14 tasks; contracts
  public-surface 64/64), so no operation shape, OpenAPI document, MCP tool
  listing, or playground projection moved.
- `protocolDifferences` is the repository's standing list of REST/MCP divergences
  and is byte-identical to `main`. This change adds no operation and therefore
  claims no new exclusion — there is no false protocol exclusion to block on.

**Result: 0 archive-blocking spec defects.**

---

## Gap finding (traceability)

Every one of the 24 requirements across both spec files has a traceable
implementation in the codebase: the port/service/module/cutover files under
`apps/api/src/domain-events/`, the catalog in
`packages/contracts/src/domain-event.ts`, the compile-time guard fixture
`domain-event-bus.typecheck.ts`, the manifest entry in
`docs/refactor/contexts-manifest.json`, the ratchet baseline
`scripts/ratchets/r11.json`, the deploy-doc registration in `deploy/DEPLOY.md`,
and the publish call sites covering `task.admitted`, `sandbox.provisioned`,
`task.run_started`, `task.settled`, and `task.superseded`, plus new spec files
(`guardrails-domain-event-publishing.spec.ts`,
`tasks-domain-event-publishing.spec.ts`,
`inline-admission-domain-event-publishing.spec.ts`) alongside the unmodified
original guardrails specs.

**No requirement was found with zero traceable implementation.**

```json
[]
```

### Correction to the raw gap note's accounting

The raw finding described the publish sites as "all seven publish call sites
across `guardrails.service.ts` / `tasks.service.ts`". Re-counting on the tree,
the accurate figure is **twelve publish statements across three files**, and the
third file matters because two spec requirements land there:

| File | Publish statements |
|---|---|
| `apps/api/src/guardrails/guardrails.service.ts` | 9 — `sandbox.provisioned` (durable), `task.admitted` legacy×2 (running / queued), `task.run_started` ×3 (`readoption` / `legacy_capacity` / `durable_arm`), `task.settled`, plus the two orchestrator-adapter closures (`publishSandboxProvisioned` legacy, `publishRunSupersession`) the inline pipeline publishes through |
| `apps/api/src/tasks/tasks.service.ts` | 3 — `task.admitted` (durable), `task.superseded` (`durable_capacity_reservation`), `task.superseded` (`durable_admission_transition`, via `observeAdmissionSupersession`) |
| `apps/api/src/inline-admission/inline-admission.pipeline.ts` | 2 call sites, both through the orchestrator port (`publishSandboxProvisioned`, `publishRunSupersession`) — the legacy `SandboxProvisioned` path and the run-level `TaskSuperseded` exit |

This is a counting correction to the note, not a defect: the corrected map still
matches the declared publish points exactly, with no undeclared extra site. The
apparent discrepancy comes from the legacy provisioning path deliberately
publishing *through* the orchestrator port rather than holding the bus itself,
so its statements live in `guardrails.service.ts` while its call sites live in
`inline-admission.pipeline.ts`.

---

## Scope findings (implementation beyond spec — recorded, not blocking)

Four narrow additions sit inside the bus/cutover/ratchet mechanism itself. None
is wired into any publisher-visible behaviour, so all four are low-severity
scope creep (dead or lightly-exercised surface, extra internal classification)
rather than functional drift. Recorded here so a later change can delete them
without re-deriving why they exist.

1. **Pluggable DI logger seam.** `DOMAIN_EVENT_BUS_LOGGER` token +
   `DomainEventBusLogger` interface + optional constructor injection for the
   bus's failure/validation logging. The spec only requires that a structured
   warn-level record be emitted, not that the log sink be swappable via DI. The
   token is never bound in `domain-events.module.ts` (production always falls
   back to a plain `Logger`) and is not even exercised *via DI* in
   `domain-event-bus.service.spec.ts` — the tests instantiate the service
   positionally (`new DomainEventBusService([], logger)`), bypassing the token
   entirely.
   `apps/api/src/domain-events/domain-event-bus.port.ts:52`,
   `domain-event-bus.port.ts:79-81`,
   `apps/api/src/domain-events/domain-event-bus.service.ts:55`,
   `domain-event-bus.service.ts:61-63`, `domain-event-bus.service.ts:69`.

2. **Extra `explicitly-enabled` reason classification** and the
   `DOMAIN_EVENT_PUBLISHING_EXPLICIT_ON_VALUES` (`'1'`/`'true'`/`'on'`) parsing
   branch in the cutover toggle. The cutover requirement and its four scenarios
   only distinguish "escape-hatch OFF" from "default ON (unset or
   unrecognised)"; no requirement or scenario asks the toggle to recognise or
   separately label an explicit opt-in value as distinct from the default-on
   path.
   `apps/api/src/domain-events/domain-event-publishing-cutover.port.ts:55-59`,
   `:62-68`, `:111-121`.

3. **Extra `unrecognised-value` vs `unset` source distinction** on the cutover
   decision object. The requirement's scenarios only test the `unset` case
   explicitly reporting a source; splitting `unset` from `unrecognised-value` as
   separate provenance values is additional classification with no backing
   scenario.
   `apps/api/src/domain-events/domain-event-publishing-cutover.port.ts:71-74`,
   `:123-125`.

4. **Baseline-vs-declaration `symbol` documentation-drift check** in the R11
   ratchet gate (fails the gate if `r11.json`'s recorded `symbol` field
   disagrees with the `COLLABORATORS` declaration). The
   *dependency-budget-ratchet-is-seeded-with-measured-counts* requirement and
   its three scenarios only require baseline-vs-live-count comparison in both
   directions, not cross-checking a documentation field for drift.
   `scripts/ratchets/r11-dependency-budget.mjs:226-236`.

### Method note

The working tree was diffed against `main` for every file the change touches
(`git diff --stat` → 15 modified + 14 new files under
`apps/api/src/domain-events/`, `packages/contracts/src/domain-event.ts`, the
three new `*-domain-event-publishing.spec.ts` files, and `scripts/ratchets/r11-*`),
then each implementation file was read against the two spec files and `tasks.md`.
All publish points match their declared requirements exactly, with no extra
publish sites found.

---

## Verdict

All 24 requirements MET. Zero re-opened tasks, zero spec defects, zero
archive-blocking findings. The change is verification-clean and eligible for
archive.
