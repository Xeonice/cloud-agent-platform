# extract-runner-minutes-ledger 调研结论（research-findings）

> 本刀是阶段 4 的「最小验证刀」。它的第二件产出不是代码，而是这份工件：把阶段 4 **剩余每一个节点**
> 的前置条件、推荐形态与预估收益，从推断变成**带命令的可证伪记录**。
> 同位工件是第二刀的 `adjudication.md`（`openspec/changes/archive/2026-08-05-adjudicate-audit-event-migration/`）。
>
> **写者分工（单写者纪律）**：本文件由 range B 调研轨创建并写满「预测」单元格与前置条件图；
> §2 结果表里**本刀自己那一行的五个单元格留空**，由集成轨任务 5.9 在**集成后的树上实测**追加。
> 调研轨不得预填那一行——它是唯一与集成轨共享的工件，靠「一阶段一个写者」保持可审。

## §0 口径与测量环境

1. **每一个数字都必须带标签**：`【实测】`= 在本树跑命令得到；`【预测】`= 尚未发生，
   **必须紧跟一条能证实或证伪它的命令/测量**。没有证伪手段的估值在本文件里算缺陷，不算内容
   （这条纪律是因为「diagnostics/transcript 各约 30 行」这类无出处估值曾在本 change 自己的
   工件里被引用了一整轮才被复测推翻）。
2. **产品决定 ≠ 测量结论**。凡是位置由人拍板而非由测量决定的节点，本文件用「这是决定」原话写明，
   不伪装成发现。
3. **测量环境**（本树，2026-08-05）：
   - `wc -l apps/api/src/guardrails/guardrails.service.ts` → **4,131**【实测】
   - `node scripts/context-layout-check-v2.mjs` → exit 0，`scanned 282 file(s)`，
     `cross-context-import: 136 / layer-direction: 2 / prisma-outside-store: 60 / unclassified-file: 132`【实测】
   - `node scripts/ratchets/r11-dependency-budget.mjs` → exit 0（六个协作者 9/6/4/4/2/2）【实测】
   - 即：以下所有增量都是从**一棵绿树**上量出来的。
4. **共享 comparator 双向 fail-closed**：`scripts/ratchets/comparator.mjs` 把「低于基线」判为
   与「高于基线」**同等的红**。因此本文件里任何「某条计数会下降」的预测，落地时都必须与基线
   收缩在**同一个 commit**，否则闸门红在收缩缺失上，而不是红在改动上。

---

## §1 Mikado 前置条件图（阶段 4 剩余节点）

**决定的顺序（用户，2026-08-05）**：
`legacy inline-admission 退役 → diagnostics → transcript → metrics-projection → 编排体拆分`，
以 legacy 退役为根节点。这是**产品决定**，其可测量的支撑只有一条（见 §7），其余排序理由属选择。

```
  ┌──────────────────────────────────────────┐
  │ N1  legacy inline-admission 退役          │  前置：none（根节点）
  │     apps/api/src/inline-admission/        │  ⚠ 有一条非代码前置：生产是否仍走 legacy（§3.1）
  └───────────────┬──────────────────────────┘
                  │ 这条边只做一件事：让 guardrails.service.ts:731/:732
                  │ 两处透传随适配器字面量一起消失，从而把 N2 的地板从 4 压到 2
                  ▼
  ┌──────────────────────────────────────────┐
  │ N2  diagnostics                           │  前置：N1（仅为地板 4→2；N2 本身不被 N1 阻塞）
  │     recorder 4 + writeGate 4 = 8          │
  └───────────────┬──────────────────────────┘
                  │ 无依赖边（排序选择）
                  ▼
  ┌──────────────────────────────────────────┐
  │ N3  transcript                            │  前置：**none**（显式）——第三位是选择不是依赖
  │     this.transcripts 2                    │
  └───────────────┬──────────────────────────┘
                  │ 无依赖边（排序选择）
                  ▼
  ┌──────────────────────────────────────────┐
  │ N4  metrics-projection                    │  前置：**none**（显式）
  │     SemaphoreProjectionSource 2           │
  └───────────────┬──────────────────────────┘
                  ▼
  ┌──────────────────────────────────────────┐
  │ N5  编排体拆分                             │  前置：N1、N2、N3、N4 **全部**
  │     协作者接线之外的残余                    │  理由见 §4：它的规模只有在四组都摘掉之后才是残差而非猜测
  └──────────────────────────────────────────┘
```

**读法**：N2 的前置边是**地板前置**而不是启动前置——不等 N1 也能做 N2，只是那样 N2 停在 8→4，
之后 N1 落地时再自动掉到 2。N3/N4 写的是显式 `none`，所以它们排在第三、第四位这件事，
在图上就看得出是**排序选择**，不是依赖。N5 的前置是四条全依赖，因为「编排体有多大」这个数字
在四组摘干净之前只是减法残差（这正是本 change 复测推翻过的那类数字，见 §4）。

已完成的节点（不在图上，仅作参照）：`this.audit` 组由第二刀裁定为 **CALL×9 / EVENT×0 / REMOVED×0**
（`scripts/ratchets/r11.json` 的 `this.audit` 条目 `change` 字段）；runner 组即本刀。

---

## §2 结果表（本 change 实测的五个维度）

列即本 change **真正测量过**的五个维度，不多不少：

