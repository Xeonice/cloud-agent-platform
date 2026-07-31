# Design — close-gate-blindspots-and-ci-hygiene

## Context

The 2026-07-28~30 series turned written rules into executable gates, but measured on
`main` @ `fb43e5a` the gates themselves have blind spots: the symbol ban walks 2 roots
while its sibling import ban walks all of `apps/api/src` (a full-scope simulation finds
6 violating files the gate cannot see); two gates enumerate their own scan surface by
hand (3 hardcoded parity dirs, 10 listed scaffolding files) — exactly the failure mode
wire-orphaned's design rejected; the `packages/sandbox` facade is 19 `export *` lines
leaking every provider internal (registered P7 "no mechanism"); and CI carries
explicitly deferred debts (contradictory boot-smoke comments, zero-consumer
`coverage:sandbox`, two complete-but-unwired web lanes, a dead `turbo.json` reference,
3 quarantine entries whose owning change never started).

Two hard constraints frame every decision below:

- **CI is never knowingly red** (series-wide ordering discipline: measure → absorb 存量
  → expand, gate lands last).
- **Check display names are a consumed attestation API** — release.yml queries
  check-runs by name before attesting — so no rename, no context change, only
  registration of drift (master-plan 总则2).

There is no in-repo ratchet prior art (`scripts/ratchets/` absent, archive grep zero
hits), but all component parts of a gate — reviewable exception data with reasons,
paired self-test, empty-list-is-healthy, CI wiring — have canon fixed across three
archived changes. Reference: `research-brief.md` for the measured evidence.

## Goals / Non-Goals

**Goals:**

- A reusable shrink-only ratchet mechanism (`scripts/ratchets/` + one shared comparator)
  that later phases (R7/R11/S2) consume unchanged.
- R3: symbol ban expanded to all of `apps/api/src`, 存量 carried by the first ratchet
  baseline; `sourceBoundaryRoots` becomes manifest-driven (S3) in the same PR.
- R4: both enumerating gates converted to discovery (capability glob / complement scan),
  fail-closed on zero matches.
- R6: facade surface becomes an explicit reviewed whitelist with a surface gate that
  cannot self-attest; 6 zero-reference stubs deleted with proof; `./testing` devDep
  leak 归位.
- CI hygiene with "fix" and "observe" strictly split; the stateful boot-smoke variant;
  both dormant web lanes wired (green, non-required); quarantine list back to empty.
- Every new/changed gate ships the canon shape plus an injection probe proving it can
  go red.

**Non-Goals:**

- Renaming any check display name or required context (later coordinated
  release.yml + branch-protection change).
- Flipping branch-protection required flags from the codebase (registered manual
  GitHub steps, per twice-codified convention).
- 7a 根治 of the ratcheted dockerode files (port-化 owned by phase 7a) — this change
  only tolerates and tracks them.
- R7/R11/S2 ratchets (later phases; they reuse the comparator built here).
- Fixing the pre-existing aio-terminal-session-ownership wall-clock flake (record,
  never retry-to-hide).

## Decisions

### D1. Ratchet semantics: strict fail-on-stale, count-keyed, build-not-buy

**Choice**: ESLint-bulk-suppressions-style strict semantics — measured count ABOVE
baseline is red (new violation), measured count BELOW baseline is equally red (stale
entry must shrink in the same PR), zero deletes the file, a zero-total baseline is
itself a failure. Entries are `{count, samples[], change}`; comparison keys on COUNT
only — samples are documentation, so entries survive refactors that move code without
changing the violation count.

**Alternatives rejected**:
- *ArchUnit-style auto-reduce* (silently accept lower counts): violates the 元规则
  fail-closed bias and 04§D's "<baseline requires same-PR update" contract; a fixed
  violation could silently regrow up to the stale ceiling.
- *Adopt Betterer / dependency-cruiser instead of building*: the existing gate checks
  symbols (regex over stripped source), not just imports — no off-the-shelf tool
  replaces it. We borrow dependency-cruiser's baseline-JSON shape and Betterer's
  documented "=0 deletes the file" endgame, nothing else.
