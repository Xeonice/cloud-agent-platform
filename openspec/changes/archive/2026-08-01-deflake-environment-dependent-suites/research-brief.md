# Research Brief — deflake-environment-dependent-suites

三路并行调研（Web 生态先例 / Codebase 实证 / Archive 惯例）的汇总，服务于 F.2/F.3/F.4 三个环境依赖型 flake 的修复 change。登记原文见 `docs/refactor/04-rules-registry.md:125-171`；change 目录已存在且已含 `surface-impact.json`（internalOnly changed，其余四面 unchanged，verification=workflow-gates），后续工件须与之一致。

---

## Web 路线发现

### 时钟注入（F.2 方向）

- **node:test 内置 MockTimers 支持 Date-only mock**：`mock.timers.enable({ apis: ['Date'] })` + `.setTime(ms)`/`.tick(ms)` 可只伪造 `Date.now()` 而不动 setTimeout/setInterval——正是把 F.2 的 wall-clock 余量断言（`Date.now()-startedAt < timeoutMs`）改成可注入时钟、同时不碰 reconnect 状态机真实定时器所需的形状。上下文作用域 + 自动恢复，不会跨测试泄漏。**注意**：API 标记为 experimental（行为自 ~20.4/21.x 稳定但文档保留变更权），因此把现有手工 `Date.now` stub 提炼成共享 helper 是同等站得住脚且零依赖的路线。
  证据：https://github.com/nodejs/node/pull/48638 ；https://codewithhugo.com/node-test-mock-date-and-timers/
- **Date 与 setTimeout 同时 mock 时共享一个内部时钟**（推进 timer 即推进 Date），且 apis 可选择性启用——F.2 的每处断言可各自选择只冻结 Date、或完全驱动时钟。这让三种 flake 形态可用一套机制处理：elapsed 窗口断言用冻结 Date，行为不可变的 reconnect 状态机不做 timer 伪造（产品语义零 diff 约束）。
  证据：https://codewithhugo.com/node-test-mock-date-and-timers/ ；https://bun.com/reference/node/test/default/MockTimers
- **@sinonjs/fake-timers 是备选**：`install({ toFake: ['Date'] })` 提供同样的 Date-only 伪造，API 稳定（非 experimental）且旋钮更细（shouldAdvanceTime、per-global install）。若仓库不接受 experimental 依赖可用；否则 node:test 内置以零依赖胜出。
  证据：https://github.com/sinonjs/fake-timers

### 异步竞态治理方法论（F.2 方向）

- **Fowler《Eradicating Non-Determinism in Tests》正典处方与本 change 方向一致**：绝不拿裸 sleep/真实时钟与被测系统竞速——要么用回调/事件做同步点，要么显式控制时钟（clock stub）；实证研究发现约 45% 的 flaky test 源于断言前未正确 await 异步调用。这是 F.2 两条修复方向（timing 断言注入时钟、'sent'-undefined 与 ACK 顺序竞态用 await-event 同步点）的外部背书：它们是业界标准疗法而非临时补丁。
  证据：https://martinfowler.com/articles/nonDeterminism.html ；https://arxiv.org/pdf/2501.12680
- **ACK deepEqual 顺序竞态的既定 Node 模式是 `events.once()`/deferred promise 确定性同步点**，而非竞速；fast-check 的 scheduler 是系统性探索 async 交错的先例（如果套件想证明顺序无关性而非钉死一个顺序）。两种可选修复形状：(a) 断言前 await 产生每个 ACK 的具体事件（确定性钉死顺序）；(b) 若协议本就不保证顺序则改为顺序不敏感断言（sort/set 比较）——选择应跟随 316 行状态机实际承诺的语义。
  证据：https://fast-check.dev/docs/tutorials/detect-race-conditions/your-first-race-condition-test/ ；https://www.devassure.io/blog/flaky-tests-race-conditions/

### 轮询双出口分离（F.3 方向）

- **Coder 的 Quartz 库（Go）就是为真实时钟轮询测试 flaky 而生**：在确定性节点截获 clock/timer 调用，让测试推进时间并选择哪条退出路径（预算耗尽 vs 超时）触发——F.3「分离两条出口」设计的最强先例。
  证据：https://coder.com/blog/introducing-quartz
