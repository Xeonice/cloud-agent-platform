# Verification Report — deflake-environment-dependent-suites

Date: 2026-08-01
Routing pass: three-way (UNMET / SPEC-DEFECT / MET), per opsx-verify. Each raw finding was
re-traced against the working tree before adjudication; nothing was rubber-stamped from the
skeptic's text.

## Tally

- Reopened as code tasks (UNMET): 0
- Spec defects routed to design.md Open Questions: 0
- Blocking spec defects (public impact / false exclusions): 0
- Reclassified MET (survived independent dynamic refutation): 2
- Mandatory public findings: none (machine-routed list was empty)

## Reclassified MET

### test-suite-discovery/time-budget-tests-control-time-through-stubs-existing-seams-or-deterministic-synchronization-points

Requirement: "Time-budget tests control time through stubs, existing seams, or deterministic
synchronization points" (spec.md:54). Risk=high (tasks span Track 1 deflake-aio-ownership and
Track 2 deflake-boxlite-client).

Re-trace (this routing pass, against the current tree):

1. Shared Date.now stub helper: `withManualReleaseClock(startedAt, run)` defined at
   `packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs:417`
   (try/finally restores the real clock), consumed at 10 call sites (:1279, :1422, :1543,
   :1888, :2001, :2339, :2374, :2856, :3428 among them), covering all four formerly
   tight-margin wall-clock assertions. `grep -n "Date.now()"` over the whole file returns
   zero matches — no test still reads the real clock.
2. The two AIO race cases are synchronization-point driven, not real-time budgets: the former
   `sent`-undefined case awaits explicit `missingSocketCreation`/`echoSocketCreation`
   promises under the frozen clock; the staged-ACK case awaits an
   `ackObservationWindowClosed` promise resolved from a hooked `socket.close` before any ACK
   assertion, with order-sensitive `assert.deepEqual` on `expectedAckRequests` justified by
   the product state machine's (`sendNextInputFrame`/`maybeAdvanceInput`) staged-emission
   guarantee.
3. BoxLite budget test drives the pre-existing seam: `execWithPoll` forwards
   `options.deadlineDriver` as `nativeExecutionDeadlineDriver`
   (`packages/sandbox-provider-boxlite/test/boxlite-client.test.mjs:689-691`); the seam
   pre-exists in product source (`src/boxlite-client.ts`) and
   `git diff --stat -- packages/sandbox-provider-boxlite/src packages/sandbox-provider-aio/src`
   is empty — no new seam was added, no product change. `grep -n "setTimeout\|Date.now"` over
   the boxlite test file returns zero timing matches; the former 1ms real-clock test is gone.
4. Both classification exits pinned separately: poll-budget exhaustion asserts
   `error.settlement === 'indeterminate'` (test.mjs:827); synchronous deadline pre-check
   asserts `error.settlement === 'timeout'` with zero poll requests (test.mjs:855),
   proving the pre-check path never enters the polling loop.

Dynamic refutation (skeptic, refuted=false): an independent standalone test written from
scratch against the built product module (`packages/sandbox-provider-boxlite/dist/index.js`)
drove the `nativeExecutionDeadlineDriver` seam with a fully synthetic clock and pinned both
classification exits ('indeterminate' via poll-budget exhaustion, 'timeout' via pre-check
with zero polls). 5/5 consecutive runs green, each subtest resolving in ~1ms — no real
wall-clock margin raced. Verdict: MET.

### test-suite-discovery/a-deflake-fix-is-proven-by-reproduction-before-and-repetition-after-under-contention

Requirement: "A deflake fix is proven by reproduction before and repetition after, under
contention" (spec.md:157). Risk=high (evidence jointly produced by Tracks 1-3, aggregated by
Track 4 in the shared tasks.md Evidence section).

Re-trace (this routing pass, against the current tree):

