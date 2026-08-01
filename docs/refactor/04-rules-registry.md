# 工件 04 — 规则登记制（rules registry）

架构规则的准入标准、登记格式与通用机制。消费者：全阶段；任何新闸门/新规则
先过本文档再落地。

## A. 元规则（总则 5 的展开）

1. **发现式或全量映射式**：规则的作用域必须是"目录/glob 发现"或"对词表 total
   的 Record 映射"，禁止硬编码枚举清单。反例（阶段 1 要改的）：
   provider-parity 的 3 目录硬编码、agent-identity 的 10 路径清单。
2. **豁免默认为空**：豁免条目必须带 reason + tracking change 引用；无 tracking
   的豁免视为违规（模板：quarantined-suites.mjs 的三字段格式）。
3. **空扫描即失败**：每条规则声明自己的扫描根；glob 命中 0 个文件时规则必须
   失败而非静默通过（防止阶段 6 搬目录后闸门变 no-op；模板：run-suite.mjs:86-89）。
4. **单一声明**：规则数据（白名单、词表、路径）只存在一处；生成器与闸门消费
   同一份（boundaries manifest 模式）。
5. **fail-closed**：新增的受治理对象（新 provider 包、新共享文件）默认落入
   规则射程，而非默认豁免。

## B. 登记格式（RULES 索引）

每条架构规则三件套，登记于本文件 C 表：

```
规则 ID │ 约束一句话 │ 声明源（spec/manifest） │ 执行器（脚本/lint/类型） │ 回路（IDE/pre-commit/CI）
```

新规则的 change 必须同时更新 C 表；opsx-verify 的 evidence lane 引用规则 ID。

## C. 规则总账（阶段 0 时点）

### 已有闸门（收编登记）

| ID | 约束 | 执行器 | 回路 | 元规则达标 |
|---|---|---|---|---|
| G1 | 测试文件必被 runner 发现 | test-discovery-check | CI | ✅ 发现式 |
| G2 | 共享脚手架无 agent 身份分支 | agent-identity-branch-check | CI | ✅ 补集扫描（三字段豁免仅 2 runtime 文件、空扫描即败；close-gate-blindspots 4.4–4.6，注入探针红证已记 tasks.md） |
| G3 | provider 测试走 conformance 账本 | provider-contract-parity-check | CI | ✅ 能力发现（递归扫描建 conformance 的包、零发现即败；close-gate-blindspots 4.1–4.3，发现集含 sandbox-cloud-http） |
| G4 | sandbox-core↔contracts 词表成员集相同 | sandbox-core-vocabulary-parity | CI | ✅ 全量 PAIRS |
| G5 | contracts 导出可达 | contracts-shared-export-check | CI | ✅ |
| G6 | contracts schema 被执行 | contracts-executed-schema-check | CI | ✅ |
| G7 | api 包内别名 import + 目录无环 | api-module-layout-check (v1) | CI | ⚠ 只治 apps/api/src、只检二元环 |
| G8 | console 请求头↔CORS allowlist 一致 | console-request-header-cors-check | CI（显式 step "Console CORS-header gate"，close-gate-blindspots 5.3） | ⚠ transport 枚举待 S1 规则接管 |
| G9 | terminal response profile 指纹 | terminal-response-profile-conformance | CI | ✅ 唯一指纹锚 |
| G10 | public-surface 跨面一致 | public-surface-tests | CI required + hooks | ✅ |
| G11 | api 不碰具体 provider | sandbox-package-boundary.test.mjs | CI | ✅ manifest 全域（roots 由 contexts-manifest.json `scope` 驱动＝S3 登记；存量 5 文件走 `scripts/ratchets/r3.json`；conformance 仅测试文件豁免＝P3；close-gate-blindspots 3.1–3.6） |
| G12 | conformance 参与 total | required-participation.ts | 编译期 | ✅ 类型穷尽 |
| G13 | runtime 声明必注册 | agent-runtime-registration.typecheck | 编译期 | ✅ |

### 新增规则（各阶段落地，此处预登记）