| 节点 | guardrails 行数差 | R11 计数差 | r7 跨上下文差 | forwardRef 环受影响边数 | 测试文件改动数 |
|---|---|---|---|---|---|
| **runner（本刀）** | 【实测】**+42**（4,131 → 4,173）。删除的转发访问器连文档注释共 5 行，被端口接线的净增覆盖：三个成员声明（`ownedRunnerMinutes` / `detachedRunnerMinutes` / `runnerMinutes` getter）及其文档注释、`onModuleInit` 里的 try/catch 解析块。**本刀在行数这一维是负收益**——这正是 §5 用结构判据取代「行数目标」的实证 | 【实测】**6 → 5**（−1）。用闸门自己的 `measureSource` 跑集成后的 `guardrails.service.ts` 量得 `this.runnerMinutes` = 5；`pnpm test:dependency-budget` 退出 0。对账：6 − 5 = 1，恰为删掉的那条读引用 `return this.runnerMinutes.intervals();`，与 `scripts/ratchets/r11.json` 同名条目 `change` 字段所写的「FIRST DECREASE 6 → 5」逐字一致 | 【实测】`cross-context-import:apps/api/src/guardrails/guardrails.service.ts` **9 → 8**（−1，账本导入改为 `*.port.ts` 合法形态）；`cross-context-import:apps/api/src/metrics/metrics.service.ts` **2 → 2 不变**；`unclassified-file:.../runner-metrics/{runner-minutes,metrics-projection}.ts` 两条仍在且均为 1；**无新键、无计数上升**（comparator 双向 fail-closed，`node scripts/context-layout-check-v2.mjs` 退出 0 即钉死这些值） | 【实测】**0**。`guardrails.module.ts` 的 `forwardRef(` 出现处 1 → 1，`metrics.module.ts` 0 → 0，新增的 `runner-minutes.module.ts` 为 0——本刀一条环边都没拆掉，端口是**新增**的直边而非替换环边 | 【实测】**7**。改 3：`metrics.verify.test.mjs`、`task-resource.test.mjs`、`terminal-diagnostics-metrics.service.spec.ts`（三个存根按 §8 的 assertion-rewrite-ledger 重述）；新增 3：`runner-minutes-derivation.test.mjs`（特征化）、`runner-minutes-ledger.port.test.mjs`（端口）、`runner-minutes-ownership.integration.test.mjs`（集成轨自己的 5.3/5.11 证明）；另改闸门自测 `scripts/ratchets/r11-dependency-budget.test.mjs`。`apps/api/src/guardrails/` 下 **0** 个 |
| N1 legacy 退役 | 【预测】−70 行（`node -e` 量 `inlineAdmission` 命名行 15 + 适配器字面量含注释 678–733 共 56，去重 1 行） | 【预测】diagnostics 组 8 → 6（recorder 4→3、writeGate 4→3） | 【预测】删 8 个 r7 键 / 9 条 finding；`guardrails.service.ts` 自身 **不变** | 【预测】0 | 【预测】≥1（`inline-admission-domain-event-publishing.spec.ts` 整文件随目录消失） |
| N2 diagnostics | 【预测】−64 ~ −80（两个 wrapper 的方法体 2948–3011 共 64 行、3016–3031 共 16 行；声明行分别是 `:2946`/`:3014`，签名与文档注释另计。取值取决于是否整体外迁） | 【预测】8 → 4（legacy 存活）/ 8 → 2（legacy 退役后） | 【预测】`guardrails.service.ts` 9 → **8**（抽走两个 wrapper 即带走 `:142` 的 observer adapter import）；再带走 settle 路径才 → **7**（`:138` 的 primary classifier）。⚠ `:137` 的 write-gate `*.port.ts` import **本来就不是 finding**（`.port.ts` 是合法形态），所以反转闸门本身不动 r7 | 【预测】0 | 【预测】≥3 |
| N3 transcript | 【预测】−23（`captureTranscript` 2096–2118 整体） | 【预测】2 → 0（条目按归零纪律**删除**，不写 0） | 【预测】不是「下降」而是**重键**，见 §3.3 陷阱 (3) | 【预测】1（两条组成边中的 guardrails→tasks 那条） | 【预测】≥2 |
| N4 metrics-projection | 【预测】−28（`semaphoreProjection()` 3850–3876 共 27 行 + import `:108`） | 【预测】2 → 0（同样删条目） | 【预测】`guardrails.service.ts` −1（`:108` `@/runner-metrics/metrics-projection`） | 【预测】0 | 【预测】≥2 |
| N5 编排体拆分 | 【预测】区间见 §4，**不是**一个点估值 | 【预测】0（编排体不点名协作者） | 【预测】未知——取决于切法，不预设 | 【预测】0 ~ 1 | 【预测】未知 |

**runner 那一行的测量出处**（集成轨任务 5.9，2026-08-05，集成后的树）：

| 单元格 | 跑的命令 |
|---|---|
| 行数差 | `git show main:apps/api/src/guardrails/guardrails.service.ts \| wc -l` → 4,131；`wc -l apps/api/src/guardrails/guardrails.service.ts` → 4,173 |
| R11 计数差 | `measureSource` 直接跑集成后的源码（`measured['guardrails-symbol-reference:this.runnerMinutes']` = 5，其余五个协作者 9/4/4/2/2 逐字未动）＋ `pnpm test:dependency-budget` 退出 0 |
| r7 跨上下文差 | `node scripts/context-layout-check-v2.mjs` 退出 0（`scanned 285 file(s)`，`cross-context-import: 135`）＋ 读 `scripts/ratchets/r7.json` 四条相关键 |
| forwardRef 边 | `grep -c 'forwardRef(' ` 逐个模块，与 `git show main:` 的同名文件对照 |
| 测试文件改动数 | `git diff --name-only` ＋ `git ls-files --others --exclude-standard`，过滤 `*.spec.ts` / `*.test.mjs` |

> **这一行最该被后续作者读到的一格是第一格**：行数 **涨了 42**。本刀是阶段 4 的最小验证刀，
> 它验证出来的第一件事就是「把状态所有权迁出去」与「让 guardrails 变短」不是同一件事——
> 端口化要付出成员声明 + 解析块 + 文档的固定成本，而被移走的读面只有 5 行。
> §5 用结构判据替换数字目标的决定，在本行拿到了它的第一份实测支撑，不再只是论证。