- **AWS SDK JS v3 waiters 与 Kubernetes wait 包都用显式分离的参数建模轮询**——maxWaitTime（wall clock）与 attempts/delay（预算）是不同的终态、不同的触发器；AWS 正是因为从 attempt 推导超时容易出错才改成直接的 maxWaitTime。支持按路径注入触发器（时钟或 attempt 计数）而非调 1ms 常数，并确认 `classifySandboxCommandExecutionRejection` 的双路径语义是主流惯例、应保持不变。
  证据：https://aws.amazon.com/blogs/developer/waiters-in-modular-aws-sdk-for-javascript/ ；https://pkg.go.dev/k8s.io/apimachinery/pkg/util/wait
- **Ember「轮询任务确定性测试」模式**——绕过自动计时、由测试手动驱动每次 poll 迭代——是 poll-count 注入的最轻量版本。若 execWithPoll 能在测试里接受注入的 scheduler/attempt 源（internalOnly 缝），预算耗尽路径就变成同步的、与负载无关的循环，完全不需要 timer mock。
  证据：https://dev.to/michalbryxi/deterministic-testing-of-a-polling-task-in-emberjs-157f ；https://www.damirscorner.com/blog/posts/20240614-ImplementPollingUsingPolly.html

### EPIPE 容错（F.4 方向）

- **对已断连 peer 写入产生 EPIPE/ECONNRESET 是 Node 里正常的 TCP 行为**，正典处理是 socket 'error' 监听器按 `err.code` 过滤（吞 EPIPE/ECONNRESET，其余照抛）——net.Socket 上未处理的 'error' 事件会崩掉进程，正是 F.4 的 uncaughtException 失败形态。修复方向应是带 code 白名单的 error 监听器（EPIPE、ECONNRESET——若涉及 streams/pipeline 还有 ERR_STREAM_PREMATURE_CLOSE），而非会掩盖夹具真实 bug 的一揽子 try/catch。
  证据：https://github.com/nodejs/node/issues/40590 ；https://oneuptime.com/blog/post/2026-01-22-nodejs-econnreset-error/view
- **Socket.write 的 callback 在 peer 已关闭时不可靠地收到错误**（长期行为，nodejs/node #11918）——只守 write callback 不够；健壮的夹具还要在 `end()` 前检查 `socket.destroyed/writable`，并**在 socket 创建时、任何写入之前**就挂上 'error' handler。实现陷阱：只包 `socket.end()` 的 try/catch 或只传 end-callback 的修复，仍会在异步 'error' 发射时崩溃。
  证据：https://github.com/nodejs/node/issues/11918
- **两个参考实现可借鉴错误处理形状**：isomorphic-git/git-http-mock-server（native git http-backend 服务 bare 仓库，专为测试夹具的 clone/push over HTTP 而建）与 fuubi/node-git-http-backend（HTTP 管道进 CGI）。git smart-HTTP 客户端提前挂断（"the remote end hung up"）是文档化的正常协议行为——断连是 git 客户端行为正确，产品语义零 diff 约束成立，只改夹具的容错。
  证据：https://github.com/isomorphic-git/git-http-mock-server ；https://github.com/fuubi/node-git-http-backend ；https://git-scm.com/docs/git-http-backend
- **Node core 自己的套件也打过同一类 flake**（test-http2-respond-file-error-pipe-offset，响应流期间 premature close），core PR 常规做法是把 timing 竞速换成确定性等待、把 teardown 期间的 premature-close 错误当预期容忍。最受审视的 Node 测试套件先例：(a) teardown 期 EPIPE 靠容忍预期错误码修复；(b) 本 change 的「修复而非隔离」姿态与 core 实践一致。
  证据：https://github.com/nodejs/node/issues/35881 ；https://github.com/nodejs/node/pull/61629

### 复现与验收工具（验收配方）