| ID | 约束 | 声明源 | 执行器 | 阶段 |
|---|---|---|---|---|
| R1 | 包级边界（P1–P8） | 工件 02 A 表 → `docs/refactor/boundaries-manifest.json` | ESLint 生成器（`packages/eslint-config/boundaries.js`，15 个 eslint.config 全接）+ CI 同源闸门（`scripts/boundaries-manifest-check.mjs`） | 3 ✅ 已落地（enforce-boundaries-from-manifest：两个消费者各自直读同一 manifest、互不派生；解释器不经 ESLint 管线故 disable 注释无效；manifest 进 turbo globalDependencies 防缓存回放） |
| R2 | app 内 seam（S1–S3） | 工件 02 C 表 → `docs/refactor/boundaries-manifest.json` | 同上 | 3 ✅ 已落地（enforce-boundaries-from-manifest：S1 发现式出网扫描 + S2 capabilities seam 旁路禁令；存量落 manifest 三字段豁免、闸门对失效豁免报红＝shrink-only；S3 按引用登记，不派生第二份执行） |
| R3 | dockerode 全域禁令 | 工件 02 S3 | G11 扩域 | 1 ✅ 已落地（close-gate-blindspots：全 src 符号扫描 + `scripts/ratchets/r3.json` 共享 comparator） |
| R4 | G2/G3 fail-closed 化 | 本文件 A.1/A.5 | 脚本改造 | 1 ✅ 已落地（close-gate-blindspots：G2 补集 + G3 能力发现，均零扫描即败） |
| R5 | 词表单一声明（source-kind 等并入 G4 PAIRS） | 工件 03 A 表 | G4 扩容 | 2 |
| R6 | facade 导出白名单 | 工件 02 P7 | 导出面快照测试 | 1 ✅ 已落地（close-gate-blindspots：`packages/sandbox/test/facade-surface.gate.mjs`，`export *` 即红） |
| R7 | 跨上下文 + 层方向 + Prisma 位置 | contexts-manifest.json（含文件→层判定，本次补齐） | layout v2（`scripts/context-layout-check-v2.mjs`） | 3 报告 ✅ 已落地（enforce-boundaries-from-manifest：三类检查 + unclassified 报告，基线活测写入 `scripts/ratchets/r7.json` 走共享 comparator；v1 闸门字节不动） / 6 拦截 |
| R8 | 操作员词表覆盖对账 | 工件 03 B.2 | 新 parity 脚本 | 2 |
| R9 | 安全 seam 唯一实现 | 工件 02 D 表 → `docs/refactor/boundaries-manifest.json` `securitySeams` | seam 存在性断言（`scripts/security-seam-check.mjs`） | 3 ✅ 已落地（enforce-boundaries-from-manifest：4 个 seam 的路径与唯一性谓词全是 manifest 数据、脚本内零副本；文件缺失/多实现/空集/空扫描一律红） |
| R10 | CLAUDE.md 依赖清单对账 | 工件 02 E 节 + A 表 | 对账脚本（`scripts/claude-md-dependency-reconcile.mjs`） | 3 ✅ 已落地（enforce-boundaries-from-manifest：4 份 governed CLAUDE.md 的依赖段与 A 表比对，段落缺失/不可解析 fail-closed；contracts 与 sandbox 两份段落本次补齐） |
| R11 | 依赖预算（guardrails→五关注点只降不升） | 工件 08 §C | ratchet（`scripts/ratchets/r11-dependency-budget.mjs` + 基线 `scripts/ratchets/r11.json`，CI step「Dependency budget ratchet (R11)」） | 4 ✅ 基线已播种（add-domain-event-bus：六个 collaborator 键位、种子取本树**活测**而非文档抄录，`this.audit` 9 / `this.runnerMinutes` 6 / `provisioningDiagnosticRecorder` 4 / `provisioningDiagnosticWriteGate` 4 / `this.transcripts` 2 / metrics-projection 2；统计口径＝**按符号引用**计，键前缀 `guardrails-symbol-reference:` 就地写死；走共享 comparator 双向 fail-closed；燃尽由阶段 4 五个订阅迁移 change 逐条删条目，最后删文件） |
| R12 | 事件 payload 用 contracts zod 声明 | 工件 08 §C | G5/G6 自然覆盖 | 4 |

## D. ratchet 通用机制

存量违规不阻塞、只防增长：

1. 基线文件 `scripts/ratchets/<rule-id>.json`：`{ count, samples[], change }`；
2. 闸门比对当前计数：> 基线红；< 基线要求同 PR 更新基线（燃尽留痕）；= 通过；
3. 基线到 0 时，规则转常规禁止，ratchet 文件删除；
4. 基线文件的每次下降在 PR 里可见——燃尽曲线即 git log。

