# 架构重构总计划 — 8 阶段（现行版 V3）

母文档。记录 8 阶段架构重构的动机、阶段定义、依赖关系、已锁定决策与计划级总则。
每个阶段落地为 1–3 个独立的 OpenSpec change；本文档只承载**跨 change 的约束**，
不重复各 change 内部的细节。设计工件在 `docs/refactor/` 下（8 份，见 §6 索引）。

状态：**阶段 0 进行中（设计工件产出）。阶段 1 可并行开工。**

版本沿革：V1 = 五路架构评审后的初版；V2 = 52-agent 交叉验证修订（34 条采纳）；
V3 = explore 拍板后的现行版（12 个决策全部闭环）。**本文档是唯一现行版，
旧版散落在会话记录中，不得作为执行依据。**

---

## 1. 动机（四轮评审的结论摘要）

- **前后端拆分干净**（零越界、契约单一事实源），但边界靠纪律不靠机制。
- **包依赖图为严格 DAG**，但 facade `export *` 泄漏具体 provider 符号，
  边界测试作用域只有 2/51 个目录，闸门给了错误的安全感。
- **模块化治理优秀但领域模型贫血**：guardrails 3,806 行 / 81 方法 god service、
  零领域事件、零仓储层、260 处 Prisma 散落在 45 个文件、tasks↔guardrails
  forwardRef 循环。
- **三条扩展轴成熟度不均**：runtime 轴 A-（编译期全量表+typecheck 夹具），
  镜像轴 B（闭环在但词表漂移），provider 轴 B-（端口优秀、装配层 20+ 处字面量分支，
  cloud-http 物理无法显式选中）。
- **harness 体系方向正确**（10+ 个闸门真实跑在 CI），但部分闸门自身是
  fail-open 的硬编码 allowlist——正是它们被建来消灭的失败模式。

## 2. 阶段总览与依赖

```
阶段0(设计) ──┬─→ 阶段2(扩展轴) ──→ 阶段7a(provider plugin化)
              ├─→ 阶段3(边界前移) ─→ 阶段7b(terminal抽包/lib-api归拢，可插)
              └─→ 阶段4(事件) ─→ 阶段5(仓储+聚合) ─→ 阶段6(归拢)
阶段1(补洞+CI卫生) ── 与阶段0并行，立即可开工
```

- **0→{2,3} 是硬依赖**（接口定稿与 manifest 是它们的输入），不是软引用。
- **4→5→6 是唯一的硬串行链**（DDD 三刀必须按序）。
- 阶段 7 两个 track 相互独立，7a 依赖阶段 2 词表统一，7b 依赖阶段 1 的
  terminal-stories 进 CI。
- 每个阶段 1–3 个 change，粒度以"单 change 可独立 verify + 可独立回滚"为准。

## 3. 计划级总则

1. **发版纪律**：阶段 4/5/6 各自收口必须发一版并做真实自托管栈升级演练。
   self-update 强制跳 latest 且无回滚，禁止把三个阶段聚合成一次大版本发布。
2. **attestation 公开 API**：CI check 显示名与 release.yml 的 SUBJECT 路径集是
   发版 attestation 链路的消费接口，视同公开 API——改名/改路径必须走协调变更，
   不得作为"卫生修复"顺手改。
3. **排序总裁定**：本重构阶段 0–6 整体在 repo-split epic Phase 3（物理拆分）
   之前完成；阶段 2 要新增进 contracts 的词表赶在 epic Phase 1c（contracts
   首次公开发版）之前。依据见 `docs/refactor/05-repo-split-reconciliation.md`。
4. **废弃判据**：确定漂移 + 无使用的在途工件（change/代码/文档）→ 废弃删除，
   不保留"部分完成"状态。
5. **元规则**：任何新架构规则必须是"发现式"或"全量映射式"，禁止硬编码
   allowlist；豁免必须带 reason + tracking change，豁免清单默认为空。

## 4. 各阶段定义

### 阶段 0 — 设计（唯一不改产品代码的阶段）

