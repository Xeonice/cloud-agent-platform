# Deflake Environment-Dependent Suites

## Why

三个 environment-dependent flake（F.2 aio-terminal-session-ownership、F.3 boxlite-client、F.4 generated-private-git-fixture，登记于 `docs/refactor/04-rules-registry.md:125-171`）在 PR #189/#190/#191 的四轮 CI 中轮流出场，每次挂掉的都是与该 PR 无关的套件——docs-only 的 PR #190 也能红。三条登记全部明示「归后续 flake 专项 change」：本 change 就是 `close-gate-blindspots-and-ci-hygiene` 在 Not-in-scope 里明文承诺的承接方，而 F.2 的债务链已横跨四个归档 change（enforce-provider-contract-parity 5.4 → close-request-boundary-gaps 8.1 → retire-superseded 1.5 → establish-api-module-layout 6.5 → close-gate-blindspots 8.5/8.11），每一站都是「记录、不修」——专项修复已到期。前一个 flake 专项（release-quarantined-installer-and-terminal-suites）从未独立执行、最终被别的 change 吸收；本 change 吸取该教训：保持小体量，propose 后立即执行。

## What Changes

三处修复全部在测试/夹具侧，被测产品语义零 diff（与已存在的 `surface-impact.json` internalOnly scope 一致）：

- **F.2 — `packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs`（成本中）**：产品源码零时钟缝且不加 seam。把文件内已验证的 Date.now stub 先例（1419/2160 行）提炼为共享 helper，覆盖**全部四处** wall-clock 紧余量断言（1279/2281/2760/3313 行——漏一处就还会轮流出场）；「'sent' undefined」（1856 行，10ms 真实预算在慢机上先于 socketFactory 耗尽）与 staged ACK 顺序 deepEqual（1941 行）两个竞态改用确定性同步点（await socket 创建/ACK 事件），因为 Date.now stub 不控制源码 1362 行的真实 setTimeout。ACK 断言走「钉死顺序」还是「顺序不敏感」跟随 316 行状态机实际承诺的语义。
- **F.3 — `packages/sandbox-provider-boxlite/test/boxlite-client.test.mjs`（成本最低）**：产品注入缝 `nativeExecutionDeadlineDriver` 早已存在（`boxlite-client.ts:165-168,351-352,2280-2354`），该文件 795-800 行是唯一还在用 1ms 真实时钟选路的 native-exec 预算测试。给 execWithPoll 工厂传手动 driver（同包 8+ 现成范本直接照抄），拆成两条确定性断言分别钉两条出口：poll 预算耗尽 → `'indeterminate'`（轮询循环 break 路径）、deadline 触发 → `'timeout'`（预检路径）——两条分类路径各有断言，因登记确认两种行为均正确。
- **F.4 — `packages/sandbox-conformance/src/generated-private-git-fixture.ts`（改 src 不改 dist）**：git 客户端提前挂断是 smart-HTTP 协议正常行为，崩的是夹具自己（867 行 `child.stdin?.end()` 写入已死子进程、stdin 无 'error' 监听 → uncaughtException）。两条写路径容错：child.stdin 在**创建时、任何写入之前**挂 'error' 监听，writeCgiResponse 的 response 同样；按 code 白名单只吞 EPIPE/ECONNRESET，其余照抛（只守 write callback 不够，node #11918）。配 injection-probe 式负向测试证明非白名单错误仍上浮；三份配对自测保持绿，turbo `dependsOn [build,^build]` 保证 dist 重建。
- **验收配方（复现 → 修复 → 证明）**：本地用限核 + 竞争负载（`taskset -c 0` + `stress-ng`）针对 CI 两个 job 的真实入口命令行（`pnpm turbo test --filter='./packages/*' --continue` 与各包 `node --test --test-force-exit`）修复前逼出三个失败形态、修复后同条件重复 N 次全绿；GitHub runner 实证按 close-gate-blindspots 7.2 的证据格式（run/job ID + 根因 + 本地复现机制）记进 tasks.md；F.4 另加确定性敌意模拟（照 isolate-fixture-git-env 惯用法：模拟客户端提前断连，断言夹具存活且非白名单错误仍传播）。
- **登记翻转**：把 `docs/refactor/04-rules-registry.md` 的 F.2/F.3/F.4 条目从「留痕、归后续 change」翻转为 resolved（镜像 close-gate-blindspots 翻转工件04 表行作验收的做法）。

## Non-Goals

- **不放宽任何断言**让某个 case 恰好通过（release-quarantined 措辞："never loosen an assertion so a case passes"）。
- **不加 retry**——wire-orphaned-test-suites 的反 retry 原则仍然适用，retry 只会重新掩埋信号。
- **不使用 quarantined-suites 机制**。这是对 wire-orphaned-test-suites design 已记录 fallback（「环境依赖套件移入非默认 lane」）的刻意背离，理由有二：canon 要求根因修复而非收容（列表 2026-07-31 已清空，空列表是健康态）；机制现实上 quarantine runner（run-suite.mjs）只覆盖 apps/api test:src 与根 test:scripts，**根本覆盖不到这三个目标套件**——往列表里加它们既违背验收也大半无效。
- **不靠删除套件减员**，不动 `releaseAioTerminalGuestPairExact`、`classifySandboxCommandExecutionRejection` 等被测产品行为（双出口语义与 AWS waiters/k8s wait 主流惯例一致，保持不变）。
- 不引入新依赖：node:test MockTimers（experimental）与 @sinonjs/fake-timers 作为 design.md 里记录的备选即可——手工 Date.now stub 既是库内先例又被登记条目预批，为默认选择。

## Capabilities

### New Capabilities

_None——本 change 不引入新能力，修的是既有套件与夹具的确定性。_

### Modified Capabilities

- `test-suite-discovery`: 「套件被发现即被执行、且执行结果 gate 合并」的契约补上确定性这一半——环境依赖型红灯 SHALL 以根因修复归位（可注入时钟/确定性同步点/夹具按错误码白名单容错），retry、放宽断言、quarantine 收容均不构成 resolution；夹具容错 SHALL 保持可失败性（非白名单错误仍上浮），登记在案的 flake 条目随修复翻转为 resolved。

## Impact

- **代码（全部 internalOnly，与 sidecar 一致）**：`packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs`（四处 wall-clock 断言 + 两处竞态 + 提炼共享时钟 helper）、`packages/sandbox-provider-boxlite/test/boxlite-client.test.mjs`（execWithPoll 工厂接 manual driver + 双出口断言）、`packages/sandbox-conformance/src/generated-private-git-fixture.ts`（两条写路径容错 + 负向测试）；`docs/refactor/04-rules-registry.md` F.2/F.3/F.4 条目翻转。
- **公开面**：publicV1/mcp/openapi/apiPlayground 全部 unchanged；无 schema、无端点、无 wire 行为变化（`surface-impact.json` 已声明，verification=`workflow-gates`，不需要 wire-compat fixture）。
- **验证链路**：F.4 经 `test:public-surface` 跑编译后 dist（required 的 public-surface-parity job），改 src 后由 turbo 任务图重建；三份 fixture 配对自测（`apps/api/test/generated-private-git-fixture.test.mjs`、`generated-private-git-boxlite-native.test.mjs`、`packages/sandbox-conformance/test/sandbox-conformance.test.mjs:1839-1881`）须保持绿。
- **依赖**：零新增。