阶段 0 已知待建 ratchet 清单见工件 07 §C。

## E. 领域专项规则

- **数据库变更**：migration additive-only + N-1 boot 兼容（migration 随容器
  启动自动执行、无 down migration）；每个含 migration 的 change 必须登记进
  migration 兼容测试的逐条断言。执行器：既有两个 CI 兼容 job + 阶段 5 起的
  change 模板条款。
- **发版**：CI check 显示名 + release.yml SUBJECT 路径集 = attestation 公开
  API（总则 2）；阶段 4/5/6 收口发版 + 升级演练（总则 1）。
- **充血判据**（决策 10）：仅 ≥2 处被重复检查的不变量收进聚合；单点校验留
  service。
- **事件/调用判据**（决策 5）：订阅者需向发布者返回确认的，是调用不是事件。
- **废弃判据**（总则 4）：确定漂移 + 无使用 → 废弃删除，不留部分完成态。
- **路径锚定**：任何写死源码路径的脚本/测试适用 A.3（空扫描即失败）；阶段 6
  前跑一次全量清点（工件 07 §D）。

## F. 债务与留痕登记（close-gate-blindspots-and-ci-hygiene）

### F.1 check 显示名漂移（task 8.8，登记为债务，不改名）

CI check 显示名是被消费的 attestation 公开 API（§E"发版"条）。当前实测状态
（2026-07-31，`gh api .../branches/main/protection/required_status_checks`）：

- **现行 required contexts**：`typecheck + lint + test`、`public-surface-parity`
  ——与 ci.yml 现行 `name:` 一致；
- **历史命名 `typecheck + lint`**（2026-06-18 add-ci-typecheck-gate 时代注册）
  已被 job 改名演化为 `typecheck + lint + test`，但旧名仍散落于历史文档/注释/
  归档 change——引用旧名的文字是漂移残留，遇到即按现行名理解；
- **消费方清单**（改任何显示名必须同 change 更新的面）：main 分支保护
  required contexts；`release.yml` "Verify task model N-1 compatibility
  evidence" 步骤按 `check_name='task model N-1 compatibility'` 查询 check-runs
  （字符串精确匹配）。

处置：**登记，不改名**。改名是一次协调 release.yml + 分支保护的独立 change
（本 change proposal 的 Not-in-scope 项）。close-gate-blindspots 的 ci.yml
diff 已验证：所有既有 `name:` 逐字节不变（唯一含 `name:` 的删除行是注释）。

### F.1b openspec-metadata 验证器不识别 change 整目录删除（登记为债务）

`validateChangedOpenSpecChanges` 对 diff 中出现的 change 路径逐个验证
metadata，但当整个 change 目录被**废弃删除**（总则 4 判据，首例
redesign-settings-single-column）时，验证器把"目录不存在"报成"sidecar/tasks
required 缺失"，pre-commit/pre-push 双双误红。**已在本 change 内修复**：
目录不存在（归档移动或废弃删除）即跳过——被删的 change 没有可验证对象；
目录仍在但 sidecar 缺失依旧报错，误删保护不受影响。配套自测已改写
（原测试把误报行为钉成了规格），死函数 archivedOpenSpecChangeNames 一并删除。
阶段 0 的 commit 1 曾以 `--no-verify` 绕过该误报（当时修复未落地），留痕于此。

### F.2 aio-terminal-session-ownership wall-clock flake（task 8.11 登记，已由 deflake-environment-dependent-suites 修复）

- **现象**：`packages/sandbox-provider-aio/test/aio-terminal-session-ownership.test.mjs`
  在并行 `turbo test` 满载下约 1/3 概率红在 wall-clock 断言
  （如 `AssertionError: elapsed=81`，断言 `Date.now() - startedAt < timeoutMs`
  一类紧余量计时），standalone 3/3、10/0 全绿。四个归档 change
  （2026-07-28 enforce-provider-contract-parity 5.4 起）连续记录且从未
  retry-to-hide。
- **三分法分类**：**environment-dependent**（环境依赖的计时敏感）。非
  product defect——被测 reconnect 状态机行为正确，失败面是测试对真实
  时钟的紧余量断言在 CPU 争用下超窗；非 stale harness——断言对象
  （316 行 reconnect 状态机的超时预算）就是该套件的被测语义，不是过时
  脚手架。
