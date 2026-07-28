## Why

Test mounting in this repo is a hand-written allowlist, and it has been leaking silently. Measured on `origin/main` @ v0.46.1: **40 of the 56 `.test.mjs` files under `apps/api/src` are executed by no runner at all**, including every security suite (constant-time comparison, session tokens, at-rest token encryption, bearer-prefix dispatch, API-key revocation, single-writer lock). All **91** package test files — among them `@cap/sandbox-conformance`, the only cross-check binding provider capability declarations to real method presence — are referenced by zero CI workflow. `turbo` has no `test` task, so nothing catches an unmounted suite.

Running the orphans proves the cost is not hypothetical: **4 are red**, every one of them a test artefact that drifted away from the code it guards — a fake that still expects `create` where production moved to an idempotent `upsert`, two compiler harnesses whose flags no longer match the repository baseline, and a fixture assertion frozen before two columns were added. None of them would have survived a week of running.

This lands first because the next change writes reproduction tests for four security findings. Writing them on a mechanism that drops new files without a signal would be building on sand.

## What Changes

- Add a `test` task to `turbo.json` so a repo-wide `turbo test` exists and every workspace package participates in one graph.
- Replace hand-written test file lists with **glob discovery** in `apps/api` and in the `packages/sandbox` family; remove the serial `pnpm --filter … build &&` prefixes that duplicate what the task graph already expresses.
- Mount every workspace package's tests in CI, including the whole sandbox family (closing the `test:sandbox`-exists-but-never-runs gap).
- Add a **discovery gate**: a check that fails when a test file exists that no runner would discover. Without it the allowlist problem returns the first time someone adds a file.
- Fix the fallout the mounting exposes — all four are stale test artefacts; **no production code changes**:
  - `audit.verify.test.mjs` — its fake supplies `auditEvent.create`, but the recorder writes through an idempotent `upsert`; the missing method throws into a best-effort `catch`, so the assertion saw `undefined`. Give the fake an `upsert`.
  - `v1-transcript.controller.test.mjs` and `session-history.controller.test.mjs` — invoke `tsc` without `--strict` while the repo baseline is strict, degrading discriminated-union narrowing so correct code reports as broken. Adding `--strict` yields zero errors.
  - `scheduled-tasks-live-e2e/control-server.test.mjs` — a `deepStrictEqual` fixture assertion written before `copyStatus` / `copyUpdatedAt` were added by the repo-content-store work.
- Relocate strays into the structure that discovery covers: two repo-root `legacy-token-*.test.mjs` files and `apps/api/test-settings-minted-mcp-tokens.mjs`.

No production behaviour changes at all — every repair is to a test artefact.

## Capabilities

### New Capabilities
- `test-suite-discovery`: every test file in the workspace is discovered mechanically rather than by hand-maintained lists, participates in a single `turbo test` graph, gates merges in CI, and a drift check fails the build when a test file exists that no runner would execute.

### Modified Capabilities
- `monorepo-foundation`: its existing requirement "Contracts tests participate in normal verification" — which already states that a test file present but absent from normal scripts SHALL NOT be considered enforced — is generalised from `@cap/contracts` alone to every workspace package, and gains the `turbo test` task as the mechanism that makes it true.
- `audit-history`: attribution is currently specified as "the GitHub-identity user the event is attributed to (per the multi-user OAuth identity model)". The implementation already handles local accounts correctly — it resolves the account id directly — so it is the **spec** that is behind the code, not the other way round. Attribution is restated in identity-neutral terms so the written requirement matches the behaviour the newly-mounted test now guards.

## Impact

- **Build config**: `turbo.json` (new `test` task); `package.json` at root, `apps/api`, `apps/web`, `packages/contracts`, and the `packages/sandbox*` family (test scripts become globs).
- **CI**: `.github/workflows/ci.yml` — package test steps become graph-driven; the sandbox family enters the merge gate for the first time; the discovery gate becomes a required check.
- **Product code**: none.
- **Tests**: four stale artefacts repaired (one fake gains `upsert`, two harnesses gain `--strict`, one fixture expectation gains two columns); three files move.
- **Expected friction**: mounting the package suites and the API orphans into CI lengthens the pipeline. Packages had never gated a merge, so their state was unknown when this was written; the task list treats "triage newly-surfaced red" as explicit work rather than an assumption of green. (Measured during implementation: every package suite passed — `@cap/sandbox` 34/34, `sandbox-provider-aio` 10/10, `sandbox-provider-boxlite` 14/14, `contracts` 229/229.)
- **Not in scope** (belongs to the clean-out change): the dead `tsconfig.base.json` entry in `turbo.json` `globalDependencies`, unmounted `scripts/` tests, and `settings-crypto.test.mjs` testing an inlined copy instead of the real module.