- **本地复现环境依赖 flake 的标准配方是把 CPU 节流到 CI 级速度**——4-6x throttle 立刻复现过 CI-only 的 Playwright flake；Linux 上用 `taskset` 钉少核（stress-ng 甚至内置 `--taskset`）+ stress-ng 制造竞争负载。直接支持验收标准（模拟慢/满载环境）：`taskset -c 0` + `stress-ng --cpu N` 伴跑套件，是修复前逼出 F.2 的 elapsed=81>窗口、F.3 的 wall-clock 先到排序，修复后证明其消失的标准手段。
  证据：https://charpeni.com/blog/how-to-easily-reproduce-a-flaky-test-in-playwright ；https://manpages.debian.org/testing/stress-ng/stress-ng.1.en.html
- **重复 N 次验收闸**：`node --test` 无内置 repeat 旗标，生态模式是 shell 循环（thoughtbot「run it in a loop until it fails」）或 flaker CLI（按时长重复/并行跑命令、JSON 结果），在 GitHub Actions 里只包住测试阶段并上传 flake 报告。ubuntu-latest runner 是 4 核 Linux，taskset 可在 workflow 内用——同一 job 可组合钉核 + 重复循环作为修复后证明。
  证据：https://github.com/pcman312/flaker ；https://thoughtbot.com/blog/dealing-with-flaky-tests
- **retry/quarantine 工具链是生态主流备选，但文献一致把它定位为短期收容**，根因修复（时钟注入、同步点、错误容忍）才是终态。这验证了本 change 的显式约束（不用 quarantined-suites 机制、修复优先于隔离）：proposal 站在既定实践的强侧，reviewer 若推 retry-wrapper 可指向该共识。
  证据：https://blog.arkency.com/weekly-quarantine/ ；https://oneuptime.com/blog/post/2026-01-24-fix-flaky-tests-cicd/view

---

## Codebase 路线发现

### 登记与 change 现状

- **三个 flake 的三分法登记原文与修复方向就在 F.2/F.3/F.4 条目**：F.2（1/3 概率、standalone 全绿、PR #190 docs-only 复现 1856 行 'sent' undefined 铁证在 main）、F.3（1ms 真实时钟选路、最近改动 34c8611）、F.4（PR #191 openspec-only 红、uncaughtException write EPIPE 栈在 runGitHttpBackend）。三条都明示「归后续 flake 专项 change」——本 change 即其指认的承接方。
  证据：`docs/refactor/04-rules-registry.md:125-171`
- **change 目录已存在且只有 sidecar**：`deflake-environment-dependent-suites` 已声明 internalOnly changed（列全三个文件与修法）、其余四面 unchanged、verification id `workflow-gates`——proposal/tasks 尚未写。不要新建 change 目录；后续工件须与已写好的 internalOnly scope 文字保持一致。
  证据：`openspec/changes/deflake-environment-dependent-suites/surface-impact.json`

### F.2（aio-terminal-session-ownership，三种形态 + 修法素材）

- **形态一（wall-clock 紧余量）完整靶点清单——四处**：1279 行 `assert.ok(Date.now()-startedAt < timeoutMs)`（timeoutMs=120）；2281 行 `assert.ok(elapsedMs >= 30 && elapsedMs < 75)`——观测到的「elapsed=81 超窗」与 2281 的 <75 上界精确吻合；另有 2760 行 `elapsedMs<100`、3313 行 `<250` 两处同类。漏一处就还会轮流出场。
  证据：`packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs:1279,2281,2760,3313`
- **形态二（undefined reading 'sent'）机理**：1856 行 `missing.sockets[0].sent.length` 在 `timeoutMs:10` 真实毫秒 + 'silent' socket 下断言；harness 的 sockets 数组只由 socketFactory 填充（408-421 行），而被测源码在 reconnect 前有 `Date.now()>=deadline` 早退检查（src 774/787/792 行）——慢机上 10ms 先耗尽则 socketFactory 从未被调、`sockets[0]` 为 undefined。修法应是确定性同步点（await socket 创建事件或 stub 时钟钉死预算），而非放宽断言；同测试内 echo/duplicate 分支（timeoutMs:10/100）同病。
  证据：`packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs:1846-1856` + `packages/sandbox-provider-aio/src/aio-terminal-session-ownership.ts:774-792`