**每一格预测的证伪命令**（§0 纪律 1 的兑现）：

| 预测 | 证实/证伪它的命令 |
|---|---|
| 任意「行数差」 | 落地后 `wc -l apps/api/src/guardrails/guardrails.service.ts` 与本表的 4,131 起点相减 |
| 任意「R11 计数差」 | `pnpm test:dependency-budget`；或直接 `import { measureSource } from 'scripts/ratchets/r11-dependency-budget.mjs'` 跑改动后的源码（本文件 §3.2 的三个模拟就是这么量的） |
| 任意「r7 跨上下文差」 | `pnpm test:context-layout-v2`；逐条 finding 用 `analyzeLayout({root, manifest})` 过滤文件名打印 |
| 任意「forwardRef 环受影响边数」 | 数 `guardrails.module.ts` / `tasks.module.ts` 里 `forwardRef(` 的出现处并判断它们是否只由 `*.module.ts` 写出（今天：是，见 §5.2）；**今天没有闸门测它**，所以这一列的预测只能靠人工复核，这本身就是 §5.2 判据 (d) 存在的理由 |
| 任意「测试文件改动数」 | `git diff --name-only` 过滤 `*.spec.ts` / `*.test.mjs` |
| N1 的「生产是否仍走 legacy」 | **不可从本树测量**——见 §3.1 的运营查询步骤 |

---

## §3 逐节点详表

### §3.1 N1 · legacy inline-admission 退役（根节点，前置 none）

**规模【实测】**（`wc -l apps/api/src/inline-admission/*.ts`）：

| 文件 | 行数 |
|---|---|
| `inline-admission.pipeline.ts` | 967 |
| `inline-admission.port.ts` | 198 |
| `inline-admission-state.ts` | 100 |
| `inline-admission.entry.ts` | 75 |
| 生产代码小计 | **1,340** |
| `inline-admission-domain-event-publishing.spec.ts` | 245 |
| 目录合计 | **1,585** |

**反向端口（单元 → 编排器）成员数 = 20**【实测】：`guardrails.service.ts:682-733` 的适配器字面量里
深度 1 的键计数。抽取当天（`archive/2026-07-29-isolate-legacy-admission-behind-capability-policy/track-3-recut.md` §5）
记的是 **18**，即这条反向面在抽取之后**又长了 2 个成员**——它没有随「已判定退役」而冻结。
**正向入口（编排器 → 单元）成员数 = 10**【实测】（`inline-admission.entry.ts` 的 `InlineAdmissionPort`：
`run` / `abortProvisioning` / `resolveTerminalDiagnosticAttempt` / `providerBoundaryCrossed` /
`cleanupNotRequired` / `markCleanupNotRequired` / `settleTerminalPrimary` /
`settleProvisioningSupersession` / `rememberBegunAttempt` / `forget`），与抽取当天记录一致。

**随它离开 guardrails 的行【实测】**：命名该管线的行 15 条
（`:102` `:103` `:554` `:682` `:2317` `:2574` `:2577` `:2596` `:2603` `:2666` `:2878` `:2937`
`:2975` `:2989` `:3047`），其中 `:682` 落在适配器字面量内；字面量本体 `682-733` 共 52 行，
连它自己的说明注释是 `678-733` 共 56 行。合计 **≈70 行**（14 + 56）。
⚠ 这是**保守口径**：它只数「点名了管线的行」与那段字面量，不含 11 个调用点所在方法里
仅服务 legacy 分支的语句——那部分不能靠符号计数量出来，要靠真的切一刀。

**它移除的闸门条目【实测】**（`grep -n 'inline-admission' scripts/ratchets/r7.json`）：

| 类别 | 键数 | finding 数 |
|---|---|---|
| `cross-context-import:…/{inline-admission-state,inline-admission.entry,inline-admission.pipeline,inline-admission.port}.ts` | 4 | 5（pipeline 为 2） |
| `prisma-outside-store:…/inline-admission.pipeline.ts` | 1 | 1 |
| `unclassified-file:…/{inline-admission-state,inline-admission.entry,inline-admission.pipeline}.ts` | 3 | 3 |
| 合计 | **8** | **9** |

**它不移除什么**：`cross-context-import:apps/api/src/guardrails/guardrails.service.ts` 的 9 条 finding 里
**没有一条**是 `@/inline-admission/*`——`:102`/`:103` 两条 import 与 guardrails 同属 `task-execution`
上下文，闸门根本不计。所以 legacy 退役对 guardrails 自身的 r7 数字是 **0**【实测：`analyzeLayout`
过滤该文件，9 条依次是 forge×3(`:94/:95/:96`)、sandbox(`:101`)、runner-metrics×2(`:108/:109`)、
agent-runtime(`:125`)、task-provisioning-diagnostics×2(`:138/:142`)】。

**R11 效应【实测·模拟】**：删掉 `:731`/`:732` 两处透传后，`measureSource` 报
recorder 3 / writeGate 3（组 8 → 6）。它真正的价值不在这 2，而在把 N2 的地板从 4 压到 2（§3.2）。

