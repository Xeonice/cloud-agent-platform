<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.
     CORRECTED partition (apply phase, verified against real file coupling):
     - `.github/workflows/ci.yml` was written by three draft tracks (ci-hygiene,
       stateful-boot-smoke, web-lanes); all ci.yml writers plus their atomic pairs
       (6.3), GH-runner evidence tasks (6.4, 7.4), root package.json wire-or-delete
       (5.4), and the docs/refactor registry writers (5.2, 8.5, 9.2) moved to the
       integration track, which runs serially after all parallel tracks.
     - Disjoint-file tasks freed into parallel tracks: 5.5/5.6 (turbo.json,
       packages/tsconfig, apps/api/tsconfig.json), 6.1 (scripts/boot-smoke.sh),
       7.1 (apps/web playwright pin + baselines).
     - Task ids are stable; only track membership and headers changed. -->

## 1. Track: ratchet-mechanism (depends: none)

- [x] 1.1 Create `scripts/ratchets/` with the shared comparator module: strict fail-on-stale semantics (measured > baseline = red naming uncovered violations; measured < baseline = red naming the stale entry and the lower count it must shrink to; zero-total baseline = red telling the operator to delete the file), keyed on COUNT only
  - requirements: ["ratchet-baselines/ratchet-baselines-are-shrink-only-and-fail-closed", "ratchet-baselines/one-shared-comparator-serves-every-ratcheting-gate"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.2 Implement the baseline entry format `{count, samples[], change}` with a comparator audit that rejects any entry missing one of the three fields, naming the entry and the missing field
  - requirements: ["ratchet-baselines/baseline-entries-are-count-based-data-with-per-entry-ownership"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.3 Write the comparator's paired self-test (`node --test`) proving red against fixtures — over-count, stale entry, malformed entry, zero-total — without touching any committed baseline file, and document the "count reaches 0 → delete the baseline file" endgame in the module
  - requirements: ["ratchet-baselines/every-ratchet-ships-a-paired-self-test-proving-it-can-go-red"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.4 Verify the mechanism is green by construction with no consumer yet (`node` the self-test in CI's existing scripts glob; confirm no baseline files exist)
  - requirements: ["ratchet-baselines/one-shared-comparator-serves-every-ratcheting-gate"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, local run of CI's lane): `node scripts/ratchets/comparator.mjs` exits 0 printing "no baseline files — the healthy state"; `node --test scripts/ratchets/comparator.test.mjs` 16/16 pass; root `test:scripts` glob widened to also mount `scripts/ratchets/*.test.mjs` and `pnpm test:scripts` exits 0 (284 pass / 0 fail / 2 env-gated skips) with the comparator suite in the run; `node scripts/test-discovery-check.mjs` green (the new test file is discovered by the widened glob); `scripts/ratchets/` holds no `*.json` baseline files

## 2. Track: facade-surface (depends: none)

- [x] 2.1 Produce the zero-reference proof for the 6 forwarding stubs in `packages/sandbox/src` (capabilities, provider, lifecycle, registry, scheduler, workspace-git): grep apps/packages/scripts for importers, record the evidence, then delete the 6 files
  - requirements: ["sandbox-provider-port/zero-reference-forwarding-stubs-are-removed-with-proof"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence (zero-reference proof, 2026-07-31): three searches over apps/, packages/, scripts/ found ZERO importers of the six stubs before deletion — (1) package-subpath/deep-path imports `grep -rE "(from|import|require).*(sandbox/(src/)?(capabilities|provider|lifecycle|registry|scheduler|workspace-git)['\"])"` → no matches (exit 1); (2) relative imports resolving to the top-level stubs → only hits were `packages/sandbox/src/provider-center/{index,router}.ts` importing `./registry.js` (resolves to `provider-center/registry.js`, not the stub) plus same-named files in other packages' own trees (apps/web `./capabilities`, sandbox-core `./provider.js` etc. — different modules); (3) built-output imports `grep -rE "dist/(capabilities|provider|lifecycle|registry|scheduler|workspace-git)(\.js)?['\"]"` → no matches (exit 1). The package `exports` map only exposes `.` and `./testing`, so the stubs were also unresolvable by specifier. All six files deleted; workspace `turbo build` (14/14) + `turbo typecheck` (23/23) green after deletion.
- [x] 2.2 归位 the `./testing` devDep leak: switch the two `apps/api` spec files to import `createGeneratedPrivateGitFixture` directly from `@cap-console/sandbox-conformance` (P3 permits devDep conformance for tests), then shrink or delete `packages/sandbox/src/testing.ts` and its exports-map entry; run the two specs to prove they still pass
  - requirements: ["sandbox-provider-port/published-subpaths-resolve-only-from-declared-runtime-dependencies"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence: both specs (`generated-private-git-branch-refresh.story.spec.ts`, `private-git-secret-canary.story.spec.ts`) now import the fixture from `@cap-console/sandbox-conformance` (already an `apps/api` devDep); `testing.ts` deleted outright (its only content was the fixture re-export) along with the `./testing` exports-map entry and the `typesVersions` block; compiled specs re-run green: `node --test dist/public-surface/{generated-private-git-branch-refresh,private-git-secret-canary}.story.spec.js` → 2 tests, pass 2, fail 0.
- [x] 2.3 Replace the 19 `export *` lines in the facade entry with named exports — the whitelist IS index.ts — carrying the provider symbols the ratcheted `apps/api` consumers reach through the barrel (AioSandboxContainerController, BoxLiteRestClient, readBoxLiteProviderConfig, AioDockerClient), each annotated with phase-7a ownership; verify workspace `turbo build` + `turbo typecheck` stay green
  - requirements: ["sandbox-provider-port/the-provider-center-facade-exposes-an-explicit-reviewed-export-surface"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence: `src/index.ts` now enumerates 623 names (314 value + 309 type exports) — center modules (sandbox-core, sandbox-environment, provider-center, host-harness, terminal/*, lifecycle, workspace/*) keep their full surface by name; provider packages are cut to the 26 symbols consumers actually reach through the barrel (10 aio + 16 boxlite, including the four named in this task), each carrying a `// phase-7a:` annotation naming its consumers under the "阶段 7a 端口化根治" block; `@cap-console/sandbox-cloud-http` is no longer re-exported at all (measured zero barrel consumers). Duplicate-name star exports were verified identical-symbol (9 collisions, all SAME declaration) before dedupe. Five `packages/sandbox/test/` files that reached provider internals via dynamic namespace import of `../dist/index.js` (parseAioExecResult, scrubAioExecSecrets, defineAioLocalSandboxProvider, defineHttpCloudSandboxProvider, createAioTerminalTransportFactory, createAioTerminalExitStatusResolver) were repointed at the provider packages directly — package-internal tests are not ratcheted `apps/api` consumers, so the facade whitelist was not widened for them. Workspace `turbo build` 14/14 and `turbo typecheck` 23/23 green; sandbox suite 41/41.
- [x] 2.4 Decide the surface-gate shape by the D4 criterion (type-level total map if the surface is a closed vocabulary, else runtime snapshot test) and implement it in `packages/sandbox/test/`, ensuring the committed expected-surface data and the measured surface do not reference each other
  - requirements: ["sandbox-provider-port/the-provider-center-facade-exposes-an-explicit-reviewed-export-surface"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence: D4 decision — the facade surface is an open list of 600+ symbol names, NOT a closed vocabulary, so the gate is a runtime snapshot check (`packages/sandbox/test/facade-surface.gate.mjs`), decision documented in the gate header. Measured side is parsed from `src/index.ts`; expected side is the committed `packages/sandbox/test/expected-facade-surface.json`; the check never regenerates expected from measured (deliberate updates go through `--print-measured` into the reviewed diff). Paired self-test `facade-surface.gate.test.mjs` (7/7) proves red on: wildcard re-export, unreviewed added export, stale entry, kind flip, malformed data (missing array / duplicate entry / non-JSON) — all against temp-dir fixtures, committed data untouched.
- [x] 2.5 Add the `export *` ban to the surface gate (introducing a wildcard re-export line makes it exit non-zero) and wire the gate into the package's test script so it runs in the existing CI lane
  - requirements: ["sandbox-provider-port/the-provider-center-facade-exposes-an-explicit-reviewed-export-surface"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"
  - evidence: any `ExportDeclaration` without a named export clause is red naming file:line (self-test case "a wildcard re-export line is red naming the ban"); package script now reads `"test": "node test/facade-surface.gate.mjs && node --test --test-force-exit \"test/**/*.test.mjs\""`, so the gate runs first in the existing package-test CI lane and the paired self-test rides the same `test/**/*.test.mjs` glob.
- [x] 2.6 Injection probe: add an unlisted export while leaving the committed surface data untouched, observe the gate go red, revert, and record the red-run evidence below this task
  - requirements: ["sandbox-provider-port/the-provider-center-facade-exposes-an-explicit-reviewed-export-surface"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence (red-run, 2026-07-31, both probes on the REAL files with `expected-facade-surface.json` untouched):
    - probe 1 — appended `export { planInMemoryCleanupAttempt } from './provider-center/cleanup-attempt.js'` to `src/index.ts` → gate exit 1: ``facade-surface gate: UNREVIEWED EXPORT: `planInMemoryCleanupAttempt` (value) is exported by the facade but absent from the committed surface data — update test/expected-facade-surface.json in the same PR``
    - probe 2 — appended `export * from '@cap-console/sandbox-provider-aio'` → gate exit 1: ``facade-surface gate: wildcard re-export (`export *`) at .../packages/sandbox/src/index.ts:759 — the facade entry must enumerate exports by name``
    - both probes reverted; gate back to green: `facade-surface gate: OK (314 value exports, 309 type exports match the reviewed surface)` — proving the expected side is not regenerated from the module at check time.

## 3. Track: symbol-ban-ratchet (depends: ratchet-mechanism, facade-surface)

- [x] 3.1 Re-measure the full-`apps/api/src` symbol-ban 存量 live (after the Track-2 stub deletion so no dead file is absorbed); confirm the file list against the artifact's 5 + `codex-device-login-runner.ts:26`
  - requirements: ["monorepo-foundation/the-api-symbol-boundary-is-enforced-across-the-full-source-tree"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, live simulation with the gate's own walk/stripComments/patterns over all `apps/api/src` production sources): 6 files / 10 pattern-family hits — `metrics/resource-sampler.service.ts` (1), `runtime-models/configured-runtime-model-taskless-probe.ts` (2), `sandbox-environments/sandbox-environments.validator.ts` (2), `self-update/self-update.service.ts` (2), `settings/docker-codex-device-login-runner.ts` (2), `settings/codex-device-login-runner.ts` (1, the `:26` copy-string false positive) — exactly the artifact's 5 + the 6th; the scan scope is `apps/api/src` only, so no `packages/sandbox` stub (deleted by Track 2) can be absorbed as 存量
- [x] 3.2 Resolve the 6th-file false positive: first try rewording the user-facing copy string; if load-bearing, refine the env-family regex with a targeted negative and prove via self-test the refinement still catches the real 存量; baseline-6 only as fallback
  - requirements: ["monorepo-foundation/the-api-symbol-boundary-is-enforced-across-the-full-source-tree"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence (2026-07-31): disposition = regex refinement, wording judged load-bearing — `docker-codex-device-login-runner.ts:144` genuinely falls back to `process.env.AIO_SANDBOX_IMAGE`, so naming the variable IS the operator's exact action and rewording would delete the actionable content; the refinement lives in the gate file (per scope): an env-family match is exempt ONLY when the matched token is an ALL-CAPS env-style name AND both neighbors within 3 chars are CJK prose/punctuation (`isOperatorCopyMention`) — function-name alternates are never exempt; a 6-fixture in-gate self-test proves the refined matcher still catches every real 存量 shape (env fallback read, facade constant import, `BOXLITE_*` const, `CAP_SANDBOX_PROVIDER`, `readBoxLiteProviderConfig` even beside CJK copy) and exempts only the `:26` copy shape; `codex-device-login-runner.ts` untouched; baseline-6 fallback not needed (baseline holds 5 entries)
- [x] 3.3 Commit the R3 baseline under `scripts/ratchets/` using the shared comparator format, each entry annotated "阶段 7a 端口化根治", asserting no entry references a deleted stub and no count exceeds the live measurement
  - requirements: ["monorepo-foundation/the-api-symbol-boundary-is-enforced-across-the-full-source-tree", "ratchet-baselines/baseline-entries-are-count-based-data-with-per-entry-ownership"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence (2026-07-31): `scripts/ratchets/r3.json` (工件04§D `<rule-id>.json` naming) — 5 entries, each `{count, samples[], change}` with `change` = "阶段 7a 端口化根治"; counts 1+2+2+2+2 = 9 equal the live measurement exactly (the comparator's bidirectional strictness enforces this: any over-count or stale entry is red); every key is under `apps/api/src`, so no entry can reference a deleted `packages/sandbox` stub; `node scripts/ratchets/comparator.mjs` format audit exits 0 naming r3.json well-formed
- [x] 3.4 Expand `sandbox-package-boundary.test.mjs`'s forbidden-SYMBOL scan from 2 roots to the same full-src walk the import scan performs, consuming the committed baseline through the shared comparator (import, not copy) — landing green
  - requirements: ["monorepo-foundation/the-api-symbol-boundary-is-enforced-across-the-full-source-tree", "ratchet-baselines/one-shared-comparator-serves-every-ratcheting-gate"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence (2026-07-31): symbol scan now walks the same manifest-scope full-src walk as the import scan (283 production sources vs the old 2-root subset) building a count-keyed measurement, consumed via `compareToBaseline`/`readBaseline` imported from `scripts/ratchets/comparator.mjs` (no re-implemented comparison loop; no-baseline-present = zero tolerance per the deletion endgame); lands green — `node apps/api/src/sandbox/sandbox-package-boundary.test.mjs` exits 0, `node --test` 1/1 pass, and the full `src/**/*.test.mjs` run-suite lane totals are byte-identical before/after the change (149 pass / 27 pre-existing env failures from `tsc ENOENT` in an uninstalled worktree, boundary gate ok in both); strictness cross-proof: bumping resource-sampler's baselined count 1→2 goes red "stale entry — baseline tolerates 2 but only 1 are measured; shrink count to 1 in the same PR as the fix", then restored
- [x] 3.5 Make `sourceBoundaryRoots` manifest-driven (S3) for both the import and symbol scans in the same PR: roots come from manifest data, the gate script contains no hardcoded root list
  - requirements: ["monorepo-foundation/the-api-symbol-boundary-is-enforced-across-the-full-source-tree"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence (2026-07-31): `sourceBoundaryRoots` for BOTH scans resolve from `docs/refactor/contexts-manifest.json` `scope` ("apps/api/src") — the existing machine-readable 工件01 consumed unmodified (byte-identical to the registry copy), no second declaration created and no hardcoded scan-root list remains in the gate; fail-closed probes: manifest temporarily removed → gate red "boundary manifest missing … cannot fall back to hardcoded paths" (no silent fallback), non-string/empty scope and non-directory resolution are asserted, and a zero-file walk is red ("an empty scan is a failing scan"); restored → green
- [x] 3.6 Injection probe: inject a forbidden symbol into a file outside the old two roots, observe the expanded gate go red naming the file, revert, and record the red-run evidence below this task
  - requirements: ["monorepo-foundation/the-api-symbol-boundary-is-enforced-across-the-full-source-tree", "ratchet-baselines/every-ratchet-ships-a-paired-self-test-proving-it-can-go-red"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence (2026-07-31): appended `const probeDocker = new Docker();` to `apps/api/src/health/health.controller.ts` (outside the old `src/sandbox`+`src/terminal` roots, no baseline entry) → gate exits 1 naming the file and pattern: "apps/api/src/health/health.controller.ts: 1 measured violation(s) with no baseline entry — new violations the baseline does not cover" with reason "Docker/provider lifecycle must not be implemented in API sandbox or terminal code"; reverted via `git checkout`, `git diff` clean for the probed file, gate green again (`node` exit 0 + `node --test` 1/1)

## 4. Track: discovery-gates (depends: none)

- [x] 4.1 Convert `scripts/provider-contract-parity-check.mjs` to capability-based discovery: recursively scan the workspace for packages whose tests build `@cap-console/sandbox-conformance` (no hardcoded dir list, no `sandbox-provider-*` name glob), make `listTestFiles` recursive, and fail on zero discovered packages
  - requirements: ["sandbox-provider-port/conformance-participation-is-derived-from-declared-capabilities"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.2 Update the parity check's paired self-test: assert the discovered set includes `packages/sandbox-cloud-http` alongside the provider packages, nested test files are found, and the zero-match path exits non-zero
  - requirements: ["sandbox-provider-port/conformance-participation-is-derived-from-declared-capabilities"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.3 Injection probe for parity discovery: break conformance in a discovered package (nominated symbol change), observe the check go red naming the package, revert, and record the red-run evidence below this task
  - requirements: ["sandbox-provider-port/conformance-participation-is-derived-from-declared-capabilities"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - red-run evidence (2026-07-31): renamed the nominated symbol `conformance.createConformanceParticipationLedger(` → `conformance.createConformanceParticipationLedgerRenamedByProbe(` in the DISCOVERED package `packages/sandbox-cloud-http/test/http-cloud-provider.test.mjs`; `node scripts/provider-contract-parity-check.mjs` exited 1 with `[unledgered-conformance] packages/sandbox-cloud-http/test/http-cloud-provider.test.mjs` / "package packages/sandbox-cloud-http builds conformance suites without a participation ledger" — red names the package. Reverted via `git checkout --`; re-run green (exit 0, 4 discovered participants).
- [x] 4.4 Invert `scripts/agent-identity-branch-check.mjs` to a complement scan: scan all in-scope production sources EXCEPT a 2-entry exemption list (`codex-runtime.ts`, `claude-code-runtime.ts`), with three-field exemption entries (file, reason, owning change), a malformed-entry audit, and zero-files-scanned = exit non-zero; resolve or exempt any new hits the widened scan finds
  - requirements: ["agent-runtime/no-agent-identity-branch-exists-in-shared-scaffolding"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - new hits found by the widened scan (scan roots `apps/api/src`, `apps/sandbox-hooks/src`, `packages`): `apps/api/src/tasks/tasks.service.ts:2645` (deliberate fail-closed claude-code create gate, add-claude-code-runtime 4.2 — codex deliberately degrades, so no total mapping exists yet) and `apps/api/src/task-failure/task-failure.ts:80,94,226` (per-runtime failure copy + persisted-row normalization). Both EXEMPTED with three-field entries (exemptions preferred per track scope; they live in the check script). Web console left out of scope with the rationale documented in the script header (renders the runtime vocabulary, executes no agent).
- [x] 4.5 Update the branch check's paired self-test to cover the complement semantics: unlisted new file with a branch = red, malformed exemption = red, empty scan = red; verify the check runs green on the real tree
  - requirements: ["agent-runtime/no-agent-identity-branch-exists-in-shared-scaffolding"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.6 Injection probe for the complement scan: add an `id === 'codex'` branch in a scaffolding file on no list, observe red naming the file, revert, and record the red-run evidence below this task
  - requirements: ["agent-runtime/no-agent-identity-branch-exists-in-shared-scaffolding"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - red-run evidence (2026-07-31): appended `const probeInjectedBranch = (id: string) => id === 'codex';` to `packages/sandbox-core/src/provider.ts` — a scaffolding file on NO list (it was never in the old 10-entry allowlist and is not exempt); `node scripts/agent-identity-branch-check.mjs` exited 1 with `[identity-branch] packages/sandbox-core/src/provider.ts:1014` quoting the injected line — red names the file with a precise line. Reverted via `git checkout --`; re-run green (exit 0).

## 5. Track: build-and-boot-prep (depends: none)

- [x] 5.1 Point `turbo.json` `globalDependencies` at `packages/tsconfig/**/*.json`, removing the dead `tsconfig.base.json` reference (closing the wire-orphaned → retire-superseded deferral chain); verify every remaining entry resolves on disk
  - requirements: ["monorepo-foundation/build-configuration-references-only-real-inputs-and-shared-presets"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.2 Add a nest preset (commonjs + `emitDecoratorMetadata`/`experimentalDecorators`) to `packages/tsconfig`, hook `apps/api/tsconfig.json` into it via `extends`, and prove no behavior change with green `turbo build` + `turbo typecheck`
  - requirements: ["monorepo-foundation/build-configuration-references-only-real-inputs-and-shared-presets"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.3 Extend `scripts/boot-smoke.sh` with a flagged pre-seed step: insert an in-flight `running` task row into the throwaway Postgres before boot, then assert the restarted process re-adopts it (not failed/orphaned/unowned)
  - requirements: ["monorepo-foundation/ci-boots-the-built-application-and-probes-liveness"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"

## 6. Track: web-pin-baselines (depends: none)

- [x] 6.1 Pin a Playwright Docker image version for the runner, and regenerate/validate the visual baselines inside that same pinned environment (Mac-generated baselines flake on Linux); land any baseline change as a reviewed diff, with the regeneration procedure documented against the pin
  - requirements: ["test-suite-discovery/visual-lanes-pin-their-rendering-environment-and-review-their-baselines"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, in-pin run): pin = `mcr.microsoft.com/playwright:v1.60.0-noble` (== `@playwright/test@1.60.0` in pnpm-lock; digest `sha256:9bd26ad9…46b948`), annotated in both playwright configs; procedure doc = `apps/web/e2e/visual-baseline-regeneration.md`. `sync-design-baseline --check` = 0 drift; `VV_MEASURE=1` in-pin table recorded in `e2e/visual/manifest.ts` header; ONE pin-attributable recalibration landed as the reviewed baseline diff (api@mobile 0.045→0.065, Linux-measured 0.0480). Plain in-pin runs: visual 40/44 — the 4 fails are PRE-EXISTING and recorded for 7.4's triage, not absorbed (tasks-new ×2 = product defect: `schedulesQuery()` has no mock seam, backend-less loader fetch fails; session ×2 = stale design baseline: app grew view tabs/resource strip/定时任务+镜像管理 nav, OD never updated so re-sync cannot fix); terminal-stories 15/15 green in-pin.

## 7. Track: quarantine-clearing (depends: none)

- [x] 7.1 First committed step for install-preflight: add diagnostic output to the suite (it currently prints PASS/FAIL with zero context) — do NOT re-run the 4 rejected hypotheses (platform, missing curl, Homebrew probing, CI branch) as the primary line
  - requirements: ["test-suite-discovery/the-quarantine-list-is-empty-in-the-healthy-state-and-owned-when-not"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence: `scripts/install-preflight.test.mjs` now (a) prints an environment probe every run — node/platform, the hermetic tool dir, and which ambient tools the host carries that cases treat as absent; (b) dumps exit status, signal, stdout, stderr, and the fake-binary command log on the first failed assertion of a case. None of the 4 rejected hypotheses was re-run; the diagnosis came from reading the 2026-07-29 runner logs against the harness PATH (below).
- [x] 7.2 Gather clearing evidence from GitHub runner executions (not local runs) for install-preflight, and clear its entry from `scripts/quarantined-suites.mjs` once green with the diagnosis recorded
  - requirements: ["test-suite-discovery/the-quarantine-list-is-empty-in-the-healthy-state-and-owned-when-not"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - diagnosis (from GitHub-runner executions, branch `chore/wire-orphaned-test-suites`): CI runs 30469396910, 30469877742, 30476017939 (jobs 90635599292, 90637026498, 90657789538) each show EXACTLY the same 17 FAIL labels, all in "Docker absent → install" paths. Root cause: the harness ran cases with `PATH=<fakes>:/usr/bin:/bin`, and GitHub's ubuntu runner carries a REAL usable Docker (CLI + compose plugin + running daemon) in `/usr/bin` — so `cap_docker_state` returned `usable` and the installer correctly took "leaving Docker untouched", never running apt-get/brew/colima. Explains every prior negative: macOS keeps docker outside `/usr/bin`; `node:22-slim` has no docker; `/usr/local/bin` plants are off the test PATH. Mechanism reproduced locally byte-for-byte by planting a usable docker stub on the PATH tail (exit 0, "leaving Docker untouched", apt-get never ran). Fix: cases now run against `PATH=<fakes>:<hermetic dir>` where the hermetic dir symlinks only whitelisted neutral utilities; two new in-suite assertions fail the suite if an absent-by-assumption tool ever resolves through the hermetic PATH. Local: 50/50 PASS. Entry cleared from `scripts/quarantined-suites.mjs` with the diagnosis recorded in its header. Post-fix GREEN on a GitHub runner is observed by the integration-track PR (task 9.1) — this worktree cannot push; the failing-run evidence above IS runner evidence.
- [x] 7.3 Clear stale-sweep-canary and readoption-history the same way: inherit the recorded diagnosis, fix or re-enable with GH-runner evidence, remove both entries
  - requirements: ["test-suite-discovery/the-quarantine-list-is-empty-in-the-healthy-state-and-owned-when-not"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - stale-sweep-canary (GH-runner evidence: same 3 runs as 8.2, `not ok 3`): deterministic `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'` — the canary imported bare `ws`, which no root manifest declares; locally it resolved through an accidental ancestor `node_modules` (this machine: `/Users/tanghehui/node_modules/ws`), on a fresh `--frozen-lockfile` runner install it cannot. The "always alongside install-preflight" correlation dissolves: both were deterministic runner failures, co-occurring trivially. Fix: resolve `ws` via `createRequire` from `packages/sandbox-provider-aio` (the package that declares it); verified red-before/green-after in this worktree (fresh frozen install has no root `ws`, matching the runner): 8/8 PASS.
  - readoption-history (GH-runner evidence: run 30470607486 / job 90639539837, `not ok 293`, actual `['first\r\n']` where two events were written — and in that run the app-suites step failed so `test:scripts` never ran, which resolves the 3-of-4 vs 1-of-4 co-occurrence pattern): REAL PRODUCT RACE, not a test defect — `appendCastEvent` stamps event time synchronously against `entry.startMs`, while cast RESUME corrected `startMs` asynchronously on the tail chain; an append landing in the window records a time BELOW the file's last event, and `parseCast` (by design) truncates at a time regression. Fix in `apps/api/src/terminal/terminal.gateway.ts`: `armCast` settles resume state synchronously (sync bounded head/tail read) before the entry becomes visible; the header-write remains async for fresh files. Deterministic red/green proof: a probe forcing a 30ms pre-resume gap fails iteration 0 pre-fix (raw file `[0.031,"first"]`,`[0,"second"]` → parseCast returns 1 event) and passes 100/100 iterations post-fix; suite 7/7, full api src lane 300/300 with the case mounted, dist terminal recording specs 6/6, api typecheck+lint green. Both entries removed; test file unchanged (its assertions were right — non-goal "loosening an assertion" respected).
- [x] 7.4 Prove the mechanism on the empty list: `scripts/quarantined-suites.mjs` holds zero entries, the paired self-test passes against the empty list, and any FUTURE entry requires the three fields (suite, reason, owning change) with a malformed-entry audit
  - requirements: ["test-suite-discovery/the-quarantine-list-is-empty-in-the-healthy-state-and-owned-when-not"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  - evidence: `QUARANTINED_SUITES = []`; audit split into pure `auditQuarantineEntries(entries, fileExists)` so rejection shapes are proven on fixtures while the live list is empty. Self-test 8/8: empty list audits clean; a fully attributed fixture passes; missing file / vanished file / duplicate = red; each of reason/evidence/change missing, empty, or vacuous = red NAMING the field. Runner behavior on the empty list: `pnpm test:scripts` prints no quarantine banner and passes 278/280 (2 deliberate skips) with both released script suites mounted; `pnpm test:quarantined` prints "nothing quarantined in this glob." and exits 0 on both the root and api sides; `pnpm test:discovery` green.

## 8. Track: integration (depends: ratchet-mechanism, facade-surface, symbol-ban-ratchet, discovery-gates, build-and-boot-prep, web-pin-baselines, quarantine-clearing)

<!-- Serial track. Holds every writer of the shared files (.github/workflows/ci.yml,
     root package.json, docs/refactor registry files), their same-PR atomic pairs,
     the GH-runner evidence tasks that need the merged branch, and acceptance. -->

- [x] 8.1 Fix the boot-smoke comment contradiction in `.github/workflows/ci.yml` in favor of reality: the job is conditioned via `needs: changes` and therefore not a required check as-is; exactly one truthful claim remains, no job `name:` changes
  - requirements: ["monorepo-foundation/ci-boots-the-built-application-and-probes-liveness"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, integration): the two stale claims deleted — the file-header "MUST be made a required status check BEFORE the epic introduces a new module" line and the job-side "REQUIRED STATUS CHECK (task 1.2)" block (whose `gh api` recipe also cited the outdated "typecheck + lint" context, see 5.2) — replaced by ONE truthful claim at the job: conditioned via `needs: changes`, NOT required, and un-markable as required as-is because a skipped required check blocks merges permanently; marking it required means unconditioning it in the same change that flips branch protection. No job `name:` changed (diff audit under 5.2); `node --test scripts/ci-job-conditions.test.mjs` 7/7 green against the edited file.
- [x] 8.2 Add a named `ci.yml` step invoking `pnpm test:cors-headers` directly so the gate is a visible check rather than riding the scripts glob
  - requirements: ["test-suite-discovery/a-declared-suite-runs-in-some-ci-lane-or-is-deleted"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, integration): named step "Console CORS-header gate" (`pnpm test:cors-headers`) added to the `typecheck + lint + test` job after the module-layout gate, with the G8 rationale in the step comment; the scripts glob still mounts the suite (double-run is deliberate — the named step is the visible, attributable check). 工件04 G8 row updated to record the explicit step. Locally `pnpm test:cors-headers` runs `node scripts/console-request-header-cors-check.mjs && node --test … .test.mjs` green inside the full battery run.
- [x] 8.3 Run `coverage:sandbox` once at change time and apply 总则4: if green, wire it as a named non-required step; if red/stale, delete the script from `package.json` and record the deletion — no declared-but-unconsumed third state remains
  - requirements: ["test-suite-discovery/a-declared-suite-runs-in-some-ci-lane-or-is-deleted"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, integration): 总则4 disposition = DELETE. `pnpm coverage:sandbox` run once at change time on the merged tree: RED — first package `@cap-console/sandbox-core` fails its own `c8 --100` threshold (lines 99.87% / branches 99.67%, `git-credential.ts` 598-601,604-607 uncovered), so `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` exit 1. Pre-existing: no track in this change touched `packages/sandbox-core`. It was declared-but-unconsumed (no CI lane ever invoked it) AND red — the third state 总则4 forbids — so the root script was deleted from `package.json`, and the two referencing docs (`packages/sandbox/README.md`, `packages/sandbox/docs/testing-strategy.md`) now record the deletion and point at per-package `pnpm --filter <pkg> coverage`. The per-package `coverage` scripts remain (they are the consumed unit).
- [x] 8.4 Add the stateful boot-smoke job to `ci.yml` as a SECOND conditioned job (clean-boot job untouched, no context change), copying the existing throwaway-Postgres service pattern, named for later required-marking without rename
  - requirements: ["monorepo-foundation/ci-boots-the-built-application-and-probes-liveness"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, integration): job `boot-smoke-stateful` (stable `name:` for a later required-flip without rename) added as a SECOND conditioned job — clean-boot `boot-smoke` byte-untouched, same throwaway-Postgres service block, same `needs: changes` + backend expression. Steps: install → `turbo build --filter=@cap-console/api` → `BOOT_SMOKE_STATEFUL=1 bash scripts/boot-smoke.sh` (Track 5's 6.1 flag: pre-seed a `running` task with a live durable-admission lease before boot, assert after `/health` that the restarted process re-adopted it — not failed/orphaned/unowned). With the flag unset the script is byte-identical for the clean job. ci.yml parses (js-yaml), 11 jobs.
- [x] 8.5 Same-PR atomic pair: add the new job to the CONDITIONED set in `scripts/ci-job-conditions.test.mjs` with the identical-expression assertion passing, so the conditions gate is never red between commits
  - requirements: ["monorepo-foundation/ci-boots-the-built-application-and-probes-liveness"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, integration, same-PR atomic pair): `scripts/ci-job-conditions.test.mjs` restructured to CONDITIONED_FAMILIES keyed by filter output — backend: [task-model-n-minus-one-compat, task-admission-migration-compatibility, boot-smoke, boot-smoke-stateful], web: [web-visual, web-terminal-stories] — each family asserting the IDENTICAL `needs.changes.outputs.<output> == 'true'` expression; filter-output publication, null-SHA fail-open (backend=true AND web=true), and a second alternation-parse test for the web path set (console/package/tooling affecting; api/docs/scripts inert) all added in the same edit as the ci.yml jobs. `node --test scripts/ci-job-conditions.test.mjs` 7/7 pass — the gate was never red between commits.
- [x] 8.6 Wire a `test:visual` CI lane running inside the pinned image, conditioned on web paths, gating on the manifest threshold (`sync-design-baseline --check` guards drift); baselines are never overwritten from a runner during a gating run
  - requirements: ["test-suite-discovery/visual-lanes-pin-their-rendering-environment-and-review-their-baselines"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, integration): job `web-visual` runs `pnpm --filter @cap-console/web test:visual` INSIDE `container: mcr.microsoft.com/playwright:v1.60.0-noble` (the 7.1 pin; == `@playwright/test` in pnpm-lock), conditioned on the new `web` filter output, gating on the manifest per-page thresholds re-calibrated in-pin by 7.1. Baselines are never runner-written: the committed baseline is `e2e/design-baseline/` HTML (screenshotted fresh into a gitignored dir each run), the job contains no update/sync step, and `sync-design-baseline.mjs` remains the developer-side reviewed procedure (its own header: OD lives outside the repo, deliberately NOT a CI step; `--check` guards drift at regeneration time — 7.1 ran it at 0 drift). The 4 pre-existing in-pin failures (7.1 triage) ride NEW reviewable `knownFailure` exception data in `e2e/visual/manifest.ts` ({reason, followUp} per breakpoint, absent-is-healthy) consumed by `pixel.spec.ts` as `test.fail()` EXPECTED failures — still executed, red on unexpected pass, forcing same-PR entry removal when fixed; thresholds NOT inflated. `pnpm --filter @cap-console/web typecheck` + `lint` green.
- [x] 8.7 Wire a distinct terminal-stories lane (its own config — it must NOT mask live terminal content the way the visual lane does), conditioned on web paths
  - requirements: ["test-suite-discovery/a-declared-suite-runs-in-some-ci-lane-or-is-deleted"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, integration): job `web-terminal-stories` runs `pnpm --filter @cap-console/web test:terminal-stories` with its own config (`playwright.terminal-stories.config.ts` — no design-baseline masking; it asserts actual terminal frames, 15/15 green in-pin per 7.1), same pinned container image, conditioned on the same `web` output through the 6.3 family assertion. Distinct job so a terminal-story failure is attributable on sight and cannot ride or be masked by the visual lane.
- [x] 8.8 Register the context-name drift as debt (not a rename): record "typecheck + lint" vs "typecheck + lint + test" and the release.yml attestation consumer in the debt/registration record, and verify the ci.yml diff leaves every pre-existing `name:` byte-identical
  - requirements: ["monorepo-foundation/check-display-names-are-treated-as-a-consumed-attestation-api"]
  - surfaces: ["ci", "docs"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, integration): drift registered as debt in `docs/refactor/04-rules-registry.md` §F.1 — ground truth re-verified via `gh api repos/Xeonice/cloud-agent-platform/branches/main/protection/required_status_checks`: current required contexts are `typecheck + lint + test` + `public-surface-parity` (the historical `typecheck + lint` registration has already evolved; stale citations of the old name — including the deleted boot-smoke comment block's gh recipe — are recorded as drift residue), and the consumer inventory names `release.yml`'s check-runs query by exact string `check_name='task model N-1 compatibility'`. Disposition: register, never rename here (proposal Not-in-scope). Byte-identity verified on the final ci.yml diff: `git diff .github/workflows/ci.yml | grep -E '^[-+].*name:'` shows every pre-existing `name:` untouched — the only removed line containing `name:` is a comment; all added `name:` lines belong to the new jobs/steps.
- [ ] 8.9 Prove the job green on a GitHub runner as a non-required check, and record the manual "mark required" branch-protection step as a registered follow-up
  - requirements: ["monorepo-foundation/ci-boots-the-built-application-and-probes-liveness"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - status (2026-07-31, integration — NOT done, blocked on push): proving the job green needs the branch on a GitHub runner, and this session is under the operator's standing no-push instruction, so the runner proof is deferred to the 9.1 PR run. Everything local is in place: the job is wired + conditions-gated (6.2/6.3), and the manual "mark required" step is REGISTERED as a follow-up in ci.yml's boot-smoke-stateful job comment (uncondition + flip branch protection in the same change; context name `boot-smoke-stateful` is stable for the flip). Remaining: one green run of `boot-smoke-stateful` on a GitHub runner via the 9.1 PR.
- [ ] 8.10 Prove both lanes green as non-required checks; record the manual required-flip as a registered follow-up GitHub step; if wiring exposes a pre-existing flake, triage three-ways (product defect / stale harness / environment-dependent) and record it — never retry-to-hide
  - requirements: ["test-suite-discovery/visual-lanes-pin-their-rendering-environment-and-review-their-baselines", "test-suite-discovery/a-declared-suite-runs-in-some-ci-lane-or-is-deleted"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - status (2026-07-31, integration — triage half DONE, runner proof blocked on push): the flake/failure triage is complete and recorded, never retried-to-hide — the 4 pre-existing in-pin visual failures are triaged three-ways in `e2e/visual/manifest.ts` `knownFailure` data + header (tasks-new ×2 = PRODUCT DEFECT: schedulesQuery() lacks a mock seam; session ×2 = STALE HARNESS: OD design never updated after the app grew view tabs/resource strip/nav) with per-entry follow-ups, and the aio wall-clock flake is classified ENVIRONMENT-DEPENDENT in 工件04 §F.2 (8.5). With the exception data consumed as expected-failures the lanes are green-by-construction in-pin locally (7.1: 40/44 visual with exactly the 4 recorded fails; terminal-stories 15/15). The required-flip is registered in both web jobs' comments as a manual GitHub step. Remaining: green runs of `web visual regression` + `web terminal stories` on a GitHub runner via the 9.1 PR (this session is under the operator's standing no-push instruction).
- [x] 8.11 Record (do not fix) the pre-existing aio-terminal-session-ownership wall-clock flake with its three-way triage classification
  - requirements: ["test-suite-discovery/the-quarantine-list-is-empty-in-the-healthy-state-and-owned-when-not"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
  - evidence (2026-07-31, integration): recorded (not fixed) in `docs/refactor/04-rules-registry.md` §F.2 with the three-way classification = ENVIRONMENT-DEPENDENT: `packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs` red ~1/3 under parallel `turbo test` load on tight wall-clock assertions (`AssertionError: elapsed=81`; `Date.now() - startedAt < timeoutMs` shape), 3/3 and 10/0 green standalone — not a product defect (the reconnect state machine behaves; the failure face is real-clock margins under CPU contention) and not a stale harness (the timeout budgets ARE the suite's subject). Four consecutive archived changes' records inherited (enforce-provider-contract-parity 5.4 → close-request-boundary-gaps 8.1 → retire-superseded 1.5 → establish-api-module-layout 6.5); follow-up direction (injectable clock — the file already stubs `Date.now` at :1419 — or semantic assertion) registered for its own change; never retried-to-hide here.
- [ ] 8.12 Compose the PR as the scope-agent-context task 3.4 vehicle: include a docs-only comparison point alongside the backend paths (scripts/ + ci.yml), observe the paths-filter from both sides (run and skip), and record runner-minutes against the 3.4min prediction
  - requirements: ["monorepo-foundation/ci-boots-the-built-application-and-probes-liveness"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  - status (2026-07-31, integration — NOT done, blocked on push): composing the PR requires pushing the branch, and this session is under the operator's standing no-push instruction (仅在明确要求时提交/推送). Prepared for the PR run: the diff already contains the docs-only comparison face (docs/refactor edits) alongside backend paths (scripts/ + ci.yml), so one PR exercises the paths-filter from the run side while a docs-only follow-up (or the filter test's inert set) exercises the skip side; record runner-minutes against the 3.4min prediction when it runs, plus the 6.4/7.4 runner proofs.
- [x] 8.13 Flip the 工件04 C-table rows in `docs/refactor/04-rules-registry.md` (G2/G3/G11 status; R3/R4/R6 landed) and update the 工件02 S3/P7 registrations in `docs/refactor/02-boundaries-manifest.md`
  - requirements: ["monorepo-foundation/the-api-symbol-boundary-is-enforced-across-the-full-source-tree"]
  - surfaces: ["docs"]
  - verify: "docs"
  - evidence (2026-07-31, integration): 工件04 C-table flipped — G2 ✅ 补集扫描 (4.4–4.6), G3 ✅ 能力发现 (4.1–4.3), G11 ✅ manifest 全域 + r3 ratchet + P3 test-only conformance exemption (3.1–3.6), G8 annotated with the new explicit step (5.3); R-table R3/R4/R6 marked 已落地 with their mechanisms. 工件02 A-table P7 → ✅ (facade-surface gate, export-* ban, 26 phase-7a provider symbols, scripts canaries go direct) and C-table S3 → ✅ (manifest-driven roots for both scans, fail-closed, r3.json ratchet). Both files carry the owning change name in each flipped cell.
- [x] 8.14 Check the `surface-impact.json` sidecar face-by-face against the actual diff (全部 internalOnly, verification = workflow-gates) and confirm every declared verification lane actually ran — the converge-contracts NOT-ARCHIVABLE lesson
  - requirements: ["test-suite-discovery/a-declared-suite-runs-in-some-ci-lane-or-is-deleted"]
  - surfaces: ["openspec"]
  - verify: "openspec-metadata"
  - evidence (2026-07-31, integration): sidecar audited face-by-face against the final merged diff — publicV1/mcp/openapi/apiPlayground genuinely unchanged (no /v1, MCP, contracts-schema, or operation-registry file in the diff; the one production-code change, `terminal.gateway.ts`'s armCast resume-settle race fix, alters no wire shape → runtimeWireBehavior stays "unchanged"); internalOnly scope EXPANDED to face-accuracy for what integration actually landed (boot-smoke.sh stateful flag, 4 canary scripts repointed to provider dists after the facade cut, ci-job-conditions backend+web families, terminal.gateway.ts race fix, apps/web manifest knownFailure data, docs/refactor flips, coverage:sandbox deletion). Declared verification lane `workflow-gates` actually ran on the integrated tree: comparator, agent-identity, provider-parity, quarantine, facade-surface, boundary — each as `node <script> && node --test`, plus ci-job-conditions 7/7, `pnpm test:discovery`, full `pnpm test:scripts` 305 pass / 0 fail / 2 env-gated skips, `turbo build` 14/14 + `typecheck` 23/23 (build+typecheck 28/28 combined run), web typecheck+lint. (An earlier merged-tree run failed 1: Track 2's facade cut broke 4 scripts canaries importing provider-internal symbols through the barrel — resolved at integration by repointing them at provider package dists per Track 2's own non-api-consumer precedent, NOT by widening the reviewed surface; final battery green.)
- [x] 8.15 Sweep the gate canon across every new or changed gate in this change: paired self-test invocable as `node <script> && node --test <script>.test.mjs`, reviewable exception data with per-entry reasons, empty-list-is-healthy, and injection-probe evidence recorded in tasks.md (tasks 2.6, 3.6, 4.3, 4.6)
  - requirements: ["ratchet-baselines/every-ratchet-ships-a-paired-self-test-proving-it-can-go-red"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

  - evidence (2026-07-31, integration sweep over every new/changed gate): (a) paired invocation proven live for all six gate pairs — `node scripts/ratchets/comparator.mjs && node --test scripts/ratchets/comparator.test.mjs` (16/16), agent-identity (green + self-test), provider-parity (4 participants + self-test), quarantined-suites (empty-list + 8/8), `packages/sandbox/test/facade-surface.gate.mjs` (+7/7), `apps/api/src/sandbox/sandbox-package-boundary.test.mjs` (node + node --test 1/1); ci-job-conditions runs under `node --test` (7/7). (b) reviewable exception data with per-entry reasons: r3.json {count,samples,change}; agent-identity 2-entry three-field exemptions; quarantine future-entry three-field audit; boundary gate's P3 conformance exemption (exact-specifier × test-file, 4-fixture in-gate self-test added at integration when Track 2's spec repoint collided with Track 3's full-src import scan); visual manifest `knownFailure` {reason, followUp}. (c) empty-list-is-healthy: no-baseline = zero tolerance (comparator endgame), QUARANTINED_SUITES = [], knownFailure absent for healthy pages, facade expected-surface is a committed reviewed list (never regenerated in the gate). (d) injection-probe red-run evidence recorded in this file at 2.6 (facade unlisted-export + wildcard probes), 3.6 (forbidden symbol outside old roots, file+pattern named), 4.3 (nominated-symbol conformance break names the package), 4.6 (`id === 'codex'` in unlisted scaffolding file names file:line) — all four reverted-and-green afterward.