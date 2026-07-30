## Context

Test mounting is an allowlist maintained by hand. `turbo.json` declares only `build`, `typecheck`, `lint`, and `test:public-surface` — there is no `test` task, so no repo-wide command exists and no fallback can catch a suite nobody mounted.

`apps/api` splits its own suite along an accidental line: `.spec.ts` files compile into `dist` and are found by the glob `dist/**/*.spec.js`, so all 167 run. `.test.mjs` files stay in `src` (Nest declares no assets, so they never reach `dist`) and are named individually in four scripts. Measured: 56 such files, 16 covered, **40 orphans**, including every security suite.

`packages/**` holds 91 test files. A root `test:sandbox` script chains six packages, but `grep -rn "test:sandbox" .github/workflows/ Makefile` returns 0. CI runs package tests for exactly three filters: `@cap/api`, `@cap/contracts`, `@cap/web`.

Running the 40 orphans after `build` + `prisma:generate` gives 37 green, 3 red — one real product defect (local-account audit attribution) and two stale harnesses (standalone `tsc` invoked without `--strict`, verified to pass once the flag is added).

The constraint that shapes this design: this change is the floor for the next one, which writes reproduction tests for four security findings. A mechanism that silently drops new files makes those tests worthless.

## Goals / Non-Goals

**Goals:**
- Discovery by pattern, never by enumerated path lists.
- One `turbo test` graph covering every workspace package, with build ordering expressed once.
- Every package's tests gate merges, including the sandbox family and its conformance suites.
- A drift check that fails when a test file exists that no runner would run — the mechanism that keeps the allowlist from growing back.
- Leave CI green: resolve the three known red, and triage whatever else surfaces when packages enter CI for the first time.

**Non-Goals:**
- Restructuring where test files live, or unifying the `.spec.ts` / `.test.mjs` / `.test.ts` convention split. Both are real, both belong to the directory-and-naming work later in the program.
- Fixing `scripts/`-level test mounting, the dead `tsconfig.base.json` entry in `globalDependencies`, or `settings-crypto.test.mjs` testing an inlined copy instead of the real module. All belong to the clean-out change.
- Raising coverage. Nothing new is written except what is needed to keep the wired suites honest.
- Touching CI job topology beyond what mounting requires.

## Decisions

**Discovery by glob, with the exclusion list as the only escape hatch.**
Package `test` scripts become pattern-based (`node --test "src/**/*.test.mjs"` and equivalents). The alternative — keep lists but add a lint that they are complete — was rejected: it preserves the failure mode (a list that must be edited) and only adds a second thing to forget. Where a file genuinely must not run in the default suite, it goes in an explicit exclusion list that a reviewer can see, rather than being invisible by omission.