**唯一一条本树测不出的前置条件**：**生产是否仍有任务走 legacy 路径。**
判定路径本身是纯代码的——`apps/api/src/task-admission/admission-mode-policy.ts` 把
`disabled` / `deployment_attestation_{missing,invalid,expired}` / `worker_report_{missing,unexpected}` /
`worker_capability_missing` / `worker_not_ready` 等每一种「durable 能力未被证明」的理由
**全部映射为 `legacy`**（`:76-88`）——但**这些理由在生产当下是否成立**取决于运行环境，源码答不了。
- **运营必须查的端点**：`GET /v1/tasks/:id/provisioning-diagnostics`
  （`apps/api/src/v1/v1-task-provisioning-diagnostics.controller.ts:17` 的 `v1/tasks` 前缀 + `:23` 的路由；
  控制台同名只读面在 `task-provisioning-diagnostics-console.controller.ts:23/:29`），
  其响应逐条带 `admissionMode`（`task-provisioning-diagnostics.projection.ts:21/:51/:97/:139`）。
- ⚠ **不能把「查不到 legacy 行」当成「没有 legacy 流量」**：诊断写闸门是 default-closed
  （`task-provisioning-diagnostics-write-gate.port.ts:46-48`，只有
  `CAP_TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED` 为 `1`/`true` 才写）。闸门关着时一行都不落。
  所以正确问法是两步：先确认该 env 在目标部署上是开的，再查一段时间窗内的 `admissionMode` 分布。
  **本文件不替运营假设任何一边。**

**公开面位置取决于产品决定（本节点独有）**：剩余五个节点里，只有 N1 的公开面结论不是「内部重组」。
退役 legacy = 在 durable 能力未被证明时**拒绝准入**，而今天是**降级到 legacy 继续受理**。
这是任务创建端点上的**行为变化**，不是内部重排——因此 N1 的 `surface-impact.json` 需要产品拍板，
而不是照抄本刀的 `unchanged`×4。**这是决定，不是测量。**

### §3.2 N2 · diagnostics（recorder 4 + writeGate 4 = 8）

**8 处引用的活行号【实测】**（`measureSource` 输出，非人工抄写）：

| 角色 | recorder | writeGate |
|---|---|---|
| 构造参数（第 9、第 10 个） | `:654` | `:657` |
| 透传进 legacy inline-admission 适配器 | `:731` | `:732` |
| `tryBeginProvisioningDiagnostics` 局部 | `:2950` | `:2949` |
| `tryResumeProvisioningDiagnostics` 局部 | `:3018` | `:3017` |

**两个地板，不是一个天花板**（这是本节最重要的一条纪律：给一个数字会让下一位作者把它当承诺）：

- **8 → 4，legacy 存活时**【实测·模拟】
- **8 → 2，legacy 退役后**【实测·模拟】
- **8 → 0 靠重构不可达**【实测 + 规范推理】

**8 → 0 为什么不可达**：`:654`/`:657` 是构造函数的**第 9、第 10 个参数**
（顺序实测：moduleRef, creds, sandbox, config, provisionLookup, audit, prisma, transcripts,
**provisioningDiagnosticRecorder**, **provisioningDiagnosticWriteGate**, bus）。
现行 `domain-event-bus` 能力的场景 *The bus is the trailing constructor parameter* 逐字要求
「the preceding **10** parameters keep their existing order and types」。删掉这两个参数会让 bus 从
第 11 位变第 9 位，使那条场景**字面为假**。因此 0 不是一次重构，而是
「一次 spec MODIFY + 13 个位置构造点」的联合改动：
`new GuardrailsService(...)` 全树 **22 处 / 15 文件**，其中**传满 ≥9 个实参**（即真正落到这两个位置上）
的有 **13 处**，**9 处在 `apps/api/src/guardrails/` 之外**【实测：括号配平数顶层逗号】，
而目录外 `*.spec.ts` 的合法编辑范围被现行 spec 限定为「加/省尾部可选 bus 实参」。

**推荐形态与它的实测代价**：**反转写闸门（关闭时注入 no-op recorder）**，
**并且与抽出两个私有 wrapper 方法（`tryBeginProvisioningDiagnostics` `:2946`、
`tryResumeProvisioningDiagnostics` `:3014`）配对**——不是抽一个 service。
三次模拟都用闸门自己的 `measureSource` 跑在**模拟源码**上，不是断言：

| 模拟 | 做了什么 | recorder | writeGate | 组 |
|---|---|---|---|---|
| BASELINE | 活树原样 | 4 | 4 | **8** |
| SIM 1 | 只反转闸门（两处 `const gate = this.provisioningDiagnosticWriteGate;` 随其分支消失） | 4 | **2** | **6** |
| SIM 2 | SIM 1 + 两个 wrapper 整体外迁（两处 `const recorder = …` 随之离开） | **2** | 2 | **4** |
| SIM 3 | SIM 2 + legacy 退役（`:731`/`:732` 随适配器字面量消失） | **1** | **1** | **2** |

**诚实地读这张表**：反转闸门**单独**做只有 WriteGate **4 → 2**（不是 4 → 0），组停在 **8 → 6**——
因为 legacy 管线自己独立询问闸门，且构造参数 `:657` 不随任何抽取消失；
配上两个 wrapper 的抽取才到 **8 → 4** 这个地板。
（复现：`import { measureSource } from 'scripts/ratchets/r11-dependency-budget.mjs'`，
按上表描述删行后对文本调用它。）

**归属**：目标上下文 `task-provisioning-diagnostics` 已在 `docs/refactor/contexts-manifest.json`
划给 `sandbox-provisioning`，**无需改 manifest**。

### §3.3 N3 · transcript（`this.transcripts` 2），前置 **none**

**前置 none 是显式的**：它排在第三位是排序选择，没有任何节点必须先于它。

**活引用【实测】**：`:2110` `if (!this.transcripts) return;` 与 `:2112` `await this.transcripts.capture(taskId);`，
两处都在 `captureTranscript`（`2096-2118`，23 行）内。

