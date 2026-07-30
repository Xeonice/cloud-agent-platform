<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tracks 2 and 3
     touch disjoint directories (`tasks/` + `task-admission/` vs `guardrails/` + the
     new pipeline directory) and can run in parallel; Track 4 gates on both. -->

## 1. Track: baseline-evidence (depends: none)

- [x] 1.1 Run `node --test --test-force-exit "dist/guardrails/*.spec.js"` (after `turbo run build --filter=@cap/api`) and record the pass count and duration as the pre-change baseline.
- [x] 1.2 Run the same suite with `--experimental-test-coverage --test-reporter=lcov` and record, for `guardrails.service.js`, the line and branch coverage plus the execution counts of `startRunningAfterCapacity` and `processDurableAdmissionAfterCapacity`.
- [x] 1.3 Re-derive the extracted block's coupling set directly from the source: the `this.<method>(` calls and `this.<field>` reads inside the `if (sandbox)` block, split into legacy-exclusive and shared. Record it — this list, not the brief's snapshot, is what the port is cut from.

## 2. Track: admission-policy (depends: none)

- [x] 2.1 Introduce the admission capability outcome union: every closed reason the gate can report, plus `open`, plus a distinct key for an absent gate provider. Derive the closed-reason members from the existing gate schema rather than re-listing them, so the two cannot drift.
- [x] 2.2 Introduce the policy as a total `Record` from that union to a decision carrying the resolved mode and the originating reason. Register `open` to durable and every other key to legacy — the mapping states the consequence for each, none inherits one.
- [x] 2.3 Add a resolver that turns the optional gate provider plus its evaluation into exactly one outcome key, mapping provider absence to its own key rather than coercing it to `false`.
- [x] 2.4 Replace the ternary at the acceptance point with the resolver, keeping the read-once-and-freeze property and leaving the value carried on the prepared acceptance unchanged in type and meaning.
- [x] 2.5 Log the resolved decision at the acceptance point when it degrades, naming the capability and the reason. Do not add a persisted field, and do not change the capability endpoint response.
- [x] 2.6 Add tests: a closed gate resolves to legacy carrying its reason; an absent provider resolves under its own key and is distinguishable from a closed gate; an open gate resolves to durable; the mapping covers the outcome union exhaustively.
- [x] 2.7 Add a compile-time guard proving that a new closed reason without a policy entry fails to typecheck, following the repository's existing `.typecheck.ts` fixture convention.

## 3. Track: legacy-pipeline (depends: baseline-evidence)

<!-- Re-cut per design D4a: the extraction is the whole legacy cluster (12 methods,
     6 state containers, the 347-line block), not the block alone. Each step ends
     green under the zero-test-edit rule, so a missed dependency surfaces as a
     compile error or a red test rather than as later behavioural drift. -->

- [x] 3.1 Create the new top-level directory under `apps/api/src` named for what the pipeline does (synchronous in-request admission), with a header comment stating its relationship to the durable pipeline and that it is expected to be removable as a unit.
- [x] 3.2 Move the six legacy state containers and their two record types into a named state object in the new directory, exposing one `forget(taskId)` that subsumes the five separate deletions on the terminal path. Guardrails holds the object; no logic moves yet.
- [x] 3.3 Run the guardrails suite. It must pass with zero edits to any test file; a test that needs changing means 3.2 altered behaviour and must be reworked, not accommodated.
- [x] 3.4 Declare the orchestrator port in the new directory from the outward set measured in `baseline.md`, declaring its own structural slice of any type currently defined inside `guardrails` (notably the terminal gateway) so the new directory never imports from `guardrails`.
- [x] 3.5 Move all twelve `*Legacy*` methods and the `if (sandbox)` block into a pipeline class in the new directory, constructed by `GuardrailsService` with the state object, a port adapter, and its own injected dependencies. The 28 preamble lines of `startRunningAfterCapacity` stay in guardrails.
- [x] 3.6 Replace the orchestrator's remaining direct legacy touchpoints — in `fenceTerminal`, `settleTask`, `startRunning`, `tryBeginProvisioningDiagnostics`, and `settleProvisioningDiagnostics` — with calls to the pipeline's entry surface, so no legacy state is reachable from guardrails except through it.
- [x] 3.7 Run the guardrails suite again under the same zero-test-edit rule, and confirm `GuardrailsService` no longer contains any `legacy` identifier outside the pipeline's entry calls.

## 4. Track: verification (depends: admission-policy, legacy-pipeline)

- [x] 4.1 Run `node scripts/api-module-layout-check.mjs` and confirm it passes with `ALLOWED_CYCLES` still empty — no new permitted cycle may be added to make this change pass.
- [x] 4.2 Re-run coverage and compare against the 1.2 baseline: line and branch coverage of the combined guardrails plus extracted sources must not drop, and the extracted block must still be exercised the same number of times.
- [x] 4.3 Confirm behaviour was preserved rather than re-baselined: no file under `apps/api/src/guardrails/` matching `*.spec.ts` was modified, and in the five gate-stub spec files touched per design D2a the diff renames the stubbed method only — no assertion, expected value, or counter is changed. One further test outside that set, `sandbox/sandbox-host-harness-wiring.test.mjs`, scans source text rather than behaviour and named `guardrails.service.ts` as the single file holding both provisioning paths; it now reads both path files. Its assertions keep their strength — each path must still resolve a workspace source, and the provision-context count is still pinned at exactly 2.
- [x] 4.4 Run `pnpm --filter @cap/api typecheck`, `pnpm --filter @cap/api lint`, and the full `pnpm --filter @cap/api test`.
- [x] 4.5 Run `pnpm test:scripts` and the repository test-discovery gate so the new directory's tests are actually mounted rather than silently unrun.
