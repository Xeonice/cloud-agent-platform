# Design — deflake-environment-dependent-suites

## Context

三个 environment-dependent flake（F.2 aio-terminal-session-ownership、F.3 boxlite-client、F.4 generated-private-git-fixture，登记于 `docs/refactor/04-rules-registry.md:125-171`）在满载 CI（package-suites job 用 `pnpm turbo test --filter='./packages/*' --continue` 单 runner 并行跑全部包套件）下轮流出红，standalone 全绿。修复方向在债务登记里已被预批（F.2「可注入时钟，文件内已有 Date.now stub 先例」、F.3「injectable clock 或分离预算/deadline 触发器」），research-brief 三路调研（Web 生态先例 / Codebase 实证 / Archive 惯例）收敛一致——本 design 只需钉死每处的技术选择与边界，不需要重新做方案搜索。

硬约束（来自 proposal 与 `surface-impact.json` internalOnly scope）：

- 被测产品运行时语义零 diff；产品源码不为测试新增注入缝。
- 唯一被改的 `src/` 文件是 `packages/sandbox-conformance/src/generated-private-git-fixture.ts`——它是测试夹具而非产品运行时。
- 零新依赖。

## Goals / Non-Goals

**Goals:**

- F.2/F.3/F.4 三个套件在满载/慢机环境下确定性绿（根因修复，非收容）。
- 每条修复保持可失败性：断言结果值不变、夹具非白名单错误仍上浮。
- 修复经「复现 → 修复 → 重复证明」配方验收，证据按既定格式记入 tasks.md。
- `docs/refactor/04-rules-registry.md` 三条登记随修复翻转为 resolved。

**Non-Goals:**

- 不放宽任何断言、不加 retry、不使用 quarantined-suites 机制、不删套件（详见 proposal Non-Goals；quarantine 的刻意背离理由见 Decision 5）。
- 不动 `releaseAioTerminalGuestPairExact`、`classifySandboxCommandExecutionRejection` 等被测产品行为。
- 不引入 node:test MockTimers 或 @sinonjs/fake-timers（作为备选记录于 Decision 1，不采用）。

## Decisions

### D1 — F.2 时钟控制：提炼文件内既有 Date.now stub 为共享 helper

**选择**：把 `aio-terminal-session-ownership.test.mjs` 已验证的两处内联先例（1419/2160 行：save originalDateNow → `Date.now = () => now` → finally 恢复，回调里手动推 `now +=`）提炼为一个共享 helper，覆盖**全部四处** wall-clock 紧余量断言（1279/2281/2760/3313 行）。漏一处就还会轮流出场，因此 spec scenario 钉「零处仍读真实时钟做余量」。

**为什么不是别的**：

- *node:test MockTimers*（`mock.timers.enable({ apis: ['Date'] })`）是平台原生形状，但标 experimental——手工 stub 既是库内先例又被登记条目预批，零依赖零风险，为默认选择。
- *@sinonjs/fake-timers* API 稳定但引入新依赖，违背「零新增」。
- *产品加时钟缝*：aio 源码零时钟缝（裸 `Date.now()` 于 436/469/774/787/792 等行），加缝破「产品零 diff」验收，直接否决。

### D2 — F.2 两个竞态：确定性同步点，不是更大的真实预算

**选择**：「'sent' undefined」（1856 行，10ms 真实预算在慢机上先于 socketFactory 耗尽 → `sockets[0]` undefined）与 staged ACK 顺序 deepEqual（1941 行）改用确定性同步点——断言前 await socket 创建 / ACK 观测事件。

**理由**：Date.now stub 不控制产品源码 1362 行的真实 `setTimeout`，单靠 stub 无法消除这两处竞速；调大真实预算只是把竞态窗口挪远，属「放宽以通过」，被 Non-Goal 明令禁止。Fowler《Eradicating Non-Determinism in Tests》的正典处方与此一致：绝不与被测系统竞速，用事件同步点或时钟控制。

**ACK 断言语义**：走「钉死顺序」还是「顺序不敏感（精确集合比较）」跟随产品 316 行状态机实际承诺——状态机保证发射顺序则 order-pinned，否则 sort/set 精确比较；两种形状都不得弱于承诺语义（禁 subset/count-only）。这一裁定推迟到实现时读源码定案，spec scenario 已双向钉死。

### D3 — F.3 双出口分离：驱动既有产品 seam，两条断言各钉一条路径

**选择**：`boxlite-client.test.mjs` 795-800 行的 1ms 真实时钟选路测试，改为给 execWithPoll 工厂传手动 `nativeExecutionDeadlineDriver`（产品 seam 早已存在：`boxlite-client.ts:165-168,351-352,2280-2354`，注释即 "@internal Deterministic deadline seam"），拆成两条确定性断言：

- poll 预算耗尽 → `'indeterminate'`（轮询循环 break 路径，1154-1155 → 1241 行）
- deadline 触发 → `'timeout'`（预检路径，715/746 行）