**环的真相**：`tasks ↔ guardrails` 的 forwardRef 环今天由**两条边**组成——
`guardrails.module.ts:59 imports: [forwardRef(() => TasksModule)]`（其 tasks 侧唯一需求是 `:11`
的 `SessionTranscriptService`）与 `tasks.module.ts:57 forwardRef(() => GuardrailsModule)`
（为 `GUARDRAILS_SERVICE_TOKEN`）。抽走 transcript 只消掉其中**一条**。
**而今天没有任何闸门在测这个环**：`scripts/context-layout-check-v2.mjs` 里 `cycle` 零命中；
`monorepo-foundation` 能力把「只由 `*.module.ts` 写出的互相依赖」显式列为 composition 豁免
（场景 *Module composition may be mutual*），而这两条边**恰好都写在 `*.module.ts` 里**
【实测：`grep "from '@/tasks" apps/api/src/guardrails/*.ts` 的非 spec 命中只有
`guardrails.module.ts:3` 与 `:11`】。**本刀移除 0 条边。**

**完成时序不会因为抽取而自然消解**：NestJS 对同一 module 内多个 provider 的生命周期钩子
**不保证**拓扑顺序（与本仓 `onApplicationBootstrap` 跨 provider 无序导致活任务被误判 failed 的
生产事故同构）。`captureTranscript` 的注释（`:2096-2107`）把义务写得很清楚：capture 必须
**先于** stop-only `teardownSandbox`，容器还在时落盘。

**§3.3-a 时序义务怎么验（3.5）**：抽取后，happens-before 必须由 teardown 路径上的
**显式 `await`** 承担，并用**顺序断言**验证——fake 记录调用序列，断言 `capture` 的完成早于
`teardownSandbox` 的调用——**不用 sleep/超时**（否则测试结论随机器速度漂移）。
【预测】标签：这是预测，不是实测。**证实/证伪它的测量**：在抽取后的树上跑那条顺序断言测试；
若它在不加 `await` 的实现下**仍然绿**，说明断言写松了（多半断在调用发起而不是完成上），
预测被证伪的方式是「测试无法区分有无 await 的两种实现」。

**§3.3-b 它不是一次文件搬家（3.6）——四个实测陷阱**：

1. **非可选注入的 token 被 provide 但没被 export。**
   `SessionTranscriptService` 在 `:80` 用 `@Inject(AGENT_RUNTIME_REGISTRY_TOKEN)` **非可选**注入；
   该 token 由 `tasks.module.ts:107` 提供，而该 module 的 `exports` 只有
   `[TasksService, TASK_OPERATIONS, SessionTranscriptService]`——**token 不在其中**【实测】。
   新 module 必须自己重新 provide，否则**启动期 DI 解析失败**（不是运行期降级，是起不来）。
2. **tasks 目录里的 controller 反向 import 被搬走的单元。**
   `apps/api/src/tasks/session-cast.controller.ts:12` `import { resolveWorkspaceDir } from './session-transcript.service'`【实测】。
   今天是同目录 import（不计）；服务搬走后它变成**跨上下文 import**，把那个 controller 的 r7 计数
   **抬高**——而 r7 是**向上 fail-closed** 的。
3. **r7 条目按路径为键，所以搬家是重键不是缩减。**
   被搬走的文件今天持有两个键：`cross-context-import:apps/api/src/tasks/session-transcript.service.ts`
   count 2 与 `prisma-outside-store:apps/api/src/tasks/session-transcript.service.ts` count 1【实测】。
   搬走后这两个**旧键测不到**（新路径下会长出新键），而 comparator 对「低于基线」判红同样严厉，
   且明写「a zero-count entry is a stale shell, delete the entry」。**旧键必须在同一 commit 删除、
   新键同一 commit 落库。** 与陷阱 (2) 合看更清楚：留在原地的
   `cross-context-import:…/session-cast.controller.ts`（今天 count 1，内容是
   `@/session-recording/recording-policy`）会因为那条反向 import 变成跨上下文而**升到 2**——
   一个键往下漂、另一个键往上漂，两边都要在同一个 commit 里对齐。
4. **未声明的新顶层目录是硬 `exit 1`，不是一条 finding。**
   `context-layout-check-v2.mjs` 在比对基线**之前**就检查 `unmappedDirectories`，命中即
   `exitCode: 1` 并报「belongs to no context in the manifest … declare it in contexts-manifest.json」【实测：
   `:571-580` 的提前 return】。所以 manifest 声明必须与目录**同 commit**落地。

### §3.4 N4 · metrics-projection（`SemaphoreProjectionSource` 2），前置 **none**

**前置 none 是显式的。** 活引用【实测】：`:108` 的 `import type { SemaphoreProjectionSource } from '@/runner-metrics/metrics-projection'`
与 `:3861` 的返回类型；宿主方法 `semaphoreProjection()` 在 `3850-3876`（27 行）。
它与本刀是同一类形态（guardrails 停止向外导出投影即归零），且 `:108` 恰好是
`guardrails.service.ts` 那 9 条 r7 finding 中的一条——**这一节点是本刀的直接同位物**，
本刀摘的是 `:109`，它摘 `:108`。
【预测】R11 2 → 0，**按归零纪律删条目而不是写 0**；证伪命令 `pnpm test:dependency-budget`。

### §3.5 N5 · 编排体拆分，前置 = N1 + N2 + N3 + N4

它等的不是接口，而是**数字**：在四组摘干净之前，「编排体有多大」只是减法残差，
而本 change 已经复测推翻过一个这样的残差（见 §4）。规模区间见 §4，**不给点估值**。

---

## §4 阶段 4 的验收算术（摆在明处，不放脚注）

**这一节存在的原因**：本 change 自己的工件曾把「diagnostics/transcript 各约 30 行」
一路传递下去，而那两个数字**既无行号也无命令**。重测后区间随计数规则从几十行摆到约一千行。
所以下面每一个数字都写清**它按哪条规则算的**，不写无出处的估值。

