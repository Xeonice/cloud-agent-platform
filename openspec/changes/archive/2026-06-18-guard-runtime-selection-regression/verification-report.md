# Verification report — guard-runtime-selection-regression

opsx-verify (run wf_4eaf7831-98b, 5 agents): **pass = true** — 1 requirement, 1 met,
0 unmet, 0 spec defects, 0 reopened tasks. (The workflow returned the verdict but did
not materialize this file; written here for the archive audit trail.)

## Requirement: Persisted task runtime deterministically selects the provisioning runtime, guarded against silent regression — MET

Capability: `agent-runtime`. All five scenarios are satisfied by shipped code +
adversarial red-checks:

| Scenario | Evidence |
|---|---|
| A claude-code task resolves the Claude runtime through the real seam | `runtime-selection.spec.ts` test 1 + 5 (real `IntegrationRuntimeRegistry`, incl. real `PrismaProvisionLookup`) → PASS |
| A codex or runtime-absent task resolves the codex runtime | tests 2, 3, 9 → PASS |
| The persistence lookup actually returns the stored runtime | test 4 (real `PrismaProvisionLookup.getTaskRuntime` + fake Prisma) → PASS |
| Omitting getTaskRuntime is a build-time failure | RED-CHECK A: removing it from `provision-lookup.port.ts` → `tsc TS2339` at `agent-runtime.integration.ts:188` (D1 direct call). Restored. |
| An unresolvable runtime is logged, never silently defaulted | tests 6 (out-of-set), 7 (throws), 8 (unwired) assert codex + a `warn`; test 9 asserts the legitimate `null` case stays quiet (D3) |

## Adversarial red-checks (both layers proven non-vacuous)

- **Compile-time (D1):** remove `getTaskRuntime` from the port → `tsc` error `TS2339`
  on the registry's direct call. The CI typecheck gate catches the exact v0.6.0 DOA class.
- **Test-time (D2):** stub `PrismaProvisionLookup.getTaskRuntime` to return `null`
  (the v0.6.0 broken read path) → spec tests 4 & 5 FAIL. The regression test guards the seam.

## Build/lint/test

`turbo typecheck lint` 12/12 · `tsc --noEmit` (@cap/api, uncached) PASS · eslint PASS ·
`pnpm --filter @cap/api test` 57/57 PASS (new spec 9/9). CI now runs the api suite
(`.github/workflows/ci.yml`).

## Known limitation (documented, not silently dropped)

The ~50 self-compiling `.test.mjs` leaf tests (incl. the codex byte-identity golden
suite) remain outside the CI lane — a larger separate effort (design D4). The
runtime-selection seam itself is fully gated (compile-time + the new spec).