- **形态三（staged ACK 顺序 deepEqual 竞态）**：1921 行测试对五种 socketBehavior 用 `timeoutMs:20` 真实毫秒跑 releaseAioTerminalGuestPairExact，1941 行 deepEqual 断言 cause 精确等于 'timeout' 或 'protocol-unconfirmed'——哪条路径先到取决于真实时间竞速；'timeout' 分支（stage-no-ack/stage-restore-ack）依赖 20ms 真实预算先于协议路径耗尽。
  证据：`packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs:1921-1958`
- **可推广先例是测试侧全局 Date.now stub**：1419-1530 与 2160-2244 两个测试均 save originalDateNow → `Date.now = () => now` → finally 恢复，并在 fetch/socketFactory 回调里手动推 now（如 `now += 50`、`now += 2_000`）模拟耗时。被测源码没有任何时钟注入缝（见下条），产品零 diff 约束下这是唯一在库内已验证的可注入时钟手法。
  证据：`packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs:1419,1500,1530,2160,2227,2244`
- **aio 被测源码零时钟缝**：裸用 `Date.now()`（436/469/774/787/792/1981/2009/2221 行）和 `setTimeout`（1132/1362/1968/2868 行）；`AioTerminalOwnershipTiming`（2137 行）只是超时时长配置不是时钟；releaseAioTerminalGuestPairExact 本体在 371 行——行为正确不改。**确认 F.2 不能走「产品加 seam」路线**（破产品零 diff 验收）；注意全局 Date.now stub 不控制 setTimeout（源码 1362 行超时定时器仍走真实定时），确定性同步点必须靠 await 事件补齐。
  证据：`packages/sandbox-provider-aio/src/aio-terminal-session-ownership.ts:371,436,1362,2137,2221`

### F.3（boxlite-client，seam 已在、只差测试用它）

- **触发点**：boxlite-client.test.mjs 795-800 行 `execWithPoll({status:'running'}, 1)` 断言 `settlement==='indeterminate'`；execWithPoll 工厂（664-694 行）构造 BoxLiteRestClient 时**没有传 nativeExecutionDeadlineDriver**——是该文件里唯一还在用真实时钟做选路的 native-exec 预算测试。
  证据：`packages/sandbox-provider-boxlite/test/boxlite-client.test.mjs:664-694,795-800`
- **注入缝产品里早已存在**：`BoxLiteRestClientOptions.nativeExecutionDeadlineDriver`（351-352 行，注释 "@internal Deterministic deadline seam"），接口 `BoxLiteNativeExecutionDeadlineDriver{now,schedule}`（165-168 行），默认实现 systemNativeExecutionDeadlineDriver 用 performance.now+setTimeout（2347-2354 行），预算工厂 createNativeExecutionBudget 全程走 driver（2280-2346 行）——**产品零 diff 即可修，F.3 是三个目标里成本最低的**。
  证据：`packages/sandbox-provider-boxlite/src/boxlite-client.ts:165-168,351-352,2280-2354`
- **两条出口的分岔机理**：`budget.reason()==='deadline'` 时 nativeExecutionBudgetError 造 SandboxCommandSettlementError('timeout')（2370-2379 行），在 exec 的 throwIfNativeExecutionBudgetEnded 预检（715/746 行）抛出；而 waitForNativeExecution 轮询循环因 deadline break 后统一抛 'indeterminate'（1154-1155 break → 1241 行 throw）——1ms 真实预算下先到哪个检查点决定出口，**两路径行为均正确**（与登记一致，是测试选路不稳而非产品缺陷）；确定性测试要分别钉两个检查点各写一条断言。
  证据：`packages/sandbox-provider-boxlite/src/boxlite-client.ts:715,746,1154-1155,1241,2370-2379`
- **手动时钟测试模式在同包已有 8+ 处现成范本**：boxlite-diagnostics.test.mjs 的 nativeDeadlineHarness()（77-102 行，now/schedule/runDue）、boxlite-boundary-regressions.test.mjs 六处内联 fake driver（894/957/1011/1040/1064/1088 行，含 clockReads 计数选路）、boxlite-conformance.test.mjs:711 直传 deadlineDriver；conformance 包内另有 manualDeadlineDriver()（command-output-conformance.ts:683、workspace-git-conformance.ts:695）和 apps/api/test/generated-private-git-fixture.test.mjs:35 的 ManualDeadlineDriver 类。**直接复用/照抄即可，不需要发明新测试基建**——该模式是这个 codebase 的既定惯例。
  证据：`packages/sandbox-provider-boxlite/test/boxlite-diagnostics.test.mjs:77-102`；`packages/sandbox-provider-boxlite/test/boxlite-boundary-regressions.test.mjs:894`

