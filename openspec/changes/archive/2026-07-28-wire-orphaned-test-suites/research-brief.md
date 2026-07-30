# Research brief — wire-orphaned-test-suites

Baseline: `origin/main` @ `0216ab1` (v0.46.1). All numbers below were measured in this worktree, not estimated.

## 1. The mounting mechanism is an allowlist, and it leaks

`turbo.json` declares exactly four tasks — `build`, `typecheck`, `lint`, `test:public-surface`. **There is no `test` task**, so `turbo test` does not exist and no repo-wide fallback can catch an unmounted suite.

Discovery is therefore per-package and hand-written. `apps/api/package.json` splits its suite two ways:

- `test:compiled` → `node --test "dist/**/*.spec.js"` — a **glob**, so all 167 `.spec.ts` under `apps/api/src` are picked up automatically.
- `test:sandbox-src` / `test:terminal-src` / `test:tooling-src` / `test:generated-private-git` → **hand-listed paths** plus a single directory glob `src/sandbox/*.test.mjs`.

`.mjs` files never enter `dist` (`nest-cli.json` declares no assets), so the `dist/**` glob cannot see them. Everything under `src/**/*.test.mjs` that is not literally named in a script is invisible.

Measured: **56** `.test.mjs` files under `apps/api/src`; **16** are covered; **40 are orphans**.

## 2. What the 40 orphans actually are

Concentrated in exactly the areas with the least other coverage:

| Area | Orphaned files |
|---|---|
| `auth/` | 8 — `constant-time`, `session-token`, `github-token-encrypted-at-rest`, `bearer-prefix-dispatch`, `operator-principal`, `machine-kinds-and-scopes`, `auth-guard`, `password-login.verify` |
| `guardrails/` | 7 — `semaphore`, `circuit-breaker`, `idle-tracker`, `guardrails-bootstrap`, `guardrails-exit-roundtrip`, `delivery-results-surfaced-and-audited`, `pushback-on-success-before-teardown` |
| `metrics/` | 6 · `settings/` | 6 · `tasks/` | 3 · `audit/` | 2 · `repos/` | 2 |
| singletons | `main.test.mjs`, `agent-runtime`, `api-key-revocation`, `write-lock-single-writer`, `v1-transcript.controller`, `terminal/approvals-endpoint-roundtrip` |

The security-relevant suites (constant-time comparison, session token handling, at-rest token encryption, bearer prefix dispatch, API-key revocation, single-writer lock) are **all** in this set. This matters directly: the next change in the program writes reproduction tests for four security findings, and it cannot rely on a mounting mechanism that silently drops new files.

## 3. Empirical red/green — measured, not assumed

Procedure: `turbo run build --filter=@cap/api`, then `pnpm --filter @cap/api prisma:generate`, then ran every orphan individually.

Result: **37 pass, 3 fail.** Two distinct failure classes, and the distinction drives the task list.

### 3a. Audit attribution — **initially misread as a product defect; it is a stale harness** (corrected during implementation)

`src/audit/audit.verify.test.mjs:269` — "6.2 attribution resolves the account id DIRECTLY (no githubId reverse lookup)":

```
AuditEvent.userId is the account FK for a local account
+ actual   undefined
- expected 'local-acct-9'
```

The first reading of this failure was that local (non-GitHub) accounts were never attributed. Reading the production path disproves it. `AuditService.resolveUserId` (`audit.service.ts:386-388`) already does `findUnique({ where: { id: userId } })` — a direct lookup, no GitHub-id reverse lookup — and `taskCreatedAuditData` (`task-created-audit.ts:12-28`) places that FK on the payload. Both carry comments referencing the `fix-local-account-task-attribution` work.

The real cause is in the test's fake. `recordTaskCreated` writes through `prisma.auditEvent.**upsert**` (`audit.service.ts:94-98`, keyed on the `task.created` dedupe key), while the fake supplies only `auditEvent.create`. Calling the missing `upsert` throws, the recorder's best-effort `catch` swallows it, and the captured value stays `undefined`. The production code moved from `create` to an idempotent `upsert` and the fake was never updated — because the test never ran.

Fix: give the fake an `upsert` that reads the FK off the `create` branch. Verified: 18/18 pass, no production change.

**Consequence for this change: there is no product defect among the red.** Every failure surfaced is a test artefact that drifted away from the code it guards — which is the same phenomenon the change exists to stop, just one layer up.

### 3b. Two stale compiler harnesses (production code is fine)

`src/v1/v1-transcript.controller.test.mjs` and `src/tasks/session-history.controller.test.mjs` shell out to `tsc` to prove a single controller compiles standalone. Both fail with errors located in *other* files (`forge/task-branch-resolver.ts`, `runtime-models/runtime-model-catalog.service.ts`), all of the shape:

```
error TS2339: Property 'reason' does not exist on type '{ readonly ok: true; ... }'
```

Root cause: the harness passes `--module commonjs --moduleResolution node --target ES2021 --experimentalDecorators --esModuleInterop --skipLibCheck` but **omits `--strict`**, while the repo baseline is `strict: true` (`@cap/tsconfig` base). Without `strictNullChecks`, discriminated-union narrowing degrades and correct code reports as broken.

Verified: adding `--strict` to the same invocation yields **exit code 0, zero errors**. The fix is one flag in each harness, not a production change.

## 4. Packages are entirely outside CI

`packages/**` holds **91** `.test.mjs` files. A root `test:sandbox` script exists and chains six packages serially — but `grep -rn "test:sandbox" .github/workflows/ Makefile` returns **0 hits**. `ci.yml` runs package tests for exactly three filters: `@cap/api` (:189), `@cap/contracts` (:195), `@cap/web` (:200).