**起点与缺口**：

| 量 | 值 | 出处 |
|---|---|---|
| guardrails 现测行数 | **4,131**【实测】 | `wc -l` |
| 计划中写下的基线 | 3,806（评审时点） | `docs/refactor-master-plan.md:20`、`docs/refactor/07-baselines-and-dependencies.md:32`、`docs/refactor/08-ddd-target-architecture.md:19` |
| 与旧数字目标的差额 | **≥2,132 行**（4,131 − 1,999） | 「<2,000」的最宽松读法即 ≤1,999 |

**协作者燃尽能摘掉多大一块——两条命名规则，两个端点，都是实测**：

| 规则 | 定义 | 实测值 | 摘完后的行数 |
|---|---|---|---|
| **规则 C（保守）** | 所有**点名了协作者的源码行**的并集，判定口径与 R11 完全一致（`\b` 锚定六个符号） | **27 行**（`:108 :654 :657 :731 :732 :1197 :1824 :2063 :2067 :2110 :2112 :2319 :2770 :2917 :2949 :2950 :3017 :3018 :3264 :3286 :3529 :3778 :3787 :3806 :3815 :3861 :3880`） | 4,104 |
| **规则 A（激进）** | **删掉每一个碰到协作者的类成员**（整段，含其文档注释） | **974 行 / 17 个成员**；再补上规则 A 覆盖不到的两处——构造函数参数列表 `606-675`（70 行，`:654/:657` 在其中）与 import `:108`（1 行）——外沿 **1,045 行** | 3,086 |

规则 A 的 17 个成员及行数【实测】：`676-774`(99, 构造函数体) / `1104-1389`(286) / `1746-1854`(109) /
`2046-2071`(26) / `2096-2118`(23) / `2296-2326`(31) / `2686-2782`(97) / `2907-2938`(32) /
`2948-3011`(64) / `3016-3031`(16) / `3249-3267`(19) / `3272-3300`(29) / `3489-3551`(63) /
`3777-3803`(27) / `3805-3826`(22) / `3850-3876`(27) / `3878-3881`(4)。

**结论（两个端点都写出来，取哪个都一样）**：
- 保守端点摘完，文件还有 **4,104 行**，比旧目标高 **2,105 行**；
- 激进端点——注意它已经**荒谬地**把 286 行的准入编排、109 行的 readopt 整段算成「协作者接线」——
  摘完还有 **3,086 行**，仍比旧目标（1,999）高 **1,087 行**。
- 也就是说：**即便按最激进、明显过头的规则算，协作者燃尽路线也到不了旧目标，还差一千多行。**
  剩下的不是接线，是编排体本身（N5）。

---

## §5 决定：数字目标作废，改结构判据（Q4，用户 2026-08-05）

### §5.1 决定与两个被否的候选

**决定人与时间**：用户，2026-08-05。**内容**：用**结构判据**替换「guardrails <2,000 行」这个数字验收目标（选项 b）。
作出该决定时，用户已被告知两个**看起来最顺手的替代判据本身是坏的**——两条都要记下来，
免得下一位作者再提一遍：

- **被否 ①「协作者符号引用归零」**：不可达。本刀 Q1 实测 runner 组自己的地板是 **5**
  （五处写引用在「guardrails 仍调协作者」的任何形态下必然存活）；`this.audit` 组被第二刀裁定为
  **9 处全部保留（CALL×9）**。编排器合法地继续点名它仍在调用的协作者，所以「归零」这个判据
  与「编排器还活着」互斥。
  （§6 记的 **1** 是**另一条路**的天花板：把写点也改成订阅者时 runner 组能到的最低值。
  两个数字不矛盾——**5** 是本刀所走形态下的地板，**1** 是那条被否决的事件路线的地板；
  两条路都不通向 0。）
- **被否 ②「forwardRef 环归零」（裸写）**：**没有闸门测它**。`context-layout-check-v2.mjs` 里
  `cycle` 零命中；而 `monorepo-foundation` 能力显式豁免「只由 `*.module.ts` 组成的环」，
  今天这个环恰好**整体落在豁免里**（§3.3）。一条谁也不会红的验收判据不是判据。

**行数怎么办**：保留为**趋势数据**——每个 change 的结果表照报 before/after（本文件 §2 就是），
但**不作为验收判据**。

### §5.2 替换判据草案（每条都点名它的闸门与状态）

| # | 判据 | 由谁判定 | 状态 |
|---|---|---|---|
| **(a)** | **每个 R11 协作者条目都停在它被裁定的地板上**（而不是零）：`this.audit` 9、`this.runnerMinutes` 5、diagnostics 组按 §3.2 的两个地板、`this.transcripts` 0（删条目）、metrics-projection 0（删条目） | `pnpm test:dependency-budget` | **今天就可测，零改动**。该闸门双向 fail-closed，且已在 required CI job（步骤显示名 `Dependency budget ratchet (R11)`）里跑 |
| **(b)** | **编排器不再自己 `new` 出横切子系统** | 同一个闸门 | **需要一次数据改动**：往 `r11-dependency-budget.mjs` 的 `COLLABORATORS` 表里加**类名符号**（今天自建 6 个：`RunnerMinutesLedger:593`、`InlineAdmissionPipeline:682`、`ConcurrencySemaphore:737`、`DeadlineWatcher:762`、`IdleTracker:767`、`CircuitBreaker:770`【实测】）。`measureSource` 是通用的 `\b` 符号计数，**计数逻辑一行都不用改**——加的是数据，不是新闸门 |
| **(c)** | **`guardrails.service.ts` 的 r7 `cross-context-import` 计数降到它被裁定的数字**（今天 9；本刀 → 8；§3.2/§3.4 各再摘几条） | `pnpm test:context-layout-v2`（步骤显示名 `Context layout gate (v2, report)`） | **今天就可测，零改动** |
| **(d)** | **guardrails 与 tasks 两个 module 之间不再有 `forwardRef`** | **今天没有闸门** | **必须自带闸门**：加一个**窄**检查——只读 `apps/api/src/guardrails/guardrails.module.ts` 与 `apps/api/src/tasks/tasks.module.ts` 两个文件，断言二者互相 import 的 `forwardRef(` 出现次数为 0。**故意不走目录级环检测**，因为那条路要依赖 composition 豁免（§5.1 被否 ②），一依赖就又变成测不出来的判据 |