### F.4（generated-private-git-fixture，崩溃点与验收链路）

- **崩溃点定位**：dist 580 行 = src 867 行 `child.stdin?.end(args.body)`——把请求体写进 git http-backend 子进程 stdin；866 行 response 'close' 即 SIGKILL 子进程（clientClosed），客户端正常提前断连 → 子进程死 → stdin 管道塌 → 写抛 EPIPE 且 child.stdin 无 'error' 监听 → uncaughtException。另一写路径 writeCgiResponse 的 response.writeHead/end（904-905 行）只有 check-then-act 守卫（870 行 destroyed||writableEnded），response 同样无 error 监听。**修复 = 两条写路径都容错**：child.stdin 挂 error 监听吞 EPIPE/ECONNRESET、response 写路径同样只吞这两个 code，其余照抛——与登记的「三五行 catch」方向一致。
  证据：`packages/sandbox-conformance/src/generated-private-git-fixture.ts:865-877,904-905` + `packages/sandbox-conformance/dist/generated-private-git-fixture.js:580`
- **运行与验收链路**：story spec 在 `apps/api/src/public-surface/private-git-secret-canary.story.spec.ts:1051` 建 fixture，经 test:public-surface 跑**编译后的 dist**（apps/api/package.json:20），CI 入口是 required 的 public-surface-parity job（ci.yml:115-142 `pnpm verify:public-surface`）；turbo test dependsOn [build,^build]（turbo.json:19-23）保证改 src 后 conformance dist 重建。**fixture 的配对自测有三份需保持绿**：apps/api/test/generated-private-git-fixture.test.mjs、generated-private-git-boxlite-native.test.mjs、packages/sandbox-conformance/test/sandbox-conformance.test.mjs:1839-1881。这也解释了为何 F.4 栈引用 dist 行号——直接改 dist 无效，必须改 src 并重建。
  证据：`apps/api/package.json:20`；`.github/workflows/ci.yml:115-142`；`turbo.json:19-23`；`packages/sandbox-conformance/test/sandbox-conformance.test.mjs:1839`

### 机制与环境现实

- **quarantine 机制现状与不用它的依据**：`scripts/quarantined-suites.mjs` 列表自 2026-07-31 已清空（三条目归零），配套 run-suite.mjs 只在 apps/api test:src 与根 test:scripts 生效——**三个目标套件（package 各自 node --test glob + dist spec）本就不在 quarantine 可覆盖的 runner 里**；豁免三字段格式与「空扫描即失败」是 canon 元规则 2/3。约束「不使用 quarantine、目标是修复」与机制现实吻合：往列表里加这三个套件既违背验收也大半无效。
  证据：`scripts/quarantined-suites.mjs:22`；`scripts/run-suite.mjs:86-89`；`docs/refactor/04-rules-registry.md:12-13`
- **复现满载环境的 CI 形态**：package-suites job 用 `pnpm turbo test --filter='./packages/*' --continue` 在单 runner 上并行跑全部包套件（ci.yml:414），app 侧同构（366 行）——这正是 F.2「并行 turbo test 满载下约 1/3 概率红、standalone 全绿」的争用条件；各包套件本体是 `node --test --test-force-exit "test/**/*.test.mjs"`（三个包 package.json:26 一致）。**验收脚本（taskset 限核/重复 N 次）应模拟的就是这条命令行**；GitHub runner 实证也应针对这两个 job 的入口命令。
  证据：`.github/workflows/ci.yml:366,414`；`packages/sandbox-provider-aio/package.json:26`

---

## Archive 路线发现

### 结构模板与前车之鉴

