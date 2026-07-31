## 1. Track: diagnose (depends: none)

- [x] 1.1 Make `scripts/install-preflight.test.mjs` report why a case failed — at minimum the script's exit status, stderr, and the fake-binary log — because its current `PASS`/`FAIL` output is what turned four investigations into four rejected hypotheses and no answer.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.2 With diagnostics in place, obtain the failure detail from the GitHub runner. Local environments do not reproduce it: 48/48 pass on macOS, in `node:22-slim` with curl, and in that container with tools planted in `/usr/local/bin`.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.3 Establish whether `aio-terminal-pair-stale-sweep-canary` shares a cause with install-preflight. They have failed together in every observed run and neither has failed alone, which is either one cause or a coincidence worth disproving.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.4 Read what `flushCast` awaits in `readoption-history.test.mjs` and determine whether the intermittent single-event observation is a race in the code under test or an assertion on timing the test does not control.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 2. Track: release (depends: diagnose)

- [x] 2.1 Fix or explain each suite, and remove its entry from `scripts/quarantined-suites.mjs`. A suite that should not exist is deleted with that stated as the reason, never by attrition.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.2 Prove each released suite on the GitHub runner, not locally. All three pass locally today; that is why they were quarantined rather than fixed.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.3 Confirm the quarantine list is empty and that `scripts/quarantined-suites.test.mjs` still passes with it empty — the mechanism must survive its own disuse.
  - requirements: ["test-suite-discovery/a-suite-excluded-from-execution-shall-name-an-accountable-change"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

> 结案注记（2026-08-01）：本 change 被 close-gate-blindspots-and-ci-hygiene
> track 7（quarantine-clearing，tasks 7.1–7.4）接管并随 PR #189 合并（efbb014）
> 完成。逐项对应：1.1 诊断输出=7.1；1.2 GH runner 失败细节=7.2；1.3/1.4 同因
> 分析与 flushCast 判定=7.3 继承的诊断记录；2.1 条目移除=7.2/7.3；2.2 GH
> runner 证明=PR #189 两轮 package-suites 绿（释放的套件随 packages lane 执行）；
> 2.3 空列表机制=7.4（QUARANTINED_SUITES=[] 且配对自测过）。main 现状实证：
> scripts/quarantined-suites.mjs 为空数组。