1. tasks.md Evidence section (`openspec/changes/deflake-environment-dependent-suites/tasks.md`,
   § Evidence, entries at :114 F.2 / :166 F.3 / :220 F.4) records for each flake: CI run/job
   ID, root cause, local reproduction mechanism, and post-fix repetition counts.
   - F.2: run 30671722240 / job 91290662215 (`TypeError: ... 'sent'` at former test line
     1856); pre-fix repro 6/12 failures under a 32-busy-loop contention substitute; post-fix
     24/24 reps (12 @32 + 12 @64 burners).
   - F.3: run 30670136646 attempt 1 / job 91285916348 (`settlement is timeout` at former
     line 795); pre-fix repro under docker `--cpu-period=10000 --cpu-quota=1000` at
     iteration 6/12; post-fix 10/10 reps under the identical cgroup recipe.
   - F.4: run 30672743633 / job 91293747038 (test 39, `uncaughtException` / `write EPIPE`);
     reproduction via deterministic adversarial simulation (SIGKILL + blocked event loop) —
     a spec-sanctioned exception (spec.md:192 and design.md D6 explicitly authorize the
     deterministic simulation for F.4 over probabilistic contention); post-fix 10/10 reps of
     the full conformance suite.
   All three CI run/job IDs, failure texts, and line numbers were independently verified in
   the original verify pass via live `gh api` calls against real GitHub Actions history.
2. Fix artifacts present: `guardGeneratedPrivateGitWriteStream` (whitelist EPIPE/ECONNRESET
   only, `packages/sandbox-conformance/src/generated-private-git-fixture.ts:24-25,37`)
   attached at both acquisition points (:710 CGI ServerResponse, :904 child.stdin);
   `withManualReleaseClock` (aio) and `deadlineDriver` seam usage (boxlite) as above.
3. Registry closure corroborates: `docs/refactor/04-rules-registry.md` flips F.2 (:125),
   F.3 (:152), F.4 (:172) to 已解决（resolved）, each naming this change.

Dynamic refutation (skeptic, refuted=false): an independently written contention harness
spawned 20 CPU busy-loop processes on a 10-core host (verified ~60% CPU each — real
oversubscription) and ran the real CI entry command
(`node --test --test-force-exit test/boxlite-client.test.mjs`) for 10 consecutive
repetitions: 10/10 exited 0 with pass=1 fail=0, zero failures — directly satisfying the
scenario's "at least 10 consecutive repetitions with zero failures" under contention, as an
independent ground-truth run rather than a re-read of tasks.md's own claims. Verdict: MET.

## Gap findings (requirements vs. diff)

Based on review of the spec against the actual diff (`git diff --stat` shows exactly the 5
files the spec references: `docs/refactor/04-rules-registry.md`,
`packages/sandbox-conformance/src/generated-private-git-fixture.ts`, and the three test
files), every requirement has a traceable implementation:

- **environment-dependent-suite-failures-are-resolved-at-root-cause-never-contained**:
  `QUARANTINED_SUITES = []` confirmed empty (scripts/quarantined-suites.mjs:52), no retry
  loops added, only `src/generated-private-git-fixture.ts` touched (aio/boxlite `src/`
  untouched).
- **time-budget-tests-control-time-through-stubs-existing-seams-or-deterministic-synchronization-points**:
  `withManualReleaseClock` helper present in the aio test file (10 call sites incl. the 4
  required assertions); `nativeExecutionDeadlineDriver` wired through `execWithPoll` in the
  boxlite test file with separate `'indeterminate'`/`'timeout'` assertions.
- **fixture-write-paths-tolerate-whitelisted-disconnect-errors-while-preserving-failability**:
  `guardGeneratedPrivateGitWriteStream` exported and attached at acquisition time to both
  `child.stdin` and the CGI `ServerResponse`, whitelisting only `EPIPE`/`ECONNRESET`.
- **a-deflake-fix-is-proven-by-reproduction-before-and-repetition-after-under-contention**:
  `tasks.md` Evidence section contains, for F.2/F.3/F.4, CI run/job IDs, root cause, local
  reproduction commands, and post-fix repetition counts.
- **registered-flake-entries-flip-to-resolved-with-the-fix**:
  `docs/refactor/04-rules-registry.md` diff flips all three F.2/F.3/F.4 entries from
  "留痕，不修" to "已解决（resolved）… 由 deflake-environment-dependent-suites 修复".

No requirement lacks a traceable implementation. Gap defect list: `[]`

## Scope findings

Scope defect list: `[]` — no out-of-scope changes detected; the diff is confined to the
three target test suites, the whitelisted fixture source file, and the registry doc.

## Verdict

PASS. Zero reopened tasks, zero spec defects, zero blocking spec defects. Both high-risk
requirements survived independent dynamic refutation and are reclassified MET. Archive is
not gated by this pass.
