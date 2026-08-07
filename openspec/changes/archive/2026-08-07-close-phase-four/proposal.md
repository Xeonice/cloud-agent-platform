# Proposal: close-phase-four

> 阶段 4 收口刀。五个横切关注点各自的刀已全部归档，剩下的是**验收判据本身**与两个收尾项。
> 判据 b 的处置由用户于 2026-08-07 拍板（推到阶段 6），记在 §决策，不得与测量结论混同。

## Why

阶段 4 的四条验收判据里，两条已过、一条几乎免费、一条撞上一个刻意的设计决定：

- **a 已过** —— 六条 R11 全停在裁定地板（audit 9 / runnerMinutes 4 / recorder 2 / writeGate 2 /
  transcripts 1 / metrics-projection 2），`pnpm test:dependency-budget` 绿。
- **c 已过，但母文档没写出数字** —— 实测 7，且 7 就是阶段 4 的地板：七条残余 import 全是「有返回值的
  调用/类型」，按母文档自己的非事件判据（`:133-135`）结构上转不成事件，它们归阶段 5–6 的另一套机制。
- **d 几乎免费，且前提已过期** —— 母文档说要「解 tasks↔guardrails forwardRef 环」，但**环已经断了**：
  `guardrails.module.ts` 是 `imports: []`，非测试文件里没有一处从 guardrails 反向 import `@/tasks`。
  全仓只剩 `tasks.module.ts:58` 一处 `forwardRef`，是残迹。真正缺的是母文档自己点名的那条窄闸门。
- **b 撞上刻意设计** —— 见 §决策 D1。

## 决策（用户 2026-08-07 拍板，非测量）

- **D1 —— 判据 b 推到阶段 6。** 六个自建里五个不是横切（同目录、同上下文、唯一生产消费者是编排器自身、
  不在 `COLLABORATORS`、不在 r7）；第六个 `TaskProvisioningDiagnosticsObserverLifecycle` 是横切，
  DI 接缝也现成，但 `guardrails.service.ts:740-746` 写明它本地构造是为了让**被冻结的目录外 spec 与接线
  应用共用同一条构造路径**，注入会把它劈成 DI 路径与测试路径两条。阶段 6（目录归拢 + layout v2 转正）
  是构造路径与目录归属同时动的地方。
  ⚠ 这意味着阶段 4 **带着一条明确延期的判据收口**，不是四条全达成。延期理由必须写进母文档，否则下一位
  作者会当成漏掉的。

## What Changes

1. **删残迹 forwardRef**（`tasks.module.ts`）—— 改成直接 import，并订正那段说它「用于打破循环引用」的
   文档段落：循环已经不存在，`GUARDRAILS_SERVICE_TOKEN` 解耦的是具体类而非环。
2. **建母文档点名的窄闸门** —— 只读那两个文件、断言互指 `forwardRef(` 为 0，**双向 fail-closed**：
   出现 forwardRef 判红，闸门自己丢失读取对象（文件被改名/搬走）同样判红。
   现有 layout 闸门看不见这条边，是因为它对 `*.module.ts` 发起的 import **按设计豁免**——那条豁免保留，
   新闸门不去重新论证它。
3. **母文档订正三处** —— c 的数字（7）与它的理由、b 的延期与依据、`:146` 两个已被实测推翻的数字
   （runner 计费 5→**4**，diagnostics 退役后 2→**4**）。

## Non-Goals

1. **注入 `TaskProvisioningDiagnosticsObserverLifecycle`** —— D1 推到阶段 6。
2. **重新论证 layout v2 对 `*.module.ts` 的豁免** —— 那条豁免是对的（母文档 `:164-166` 已论证），
   新闸门是补它按构造看不见的那条边，不是替代它。
3. **收口发一版 + 升级演练** —— 发版走 release-please（合并现有 release PR 触发 tag + 镜像），升级演练
   要碰生产 host。**两者都需要用户操作**，本刀只做仓内前置，不声称代替。

## apply 期发现（记录，非本刀计划内）

用前一刀的归档断言跑当前树——那条我在上一次会话里提出、成本 2 秒的「前任断言通道」——**当场抓到 main
正违反一条它自己刚合并进去的安全断言**：`retire-legacy-inline-admission` 的
`no-symbol-reaches-pipeline` 判红，命中的是同一刀最后一个提交里我写的一条 e2e 注释，它引用了退役管线的
文件路径作为历史证据。

安全属性没破（没有符号可达退役管线，那只是散文引用），但断言是纯文本 grep，且**归档之后没有任何东西会
再跑归档 change 的断言**，所以它红在 main 上无人知晓。已改措辞让信息保留、字面量避开，前任断言恢复 34/34。

顺带暴露同一刀内的口径不一致：`boot-reoffer-gone-from-code` 刻意排除注释（并写明理由——数注释会逼作者删掉
解释来把数字凑零），而 `no-symbol-reaches-pipeline` 不排除。对「退役的整条管线」用更严的绊线可以辩护，但
它的代价是退役理由的记录不能点名那个文件，这条代价此前没被写下来过。

这是「前任断言通道」值得建的第二个实证（第一个是它会在 apply 完成那一刻抓到 135→91）。本刀不建它——
那是工具链改动，且母文档没有把它列为阶段 4 的收口项。