- **最近似先例是归档 change `2026-07-31-release-quarantined-installer-and-terminal-suites`**：整个 scope 就是诊断并释放三个环境依赖 flaky 套件。结构 = proposal 带 per-suite 证据表 + 显式 Non-Goals（"never delete a suite by attrition"、"never loosen an assertion so a case passes"）、一个 modified capability spec（test-suite-discovery，1 ADDED requirement 4 scenarios）、双 track tasks.md（Track 1 diagnose → Track 2 release）、"prove on the GitHub runner, not locally" 独立成验收任务（2.2）。**直接的结构模板**：diagnose→fix 的 track 拆分、runner-proof 验收任务、Non-Goal 措辞都与本 change 的「被测产品语义零改动/不放宽断言」约束吻合。
  证据：`openspec/changes/archive/2026-07-31-release-quarantined-installer-and-terminal-suites/proposal.md`（Non-Goals 56-61 行），tasks.md（tracks 1-2）
- **该先例从未独立执行**——被 close-gate-blindspots-and-ci-hygiene track 7 吸收，归档时只留结案注记把任务映射到吸收方（PR #189, efbb014）；close-gate-blindspots 的 proposal 明确批评「quarantine 列表挂着 3 条 owning change 从未启动的条目」。**要避免的模式**：提出 flake 修复 change 后搁置直到被别的 change 吸收。F.2-F.4 修复方向已知，本 change 应保持小体量、迅速执行而非停车。
  证据：`openspec/changes/archive/2026-07-31-release-quarantined-installer-and-terminal-suites/tasks.md:35-41`；`.../2026-07-31-close-gate-blindspots-and-ci-hygiene/proposal.md:5`

### 血统与债务链

- **close-gate-blindspots-and-ci-hygiene 是操作性惯例的建立处、也是 F.2-F.4 的登记处**：三分法 triage（产品缺陷/过时 harness/环境依赖）、"record, never retry-to-hide"、「记录在案的重跑不是 retry-to-hide」。其任务 8.11 正是本 change 的「记录（不修）」对偶，Not-in-scope 行明确把 aio wall-clock flake 推迟给后续专项 change——**本 flake 专项就是那个被承诺的 change，Why 里应明说**。也隐含本 change 须把 F.2/F.3/F.4 登记条目从「留痕不修」翻转为 resolved 作为自身验收的一部分（镜像 close-gate-blindspots 把工件04 C 表行翻转作验收的做法，proposal.md:19）。
  证据：`openspec/changes/archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/tasks.md`（8.10/8.11 evidence），proposal.md:21；`docs/refactor/04-rules-registry.md:125-171`
- **F.2 的债务链长达四个归档 change，每次「记录不修」的交接都有文档**：enforce-provider-contract-parity 5.4（"Reported, not retried into silence"）→ close-request-boundary-gaps 8.1 → retire-superseded 1.5 → establish-api-module-layout 6.5 → close-gate-blindspots 8.5/8.11。**proposal Why 里应引用该链**——它是「专项修复 change 已到期」的最强论据，也展示了仓库惯例：每次推迟必须写明债务去向。
  证据：`openspec/changes/archive/2026-07-28-enforce-provider-contract-parity/tasks.md:42`；close-gate-blindspots tasks.md 8.11 evidence；`docs/refactor/04-rules-registry.md:130-132`

### 工件与证据格式模板

- **`2026-07-20-isolate-fixture-git-env` 是 test/fixture-only internalOnly、产品零 diff change 的模板**：proposal Impact 声明 "No product code"；surface-impact.json 四公开面 not-applicable + internalOnly changed + verification workflow-gates（requiresWireCompatibilityFixture false）；核心交付物是**确定性模拟敌意环境**的回归测试（投毒 GIT_DIR/GIT_INDEX_FILE 指向旁观者仓库）+ 断言 byte-identical 前后状态 + 带配对单测的小共享 helper。**sidecar 形状与测试模式都复用**：F.4 应模拟提前断连的 git 客户端、断言夹具容忍 EPIPE/ECONNRESET 而其他错误仍传播——确定性敌意环境模拟是本仓库的已验证惯用法，正合「模拟满载/慢环境」验收标准。
  证据：`openspec/changes/archive/2026-07-20-isolate-fixture-git-env/proposal.md`、surface-impact.json、verification-report.md
