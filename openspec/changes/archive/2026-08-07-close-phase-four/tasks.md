<!-- Track-annotated tasks. Two requirements, six tasks — ratio 3.0. Defences are executable
     assertions in assertions.json, not prose tasks. The two tracks share no file. -->

## 1. Track: acyclic-edge-and-gate (depends: none)

- [x] 1.1 Remove the vestigial `forwardRef` in `apps/api/src/tasks/tasks.module.ts`: `:58` becomes a plain `GuardrailsModule,`, and `forwardRef` leaves the `@nestjs/common` import at `:1`. Correct the doc paragraph at `:43-46` in the same edit — it says GuardrailsModule is imported via forwardRef to break the circular reference, and there is no circular reference: `guardrails.module.ts:68` declares an empty imports array and no non-test file under `apps/api/src/guardrails/` imports `@/tasks`. The honest sentence is that `GUARDRAILS_SERVICE_TOKEN` (`:80-83`) decouples TasksService from the concrete class; name metrics/settings/terminal as the three sibling modules that already import GuardrailsModule plainly. Do NOT touch `guardrails.module.ts:63` — its comment is already past-tense and historically accurate.
  - requirements: ["monorepo-foundation/the-tasks-guardrails-composition-edge-carries-no-forwardref-and-a-gate-says-so"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

- [x] 1.2 Write `scripts/module-composition-cycle-check.mjs`: read exactly `apps/api/src/tasks/tasks.module.ts` and `apps/api/src/guardrails/guardrails.module.ts`, and exit non-zero if either contains a forwardRef naming the other module. FAIL CLOSED IN BOTH DIRECTIONS — a missing file exits non-zero rather than passing over a file it never opened, which is the green-because-it-found-nothing failure this repo has paid for. Comment lines do not count as violations: prose that names the retired forwardRef is the record the requirement wants kept, and a check that counted it would push a future author to erase the explanation to make the number zero. Match the voice of the existing narrow checks (`scripts/console-request-header-cors-check.mjs`): lead with WHY it exists, and say what it deliberately does NOT do — it does not re-litigate the module-composition exemption in monorepo-foundation, which is correct and stays.
  - requirements: ["monorepo-foundation/the-tasks-guardrails-composition-edge-carries-no-forwardref-and-a-gate-says-so"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

- [x] 1.3 Write `scripts/module-composition-cycle-check.test.mjs` beside it and register `test:module-composition` in `package.json` running the check then its self-test, exactly as `test:cors-headers` (`package.json:23`) does. The self-test must cover both failure directions — a planted forwardRef, and a missing file — because a fail-closed claim nobody tested is a claim.
  - requirements: ["monorepo-foundation/the-tasks-guardrails-composition-edge-carries-no-forwardref-and-a-gate-says-so"]
  - surfaces: ["developer-workflow"]
  - verify: "spec-assertions"

## 2. Track: phase-4-acceptance-record (depends: none)

- [x] 2.1 `docs/refactor-master-plan.md:160` — criterion (c): replace the phrase that promises a value without stating it with the measured floor **7** and the reason it is the floor: the seven surviving imports are calls/types with return values, which this plan's own non-event criterion (`:133-135`) puts structurally out of reach of phase 4's mechanism; they are retired by the mechanism the r7 entry itself names — the owning context exporting an explicit port file — in phases 5-6. Also drop the stale parenthetical that still says 9: that figure is two cuts old. State the command (`pnpm test:context-layout-v2`) so the number can be re-derived.
  - requirements: ["guardrails/phase-4-s-acceptance-record-states-measured-values-and-names-what-it-defers"]
  - surfaces: ["docs"]
  - verify: "spec-assertions"

- [x] 2.2 `docs/refactor-master-plan.md:159` — criterion (b): record it as DEFERRED TO PHASE 6 by decision (user, 2026-08-07), with the measurement behind it: six constructions in `guardrails.service.ts` (Logger :470, ConcurrencySemaphore :724, TaskProvisioningDiagnosticsObserverLifecycle :748, DeadlineWatcher :762, IdleTracker :767, CircuitBreaker :770); five are the orchestrator's own mechanisms by every instrument the repo owns; the sixth is cross-cutting but is built locally on purpose (`guardrails.service.ts:740-746`) so the frozen out-of-directory specs and the wired application keep ONE construction path. Say plainly that phase 4 therefore closes with one criterion deferred rather than four met — a deferral a reader can disagree with, not an omission.
  - requirements: ["guardrails/phase-4-s-acceptance-record-states-measured-values-and-names-what-it-defers"]
  - surfaces: ["docs"]
  - verify: "spec-assertions"

- [x] 2.3 `docs/refactor-master-plan.md:146` — correct two numbers measurement has refuted, keeping the refutation rather than erasing it: the runner-billing floor reads 5 and measures **4** (the legacy retirement removed one further recordStart with the method that held it), and the diagnostics group is written as reaching 2 after that retirement and measures **4** (2 recorder + 2 write gate; the orchestrator's single read of the pair fed two consumers and only the legacy one left). The second is the prediction retire-legacy-inline-admission already corrected in the live guardrails spec and in `scripts/ratchets/r11.json` and did not correct here — say so, because one number true in one place and false in another is the defect this epic keeps paying for.
  - requirements: ["guardrails/phase-4-s-acceptance-record-states-measured-values-and-names-what-it-defers"]
  - surfaces: ["docs"]
  - verify: "spec-assertions"
