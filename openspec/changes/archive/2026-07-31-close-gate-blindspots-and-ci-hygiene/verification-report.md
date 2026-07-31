# Verification Report — close-gate-blindspots-and-ci-hygiene

Date: 2026-08-01
Verdict: **PASS** — 16/16 requirements MET, 0 UNMET, 0 spec defects, 0 blocking sidecar defects.

## Three-way routing tally

| Route | Count | Ids |
|---|---|---|
| UNMET → verify-reopened tasks | 0 | — |
| SPEC-DEFECT → design.md Open Questions | 0 | — |
| MET → this report | 16 | all requirements below |

The verify pass surfaced zero raw-unmet requirements, zero machine-routed public
findings, and an empty mandatory-findings list. No skeptic refutation survived to
adjudicate; the adjudicator independently re-spot-checked the load-bearing artifacts
(below) rather than accepting the empty list on faith.

## Requirements — all MET

### ratchet-baselines
- **ratchet-baselines-are-shrink-only-and-fail-closed** — `scripts/ratchets/comparator.mjs`
  implements bidirectional strictness (over-count red, stale-entry red naming the shrink
  target, zero-total-baseline red demanding file deletion). Tasks 1.1–1.4 evidence.
- **baseline-entries-are-count-based-data-with-per-entry-ownership** — `{count, samples[], change}`
  format with malformed-entry audit; `scripts/ratchets/r3.json` carries 5 entries each
  annotated "阶段 7a 端口化根治" (re-confirmed on disk at adjudication).
- **one-shared-comparator-serves-every-ratcheting-gate** — single implementation in
  `scripts/ratchets/comparator.mjs`; `sandbox-package-boundary.test.mjs` imports
  `compareToBaseline`/`readBaseline` rather than copying the loop (task 3.4).
- **every-ratchet-ships-a-paired-self-test-proving-it-can-go-red** —
  `comparator.test.mjs` 16/16 over red fixtures; integration sweep 8.15 proved paired
  `node <script> && node --test` invocation live for all six gate pairs; injection-probe
  red-run evidence recorded at tasks 2.6, 3.6, 4.3, 4.6 (all reverted-and-green).

### sandbox-provider-port
- **the-provider-center-facade-exposes-an-explicit-reviewed-export-surface** —
  `packages/sandbox/src/index.ts` enumerates named exports only (adjudication re-check:
  zero `export *` lines); `facade-surface.gate.mjs` + committed
  `expected-facade-surface.json` + self-test 7/7; both live injection probes went red
  with the committed data untouched (task 2.6), proving no self-attestation.
- **zero-reference-forwarding-stubs-are-removed-with-proof** — three-search zero-importer
  proof recorded at task 2.1; all six stubs deleted (adjudication re-check:
  `packages/sandbox/src/{capabilities,provider,testing}.ts` absent on disk); r3 baseline
  keys all live under `apps/api/src`, so no deleted stub is tolerated.
- **published-subpaths-resolve-only-from-declared-runtime-dependencies** — `testing.ts`
  and its `./testing` exports-map entry deleted; the two apps/api specs import the
  fixture from `@cap-console/sandbox-conformance` (a declared devDep) and re-ran green
  (task 2.2).
- **conformance-participation-is-derived-from-declared-capabilities** —
  `provider-contract-parity-check.mjs` discovers by capability (builds
  `@cap-console/sandbox-conformance`), no name glob, zero-match = red; self-test asserts
  `sandbox-cloud-http` is discovered; red-run at 4.3 named the package.

### monorepo-foundation
- **the-api-symbol-boundary-is-enforced-across-the-full-source-tree** — symbol scan
  expanded to the manifest-driven full-src walk (283 sources), 存量 rides r3.json via
  the shared comparator, `sourceBoundaryRoots` resolve from
  `docs/refactor/contexts-manifest.json` fail-closed; red-run at 3.6 caught an
  injected symbol outside the old roots.
- **ci-boots-the-built-application-and-probes-liveness** — `scripts/boot-smoke.sh`
  carries the `BOOT_SMOKE_STATEFUL` pre-seed/re-adopt flag (byte-identical when unset);
  `boot-smoke-stateful` job wired as a second conditioned job with the clean job
  untouched; `ci-job-conditions.test.mjs` 7/7 asserts the identical condition
  expression. See "Runner-proof deferral" below for tasks 8.9/8.12.
- **check-display-names-are-treated-as-a-consumed-attestation-api** — drift registered
  as debt in `docs/refactor/04-rules-registry.md` §F.1 (never renamed); final ci.yml
  diff verified byte-identical for every pre-existing `name:` (task 8.8).