- **runner-only 失败的证据格式由 close-gate-blindspots 7.2 定调**：写明确切 CI run/job ID、陈述根因、在本地逐字节复现 runner 机制（彼处：在 PATH 尾部种可用 docker stub），然后落修复并把诊断记进被清除条目的头部。6.1/8.4 展示了 pinned-environment web lanes 的同款风格（in-pin 运行、记录阈值）。**本专项验收（taskset 限核或并行重复跑 N 次全绿 + GitHub runner 实证）应按此格式留证**：先本地确定性复现慢 runner 机制，再在 tasks.md 里按 ID 引用 runner 运行。
  证据：`openspec/changes/archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/tasks.md:164-179,151-155`
- **sidecar 逐字段照抄的模板**：release-quarantined 的 surface-impact.json 四公开面 status 'unchanged' + per-surface reason、internalOnly changed 带 scope slug、intent 'developer-workflow'、verification {id: 'workflow-gates', requiresWireCompatibilityFixture: false}；.openspec.yaml 极简（schema: spec-driven, created date）。仓库近期记忆亦警告 opsx-verify 要求 surface-impact.json 存在。本专项是同一姿态（test/fixture only、公开面全不动），复用该形状可零额外工作保持 public-surface-parity 与 opsx-verify 绿。
  证据：`openspec/changes/archive/2026-07-31-release-quarantined-installer-and-terminal-suites/surface-impact.json`、`.openspec.yaml`

### 约束的谱系与 canon 义务

- **wire-orphaned-test-suites 的 design 确立了本 change 刻意拒绝的 fallback**："If a suite proves environment-dependent it moves to a non-default lane with its reason recorded"、"quarantine ... rather than adding retries, which would re-hide the signal"。本 change 的约束（quarantined-suites 机制不使用，目标是修复）**是对该已记录 fallback 的背离，proposal 里应明说**——防止 reviewer（或 verify pass）把套件廉价地路由进 quarantine lane；同一 design 的反 retry 原则仍然适用，禁止把加测试 retry 当「修复」。
  证据：`openspec/changes/archive/2026-07-28-wire-orphaned-test-suites/design.md:53-57`
- **闸门 canon 对本 change 的约束**：每个被改的 gate/fixture 保持配对自测（packages/sandbox-conformance 已有 sandbox-conformance.test.mjs 与 generated-private-git-fixture.ts 相邻）；close-gate-blindspots 的 canon 还期待 injection-probe 式「改动的机制仍能失败」证明（红跑后回滚、证据记入 tasks.md，见其 2.6/3.6/4.3/4.6 记录）。**对 F.4：EPIPE 容忍绝不能静默吞掉所有写错误**——非 EPIPE 错误仍上浮的 injection-probe 式负向测试满足 canon；对 F.2/F.3：可注入时钟重写须保持两条分类路径（'timeout' 与 'indeterminate'）各有断言，因 F.3 登记强调两种行为都正确。
  证据：packages/sandbox-conformance/src/ 列表；`openspec/changes/archive/2026-07-31-close-gate-blindspots-and-ci-hygiene/tasks.md`（canon sweep evidence）
- **修复方向在债务登记里已被裁定，design 可以很短**：F.2 条目把修复先例钉在目标文件内部（"可注入时钟（该文件 1419 行起已有 Date.now stub 先例）"）；F.3 条目同样预批 "injectable clock or separate 预算耗尽 vs wall-clock triggers"。design.md 主要只需补 F.4 的错误容忍边界（哪些错误是协议正常的）和负载模拟验证配方，不需要重新做方案搜索。
  证据：`docs/refactor/04-rules-registry.md:138-140,156-158`

---

## Implications for the proposal

**1. 载体与工件形状（不新建、照模板补齐）**
change 目录与 surface-impact.json 已存在（internalOnly changed + 四面 unchanged + workflow-gates），proposal/tasks/design 须与该 scope 文字一致，sidecar 形状与 release-quarantined/isolate-fixture-git-env 的既定模板吻合，不需要动。proposal 的 Why 须写三件事：(a) 本 change 是 close-gate-blindspots Not-in-scope 明文承诺的承接方；(b) 引用 F.2 四段归档 change 的债务链作为「到期」论据；(c) 明说「不用 quarantine」是对 wire-orphaned-test-suites 已记录 fallback 的刻意背离（且机制现实上 quarantine 也覆盖不到这三个套件——runner 不经过 run-suite.mjs）。Non-Goals 抄 release-quarantined 措辞：不放宽断言、不靠删除减员、不加 retry。验收须包含把 04-rules-registry 的 F.2/F.3/F.4 条目从「留痕」翻转为 resolved。同时吸取 release-quarantined 被吸收的教训：保持小体量、propose 后立即执行。

