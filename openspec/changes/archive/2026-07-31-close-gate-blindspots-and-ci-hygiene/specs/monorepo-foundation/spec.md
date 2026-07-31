## MODIFIED Requirements

### Requirement: CI boots the built application and probes liveness

The CI pipeline SHALL include a check that starts the BUILT application (with its required runtime dependencies, e.g. a throwaway database) and probes the `/health` liveness endpoint, failing the pipeline when the application cannot reach a healthy boot. This guards the cross-provider dependency-injection / bootstrap failure class — a previous DI-ordering defect reached production and caused a multi-hour outage that neither the build nor the unit tests detected.

The boot-smoke jobs are CONDITIONED on backend-relevant paths through the always-run change-detection job; a paths-conditioned check cannot be a required status check as-is, so the workflow's own documentation SHALL make exactly one truthful claim about that status — adjacent contradictory claims (required AND not required) SHALL NOT ship — and marking any boot-smoke job required remains a registered manual GitHub branch-protection step outside the repository. The observed drift between the documented context name "typecheck + lint" and the job's actual display name "typecheck + lint + test" SHALL be REGISTERED as debt, not fixed by rename: check display names are a consumed attestation API.

The pipeline SHALL additionally include a STATEFUL boot-smoke variant: seed the throwaway database with an in-flight `running` task BEFORE boot, then assert that the restarted process RE-ADOPTS the seeded task rather than failing or orphaning it — restart-with-work-in-flight is the survive-api-redeploy bug class that clean-boot liveness and unit fakes both provably missed. The stateful job SHALL be added to the CONDITIONED set asserted by `scripts/ci-job-conditions.test.mjs` in the same change that introduces the job, SHALL reuse the existing throwaway-Postgres service pattern, and SHALL first run green as a non-required check.

#### Scenario: A boot/DI failure fails CI

- **WHEN** a change introduces a dependency-injection or bootstrap error that prevents the application from starting
- **THEN** the CI boot-smoke check starts the built app, fails to get a healthy `/health` response, and fails the pipeline — blocking the merge

#### Scenario: A healthy build passes the boot-smoke check

- **WHEN** the built application boots cleanly and serves `/health`
- **THEN** the boot-smoke check reports success

#### Scenario: A broken re-adoption path fails the stateful variant

- **WHEN** the stateful boot-smoke job boots the built application against a database pre-seeded with an in-flight `running` task, and the boot re-adoption scan fails to re-adopt it (the task ends failed, orphaned, or unowned)
- **THEN** the stateful boot-smoke job exits non-zero

#### Scenario: Healthy re-adoption passes the stateful variant

- **WHEN** the restarted process re-adopts the pre-seeded running task after a healthy boot
- **THEN** the stateful boot-smoke job reports success

#### Scenario: The stateful job is registered as conditioned in the same change

- **WHEN** `scripts/ci-job-conditions.test.mjs` runs after the stateful job is added
- **THEN** the stateful boot-smoke job appears in its CONDITIONED set with the identical-expression assertion passing
- **AND** the registration lands in the same PR that adds the job, so the conditions gate is never red between commits

#### Scenario: The workflow makes one truthful claim about required status

- **WHEN** the boot-smoke commentary in `ci.yml` is read after this change
- **THEN** it states that the check is conditioned via the change-detection job and therefore not a required status check as-is
- **AND** no adjacent comment claims the opposite
- **AND** no existing check display name was renamed; the "typecheck + lint" vs "typecheck + lint + test" drift is recorded as registered debt naming both strings

## ADDED Requirements

### Requirement: The API symbol boundary is enforced across the full source tree

The sandbox package-boundary gate's forbidden-SYMBOL scan SHALL cover every
production source under `apps/api/src` — the same scope its forbidden-IMPORT
scan already walks — not an enumerated 2-root subset. The scanned roots SHALL
be manifest-driven data rather than literals inside the test (S3), so a later
directory move edits the manifest, not the gate. Pre-existing violations SHALL
be re-measured live at change start (the artifact says 5 files; the live
simulation finds 6, the extra being a user-facing copy string in
`codex-device-login-runner.ts` tripping the env-family regex — its disposition,
reword vs regex refinement vs baseline-6, SHALL be decided before the baseline
is committed) and tolerated ONLY through a `scripts/ratchets/` baseline.
Expansion order SHALL be: measure 存量 → commit baseline → expand scope, so CI
is never knowingly red.

#### Scenario: A forbidden symbol anywhere under apps/api/src is caught

- **WHEN** a production source outside the previous two roots (`src/sandbox`, `src/terminal`) gains a forbidden symbol not covered by the ratchet baseline
- **THEN** the boundary gate exits non-zero naming the file and pattern

#### Scenario: 存量 rides the ratchet, and only the re-measured 存量

- **WHEN** the expanded gate runs on the tree at landing time
- **THEN** it passes green with the committed baseline tolerating exactly the violations re-measured at change start
- **AND** the baseline holds no entry for a deleted file and no entry above the live measurement

#### Scenario: The scanned roots are manifest-driven

- **WHEN** the gate resolves the roots for both its import scan and its symbol scan
- **THEN** the roots come from manifest data consumed by the gate
- **AND** the gate script itself contains no hardcoded root path list

#### Scenario: The expanded gate can go red

- **WHEN** a probe violation is injected into a file outside the old two roots
- **THEN** the gate fails naming that file
- **AND** the probe is reverted with the red run recorded as evidence

### Requirement: Check display names are treated as a consumed attestation API

A CI hygiene change SHALL NOT rename an existing check display name or
required context, because release attestation queries check-runs by display name.
Observed drift between a documented context name and a job's actual display
name SHALL be REGISTERED as debt; any rename is a later coordinated change
touching `release.yml` and branch protection together.

#### Scenario: Drift is registered, never renamed in a hygiene change

- **WHEN** this change's `ci.yml` diff is compared against the base
- **THEN** every pre-existing job `name:` is byte-identical
- **AND** a registration record exists naming the drifted strings ("typecheck + lint" vs "typecheck + lint + test") and the consuming attestation site

### Requirement: Build configuration references only real inputs and shared presets

`turbo.json` `globalDependencies` SHALL NOT reference a path that does not
exist in the repository — the dead `tsconfig.base.json` entry is removed,
closing the wire-orphaned → retire-superseded deferral chain. `apps/api`'s
TypeScript configuration SHALL extend a preset from `@cap-console/tsconfig` —
a new nest/commonjs+decorators preset, since no current preset carries
`emitDecoratorMetadata`/`experimentalDecorators` — instead of remaining a
standalone config.

#### Scenario: Global hash inputs all exist

- **WHEN** each `globalDependencies` entry in `turbo.json` is resolved against the repository
- **THEN** every referenced path exists on disk

#### Scenario: apps/api consumes the shared preset without behavior change

- **WHEN** `apps/api/tsconfig.json` is inspected after this change
- **THEN** it extends a `@cap-console/tsconfig` preset that carries commonjs module output and decorator emission
- **AND** the workspace `turbo build` and `turbo typecheck` remain green