产出 `docs/refactor/` 下 8 份工件（§6 索引）。12 个决策已全部拍板（§5）。
前置执行项：在途 change 清欠一轮（5 个 complete 归档、simplify-sandbox-image-model
先 opsx-verify 再归档、redesign-settings-single-column 废弃删除）。

验收：8 份工件进仓库；后续每个阶段的 change 都引用它们，不再出现"边做边设计"。

### 阶段 1 — 兑现现有承诺（补洞 + CI 卫生），与阶段 0 并行

- R3：`sandbox-package-boundary.test.mjs` 的符号禁令作用域从 2 个目录扩到全
  `apps/api/src`；存量 dockerode 越界（5 处生产文件）进 ratchet 清单，其中
  `sandbox-environments.validator.ts` 一路注明由阶段 7a 端口化根治。
- R4：`provider-contract-parity-check` 改 glob 发现（`packages/sandbox-provider-*`
  + 递归遍历）；`agent-identity-branch-check` 改补集扫描 fail-closed。
- CI 卫生：boot-smoke 注释矛盾修正；required context 名字漂移**按总则 2 走协调
  变更**（不得直接改名）；`test:cors-headers` 补显式 step；`coverage:sandbox`
  进 CI 或删。
- quarantined：接管在途 change `release-quarantined-installer-and-terminal-suites`
  （0/7），quarantine 清空是其验收。
- 新进 CI：`test:visual` 像素闸门、terminal-stories（阶段 7b 硬前置）、
  **stateful boot-smoke 变体**（带 in-flight running 任务的重启收养路径，
  阶段 4 硬前置）。
- 并入 `scope-agent-context-and-document-layout` 的 task 3.4（CI paths 过滤的
  真实 PR 双向观察），与 required-context 协调变更同一 PR。
- 卫生项：删 `packages/sandbox/src` 6 个死转发文件；`./testing` 子路径依赖归位；
  `apps/api` 接入共享 tsconfig；修 `turbo.json` 失效的 globalDependencies。

验收：所有闸门 fail-closed；ratchet 基线数字落库（见工件 07）。

### 阶段 2 — 扩展轴解锁

依赖：阶段 0 工件 03（接口定稿）。约束：contracts 词表新增赶在 repo-split
Phase 1c 之前（总则 3）。

- 轴 B：`RuntimeArtifactChecksumsSchema` 改 `z.record(RuntimeSchema, …)`；
  contracts 建 `RUNTIME_METADATA` 全量表替换 7 处静默三元；
  `runtime-credentials.tsx` 集合驱动化；`TranscriptReadStrategy` 搭真派发架子。
- 轴 A：**D14 框架内**修操作员配置词表——保留独立声明、显式补 `cloud-http`
  成员、加覆盖对账闸门（不做派生化，见工件 05 对账）。
- 轴 C：source-kind 词表合并为独立 change（前置：simplify-sandbox-image-model
  先归档），含 provider-snapshot 历史快照兼容决策；新词表纳入
  vocabulary-parity 闸门 PAIRS。
- 残存词表收敛：`runtime-model-adapter-snapshot.ts` 手写 union、tmux 会话协议
  双声明（`codex-launch.ts` vs `session-commands.ts`，去重方向=api 侧删除改
  import `@cap-console/sandbox`）、SKILL_CATALOG web↔api 跨端镜像上移 contracts。
- runtime-conformance 套件：以现有 golden 测试为种子建骨架进 package-suites job，
  场景清单含 **secret canary**（见工件 03）。
- cloud-http 参考控制面服务端：协议承诺通电（7 端点最小实现 + conformance 对打），
  作为解锁显式选中的配套。

验收："新增 runtime = 1 声明 + 1 注册 + 查表数据"以假想第三 runtime 的
typecheck 演练自证。

### 阶段 3 — 边界机制前移到 IDE

依赖：阶段 0 工件 02（boundaries manifest）。

- manifest → ESLint 规则生成器 + 同源 CI 闸门（R1/R2 落地）。
- app 内 seam 规则：`apps/web` 出网只经 `real.ts`/`ws-client.ts`，mock/real
  seam 防旁路（存量直连组件进 ratchet）。