**判据 (d) 的写法说明**：把它表述成「两个具名文件之间的 forwardRef 数 = 0」而不是「无环」，
是为了让它**落在豁免之外**——豁免管的是「目录互相依赖算不算违规」，而这条判据管的是
「这两个具体文件里还有没有 forwardRef 这个字」，是可以逐字节判定的。

### §5.3 这份草案已落到计划文档

本 change **确实编辑了计划文档**（这是 Q4 决定的一部分，不是越界）：
`docs/refactor-master-plan.md`（阶段 4 验收行 + 依赖预算 bullet）、
`docs/refactor/08-ddd-target-architecture.md`（阶段 4 验收单元格）、
`docs/refactor/07-baselines-and-dependencies.md`（3,806 基线标注为历史）。
**归档目录一律不动**——它们是不可变记录，其中若干份按设计就复述着旧目标。

**三处 3,806 是标注而不是删除**：它们在评审时点为真，且各自被规模比估算引用
（07 的 ~15× 就是按它算的），删掉会让引用它的结论失去分母。所以每处加的是
「评审时点实测 + 2026-08-05 活测 4,131 + 行数不再是验收判据」的历史框注。

**清扫证明**【实测】：
`grep -rn '3,806\|<2,000\|降到 0 转禁止\|ratchet 归零' --include='*.md' --include='*.json' --include='*.ts' --include='*.mjs' --include='*.yml' . | grep -v node_modules | grep -v '^\./openspec/changes/archive/'`
的全部非归档命中为：三份计划文档里**已加历史框注**的 3,806（master-plan `:20`/`:23`、
07 `:32`/`:38`、08 `:19`/`:20`）、08 `:133`（记述「原两条判据已被替换」这件事本身）、
以及本文件引用旧目标以说明它为何被替换的几处。
**没有任何非归档文档仍把该数字作为验收判据。** 归档 change 目录里的复述属预期
（`archive/2026-08-01-add-domain-event-bus/proposal.md`、
`archive/2026-08-05-adjudicate-audit-event-migration/{design,adjudication,tasks}.md` 等），
它们是不可变记录，**不得编辑**。

---

## §6 runner 组自己的事件路线天花板 = 1（Q1，已决）

**为什么要在这里留档**：这是一条**没走的路**的结论。不写下来，下一位作者会重新推导一遍，
而重新推导很可能推出「6 → 0，全部改订阅」这个错答案。

**天花板是 1，不是 0**【实测】。六处引用里能被事件覆盖的只有：

| 引用 | 覆盖它的事件 | 位置证据 |
|---|---|---|
| `:1824 recordStart` | `task.run_started` | 同方法 `:1833` 发布 |
| `:2917 recordStart` | `task.run_started` | 同方法 `:2922` 发布 |
| `:3286 recordStart` | `task.run_started` | 同方法 `:3293` 发布 |
| `:2319 recordEnd`（`fenceTerminal`） | `task.settled` | 同方法 `:2322` 发布 |
| `:3264 recordEnd`（`clearAdmissionRuntime`） | **无合法覆盖事件** | 见下 |
| `:3880 intervals()` | 不是写，是读面（本刀摘的就是它） | — |

`clearAdmissionRuntime` 的 `recordEnd` 没有可用事件，有两处独立证据：
- **现行 spec 的否定式需求**：*TaskSettled is published only at the terminal fence* —
  「The second `runnerMinutes.recordEnd` call site — the admission-runtime teardown in
  `clearAdmissionRuntime` — is NOT a terminal settlement, and it SHALL NOT publish `TaskSettled`.
  Both `recordEnd` call sites SHALL remain in place and unchanged.」
- **源码注释**（`guardrails.service.ts:3249-3261`，紧接在 `clearAdmissionRuntime` 之上）：在那里发 `TaskSettled` 会「fabricate a settlement
  for a task that is still alive」，并写明「The mapping is 2 `recordEnd` call sites to 1 `TaskSettled`,
  **deliberately**, and the spec carries it as a negative requirement **so a later change cannot
  'fix' the asymmetry**」。

**即：这条不对称是被两处刻意钉死的设计，不是遗漏。**
所以事件路线的极限是：4 处写引用改订阅 + 本刀已摘的读面 = 5 处消失，**`this.runnerMinutes` 6 → 1**，
剩下的 `:3264` 一处**永远不可能靠事件消掉**。天花板是 **1，不是 0**。

### §6.1 那条路除了 spec 冲突之外，还要付两笔代价（都在本树量过）