So the entire sandbox family — including `@cap/sandbox-conformance`, the suite that is the only cross-check binding provider capability declarations to actual method presence — has never gated a merge. Prior review established that AIO, the production-default provider, does not run the behaviour conformance suite at all.

`packages/sandbox/package.json`'s `test` script also hand-lists 26 files and re-builds six dependencies serially with `pnpm --filter ... build &&`, duplicating what `turbo.json`'s `dependsOn: ["^build"]` already expresses. `coverage` repeats the same list a third time.

## 5. Strays

- Repo root: `legacy-token-prefix-collision.test.mjs`, `legacy-token-synthesized-env.test.mjs` — belong to no workspace package; the second one tests `scripts/quick-deploy.sh`, whose sibling test already lives in `scripts/`.
- `apps/api/test-settings-minted-mcp-tokens.mjs` — package root, outside both `src/` and `test/`, and not `.test.mjs` so no glob would ever find it.

## 6. Precedent already in the specs

`openspec/specs/monorepo-foundation/spec.md:140-145` already states the exact principle, scoped to one package:

> `@cap/contracts` SHALL expose a package test command … **A test file present in the contracts package but absent from normal package/CI scripts SHALL NOT be considered enforced.**

This change generalises that sentence to every workspace package and gives it a mechanism instead of a convention.

There is also a working in-repo model for the drift gate this change needs: `deploy/observability/gen-prod-observability-configs.mjs --check` runs in `release.yml` and fails the release when generated output drifts from its source. The same shape applies to "a test file exists but no runner would discover it".

## 7. Scope boundaries (deliberately excluded)

- `turbo.json:5` lists `tsconfig.base.json` in `globalDependencies`, but **no tsconfig file exists at the repo root** (the real one is `packages/tsconfig/base.json`) — a dead cache-invalidation input. Real, but belongs to the clean-out change.
- `scripts/` has 33 test files, ~16 unmounted, and `public-surface-files.mjs` references two script paths that do not exist. Same reasoning — clean-out.
- `settings-crypto.test.mjs` passes, but its own header says the logic under test is **inlined, mirroring `settings-crypto.ts`** rather than importing it. It is a fidelity defect, not a mounting defect; fixing it belongs with the crypto-envelope consolidation work.
- The `audit.verify` defect (3a) is a product bug. This change surfaces it and must not leave CI red, so the task list resolves it — but any broader audit-coverage work stays out.

## 8. Corrections made during implementation

Recorded so the brief matches what was actually found, not what was predicted.

1. **The audit failure is a stale fake, not a product defect** — see §3a. The original classification was wrong; no production code changed for it.
2. **The orphan count was understated.** §1 counted 40 by scanning `apps/api/src` only. `test/**` has subdirectories that the initial `ls test/*.test.mjs` never showed: `test/scheduled-tasks-live-e2e/control-server.test.mjs` and `test/task-model-official-upgrade-seam-gate.test.mjs` were also unmounted. `packages/sandbox-core` had two more (`test/detached-jobs.test.mjs`, `test/sandbox-core-regressions.test.mjs`) — its script named only one of its three files.
3. **A fourth stale harness surfaced** once `test/**` was globbed: `control-server.test.mjs` asserts `deepStrictEqual` on a seeded repo fixture whose production shape gained `copyStatus` / `copyUpdatedAt` with the repo-content-store work (v0.45.0). Expectation never updated because the file never ran.
4. **`packages/contracts` was never an orphan case.** An early scan reported 29 orphans there; its script is `node --test src/*.test.mjs`, already a glob. The scan compared literal paths against script text and mis-flagged every globbed file. All 30 contracts suites were already enforced.
5. **`dependsOn` needed both entries.** The design specified `["^build"]`; that builds only upstream packages, so `apps/api`'s `test:compiled` (which reads its own `dist/`) would have found nothing. Corrected to `["build", "^build"]`, matching the existing `test:public-surface` task.
6. **Every package suite passed.** The proposal warned that packages entering CI for the first time could surface unknown red. They did not: `@cap/sandbox` 34/34, `sandbox-provider-aio` 10/10, `sandbox-provider-boxlite` 14/14, `contracts` 229/229, plus the smaller packages. The only red anywhere was the four stale harnesses.
7. **A fifth and sixth stale artefact surfaced from the relocated stray.** `apps/api/test-settings-minted-mcp-tokens.mjs` had never run in any form (wrong extension, wrong directory, named in no script). Once mounted it failed twice over: its Prisma fake attached only `{ githubId }` to the included user row, so the resolver's `record.user.allowed` check read `undefined` and fail-closed to `null`; and its T4 case asserted that passing a different `AUTH_ALLOWLIST` env denies the token, a model removed when access moved to the pure `User.allowed` column (`resolveMcpToken` takes the env argument as `_env` and ignores it). Repaired by giving the fake the full account shape with a mutable `allowed`, and rewriting T4 to flip that column. 19/19 pass; no production change.
8. **Final state: the whole graph is green.** `turbo test` runs 12 packages — `@cap/api` (1555 compiled specs + 300 src suites + 11 `test/` suites), `contracts` 229, `sandbox` 34, `sandbox-provider-boxlite` 14, `sandbox-provider-aio` 10, `sandbox-core` 3, `release-cache-worker` 5, `sandbox-environment` 2, `sandbox-conformance` 1, `sandbox-cloud-http` 1, plus `sandbox-hooks` and `web` — with zero failures. Six stale test artefacts were repaired; no production file changed.