- layout-check v2 雏形：读 contexts manifest，报告模式（不拦截）建立
  跨上下文违规 + 层方向违规的 ratchet 基线。

验收：IDE 里写 web→api import 立即标红；layout v2 报告出存量清单与数字。

### 阶段 4 — 领域事件 + guardrails 解耦（DDD 第一刀）

依赖：阶段 0 工件 08；硬前置：阶段 1 的 stateful boot-smoke。

- 事件机制：**进程内同步 emitter**（决策 5），payload 用 contracts zod 声明，
  不落库、零 migration。非事件判据："订阅者需要向发布者返回确认的，是调用不是
  事件"——terminal audit detail 保留显式调用+回执。
- 五个横切关注点（audit 普通路径/metrics/diagnostics/transcript/runner 计费）
  逐个从 guardrails 同步调用改订阅，**一个关注点一个 change**，每个 change 带
  cutover 开关（沿用产品 staged cutover 纪律）。
- 验收标准（修订版）：guardrails 既有 122 测试**分类处理**——行为断言零修改；
  同步顺序钉死的测试显式改写并留痕；目录外 9 个直接 `new GuardrailsService`
  的 spec 纳入安全网；4 个 inline 镜像 `.test.mjs` 同步防漂移。
- 依赖预算 ratchet：guardrails 对五者的直接 import 数只降不升，降到 0 转禁止。
- **路线校准（第二刀产出）**：剩余三组（runner 计费 / diagnostics / transcript）的三判据初判见
  `openspec/changes/adjudicate-audit-event-migration/adjudication.md` §5「阶段 4 剩余三组预扫」，
  第 3–5 刀的 propose 必须以该节为输入。
- 末尾：解 tasks↔guardrails forwardRef 环。
- 收口发一版 + 升级演练（总则 1）。

验收：guardrails 3,806 → <2,000 行；forwardRef 环归零；boot re-adoption
stateful smoke 全程绿。

### 阶段 5 — 仓储推广 + Task 聚合（DDD 第二刀）

依赖：阶段 4。

- 仓储：以 `prisma-task-admission.store.ts` 为模板，四个核心域各建 store；
  "Prisma 只在 `*.store.ts`"进 layout v2 规则，ratchet 燃尽 260 处存量；
  5 个 controller 直查库立即修。
- 聚合：Task 状态机不变量收进纯领域对象（无 Nest/Prisma 依赖），按工件 08
  §B 的不变量清单与 §F 充血判据执行。
- migration 纪律硬验收：新 migration additive-only + N-1 boot 兼容
  （migration 随容器启动自动执行，无 down migration）。
- 收口发一版 + 升级演练。

验收：状态转换合法性单点声明；核心域 Prisma ratchet 趋零。

### 阶段 6 — 目录归拢 + layout v2 转正（DDD 第三刀）

依赖：阶段 4、5。

- 前置清点：路径锚定面（17 个 scripts + 13 个自扫源码 test.mjs + 4 个 spec
  写死 `apps/api/src` 字面路径），产出引用清单；change-freeze/rebase 政策生效。
- task 系 9 目录、identity 系目录按 contexts manifest 归拢；单文件 port
  占位目录收编为上下文内部文件。
- layout v2 转拦截模式 required：上下文无环 + 层方向 + Prisma 位置三规则。
- legacy 共享 AUTH_TOKEN：退役或立带 tracking 的豁免条目（决策项）。
- 收口发一版 + 升级演练。

验收：`apps/api/src` 顶层目录 51 → 7–10；layout v2 空豁免通过；每个路径
引用点已更新且闸门扫描文件数 >0。

### 阶段 7 — 独立重构（两 track 可并行/穿插）

**7a provider plugin 化**（依赖阶段 2）：`SandboxProviderPlugin` 接口落地
（含信任边界声明，见工件 03）；host-harness 改遍历注册；
`deployment-environment.ts` 6 处 family 分支收进 plugin；镜像校验
`validateEnvironment` 收进 provider 端口（根治 api dockerode 越界，阶段 1
ratchet 清零）；前端 `IMAGE_PROVIDERS` 数据驱动。与阶段 2 轴 A 改动合并为
同一 change 序列。

