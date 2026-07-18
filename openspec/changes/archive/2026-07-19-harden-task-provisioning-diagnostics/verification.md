# Verification report

Date: 2026-07-18

Scope: OpenSpec task 8.6 for `harden-task-provisioning-diagnostics`.

## Results

| Area | Command | Result |
| --- | --- | --- |
| Strict OpenSpec | `pnpm exec openspec validate harden-task-provisioning-diagnostics --type change --strict --no-interactive` | PASS — change is valid. |
| Propose metadata | `node scripts/openspec-metadata.mjs validate-change harden-task-provisioning-diagnostics --phase propose` | PASS — all 39 tasks are valid. |
| Apply metadata | `node scripts/openspec-metadata.mjs validate-change harden-task-provisioning-diagnostics --phase apply` | PASS — all 39 tasks are valid. |
| Migration compatibility | `DATABASE_URL=postgresql://cap:cap@127.0.0.1:55432/cap?schema=public CAP_TASK_ADMISSION_MIGRATION_TEST=1 pnpm --filter @cap/api test:migration:task-admission` | PASS against a disposable PostgreSQL 16 container bound only to `127.0.0.1:55432`; fresh, upgrade, rollback, legacy AIO identity, partial/unavailable evidence, compaction, constraints, and cascades passed. The container was removed after the run. |
| Contracts suite | `pnpm --filter @cap/contracts test` | PASS. |
| API suite | `pnpm --filter @cap/api test` | PASS — compiled API suite reported 1,343 passing tests; generated private-Git offline tests reported 3 passing tests and the native environment-gated case skipped. |
| Web suite | `pnpm --filter @cap/web test` | PASS — 72 files and 542 tests passed. |
| Sandbox packages | `pnpm test:sandbox` | PASS — sandbox-core, conformance, cloud-http, AIO, BoxLite, and provider-center/package tests all completed with exit code 0. The separately gated live BoxLite integration remained skipped. |
| Native private-Git BoxLite gate | `node --test --test-force-exit apps/api/test/generated-private-git-boxlite-native.test.mjs` | SKIP (expected gate) — command exited 0, but no disposable native BoxLite configuration was provided (`BOXLITE_NATIVE_PRIVATE_GIT_E2E=1` plus `BOXLITE_*`). This is not recorded as a live E2E pass. |
| Focused public surface | `pnpm test:public-surface` | PASS — canonical operation/tool inventory, REST/MCP parity, examples, scopes, and secret-canary checks passed. |
| Fresh public surface | `pnpm verify:public-surface` | PASS — forced fresh builds and Prisma generation, downstream typechecks, metadata validation, and focused public-surface suites passed. |
| Wire compatibility fixtures | `node --test packages/contracts/src/task-provisioning-diagnostics.test.mjs packages/contracts/src/task-provisioning-diagnostics-capability.test.mjs packages/contracts/src/public-v1-operations.test.mjs` | PASS — 29/29, including canonical response round-trip, deployment membership capability, operation/tool identity, zero implicit transport differences, and forbidden-field rejection. |
| API forbidden-field scans | `node --test --test-force-exit apps/api/dist/public-surface/private-git-secret-canary.story.spec.js apps/api/dist/observability/logger-redaction.spec.js apps/api/dist/task-provisioning-diagnostics/task-provisioning-diagnostic-log.spec.js` | PASS — 27/27 against freshly built production JavaScript. |
| Web poison/boundary scans | `pnpm --filter @cap/web exec vitest run src/components/task-provisioning-diagnostics-panel.test.tsx src/lib/api/task-provisioning-diagnostics.test.ts src/components/api/catalog-and-columns.test.ts` | PASS — 3 files and 64/64 tests passed. |
| Diff hygiene | `git diff --check` | PASS — no whitespace errors. |
| Task verifier | `node scripts/openspec-metadata.mjs run-task harden-task-provisioning-diagnostics 8.6` | PASS — `public-surface-full` completed with a fresh build, typechecks, metadata checks, and focused suites. |

## Gate and rollout conclusion

All offline, database-backed, generated-contract, and production-build checks required by task 8.6 passed. The real native BoxLite E2E remains explicitly gated because this run did not have an authorized disposable native BoxLite environment. Diagnostic reads, writes, and diagnostics-scoped credential grants remain default closed and must not be opened on the strength of a skipped live gate.

An earlier `pnpm test:sandbox` execution produced passing sub-suite output but its process session was reclaimed before the final exit code could be observed. The command was rerun in full; only the second run with explicit exit code 0 is used as authoritative evidence above.

## Metadata closeout (task 8.7)

| Check | Command | Result |
| --- | --- | --- |
| Exact sidecar declaration | `jq -e '<exact sidecar assertions>' openspec/changes/harden-task-provisioning-diagnostics/surface-impact.json` | PASS — wire behavior is `changed`; Public V1 and MCP select `tasks.provisioningDiagnostics`; MCP selects `get_task_provisioning_diagnostics`; `protocolDifferences` is empty; the full verifier and wire fixture are required. |
| Propose transition | `node scripts/openspec-metadata.mjs validate-change harden-task-provisioning-diagnostics --phase propose` | PASS — 39 tasks. |
| Apply transition | `node scripts/openspec-metadata.mjs validate-change harden-task-provisioning-diagnostics --phase apply` | PASS — 39 tasks. |
| Verify transition | `node scripts/openspec-metadata.mjs validate-change harden-task-provisioning-diagnostics --phase verify` | PASS — planned operation/tool identifiers resolve to the implemented canonical registry; 39 tasks. |
| Explicit untracked-change discovery | `node scripts/openspec-metadata.mjs validate-diff openspec/changes/harden-task-provisioning-diagnostics/tasks.md openspec/changes/harden-task-provisioning-diagnostics/surface-impact.json` | PASS — one touched change validated. The no-argument form found zero changes because the whole change directory is untracked, so it was not accepted as evidence. |
| Metadata verifier | `node scripts/openspec-metadata.mjs run-task harden-task-provisioning-diagnostics 8.7` | PASS — 17 tests passed and one unrelated archived-change fixture was skipped; cross-track semantic coupling, operation/tool symmetry, zero undeclared protocol differences, registry inventory, task metadata, and fixed verifier safety passed. |
