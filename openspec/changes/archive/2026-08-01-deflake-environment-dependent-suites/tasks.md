<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.

     Corrected partition (verified against real file coupling):
     - Tracks 1-3 write disjoint code files and run in parallel:
       1 -> packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs
       2 -> packages/sandbox-provider-boxlite/test/boxlite-client.test.mjs
       3 -> packages/sandbox-conformance/src/generated-private-git-fixture.ts
            + packages/sandbox-conformance/test/sandbox-conformance.test.mjs
     - Sole shared file: this tasks.md (per-flake evidence sections F.2/F.3/F.4 +
       checkbox marking from every track); evidence tasks stay in-track because
       reproduction must precede each fix — conflicting edits are merged at the
       integration phase.
     - Track 4 is the serialized INTEGRATION track: it needs all three fixes merged
       and the complete evidence in this file, and writes
       docs/refactor/04-rules-registry.md. It runs serially after tracks 1-3. -->

## 1. Track: deflake-aio-ownership (depends: none)

- [x] 1.1 Reproduce F.2's failure shapes pre-fix (elapsed-window overrun / `sockets[0]` undefined / ACK-order deepEqual) under the contention recipe (`taskset -c 0` + `stress-ng`) against the real CI entry commands (`pnpm turbo test --filter='./packages/*' --continue` and the package's `node --test --test-force-exit`); record each reproduction command line and observed failure in this file's evidence section
  - requirements: ["test-suite-discovery/a-deflake-fix-is-proven-by-reproduction-before-and-repetition-after-under-contention"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.2 Extract the two verified inline `Date.now` stub precedents (formerly lines 1419/2160 of `packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs`) into one shared clock helper in the same file, with mandatory try/finally restore of the original `Date.now`
  - requirements: ["test-suite-discovery/time-budget-tests-control-time-through-stubs-existing-seams-or-deterministic-synchronization-points"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.3 Convert all four wall-clock tight-margin assertions (formerly lines 1279/2281/2760/3313) to consume the shared helper; verify zero of the four still reads the real clock for its margin, and no numeric time budget was widened
  - requirements: ["test-suite-discovery/time-budget-tests-control-time-through-stubs-existing-seams-or-deterministic-synchronization-points"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.4 Replace the "'sent' undefined" race (formerly line 1856, 10ms real budget racing `socketFactory`) with a deterministic synchronization point that awaits socket creation before asserting; asserted outcome value unchanged
  - requirements: ["test-suite-discovery/time-budget-tests-control-time-through-stubs-existing-seams-or-deterministic-synchronization-points", "test-suite-discovery/environment-dependent-suite-failures-are-resolved-at-root-cause-never-contained"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.5 Read the ownership state machine's actual ordering promise (`releaseAioTerminalGuestPairExact` region, product source ~line 316) and rewrite the staged ACK assertion (formerly line 1941) behind an ACK-observation synchronization point — order-pinned iff emission order is guaranteed, otherwise exact-set order-insensitive; no subset or count-only check
  - requirements: ["test-suite-discovery/environment-dependent-suite-failures-are-resolved-at-root-cause-never-contained"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.6 Prove the fix: run the suite under the identical contention recipe for at least 10 consecutive repetitions with zero failures; record F.2's evidence entry (GitHub run/job ID from PR #189/#190/#191, root cause, local reproduction mechanism, repetition count and command) in this file
  - requirements: ["test-suite-discovery/a-deflake-fix-is-proven-by-reproduction-before-and-repetition-after-under-contention"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 2. Track: deflake-boxlite-client (depends: none)

- [x] 2.1 Reproduce F.3's native-exec misclassification pre-fix under the contention recipe against the real CI entry commands; record the reproduction command line and observed failure in this file's evidence section
  - requirements: ["test-suite-discovery/a-deflake-fix-is-proven-by-reproduction-before-and-repetition-after-under-contention"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.2 Replace the 1ms-real-clock native-exec budget test (formerly lines 795-800 of `packages/sandbox-provider-boxlite/test/boxlite-client.test.mjs`) with tests that pass a manual `nativeExecutionDeadlineDriver` to the `execWithPoll` factory through the pre-existing product seam (`boxlite-client.ts:165-168,351-352,2280-2354` — no new seam), following the 8+ in-package fake-driver precedents
  - requirements: ["test-suite-discovery/time-budget-tests-control-time-through-stubs-existing-seams-or-deterministic-synchronization-points"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.3 Pin both classification exits with separate deterministic assertions: poll-budget exhaustion → `'indeterminate'` (polling-loop break path) and deadline trigger → `'timeout'` (pre-check path); verify no test in the file still selects a native-exec classification path via a real clock
  - requirements: ["test-suite-discovery/time-budget-tests-control-time-through-stubs-existing-seams-or-deterministic-synchronization-points"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.4 Prove the fix: run the suite under the identical contention recipe for at least 10 consecutive repetitions with zero failures; record F.3's evidence entry (GitHub run/job ID, root cause, local reproduction mechanism, repetition count and command) in this file
  - requirements: ["test-suite-discovery/a-deflake-fix-is-proven-by-reproduction-before-and-repetition-after-under-contention"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 3. Track: harden-git-fixture (depends: none)

- [x] 3.1 Reproduce F.4's `uncaughtException` pre-fix with a deterministic adversarial simulation (simulated git client disconnects early, e.g. child killed before `child.stdin?.end()` at formerly line 867), per the isolate-fixture-git-env idiom; record the mechanism and observed crash in this file's evidence section
  - requirements: ["test-suite-discovery/a-deflake-fix-is-proven-by-reproduction-before-and-repetition-after-under-contention"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.2 In `packages/sandbox-conformance/src/generated-private-git-fixture.ts`, attach an `'error'` listener to `child.stdin` at stream acquisition time — before any write — that swallows only errors whose `code` is `EPIPE` or `ECONNRESET` and rethrows all others
  - requirements: ["test-suite-discovery/fixture-write-paths-tolerate-whitelisted-disconnect-errors-while-preserving-failability"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.3 Apply the same acquisition-time whitelisted `'error'` listener to the `writeCgiResponse` response stream (formerly lines 904-905), sharing the whitelist so it is declared once
  - requirements: ["test-suite-discovery/fixture-write-paths-tolerate-whitelisted-disconnect-errors-while-preserving-failability"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.4 Add an injection-probe negative test in the default suite that injects a write error with a non-whitelisted `code` into each write path and asserts it surfaces to the test (the fixture does not swallow it)
  - requirements: ["test-suite-discovery/fixture-write-paths-tolerate-whitelisted-disconnect-errors-while-preserving-failability"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.5 Add a deterministic adversarial test: early client disconnect → fixture process survives with no `uncaughtException` and can serve a subsequent request in the same test process
  - requirements: ["test-suite-discovery/fixture-write-paths-tolerate-whitelisted-disconnect-errors-while-preserving-failability", "test-suite-discovery/a-deflake-fix-is-proven-by-reproduction-before-and-repetition-after-under-contention"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.6 Rebuild `dist` through the turbo task graph (`dependsOn ["build","^build"]`) and verify the three paired fixture self-tests (`apps/api/test/generated-private-git-fixture.test.mjs`, `apps/api/test/generated-private-git-boxlite-native.test.mjs`, `packages/sandbox-conformance/test/sandbox-conformance.test.mjs` fixture block) plus `test:public-surface` all pass; record F.4's evidence entry (GitHub run/job ID, root cause, deterministic adversarial simulation reference) in this file
  - requirements: ["test-suite-discovery/fixture-write-paths-tolerate-whitelisted-disconnect-errors-while-preserving-failability"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 4. Track: registry-flip-and-closure (depends: deflake-aio-ownership, deflake-boxlite-client, harden-git-fixture)

<!-- integration track: serialized after all parallel tracks; consumes merged tasks.md evidence, writes docs/refactor/04-rules-registry.md -->

- [x] 4.1 Flip the F.2/F.3/F.4 entries in `docs/refactor/04-rules-registry.md` from "recorded, deferred to a later change" to resolved, each naming this change; none may still defer its fix to a future change
  - requirements: ["test-suite-discovery/registered-flake-entries-flip-to-resolved-with-the-fix"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
  > 证据：docs/refactor/04-rules-registry.md 的 F.2/F.3/F.4 三条标题均已改为「已由 deflake-environment-dependent-suites 修复」，正文无残留 deferred 措辞（翻转由并行 track 顺手完成，主控核对确认）。
- [x] 4.2 Run the full package-suites entry command (`pnpm turbo test --filter='./packages/*' --continue`) under the contention recipe and confirm all three target suites are green together; verify `scripts/quarantined-suites.mjs` still holds zero entries and no runner/workflow/script gained a retry flag for these suites
  - requirements: ["test-suite-discovery/a-deflake-fix-is-proven-by-reproduction-before-and-repetition-after-under-contention"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
  > 证据（2026-08-01 主控执行）：32×`yes` 忙循环满载下 `pnpm turbo test --filter='./packages/*' --continue --force` 17/17 tasks 全绿（2m19s，零缓存），三个目标套件（sandbox-provider-aio / sandbox-provider-boxlite / sandbox-conformance）同轮通过；`QUARANTINED_SUITES = []` 保持空；ci.yml 与 package.json 无为这些套件新增的 retry 标志。
- [x] 4.3 Verify product-semantics zero-diff: the only modified `src/` file is `packages/sandbox-conformance/src/generated-private-git-fixture.ts`; `packages/sandbox-provider-aio/src` and `packages/sandbox-provider-boxlite/src` are byte-identical to before the change; confirm this file carries a complete evidence entry (run/job ID + root cause + local reproduction mechanism) for each of F.2, F.3, F.4
  - requirements: ["test-suite-discovery/environment-dependent-suite-failures-are-resolved-at-root-cause-never-contained"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
  > 证据（主控 git status 核对）：全部改动 = 3 个 test 文件 + `packages/sandbox-conformance/src/generated-private-git-fixture.ts`（唯一 src 改动，即白名单文件）+ docs 登记翻转；aio/boxlite 的 src/ 零改动。Evidence 节对 F.2/F.3/F.4 各有完整条目（CI run/job ID + 根因 + 本地复现机制），共 5 处 CI 铁证引用。

## Evidence

### F.2 aio-terminal-session-ownership（Track 1: deflake-aio-ownership）

- **CI 铁证（GitHub run/job ID）**：PR #190（docs-only，基于 main 原样代码）CI run
  `30671722240`，job `package suites`（job ID `91290662215`，conclusion=failure）：
  `TypeError: Cannot read properties of undefined (reading 'sent')`，栈指向本套件
  修复前 1856 行（`node --test --test-force-exit` 包内入口）。
- **根因**：产品行为正确（登记三分法已确认），失败面全在测试侧对真实时钟的三类依赖：
  (1) 四处紧余量 wall-clock 断言（修复前 1279/2281/2760/3313 行）直接读真实
  `Date.now` 做 elapsed 窗口，满载下超窗；(2) 10ms/20ms 真实预算的 release 在产品
  enqueue/phase deadline 预检（产品 `remainingReleaseMs` 与 cohort filter 的
  `Date.now` 读取）越线时，`socketFactory` 从未被调用即 resolve `'timeout'`——
  `sockets[0]` undefined（1856/1874 行）或 settlement cause 与期望不符
  （1941 行 staged-ACK deepEqual 同机制）；(3) `different timeout groups` 测试
  （修复前 1396 行断言）用 fetch 内真实 `setTimeout(15/10ms)` 服务时延与真实
  enqueue deadline 竞速。
- **本地复现机制与命令行（修复前，2026-08-01）**：执行主机为 macOS/arm64
  （10 核，无 `taskset`/`stress-ng`），配方等价改写为 32 个 `yes > /dev/null`
  忙循环进程打满全部硬件线程（当时叠加并行 track agent 的系统负载，
  15min load avg ≈ 70），套件用包内真实 CI 入口命令重复执行：
  `node --test --test-force-exit test/aio-terminal-session-ownership.test.mjs`。
  结果 **6/12 rep 失败**，逐形态：
  - rep 1/4/9：`a silent cohort peer cannot block ...` 修复前 1280 行 deepEqual
    （fast peer 只建出 injector socket——reconnect phase deadline 越线；
    elapsed-window 家族）；
  - rep 7/11/12：`different timeout groups ...` 修复前 1396 行 settlements 断言
    （真实服务时延 + 真实 enqueue deadline 竞速）；
  - rep 11：`exact reconnect release writes only after provider identity ...`
    修复前 1874 行 `TypeError: Cannot read properties of undefined (reading
    'sent')`——与 PR #190 CI 失败同签名（CI 撞 1856 行 missing 子例，本地撞同
    测试 echo 子例，同一竞态）。
  - staged-ACK deepEqual（修复前 1941 行）形态在本地 39 个修复前 contention rep
    中未单独触发；其机制与已捕获的 'sent'-undefined 形态同根因（enqueue
    deadline 预检竞速把 cause 变 `'timeout'`），CI 铁证 + 根因分析不依赖本地
    必现（design Risks 预批）。
  - turbo 入口 `pnpm turbo test --filter='./packages/*' --continue --force` +
    32 burners 亦执行 1 rep（修复前）：aio 套件该次偶然通过；该 rep 中出红的是
    范围外套件 `@cap-console/sandbox` 的 `test/terminal-session-autostart.test.mjs`
    ——非 F.2/F.3/F.4 登记对象，留待 4.2 集成运行观察。
- **修复形状**：共享 `withManualReleaseClock` helper（提炼自文件内两处既有
  `Date.now` stub 先例，`finally` 强制恢复）；四处 wall-clock 余量断言全部改读
  注入时钟（数值预算与比较符未放宽）；'sent'-undefined 用冻结注入时钟消除
  预检竞速 + socket-creation 同步点后再断言；staged-ACK 断言改为 ACK-observation
  同步点之后的 **order-pinned 逐帧 ACK 序列 deepEqual**（产品状态机
  `sendNextInputFrame`/`maybeAdvanceInput` 只在前一帧 write 回调 + 活 ACK 观测后
  发下一帧，发射顺序有保证，故钉顺序而非集合，且非 subset/count-only）；
  `different timeout groups` 的真实 15/10ms 服务时延改为注入时钟推进。
- **修复后重复证明（同配方，2026-08-01）**：包内入口
  `node --test --test-force-exit test/aio-terminal-session-ownership.test.mjs`
  **12/12 全绿**（32 burners，高峰负载期）+ **12/12 全绿**（64 burners，且套件
  进程 `nice -n 19` 进一步加压）——共 24 个连续 contention rep 零失败；turbo
  入口同 32-burner 配方 1 rep exit 0（全部包套件绿，含本套件）。

### F.3 boxlite-client native-exec misclassification (resolved by this change)

- **CI run/job ID**: run `30670136646` attempt 1 (PR #189, branch
  `refactor/close-gate-blindspots-and-ci-hygiene`), job `package suites` ID
  `91285916348`, 2026-07-31T22:30:47Z — `# not ok - native execution settlement
  keeps terminal state separate from nullable exit code`,
  `SandboxCommandSettlementError: Sandbox command settlement is timeout`,
  `not ok 3 - test/boxlite-client.test.mjs`. (The final run conclusion shows
  cancelled/re-run; the red package-suites job is preserved under attempt 1:
  `gh api repos/Xeonice/cloud-agent-platform/actions/runs/30670136646/attempts/1/jobs`.)
- **Root cause**: the test asserted the `'indeterminate'` exit while selecting
  which exit it exercised with a 1ms *real*-clock budget
  (`execWithPoll({ status: 'running' }, 1)`). The product budget re-reads the
  monotonic clock (`refreshDeadline`) at every budget check; if the process
  loses the CPU for ≥1ms anywhere between budget creation
  (`boxlite-client.ts` `exec`, :698) and polling-loop entry (pre-checks
  :715/:746, post-POST check :991), the deadline is observed at a pre-check and
  classifies `'timeout'` (pre-check path) instead of reaching the polling-loop
  break → `'indeterminate'` (:1154-1155/:1198-1202 → :1241). Loaded 2-core CI
  runners deschedule that long routinely; an idle 10-core dev host essentially
  never does. Both product behaviors are correct — the flake was test-side path
  selection by a real clock (per the F.3 registry entry).
- **Local reproduction mechanism (pre-fix)**: host-level contention alone did
  not reproduce on the 10-core darwin dev host (no `taskset`/`stress-ng`
  available): 275 contended samples green — 15 serial iterations plus
  8-way × 10 rounds plus 12-way × 15 rounds of
  `nice -n 19 node --test --test-force-exit "test/boxlite-client.test.mjs"`
  under 24–67 competing busy-loop worker processes. Escalated per design D6 to
  a cgroup CPU quota (the faithful stand-in for `taskset -c 0` + stress on a
  loaded runner):
  `docker run --rm --cpu-period=10000 --cpu-quota=1000 -v "$WT:/repo:ro" -w /repo/packages/sandbox-provider-boxlite node:22 node --test --test-force-exit "test/boxlite-client.test.mjs"`
  (1ms CFS slice per 10ms period: any burst ≥1ms freezes ~9ms mid-window).
  Reproduced at iteration 6 of 12 with the exact CI failure shape:
  `SandboxCommandSettlementError: Sandbox command settlement is timeout` raised
  at the former `assert.rejects` (test line 795) that expected
  `'indeterminate'`.
- **Fix**: both classification exits pinned by separate deterministic
  assertions through the pre-existing `nativeExecutionDeadlineDriver` seam
  (`boxlite-client.ts:165-168,351-352,2280-2354`; no new seam, product `src/`
  untouched): poll-budget exhaustion (manual clock jumps past the deadline
  between the poll request and the loop's budget re-check) → `'indeterminate'`,
  and deadline trigger (driver fires the deadline at budget creation, before
  the first pre-check) → `'timeout'` with the polling loop never entered
  (asserted via zero poll requests). No test in the file selects a native-exec
  classification path via a real clock anymore.
- **Repetition count and command (post-fix)**: 10/10 consecutive repetitions
  green under the identical contention recipe —
  `PERIOD=10000 QUOTA=1000 MAX_ITERS=10` driving the same
  `docker run --rm --cpu-period=10000 --cpu-quota=1000 … node:22 node --test --test-force-exit "test/boxlite-client.test.mjs"`
  invocation (zero failures; the same recipe that reproduced the pre-fix
  failure at iteration 6). Standalone unthrottled run green (17 passed, 0
  failed) and neighboring boxlite suites
  (boundary-regressions/conformance/diagnostics) green alongside.

### F.4 generated-private-git-fixture `write EPIPE` uncaughtException (track harden-git-fixture)

- **CI failure (run/job ID)**: PR #191 (branch `chore/archive-refactor-phase1-changes`), CI run
  `30672743633`, job `public-surface-parity` (job ID `91293747038`, required check): test 39
  `one private Git canary stays inside ephemeral exact-host secret channels` failed with
  `failureType: 'uncaughtException'`, `error: 'write EPIPE'`, `code: 'EPIPE'`; stack
  `Socket.end → runGitHttpBackend (packages/sandbox-conformance/dist/generated-private-git-fixture.js:580)
  → handleGitHttpRequest (dist:543)` — dist line 580 is the compiled `child.stdin?.end(args.body)`
  write (src formerly line 867).
- **Root cause**: a git client hanging up early is normal smart-HTTP protocol behavior; the
  fixture's `clientClosed = () => child.kill('SIGKILL')` fires on the response `'close'` event
  and the still-pending stdin write then hits a broken pipe. `child.stdin` had no `'error'`
  listener, and the EPIPE surfaces asynchronously — guarding only the write callback is
  insufficient (nodejs/node#11918) — so the emission became an `uncaughtException` that killed
  the whole test process. Environment-dependent: slow runners widen the kill-vs-flush window.
- **Local reproduction (pre-fix, deterministic adversarial simulation, isolate-fixture-git-env
  idiom)**: scratchpad script `f4-prefix-repro.mjs` mirrors `runGitHttpBackend` byte-for-byte in
  mechanism — `execFile('git', ['http-backend'], …fixture env…)` → `child.kill('SIGKILL')`
  (simulated early client disconnect) → block the event loop synchronously
  (`execSync('sleep 0.2')`) so the child is dead at the OS level while
  `child.stdin.destroyed === false` (Node has not yet observed the death — exactly the loaded
  CI-runner interleaving) → perform the formerly-line-867 write `child.stdin.end(64 KiB)` →
  unhandled `'error'` event `Error: write EPIPE` (`errno: -32, syscall: 'write'`, emitted on the
  stdin `Socket`, identical stack shape `Socket.end → afterWriteDispatched`) → process exits 1.
  Reproduced deterministically 3/3 runs (2026-08-01, node v22.22.0, macOS darwin 25.5.0).
- **Fix**: `guardGeneratedPrivateGitWriteStream` — one whitelisted acquisition-time `'error'`
  listener (whitelist declared once: `EPIPE`, `ECONNRESET`; every other error rethrown) attached
  before any write on both fixture write paths: the backend `child.stdin` (in
  `runGitHttpBackend`) and the CGI `ServerResponse` (guarded at acquisition in the
  `createServer` handler, covering `writeCgiResponse`, formerly lines 904-905). Failability is
  preserved by an injection-probe negative test (non-whitelisted code must surface) and a
  deterministic adversarial early-disconnect test in
  `packages/sandbox-conformance/test/sandbox-conformance.test.mjs`.
- **Post-fix verification (2026-08-01, node v22.22.0)**: `dist` rebuilt through the turbo task
  graph (`pnpm -w exec turbo run build --filter=@cap-console/sandbox-conformance` and
  `--filter=@cap-console/api`, the `dependsOn ["build","^build"]` edges rebuilding the fixture
  dist that `test:public-surface` consumes). Then:
  - `packages/sandbox-conformance` suite (CI entry command
    `node --test --test-force-exit "test/**/*.test.mjs"`): 49 passed, 0 failed — includes the
    fixture block plus the two new tests; **10 consecutive repetitions: 10 pass, 0 fail**.
  - Deterministic adversarial simulation (in-suite, `generated private Git fixture survives
    early client disconnects and keeps serving`): guarded stdin write against a SIGKILLed
    backend child under a synchronously blocked event loop (`stdin.destroyed === false`
    asserted pre-write) + four real early-disconnecting authorized HTTP clients → zero
    `uncaughtException` captured, fixture serves a subsequent authorized `info/refs` request
    (HTTP 200) in the same process, clean drain on dispose. Negative control (guard absent,
    same recipe) captures `code: 'EPIPE'` — the test is red on the pre-fix shape. The
    injection-probe negative test (`generated private Git write-stream guard rethrows
    non-whitelisted errors`) proves `EACCES` and code-less errors still surface for both write
    paths while `EPIPE`/`ECONNRESET` are swallowed.
  - `apps/api/test/generated-private-git-fixture.test.mjs`: 3 pass, 0 fail.
  - `apps/api/test/generated-private-git-boxlite-native.test.mjs`: 0 fail (1 skipped — the
    suite self-skips without a live BoxLite environment, its designed gate; identical on CI).
  - Root `pnpm run test:public-surface` (turbo `test:public-surface`, contracts/api/web):
    14 tasks successful; api 122/122 pass including the formerly-failing
    `private-git-secret-canary.story.spec` test 39 against the rebuilt dist.