**2. 三个修复的定案方向（web 先例 + codebase 实证收敛一致）**

- **F.2（成本中）**：产品侧确认零时钟缝、零 diff 约束下不能加 seam——修法全在测试侧。把文件内已验证的 Date.now stub 先例（1419/2160 行）提炼为共享 helper，覆盖全部四处 wall-clock 断言（1279/2281/2760/3313，漏一处即残留）；'sent'-undefined 与 staged ACK 两个竞态用确定性同步点（await socketFactory/事件）补齐，因为 Date.now stub 不控制 setTimeout（src 1362 行真实定时器）。ACK deepEqual 走「钉死顺序」还是「顺序不敏感」须跟随状态机实际承诺。node:test MockTimers 是平台原生替代但标 experimental——手工 stub 既是库内先例又被登记条目预批，为默认选择；MockTimers/fake-timers 作为 design 里记录的备选即可。
- **F.3（成本最低）**：产品 seam（nativeExecutionDeadlineDriver）、接口、默认实现全齐，只差这一个测试用它。给 execWithPoll 工厂传手动 driver（同包 8+ 现成范本直接照抄），拆成两条确定性断言分别钉两条出口：预算耗尽 → 'indeterminate'（轮询循环 break 路径）、schedule 触发 → 'timeout'（预检路径）——与 Quartz/AWS waiters/k8s wait 的「双出口分离」主流先例一致，且满足 canon「两条分类路径各有断言」。
- **F.4（改 src 不改 dist）**：在 `generated-private-git-fixture.ts` 的两条写路径容错——child.stdin 在创建时（任何写之前）挂 'error' 监听、writeCgiResponse 的 response 同样，按 code 白名单只吞 EPIPE/ECONNRESET（涉及 pipeline 则加 ERR_STREAM_PREMATURE_CLOSE），其余照抛；只守 write callback 不够（node #11918）。git 客户端提前挂断是协议正常行为，产品语义零 diff 成立。须配 injection-probe 式负向测试（非白名单错误仍上浮）满足 canon「机制仍能失败」，三份配对自测保持绿，turbo dependsOn 保证 dist 重建。

**3. 验收配方（复现 → 修复 → 证明）**
本地确定性复现优先：`taskset -c 0`（或等效限核）+ `stress-ng --cpu N` 伴跑，针对的命令行就是 CI 两个 job 的入口（`pnpm turbo test --filter='./packages/*' --continue` 与各包 `node --test --test-force-exit "test/**/*.test.mjs"`）——修复前逼出三个失败形态各至少一次（elapsed 超窗 / sockets[0] undefined / wall-clock 先到），修复后同条件重复 N 次全绿（shell 循环即可，node --test 无内置 repeat）。GitHub runner 实证（ubuntu-latest 4 核、taskset 可用）按 close-gate-blindspots 7.2 的证据格式记录：run/job ID + 根因 + 本地复现机制，写进 tasks.md。F.4 另需确定性敌意模拟（照 isolate-fixture-git-env 惯用法）：模拟客户端提前断连、断言夹具存活且非白名单错误仍传播。

**4. 姿态定位（对 reviewer 的预防性论证）**
「修复而非隔离/retry」在三路证据上均站得住：生态文献把 retry/quarantine 定位为短期收容、根因修复为终态；Node core 自己的 suite 用同款「容忍预期错误码 + 确定性等待」修法；仓库 canon（record-never-retry-to-hide）与 quarantine 机制现实（列表已清空、runner 不覆盖目标套件）都指向同一结论。reviewer 若提议 retry-wrapper 或 quarantine lane，可分别指向 Fowler/oneuptime 共识与 wire-orphaned design 的反 retry 原则。