**理由**：登记确认两种行为均正确——flake 是测试选路不稳而非产品缺陷，所以修法是让每条路径各有确定性断言，而非挑一条。这与 AWS SDK waiters / k8s wait 的「双出口分离参数化」主流惯例一致。手动 driver 模式在同包已有 8+ 现成范本（boxlite-diagnostics 的 nativeDeadlineHarness、boundary-regressions 六处内联 fake driver 等），直接照抄，不发明新测试基建。F.3 因此是三处中成本最低的。

### D4 — F.4 夹具容错：流创建时挂 'error' 监听 + code 白名单，改 src 重建 dist

**选择**：`generated-private-git-fixture.ts` 两条写路径（`child.stdin`，867 行；writeCgiResponse 的 response，904-905 行）都在**流获取时、任何写入之前**挂 'error' 监听；监听器按 `err.code` 白名单只吞 `EPIPE`/`ECONNRESET`，其余照抛。

**为什么是这个形状**：

- git 客户端提前挂断是 smart-HTTP 协议正常行为——崩的是夹具（子进程被 SIGKILL 后写 stdin → EPIPE 无监听 → uncaughtException），产品零 diff 成立。
- *只守 write callback 不够*：peer 已关闭时 write callback 不可靠地收到错误（nodejs/node #11918），异步 'error' 发射仍会崩进程。
- *一揽子 try/catch 被否决*：会掩盖夹具真实 bug。可失败性由 injection-probe 式负向测试保证——注入非白名单 code 的写错误，断言其上浮且夹具不吞。这满足 canon「改动的机制仍能失败」。
- *改 src 不改 dist*：崩溃栈引用 dist 行号，但直接改 dist 会被下次构建冲掉；改 src 后 turbo `dependsOn ["build","^build"]` 保证 `test:public-surface`（required job）消费的 dist 先重建。三份配对自测保持绿。

### D5 — 不用 quarantine：对已记录 fallback 的刻意背离

wire-orphaned-test-suites 的 design 记录过 fallback（「环境依赖套件移入非默认 lane」）。本 change 刻意背离，理由有二：

1. canon 要求根因修复而非收容——quarantine 列表 2026-07-31 已清空，空列表是健康态；
2. 机制现实上 quarantine runner（run-suite.mjs）只覆盖 apps/api test:src 与根 test:scripts，**根本覆盖不到这三个目标套件**（各包自己的 `node --test` glob + dist spec）——往列表里加它们既违背验收也大半无效。

同一 design 的反 retry 原则仍然适用：retry 只会重新掩埋信号。

### D6 — 验收配方：复现 → 修复 → 同条件重复证明

- **复现（修复前）**：限核 + 竞争负载（`taskset -c 0` + `stress-ng`）针对 CI 两个 job 的真实入口命令行（`pnpm turbo test --filter='./packages/*' --continue` 与各包 `node --test --test-force-exit`），逼出三个失败形态各至少一次（elapsed 超窗 / sockets[0] undefined / fixture uncaughtException）。
- **证明（修复后）**：同条件重复 ≥10 次全绿（shell 循环，node --test 无内置 repeat）。
- **证据格式**：按 close-gate-blindspots 7.2 定调——GitHub run/job ID + 根因 + 本地复现机制，逐 flake 记进 tasks.md。F.4 另加确定性敌意模拟（照 isolate-fixture-git-env 惯用法：模拟客户端提前断连，断言夹具存活、可继续服务后续请求、非白名单错误仍传播）——contention 复现对 F.4 是概率性的，敌意模拟才是确定性证据。
- **执行姿态**：吸取 release-quarantined 先例被吸收的教训——保持小体量，propose 后立即执行，不停车。

## Risks / Trade-offs

- **[全局 Date.now stub 跨测试泄漏]** → helper 强制 try/finally 恢复（沿用既有先例的形状）；helper 单点实现使恢复逻辑只写一次。
- **[同步点重写不小心弱化断言]** → spec scenario 钉「asserted outcome unchanged」——只有到达断言的机制变确定，分类值/released 状态/ACK 集合不变；且禁止以调宽数字预算作为过关手段。
- **[F.4 白名单吞掉夹具真实缺陷]** → injection-probe 负向测试常驻默认 suite，非白名单错误必须上浮；白名单只含协议正常断连的两个 code。
- **[本地 contention 配方复现不出某个形态]** → 配方可加压（更少核、更高 stress-ng 负载、提高重复次数）；登记条目已含 main 上的 CI 铁证（PR #189/#190/#191 run），根因分析不依赖本地必现。
- **[Date.now stub 与真实 setTimeout 混用产生新的隐性竞态]** → 边界明确：stub 只服务 elapsed 窗口断言；凡涉及产品真实定时器的路径一律用事件同步点（D2），两机制不交叉承担对方职责。

## Migration Plan

不适用——纯测试/夹具侧改动，无部署面。回滚 = revert 单个 commit；产品 dist 中唯一受影响的是 sandbox-conformance 夹具，由任务图自动重建。

## Open Questions

- staged ACK 断言最终走 order-pinned 还是 order-insensitive：实现时读 `aio-terminal-session-ownership.ts` 316 行区域状态机的实际承诺定案（D2 已把两种形状的合法条件钉死，不阻塞开工）。