- **追证（2026-08-01）**：docs-only PR #190（基于 main 原样代码）复现该套件
  失败（1856 行 `Cannot read properties of undefined (reading 'sent')`，
  同套件的竞态形态）——铁证该 flake 存在于 main、与 close-gate-blindspots
  的改动无关。
- **处置：已解决（resolved）**——change
  `deflake-environment-dependent-suites`（2026-08-01）在根因处修复：
  提炼共享 `withManualReleaseClock` 注入时钟 helper（源自该文件既有
  `Date.now` stub 先例，finally 强制恢复），四处紧余量 wall-clock 断言
  全部改读注入时钟（数值预算未放宽），'sent'-undefined 竞态与
  staged-ACK 断言改为同步点后的确定性断言。产品 `src/` 零改动。
  修复前满载复现 6/12 rep 失败、修复后同配方 24 连续 rep 全绿；
  完整证据（CI run/job ID、根因、复现命令）见该 change tasks.md 的
  Evidence F.2 条目。

### F.3 boxlite-client 1ms-timeout settlement flake（PR #189 首现，已由 deflake-environment-dependent-suites 修复）

- **现象**：`packages/sandbox-provider-boxlite/test/boxlite-client.test.mjs` 的
  `execWithPoll({status:'running'}, 1)` 断言 settlement === 'indeterminate'
  （poll 预算耗尽路径），GitHub runner 满载下 1ms 真实时钟先越线走 'timeout'
  出口（错误消息 "settlement is timeout"），package-suites job 红；本地
  standalone 通过。本 change 对该文件零改动（最近改动 34c8611）。
- **三分法分类**：**environment-dependent**——被测的
  `classifySandboxCommandExecutionRejection` 对 timeout/indeterminate 两条
  路径行为均正确；失败面是测试用 1ms 真实时钟做路径选择，慢机上选路不稳定。
- **处置：已解决（resolved）**——change
  `deflake-environment-dependent-suites`（2026-08-01）在根因处修复：
  1ms 真实时钟测试改为经既有产品 seam（`nativeExecutionDeadlineDriver`，
  `boxlite-client.ts:165-168,351-352,2280-2354`，未新增 seam）注入手动
  deadline driver，两条分类出口分别钉死确定性断言（poll 预算耗尽 →
  `'indeterminate'`、deadline 触发 → `'timeout'` 且轮询循环零进入）。
  产品 `src/` 零改动。修复前 cgroup CPU 配额（1ms/10ms CFS slice）第 6
  迭代复现 CI 同签名失败、修复后同配方 10/10 连续 rep 全绿；完整证据见
  该 change tasks.md 的 Evidence F.3 条目。

### F.4 private-git fixture EPIPE 竞态（PR #191 首现，已由 deflake-environment-dependent-suites 修复）

- **现象**：public-surface-parity（required）在 openspec-only PR #191 上红：
  `private-git-secret-canary.story.spec` 的 test 39 以 uncaughtException
  `write EPIPE` 失败，栈在 `packages/sandbox-conformance` 的
  `generated-private-git-fixture` `runGitHttpBackend`（socket.end 写入时
  对端已断连）。该 PR 仅动 openspec/docs，spec 亦不引用 openspec 路径。
- **三分法分类**：**environment-dependent**——git http-backend 客户端提前
  断连是正常协议行为，fixture 未捕获对已关 socket 的写错误，慢 runner 上
  竞态窗口更宽。非 product defect、非 stale harness。
- **处置：已解决（resolved）**——change
  `deflake-environment-dependent-suites`（2026-08-01）在根因处修复：
  `guardGeneratedPrivateGitWriteStream` 在两条 fixture 写路径
  （backend `child.stdin` 与 CGI `ServerResponse`）的流获取时刻挂
  白名单 `'error'` 监听（仅吞 `EPIPE`/`ECONNRESET`，白名单单点声明，
  其余错误一律重抛）；可失败性由注入探针负测（非白名单 code 必须上浮）
  与确定性对抗测试（早断连 → fixture 存活并继续服务）双重钉住。
  修复前确定性对抗模拟 3/3 复现 uncaughtException `write EPIPE`、
  修复后套件 10 连续 rep 全绿 + `test:public-surface` 全绿；完整证据见
  该 change tasks.md 的 Evidence F.4 条目。