**7b terminal 抽包 + 前端数据层归拢**（依赖阶段 1 的 terminal-stories 进 CI）：
`packages/ui` 拆为 terminal-core（无 React，response profile + 字节语义）+
terminal-react（xterm 绑定）；指纹逐字节不变迁移；tmux 会话管理**留在
`packages/sandbox`**；terminal-core **预留独立仓可能**（决策 6，repo-split
Phase 3 边界图相应标注）；无人用的 Button/Card/Badge 删除。
`apps/web/src/lib/api` 四个 god 文件（5,475 行）按域归拢，防回流规则接入
阶段 3 的 ESLint 生成器。

验收：假想第四 provider 接入演练 = 新包 + 1 行注册；terminal 指纹闸门全程绿。

## 5. 已锁定决策（12 项）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 与 repo-split 的排序 | 重构 0–6 在 Phase 3 前；contracts 词表新增在 Phase 1c 前 |
| 2 | 操作员配置词表修法 | 接受 D14 框架：独立声明 + 补 cloud-http + 覆盖对账闸门，不派生 |
| 3 | CLAUDE.md 收编 | boundaries manifest 为唯一声明源；CLAUDE.md 保留散文但白名单/数字被对账闸门盯 |
| 4 | 漂移半成品处置 | redesign-settings-single-column 废弃删除；判据入总则 4 |
| 5 | 事件机制 | 进程内同步 emitter；不建 outbox；"要回执的是调用不是事件" |
| 6 | terminal-core 仓归属 | 预留独立仓可能（不预设跟 cap-web 走） |
| 7 | 上下文划分 | 7 上下文（工件 01/08），Platform Ops 豁免战术 DDD |
| 8 | guardrails 拆解归属 | Task Execution 上下文（编排残余并入 application 层） |
| 9 | terminal 抽包形态 | core + react 两包（非先一包） |
| 10 | 充血判据 | 仅 ≥2 处重复检查的不变量进聚合；单点校验留 service |
| 11 | 值对象克制 | 只做聚合+状态机，不做 TaskId 全套 VO 仪式 |
| 12 | session-approval-flow | 挂起不删（未启动但方向未被推翻），propose 前重读接缝 |

## 6. 设计工件索引（docs/refactor/）

| 工件 | 文件 | 消费者 |
|---|---|---|
| 01 上下文地图 | `01-contexts-manifest.md` + `contexts-manifest.json` | layout-check v2（阶段 3/6）、阶段 6 归拢 |
| 02 边界清单 | `02-boundaries-manifest.md` | ESLint 生成器 + CI 闸门（阶段 3）、CLAUDE.md 对账 |
| 03 扩展轴接口 | `03-extension-interfaces.md` | 阶段 2、阶段 7a |
| 04 规则登记制 | `04-rules-registry.md` | 全阶段；新规则的准入标准 |
| 05 repo-split 对账 | `05-repo-split-reconciliation.md` | 总则 3；阶段 2/7 的 change 设计输入 |
| 06 在途 change 清欠 | `06-inflight-changes-ledger.md` | 阶段 0 前置执行 |
| 07 量化基线与依赖图 | `07-baselines-and-dependencies.md` | ratchet 基线；各阶段规模校准 |
| 08 DDD 目标架构 | `08-ddd-target-architecture.md` | 阶段 4/5/6 的图纸 |

## 7. 已知风险

| 风险 | 缓解 |
|---|---|
| 阶段 1 改 required context 名断发版 | 总则 2：attestation 公开 API，协调变更 |
| 阶段 4 改订阅动摇既有测试 | 验收分类处理 + 外部 9 spec 安全网 + inline 镜像同步 |
| 阶段 4–6 期间升级重启踩 re-adoption | stateful boot-smoke 硬前置 + 每阶段收口发版演练 |
| 阶段 6 搬目录踩碎路径锚定 | 前置清点 + "扫描数>0"验收 + change-freeze |
| 与 repo-split epic 互相拉扯 | 工件 05 对账表；两 epic 的 change 互引对方约束 |
| 重构期间在途 change 漂移 | 阶段 0 清欠一轮；总则 4 废弃判据 |