- *Line-number or path-keyed entries*: break on every unrelated refactor, inviting
  baseline churn that reviewers rubber-stamp.

The comparator is one small shared module under `scripts/ratchets/`; gates MUST NOT
re-implement the comparison loop (spec requirement, enforced by review + the
comparator's own self-test).

**Accepted trade-off**: count-keying cannot distinguish "one fixed + one new" at the
same total. Mitigation: the gate's failure output always names measured violating
files, `samples[]` give reviewers an anchor, and any count *change* forces a baseline
edit that lands in the reviewed diff.

### D2. R3 ordering and the 6th-file question

**Choice**: measure-存量 → commit baseline → expand scope, strictly in that order —
the expansion applies the existing `forbiddenSourcePatterns` loop to the full-src walk
the import ban already performs (a scope change to one loop, not a new gate). The
baseline is re-measured at change start per 工件07§E; the live count is 6, not the
artifact's 5.

For the 6th file (`codex-device-login-runner.ts:26`, a user-facing copy string tripping
the env-family regex): **prefer eliminating the false positive over baselining it** —
first try rewording the copy string; if the wording is load-bearing, refine the regex
with a targeted negative (and prove the refinement still catches the real 存量 via the
self-test). Baseline-6 is the fallback only if both fail. Rationale: baselines exist to
carry *real* debt with an owner; a false positive baselined as debt has no owner and no
7a exit path.

The same PR makes `sourceBoundaryRoots` manifest-driven (S3), so phase-6 moves change
data, not the gate.

### D3. R4 discovery: capability glob, not name glob; complement scan, not allowlist

**Parity check**: participation is discovered by **capability** — recursively, any
package whose tests build conformance (import `@cap-console/sandbox-conformance`) —
NOT by the task's literal `packages/sandbox-provider-*` name glob, which would silently
drop `packages/sandbox-cloud-http` today. Discovery is recursive (current
`listTestFiles` is a non-recursive `readdirSync`), and zero matches = exit 1 (current
missing-dir → `[]` is a silent pass, violating 元规则 A.3).

**Agent-identity check**: inverted from a 10-entry scaffolding allowlist to a
complement scan over everything, keeping only the 2-entry runtime-implementation
exemption (`codex-runtime.ts`, `claude-code-runtime.ts`). New hits get a fix or a
three-field exemption (quarantine-style: reason, owner, evidence).

**Alternative rejected** (word-for-word precedent, wire-orphaned design): "keep the
list + add a completeness lint" — preserves the failure mode (a manually edited list)
and adds a second thing to forget. The fail-closed complement-scan template already
exists in `scripts/test-discovery-check.mjs`.

### D4. R6 surface gate: explicit whitelist + independent measurement, 7a debt carried

**Choice**: replace the 19 `export *` lines with named exports (the whitelist IS the
index.ts), guarded by a surface gate in `packages/sandbox/test/`. Two candidate gate
shapes, decided at implementation by one criterion: the whitelist data and the measured
surface MUST NOT reference each other (the converge-contracts self-attestation blind
spot — a gate that derives "expected" from the artifact it checks always passes):

- (a) snapshot test: reviewed expected-surface list in the test, compared against the
  actual module namespace at runtime;
- (b) type-level total map (`Record<K,V>` + `satisfies`, proven in-repo by parity):
  stronger — omissions and renames become compile errors in untouched files — preferred
  if the surface is expressible as a closed vocabulary.

The whitelist MUST initially carry the provider symbols the R3-baselined `apps/api`
files consume through the barrel (taskless probe, validator →
AioSandboxContainerController, BoxLiteRestClient, readBoxLiteProviderConfig,
AioDockerClient), each annotated as phase-7a debt — otherwise R6 lands red, violating
"never knowingly red". R3 and R6 are coupled through exactly these files.

**Stub deletion**: the 6 forwarding files are pure re-export stubs with zero importers
(grep-proven; the exports map cannot even resolve them, though `files: src/` ships them
in the tarball). Delete with a retire-superseded-style zero-reference-proof task; the
R3 baseline must be measured AFTER deletion so it cannot absorb dead files as 存量.

**`./testing` 归位**: prefer having the two `apps/api` spec files import
`@cap-console/sandbox-conformance` directly (P3 already permits devDep conformance for
tests, and `apps/api` already devDeps it) over promoting conformance to a real
dependency of sandbox — promotion would put test-fixture code on the production
dependency graph to preserve one convenience re-export. `testing.ts` then shrinks or
disappears.

### D5. CI hygiene: fix reality, register drift, wire-or-delete by evidence

- **boot-smoke comment contradiction**: resolved in favor of reality — the job is
  conditioned via `needs: changes`, therefore CANNOT be a required check as-is; the
  "REQUIRED STATUS CHECK" comment block is corrected, not the workflow semantics.
- **Context-name drift** ("typecheck + lint" vs "typecheck + lint + test"): REGISTER
  only. Names are queried by release.yml's attestation steps; any rename is a later
  coordinated change touching release.yml + branch protection together.
- **`test:cors-headers`**: one named CI step, so the gate is a visible check instead of
  riding the `test:scripts` glob indirectly.
- **`coverage:sandbox`**: measured zero consumers (no workflow, Makefile, lint-staged).
  Decision rule per 总则4: run it once at change time — if green as-is, wire it as a
  named non-required step; if red (a `--100` gate over 5 packages that nobody has run
  is likely stale), delete the script and record the deletion. No third option
  (keeping an unwired script) exists.
- **`turbo.json` dead reference**: point `globalDependencies` at
  `packages/tsconfig/**/*.json` (the real shared config location) — closing the
  wire-orphaned → retire-superseded deferral chain (履约, not drive-by).
- **`apps/api` tsconfig hookup**: a new nest preset in `packages/tsconfig`
  (commonjs + `emitDecoratorMetadata`/`experimentalDecorators`) — no existing preset
  is a drop-in, and extends+override in the app would leave the next Nest app to
  re-derive the same overrides.

### D6. Stateful boot-smoke: extend the script, add a second conditioned job

**Choice**: extend `scripts/boot-smoke.sh` with a flagged pre-seed step (insert an
in-flight running task row before boot, assert the restarted process re-adopts it) and
run it as a **second conditioned job** copying the existing throwaway-Postgres service
pattern — rather than mutating the existing job. Rationale: the clean-boot job's
green history and conditioning stay untouched (no context change), and the new job
gets its own name from birth so it can later be marked required without a rename.
The new job enters `ci-job-conditions.test.mjs` CONDITIONED **in the same PR**, or
that gate goes red — this is the one place where two files must move atomically.

This closes the survive-api-redeploy bug class that clean-boot smoke and unit fakes
both provably missed (the boot re-adoption scan runs against zero task rows today).

### D7. Web lanes: pin the rendering environment before wiring

Both `test:visual` and terminal-stories are complete harnesses wired into no workflow.
They are wired only AFTER pinning a Playwright Docker image for the runner — the
baselines were generated on macOS and will flake on unpinned Linux runners; baselines
are treated as reviewed source (re-generation is a reviewed diff, `sync-design-baseline
--check` guards drift). The two lanes keep their deliberately separate configs (visual
masks live terminal content; terminal-stories must not). Both follow the twice-codified
convention: run green as non-required first; marking required is a registered manual
GitHub step.

### D8. Quarantine takeover: inherit the diagnosis, evidence from GitHub runners

The 3 entries transfer ownership to this change. The recorded diagnosis is inherited —
the 4 rejected install-preflight hypotheses are NOT re-run; the first step is teaching
install-preflight to emit diagnostics (it currently prints PASS/FAIL with zero
context), and all evidence comes from GitHub runners, not local runs (17/48 failures
were runner-only). Acceptance = the list back to empty ("the healthy state") AND
`quarantined-suites.test.mjs` proving the mechanism on the empty list.

### D9. Gate canon and injection probes

Every new or changed gate ships: paired self-test (`node script && node --test
script.test.mjs`), reviewable exception data with per-entry reasons,
empty-list-is-healthy — plus one injection-probe task each (R3 expansion, R4 glob, R6
surface gate): inject a violation, observe red, revert, record evidence in tasks.md
(the parity 5.5 template).

### D10. This PR is the scope-agent-context task 3.4 vehicle

The PR touches backend paths (scripts/ + ci.yml) and deliberately includes a docs-only
comparison point, so the paths-filter is observed from both sides (run and skip) with
runner-minutes recorded against the 3.4min prediction. This is a property of the PR
composition, not a code decision — tasks.md must carry it so it survives into evidence.

## Risks / Trade-offs

- [Baselines legitimize debt] → shrink-only + per-entry `change` ownership + zero
  deletes the file; the R3 entries are explicitly annotated "阶段 7a 端口化根治" so
  the exit path is owned, not aspirational.
- [Count-keyed entries can mask a same-count swap] → accepted for refactor-survival;
  gate output names measured files, samples anchor review (D1).
- [R6 whitelist lands red because api files consume leaked symbols] → whitelist carries
  those symbols as annotated 7a debt from day one (D4); R3/R6 coupling is sequenced so
  neither gate observes the other mid-transition.
- [Sidecar/verification mismatch — the converge-contracts NOT-ARCHIVABLE cause] →
  surface posture is 全部 internalOnly + workflow-gates, which holds only because
  nothing touches public runtime surface; the sidecar is checked face-by-face against
  the diff at verify, and every declared lane must actually run.
- [Wiring more CI exposes pre-existing flakes (aio-terminal-session-ownership
  wall-clock)] → triage three-ways (product defect / stale harness /
  environment-dependent) as an explicit task; record, never retry-to-hide.
- [Visual baselines flake on Linux] → pinned Playwright Docker image is a hard
  prerequisite of wiring (D7); lane stays non-required until proven green.
- [`ci-job-conditions` gate goes red when the stateful job lands] → same-PR atomic
  update of CONDITIONED (D6); the gate's identical-expression assertion is the
  enforcement.
- [Quarantine diagnosis burns time re-proving known dead ends] → rejected-hypothesis
  list inherited as data; first action is diagnostics, not hypotheses (D8).

## Migration Plan

Ordering discipline: every gate lands green; scope expansions are
measure → baseline → expand; independently revertible steps.

1. Comparator + `scripts/ratchets/` mechanism with self-test (no consumer yet — green
   by construction).
2. R6 stub deletion (zero-reference proof) and `./testing` 归位 — BEFORE R3
   measurement, so the baseline cannot absorb dead files.
3. R3: re-measure 存量 → resolve the 6th-file false positive → commit baseline →
   expand scope + manifest-driven roots → injection probe.
4. R6: named whitelist (carrying 7a-annotated provider symbols) + surface gate +
   injection probe.
5. R4: parity glob discovery + complement scan conversion + injection probes.
6. CI hygiene batch (comment fix, cors-headers step, coverage:sandbox wire-or-delete,
   turbo.json, tsconfig preset) — each independently revertible.
7. Stateful boot-smoke job + same-PR CONDITIONED update.
8. Web lanes (pin image → wire → prove green, non-required).
9. Quarantine clearing (diagnostics-first, GH-runner evidence) → empty list.
10. Flip 工件04 C-table rows (G2/G3/G11; R3/R4/R6 landed) + 工件02 S3/P7 updates as
    acceptance.

**Registered manual follow-ups (GitHub settings, not codebase)**: marking stateful
boot-smoke / visual lanes required; any future context rename (coordinated with
release.yml). **Rollback**: each gate/lane is a separate commit; reverting one does not
strand another — except D6's two-file pair, which reverts together.

## Open Questions

- R6 gate shape — snapshot test vs type-level total map: decided at implementation by
  whether the facade surface is expressible as a closed vocabulary (D4 criterion is
  fixed either way: no self-reference between whitelist and measurement).
- The 6th-file resolution (reword vs regex refinement) — decided at task time by
  whether the copy string's wording is load-bearing; baseline-6 only as fallback (D2).
- `coverage:sandbox` wire-vs-delete — decided by one measured run at change time (D5);
  both outcomes are terminal states, neither is deferral.