**代价一：14 处反射断言会集体变成「真空通过」。**
`apps/api/src/guardrails/guardrails.service.spec.ts` 里 `runnerMinutes` 出现 14 次【实测】——
7 个断言点（`:1380` `:3021` `:3078` `:3136` `:3207` `:3280` `:3347`）各配一处类型标注
（`:1375` `:3011` `:3072` `:3132` `:3199` `:3274` `:3341`）。
关键在于**这 7 条全是否定式断言**：形态要么是 `assert.deepEqual(internals.runnerMinutes.intervals(), [])`，
要么是 `assert.equal(internals.runnerMinutes.intervals().some(({ endedAt }) => endedAt === null), false)`。
于是：**一个不再记账的 guardrails 会让这 7 条全部通过**——因为账本永远空，"没有未闭合区间" 恒真。
「零 diff 冻结」在字面上被满足，而这些断言**悄悄地不再测试任何东西**；
其中 `:3207` 自带的断言消息「the restored running interval is closed, while historical accounting
remains」会直接变成**假话**——历史账目根本不存在了。
（本刀采取的形态与此相反：字段名与调用点全保留，账本仍在同一个对象里，7 条断言继续有效。）

**代价二：订阅式记账在 escape-hatch 下变成 fail-open。**
发布走的是 cutover 开关（`CAP_DOMAIN_EVENT_PUBLISHING_ENABLED`，
`apps/api/src/domain-events/domain-event-publishing-cutover.port.ts:37-38`）；关闭时
composition root **根本不绑定 bus**，零事件发布。若记账挂在订阅者上，**开关一关，账就不记了**——
这是 fail-open。而今天的「保留同步调用」形态对这个开关**免疫**：
现行场景 *Publishing is gated by the cutover toggle* 明确要求关掉发布后
「every retained synchronous collaborator call still runs」。
**把记账事件化，等于把一个今天不受开关影响的账本，挂到开关下面去。**

---

## §7 排序理由：为什么 legacy 先走（诚实版）

**先声明四条不能用的理由。** 以下四条曾被当作 legacy 优先的依据，**全部实测为假**，
本文件不引用它们，后续 change 也不得引用：

| 曾经的说法 | 实测结论 |
|---|---|
| legacy 退役会让 diagnostics 归零 | 假。它让组 8 → 6，地板仍需 diagnostics 自己那一刀（§3.2） |
| legacy 退役能切断 forwardRef 环 | 假。环的两条边是 transcript 与 `GUARDRAILS_SERVICE_TOKEN`，与 legacy 无关（§3.3） |
| legacy 退役能显著改善行数 | 站不住当作首要理由。保守量得 ≈70 行（§3.1），相对 4,131 行不是数量级贡献 |
| legacy 退役解锁 transcript | 假。transcript 的前置是显式 `none`（§3.3） |

**能支撑这个顺序的只有两条，一条是测量，一条是决定：**

1. **【测量】** 先退役 legacy 会把 diagnostics 的**地板从 4 压到 2**。
   机理很具体：`:731`/`:732` 这两处透传是**随适配器字面量一起消失**的，
   而不是需要 diagnostics 那一刀去把它们摘掉——SIM 2 与 SIM 3 的差值（4 → 2）就是这个（§3.2）。
   换言之，顺序颠倒的话，diagnostics 那一刀会停在 4，之后还要再回来一次。
2. **【决定】** 本仓已有的判断：**给一个已判定退役的单元建接口，是给拆除工作搭脚手架**，
   而这类工作的判据应当是**「退役日剩余成本最小」**，不是「本次改动成本最小」。
   原话见 `openspec/changes/archive/2026-07-29-isolate-legacy-admission-behind-capability-policy/track-3-recut.md`
   §3–§4：「为一个计划删除的单元建 21 成员的接口，是在给拆除工作搭脚手架 —— 脚手架本身之后也要拆」；
   「这项工作的判据是『对后续清理成本最小』——这是在清理一个已判定退役的功能，不是在长期维护它」。
   把这条判断应用到今天的排序上，是一个**判断的沿用**，不是一次新的测量。

**哪部分是测量、哪部分是决定，上面两条已经分别标注。** 顺序本身是产品决定；
它唯一的量化支撑是第 1 条的 4 → 2。

---

## §8 剩余每一刀都要付的固定开销（本刀没付）

本刀四个公开面全 `unchanged` 站得住，是因为 **runner-minutes 的派生结果不经任何 `/v1` 操作暴露**：
`apps/api/src/v1/` 下**没有** metrics 控制器，`GET /metrics` 是控制台裸路由。

**后两组不同**【实测】：`apps/api/src/v1/v1-task-provisioning-diagnostics.controller.ts` 与
`apps/api/src/v1/v1-transcript.controller.ts` **都存在**，即 N2 与 N3 各自对应真实的 `/v1` 操作。
因此它们的 `surface-impact.json` **很可能要从 `unchanged` 升到 `derived`，并转录 `protocolDifferences`**
（阶段 2 的教训：声明 `unchanged` 也必须真跑
`node scripts/public-surface-adversarial.mjs verify <change>`）。
这是**每刀一笔**的固定开销，估工时必须计入；本刀的 `unchanged`×4 是特例，不是常态。
【预测】标签：这是预测。**证伪命令**：在那一刀的树上跑上面这条 `verify`，
若它对 `unchanged` 退出 0 且 `protocolDifferences` 为空，本条预测即被证伪。

---

## §9 预测登记（§0 纪律 1 的总账）

本文件里所有 `【预测】` 及其证伪手段，已就近写在各自位置：
§2 结果表的第二张表（逐列证伪命令）、§3.1（生产 legacy 流量：两步运营查询）、
§3.3-a（顺序断言）、§3.4（`pnpm test:dependency-budget`）、§8（`public-surface-adversarial verify`）。
**没有一格预测是裸估值**；若后续作者发现某一格无法被上述任何一条命令判定真伪，
那是本文件的缺陷，应当开 change 修它，而不是照抄它。

---

*本文件由 range B 调研轨写就。§2 结果表里 runner 那一行的五个单元格由集成轨任务 5.9 实测追加，
并与 `scripts/ratchets/r11.json` 对应条目的 `change` 字段对账，使两份工件不可能互相矛盾。*