**A `test` task in `turbo.json` with `dependsOn: ["build", "^build"]`, and `cache: false`.**
Ordering is then expressed once. Both entries are required, and this was corrected during implementation: `^build` builds only *upstream* packages, so a package whose suite runs against its own compiled output (`apps/api`'s `test:compiled` reads `dist/**/*.spec.js`) would find nothing. The existing `test:public-surface` task already uses `["build", "^build"]` for exactly this reason, so the new task matches that precedent. Package scripts drop their `pnpm --filter … build &&` prefixes (`packages/sandbox` chains six of them, and repeats the file list a third time under `coverage`). Caching is off because several suites touch a real database, container runtime, or the filesystem; a cached green would be actively misleading. `apps/api`'s existing `pretest` build hook is **kept**, decided during implementation: the turbo graph supplies build ordering only when the suite is invoked *through turbo*, and both CI and local developers also run `pnpm --filter @cap/api test` directly, which bypasses it. The hook costs nothing on a warm tree (turbo reports a full cache hit in ~200ms) and removing it would make the direct invocation silently test a stale `dist`.

**The discovery gate compares two sets, and lives in `scripts/`.**
Enumerate test files on disk; enumerate what the configured runner patterns would match; fail on the difference, naming each file. This mirrors `gen-prod-observability-configs.mjs --check`, which already gates releases on generated-output drift, so the shape is familiar in this repo. Two alternatives were considered and rejected: a naming-convention lint (proves nothing about whether a runner is wired) and trusting coverage thresholds (needs the file to run first — circular).

**Sandbox packages enter CI as their own job, not appended to an existing one.**
They have never gated a merge, so their pass rate under CI conditions is unknown for anything beyond the suites sampled here. A separate job keeps a sandbox flake from masking an `apps/api` regression and makes the required-check list explicit about what is new.

**The audit failure is repaired in the fake, not in production — corrected during implementation.**
The assertion reads "attribution resolves the account id DIRECTLY (no githubId reverse lookup)", which invited the reading that local accounts went unattributed. The production path disproves it: `resolveUserId` already looks up `where: { id }` and `taskCreatedAuditData` already carries the FK. The failure is that `recordTaskCreated` writes through an idempotent `upsert` while the fake supplies only `create`; the missing method throws into the recorder's best-effort `catch`, so the captured value stays `undefined`. Repair belongs in the fake. The `audit-history` spec is still updated in this change, but for the opposite reason to the one originally recorded: the spec text says "the GitHub-identity user" while the code has handled local accounts since `fix-local-account-task-attribution`, so the **spec** is the stale artefact. Restating it identity-neutrally makes the written requirement match what the newly-mounted test now guards.

**The two `tsc` harnesses gain `--strict` rather than being deleted or loosened.**
Their intent — proving a controller compiles standalone — is sound; their flag set drifted from the repository baseline (`@cap/tsconfig` sets `strict: true`). Without `strictNullChecks`, discriminated-union narrowing degrades, so correct code reports errors in unrelated files. Adding the flag was verified to yield zero errors. Deleting them would discard a real check; relaxing the assertion would hide the next genuine break.

**Newly surfaced red is triaged into three buckets, and the bucket determines the action.**
Product defect → fix here (it is a live bug that was hidden). Stale harness → fix the harness here. Environment-dependent (needs a real database, Docker, or network) → move to an explicitly non-default suite with a recorded reason, not silently excluded. The 12 initial `.prisma/client/default` failures were of the third kind and disappeared after `prisma:generate`; CI already runs that step, so they need no special handling.

## Risks / Trade-offs

**Unknown red beyond the three measured** → 91 package tests have never run in CI. Triage buckets are defined above and the task list treats triage as work, not as a hoped-for no-op. If a suite proves environment-dependent it moves to a non-default lane with its reason recorded, so the exclusion stays visible.

**CI wall-clock grows** → Mounting ~130 previously unrun files lengthens the pipeline. Accepted: the alternative is the current state, where the pipeline is fast because it does not run the tests. The sandbox job runs in parallel with the existing ones to limit the added critical path.

**Flake exposure** → Suites that never ran may be timing-sensitive. Mitigation: quarantine to the non-default lane with a recorded reason rather than adding retries, which would re-hide the signal.

**Discovery gate false positives** → Fixtures and helpers named like tests would be flagged. Mitigation: the gate matches the runner's own patterns rather than a second hand-written pattern, so anything it flags is by definition something a runner would not run; genuine exceptions go in the visible exclusion list.

**The audit fix touches a live write path** → Attribution is written on every recorded event. Mitigation: the behaviour is already pinned by `audit.verify.test.mjs`, which will run in CI from this change onward; the fix is scoped to how the identifier is resolved, not to what is recorded or when.

**Scope creep into naming and layout** → Wiring tests invites "while we are here" restructuring. Mitigation: the convention split and file relocation beyond the three strays are explicit non-goals; the directory work has its own place later in the program.

## Migration Plan

Sequenced so each step is independently revertible and the tree is never left with a gate that cannot pass:

1. Add the `turbo test` task and convert package scripts to globs — mounting only, no CI change yet. Run locally to enumerate the true red set.
2. Fix the three known red (audit attribution, two `--strict` harnesses) and triage anything step 1 surfaced.
3. Relocate the three stray files so discovery covers them.
4. Add the discovery gate, with any genuine exceptions recorded in the exclusion list.
5. Wire CI: package-test job for the sandbox family, discovery gate as a check. Mark as required only after one green run on the branch.

Rollback: steps are additive to config and CI. Reverting the `turbo.json` task and the workflow edit restores the prior mounting; the repaired test artefacts stand on their own and would not be reverted with them.

**Manual follow-up that cannot be done from the codebase.** The new `package suites` job and the discovery gate run on every pull request as soon as this lands, but making them *block* a merge is a GitHub repository setting. After one green run on the branch, add to branch protection's required checks:

- `package suites`
- the `typecheck + lint + test` job already listed there (unchanged name; it now also carries the discovery gate and the app-suite lane)

Until that is done the suites run and report but do not gate, which is the intended order — a check is proposed as required only after it has been observed green, per the migration plan above.

## Open Questions

- Do any sandbox suites require Docker or a live daemon in a way GitHub-hosted runners cannot satisfy? Prior work established that `e2e.yml` is dispatch-only for exactly that reason, so some sandbox suites may need the non-default lane. Resolved empirically in migration step 1, before CI is touched.
- Should the discovery gate also cover `scripts/` (33 test files, ~16 unmounted)? Deferred to the clean-out change: the gate is built to take an additional root without redesign, but pulling `scripts/` in now would widen this change's triage surface.