- **build-configuration-references-only-real-inputs-and-shared-presets** — adjudication
  re-check: `turbo.json` no longer references `tsconfig.base.json`, and
  `apps/api/tsconfig.json` extends `../../packages/tsconfig/nest.json`; `turbo build`
  14/14 + `typecheck` 23/23 green (task 5.2 / 8.14 battery).

### test-suite-discovery
- **a-declared-suite-runs-in-some-ci-lane-or-is-deleted** — named CORS step
  (`pnpm test:cors-headers`, ci.yml:348, adjudication re-check); `coverage:sandbox`
  measured red-and-unconsumed at change time and DELETED per 总则4 with the deletion
  recorded (task 8.3); distinct `web-terminal-stories` lane with its own non-masking
  config; no declared-but-unconsumed third state remains.
- **visual-lanes-pin-their-rendering-environment-and-review-their-baselines** —
  pin `mcr.microsoft.com/playwright:v1.60.0-noble` present on both web jobs
  (ci.yml:611,645, adjudication re-check) and annotated in both playwright configs;
  in-pin recalibration landed as a reviewed diff; regeneration procedure in
  `apps/web/e2e/visual-baseline-regeneration.md`; the CI job contains no
  baseline-write step.
- **the-quarantine-list-is-empty-in-the-healthy-state-and-owned-when-not** —
  adjudication re-check: `QUARANTINED_SUITES = []` (scripts/quarantined-suites.mjs:52);
  all three entries cleared with GH-runner diagnoses inherited and recorded
  (install-preflight PATH-tail real-Docker, stale-sweep-canary bare `ws` resolution,
  readoption-history real product race fixed in `terminal.gateway.ts`); future-entry
  three-field audit proven on fixtures 8/8.

### agent-runtime
- **no-agent-identity-branch-exists-in-shared-scaffolding** —
  `agent-identity-branch-check.mjs` inverted to a complement scan with a 2-entry →
  4-entry three-field exemption list, malformed-entry audit, empty-scan = red; the two
  new hits found by the widened scan were exempted with owning-change attribution
  (task 4.4); red-run at 4.6 named file:line for an injected branch.

## Gap finding (recorded, non-blocking)

Based on a full cross-check of every requirement in
`openspec/changes/close-gate-blindspots-and-ci-hygiene/specs/` (agent-runtime,
monorepo-foundation, ratchet-baselines, sandbox-provider-port, test-suite-discovery)
against the actual working tree — `scripts/ratchets/{comparator.mjs,comparator.test.mjs,r3.json}`,
`scripts/agent-identity-branch-check.{mjs,test.mjs}`,
`scripts/provider-contract-parity-check.{mjs,test.mjs}`,
`scripts/quarantined-suites.{mjs,test.mjs}` (empty list confirmed),
`apps/api/src/sandbox/sandbox-package-boundary.test.mjs`,
`packages/sandbox/test/facade-surface.gate.{mjs,test.mjs,expected-facade-surface.json}`,
deleted stub files + `testing.ts`, `turbo.json`/`apps/api/tsconfig.json`/`packages/tsconfig/nest.json`,
`scripts/boot-smoke.sh` (`BOOT_SMOKE_STATEFUL` flag), `.github/workflows/ci.yml`
(`boot-smoke-stateful`, `web-visual`, `web-terminal-stories`, named CORS step),
`scripts/ci-job-conditions.test.mjs`, pinned Playwright image +
`visual-baseline-regeneration.md`, and `docs/refactor/04-rules-registry.md` (drift
registration) — every requirement has at least a traceable implementation on disk.

### Runner-proof deferral (tasks 8.9, 8.10, 8.12)

The only pending tasks.md items are "prove green on a real GitHub Actions runner" /
"record PR runner-minutes," explicitly blocked on the operator's standing no-push
instruction. That is **unproven-on-runner, not unimplemented**: the underlying jobs,
scripts, and wiring they would exercise are already present and locally green per the
recorded evidence (in-pin 40/44 visual with exactly the 4 triaged known-failures,
terminal-stories 15/15, `pnpm test:scripts` 305 pass / 0 fail, `turbo build` 14/14 +
`typecheck` 23/23). These do not block the primary scenarios of any requirement; the
runner proofs ride the eventual integration PR (task 9.1 vehicle) when the operator
authorizes a push.

## Scope finding

None (scope=null).

## Sidecar audit

`surface-impact.json` was audited face-by-face at task 8.14: all faces internalOnly,
publicV1/mcp/openapi/apiPlayground genuinely unchanged, the one production-code change
(`terminal.gateway.ts` armCast race fix) alters no wire shape, and the declared
`workflow-gates` verification lane actually ran on the integrated tree. No undeclared
public impact and no false protocol exclusion found — nothing routes to
blockingSpecDefects.
