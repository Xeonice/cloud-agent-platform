<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: turbo-test-task (depends: none)

- [x] 1.1 Add a `test` task to `turbo.json` with `dependsOn: ["^build"]` and `cache: false`; leave the existing `test:public-surface` task untouched
- [x] 1.2 Add a root `test` script that delegates to the turbo task, so a single repo-level command exists
- [x] 1.3 Verify `turbo test --dry-run` lists every workspace package that declares a `test` script, and that `@cap/contracts` builds before its dependents

## 2. Track: api-test-globs (depends: none)

- [x] 2.1 Replace `test:sandbox-src`, `test:terminal-src`, `test:tooling-src`, and `test:generated-private-git` in `apps/api/package.json` with pattern-based discovery covering `src/**/*.test.mjs` and `test/**/*.test.mjs`
- [x] 2.2 Confirm `test:compiled` still covers all `.spec.ts` via `dist/**/*.spec.js` and that the two suites do not double-run any file
- [x] 2.3 Remove the `pretest` build hook only after confirming the turbo task graph supplies the same ordering; otherwise leave it and record why
- [x] 2.4 Run `pnpm --filter @cap/api test` and confirm all 56 `src/**/*.test.mjs` files execute (was 16); capture the resulting red list for track 7

## 3. Track: package-test-globs (depends: none)

- [x] 3.1 Convert `packages/sandbox/package.json` `test` to pattern discovery over `test/**/*.test.mjs`, dropping the 26 hand-listed paths
- [x] 3.2 Remove the serial `pnpm --filter … build &&` dependency chains from that package's `test`, `typecheck`, and `coverage` scripts, relying on the turbo task graph instead
- [x] 3.3 Apply the same conversion to the remaining `packages/sandbox*` packages and to any other workspace package whose `test` script enumerates paths
- [x] 3.4 Run each converted package's `test` command and capture the resulting red list for track 7

## 4. Track: known-red-fixes (depends: none)

- [x] 4.1 Repair the `audit.verify.test.mjs` fake: `recordTaskCreated` writes through `auditEvent.upsert`, not `create`, so give the fake an `upsert` that reads the attributed FK off the create branch (production code is already correct — no change there)
- [x] 4.2 Confirm `src/audit/audit.verify.test.mjs` passes, including assertion 6.2 which reported `undefined` where `'local-acct-9'` is expected
- [x] 4.3 Add `--strict` to the standalone `tsc` invocation in `src/v1/v1-transcript.controller.test.mjs` so its flags match the repository compiler baseline
- [x] 4.4 Add `--strict` to the same invocation in `src/tasks/session-history.controller.test.mjs`
- [x] 4.5 Confirm both harnesses exit zero, and confirm each still fails when a deliberate type error is introduced into the file it compiles

## 5. Track: stray-relocation (depends: none)

- [x] 5.1 Move `legacy-token-prefix-collision.test.mjs` and `legacy-token-synthesized-env.test.mjs` from the repository root into `scripts/`, alongside the existing test for the same subject
- [x] 5.2 Move `apps/api/test-settings-minted-mcp-tokens.mjs` into `apps/api/test/` and rename it to the `.test.mjs` convention so discovery covers it
- [x] 5.3 Update every reference to the moved files (scripts, workflows, docs) and confirm no dangling path remains

## 6. Track: discovery-gate (depends: turbo-test-task, api-test-globs, package-test-globs)

- [x] 6.1 Add `scripts/test-discovery-check.mjs` that enumerates test files on disk, enumerates what the configured runner patterns match, and exits non-zero on the difference, naming each undiscovered file
- [x] 6.2 Add an explicit, reviewable exclusion list with a recorded reason per entry; the check reads its exclusions only from that list
- [x] 6.3 Add a test for the check itself: an undiscovered file is reported, an excluded file is not, and the excluded entry remains visible in the list
- [x] 6.4 Ran against the converted tree: 408 test files, all discovered. The exclusion list is empty — no genuine exception exists, which is the healthy state
- [x] 6.5 Expose the check as a root script so CI and local runs invoke the same command

## 7. Track: red-triage (depends: api-test-globs, package-test-globs, known-red-fixes)

- [x] 7.1 Run the full mounted suite and produce the complete red list beyond the three already known
- [x] 7.2 Sort each newly red suite into product defect, stale harness, or environment-dependent, recording the basis for each classification
- [x] 7.3 Fix the product defects and stale harnesses found in 7.2
- [x] 7.4 No suite required quarantine: the only environment-dependent case (`generated-private-git-boxlite-native`) already self-skips with a printed reason when its `BOXLITE_*` env is absent, which is the intended shape. Recorded rather than changed
- [x] 7.5 Confirm the default suite is green end to end from a clean checkout after `build` and `prisma:generate`

## 8. Track: ci-wiring (depends: discovery-gate, red-triage, stray-relocation)

- [x] 8.1 Replace the per-filter package test steps in `.github/workflows/ci.yml` with the graph-driven task so every workspace package participates
- [x] 8.2 Add a separate CI job running the `packages/sandbox*` family, including the provider conformance suites, so a sandbox failure is attributable and does not mask an api regression
- [x] 8.3 Add the discovery check as a CI step that blocks on undiscovered test files
- [x] 8.4 Replayed every CI lane locally against the converted tree — discovery gate, `turbo test --filter='./apps/*'` (18/18), `turbo test --filter='./packages/*'` (17/17), the release/install contract step including the two relocated files, and `turbo typecheck lint` (37/37) — all green. The green run *on the branch* remains the precondition for marking anything required
- [x] 8.5 Recorded in design.md under the migration plan: adding `package suites` to branch protection's required checks is a repository setting and cannot be done from the codebase
