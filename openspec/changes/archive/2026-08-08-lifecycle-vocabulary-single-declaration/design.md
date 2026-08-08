## Context

阶段 5 的验收句「状态转换合法性单点声明」按字面读今天已成立，真缺陷在它描述不到的地方
（终态词表双 canonical、复述面、哑镜像测试）。见 `research-brief.md` §2/§3 的实测。

三条既有机制约束本刀的每一个选择，且它们**互相冲突**：

- `layers.fileClassification.rules` 是有序后缀表，今天只有 `.port.ts` 映到 `domain`；未命中报
  `unclassified-file`，且脚本头注释明写「绝不静默跳过」。
- `comparator.mjs:178` 对**无基线条目的实测违规**直接判红；`:181-187` 对有条目的类**严格等值**——
  低于基线同样红。所以「新建文件」与「删掉复述」两个方向都会触发闸门，必须同 PR 收缩基线。
- R11 对 `guardrails.service.ts` 的协作者符号引用是严格等值，`openspec/specs/guardrails/spec.md:862`
  还按 file:line 钉死了九个 `this.audit` 行号。

## Goals / Non-Goals

**Goals:**
- 终态词表与 admission 子集规则各恰好一处声明，复述面被**按明确口径计数**并可燃尽。
- 守着生命周期词表的测试**能因词表改变而失败**。
- `domain` 层可命名，使阶段 5 后续刀新建纯领域文件时不撞 `unclassified-file` 墙。
- migration 纪律的定义成文，落在既有执行器上。

**Non-Goals:**
- **不动 `ALLOWED_TRANSITIONS` 本身** —— 它已经是单点声明，改它没有收益且会扰动五个执行点。
- **不建新闸门脚本** —— 复述面的度量寄生在既有 layout v2 / ratchet 机制上；migration 条款寄生在
  `04-rules-registry.md` E 节已写死的「change 模板条款」执行器上。
- **不碰构造签名与 20 个位置化构造点**。
- **不燃尽 `prisma-outside-store`** —— 那是刀 2–7 的事，本刀只加 composition 豁免（D4）。

## Decisions

### D-A｜保留 `packages/contracts` 版为唯一 canonical（用户 D1）

替代方案是保留 `apps/api/task-lifecycle` 版，**实测不可行**：contracts 侧 4 个消费点与 web 侧 2 个
消费点都要改指向，而 `apps/web` 结构上无法 import `apps/api`。选 contracts 版则两侧零改动，且
`guardrails.service.ts:22` 已经 import 了它——那处改动是「换成已在作用域里的标识符」，不是引新线。

代价：`task-lifecycle.ts`（domain 层）会依赖 contracts 包。工件 08 §G 禁的是装饰器/DI/IO，不禁
contracts 类型 import，且 `task-lifecycle.ts:1` 今天已经在这么做。

### D-B｜复述面的计数口径写死为「四字面量同窗共现」

口径 = 四个终态字面量以单引号形式在同一 8 行窗口内共现，每文件计首处，扫 `apps/` `packages/`
`scripts/`，排除 `*.spec.ts` / `*.test.ts` / `*.test.mjs`。按此全仓 **7 个文件**（清空排除列表则
**18**）。**研究简报原写的 12 是错的**：按它自己声明的排除项重数得 13，且那份排除项漏了
`.test.mjs`——一边声称排除测试一边把 `*.test.mjs` 数了进来。订正见简报 §2 与对应需求，错误留档。

⚠ **更重要的订正：按文件计数本身就是错的口径。** 改成「每文件所有非重叠窗口都计」后实测
**15 个站点 / 7 个文件**——按文件只记首处会把 `guardrails.service.ts` 里的**另外 4 处**全部藏起来
（该文件实际 5 处：`:169` `:3256` 两个类型联合、`:981` `:3295` 两条等值链、`:3613` 一个本地
重声明的 `isTerminalTaskStatus`）。**燃尽口径钉在站点数 15，不是文件数 7。**

15 站点的构成：**canonical 3**（`contracts/task.ts:30` 全枚举、`:39` 终态集合、
`task-lifecycle.ts:40` 邻接表终态行）＋ **待删的第二份 canonical 1**（`task-lifecycle.ts:15`）
＋ **口径假阳性 2**（`audit-mapping.ts:282`、`v1-events.controller.ts:324`，对整个状态枚举的
穷尽 switch，必须继续逐个列举，改成消费终态集合反而会去掉编译器强制的穷尽性）
＋ **真复述 9**。**实测（整合树）：15 → 5 站点 / 4 文件**，与预测逐字相符。

⚠ **原写的「guardrails 与 task-lifecycle 跨 context」是错的，apply 期读 manifest 时推翻，订正留档。**
两者同属 `task-execution`（`contexts-manifest.json` 的 contexts 把 tasks / task-operations /
task-lifecycle / guardrails 列在同一条目下），跨 context 分支不会进入；层方向对未分类端点显式 defer
（`context-layout-check-v2.mjs:485`），5.1 之后是 application→domain，合法。**那个 import 不产生任何
finding。** 规矩仍然保留，但依据换成真的：终态集合是 **contracts 拥有的词表**，派生类型应与它同处；
声明在 apps/api 再 import 等于把词表的第二个名字放进消费方——正是 1.2 刚删掉的形状。

替代方案「数 `agent_failed_to_start` 的出现次数」被否：它给出 **45** 行，其中绝大多数是**单状态引用**
（`circuit-breaker.ts` 的 `FailureKind`、`v1-events.controller.ts:331` 的 switch case），与终态集合无关。
一个不带口径的 45 是误导数，而本 epic 已经三次为「一处为真、别处为假」的数字付过代价。

**任何写进 spec 的复述计数都必须与产生它的命令同时出现。**

### D-C｜哑镜像测试：改为 import 真模块，而不是退役

`task-lifecycle.test.mjs` 自持邻接表是它唯一的问题；它覆盖的转换语义是有价值的。退役会把覆盖一起丢掉，
接线则把「结构上无法失败」变成「必然随主体失败」。

替代方案（退役）保留在 spec 里作为显式二选一，因为若接线后发现它与真模块的断言重复到零信息量，
退役才是诚实的——但那必须是**测量后的结论**，不是预设。

### D-D｜domain 后缀规则用目录而非文件后缀

`.port.ts` 是后缀规则，但 `task-lifecycle.ts` 没有可用的领域后缀，且给它硬造一个
（如 `.domain.ts`）会逼后续每个领域文件改名。

**已读解释器，结论：只支持后缀，目录形态不可表达。** `classifyLayer`
（`scripts/context-layout-check-v2.mjs:262-268`）是 `probe.endsWith(rule.suffix)`，其中
`probe = '/' + scopeRel`。所以后缀**可以跨路径段**（既有 `/main.ts` 规则即是证据），但仍锚在路径
**末尾**——「`domain/` 目录下的所有文件」写不出来。教解释器认目录规则属于**改机制**，那正是
`context-layout-report` 的「分类声明唯一且 fail-closed」需求所管的东西，会触发 MODIFIED；本刀不碰。

因此按 D-D 预写的退化执行：**声明一个文件名后缀约定**（`.domain.ts`），`task-lifecycle.ts` 随之
改名。代价已写进 spec：后续每个纯领域文件必须在**文件名**里带这个后缀，忘了就报 unclassified——
这是**期望中的响声**，也是本刀成为刀 2–7 技术前置的理由。

**simulate-then-measure（已实跑并还原）**：插入规则 + 改名 + 改 4 个 import 后
`node scripts/context-layout-check-v2.mjs` 给出 `unclassified-file` 129 → 128，其余三类
（`cross-context-import` 129 / `layer-direction` 2 / `prisma-outside-store` 59）逐个不变；闸门另报
1 条 stale baseline 条目，必须同 PR 删。改名成本实测**只有 4 个消费点**
（`task-admission.worker.ts`、`tasks.service.ts`、两个 tasks spec），且
**`guardrails.service.ts` 不在其中**——所以这条任务与 R11 严格等值风险完全不相交。

### D-E｜migration 条款寄生在既有执行器上

`docs/refactor/04-rules-registry.md` E 节已把执行器写死为「既有两个 CI 兼容 job + 阶段 5 起的 change
模板条款」。所以本刀写的是**条款与定义**，不是闸门。宽读法（D5）与既有实践一致——阶段 4 那条
DELETE 迁移已自愿在文件头自陈不可逆。

## Risks / Trade-offs

- **[R11 严格等值]** ~~移动协作者引用行就会红~~ —— **已读代码订正**：`comparator.mjs:16` 明写
  「comparison keys on COUNT only — `samples[]` are documentation」，`:170-187` 只比 `count`。
  所以**行号位移不会让 R11 变红**，真正会红的是**增删 `this.<协作者>` 引用**。本刀把 5 处终态
  复述改成消费 canonical，不产生也不删除任何 `this.X` 引用，故 R11 风险实际很低。
  **仍要做的**：改完 guardrails 单跑一次 `pnpm test:dependency-budget` 确认 9/4/6/4/2/2 不动；
  行号位移会让 `r11.json` 的 `samples` 与 `openspec/specs/guardrails/spec.md:862` 记的九个行号
  变陈旧——前者是文档（可刷新），后者按其自身措辞限定在「该 change 之前的树」，是历史陈述，
  不因本刀位移而变假。这条区分要写进任务，否则下一轮会误判成回归。
- **[基线双向 fail-closed]** 删掉复述会让 r7 的某些计数低于基线 → 同样判红。**缓解**：基线收缩
  必须与代码改动**同 commit**，这是 `comparator.mjs` 的既定语义，不是可协商项。
- **[新建 domain 文件撞墙]** 若 D-D 选错形态，本刀自己就会造出新的 `unclassified-file` key。
  **缓解**：D-D 明写「apply 期先读解释器再落地」，且把「本刀结束时 unclassified 类净减不增」
  写成需求。
- **[跨包删除公共导出]** 若最终决定删 `task-lifecycle.ts` 的本地 canonical，那是 api 内部的事；
  但若反向删 contracts 的导出，属对外面变更。**本刀按 D1 删的是 api 侧**，故不触发公开面。
- **[口径漂移]** 复述计数一旦写进 spec 而不带命令，下一位作者会用别的口径重数并得出不同结论。
  **缓解**：D-B 强制口径与命令同现，并以断言固化。

## Open Questions

- ~~**D-D 的规则形态**~~ —— **propose 期已解决**，见 D-D：解释器只认后缀，退化方案已选定并
  simulate-then-measure 实测。留此条是为了记录它曾是开放项，以及它是被**读代码 + 实跑**关掉的，
  不是被推理关掉的。

- **D4 豁免的实现落点**：`prismaExemptFile` 现在是
  `isStoreFile || prismaExempt.has(dir)`（`:427`），而 `isComposition` 在同一循环的上方
  （`:422-425`）已经算好。模拟时用的是 `prismaRules.exemptComposition === true && isComposition`，
  实测 `prisma-outside-store` 59 → 56 且恰好是那三个 module 文件。apply 期需确认 manifest 的
  `need(...)` 校验链是否要为新键补一条断言——加可选键本身不破坏现有校验，但**闸门 self-test
  是否需要新 case** 要看 `context-layout-check-v2.test.mjs` 里 prismaPlacement 的既有覆盖，
  这一条留给 apply 期读了再定。

- ⚠ **[verify 期新开 · 需求缺陷，非代码任务]「复述计数」需求里的『the gate』指的是谁？**
  —— `task-lifecycle-vocabulary/restatements-of-the-terminal-vocabulary-are-counted-per-site-and-the-convention-s-false-positives-are-named`
  的第二条 scenario 写的是：「**WHEN** 某个 change 新增一处四个终态字面量共现的站点（不在两处
  canonical、也不在两处具名假阳性之内）→ **THEN** 站点计数升到记录值之上**并且闸门报出来**」。

  **这条按字面读今天不可能为真，而且不是实现没做到，是需求自相矛盾。**verify 期实跑核过三件事：

  1. 全仓没有任何闸门统计这个口径。`grep -rn agent_failed_to_start scripts/` **零命中**——
     `scripts/` 下没有一个脚本认识终态字面量。
  2. 本刀 proposal 的 Impact 明写「**不建新闸门脚本**（度量寄生在既有 layout v2 / ratchet 上）」，
     而 layout v2 只报 `cross-context-import` / `layer-direction` / `prisma-outside-store` /
     `unclassified-file` 四类，r7/r11 亦然——**没有一类是站点计数**。需求正文本身也只讲计数口径与
     具名豁免，从头到尾没有要求建闸门。
  3. 唯一在数它的是本 change 自己的 `assertions.json#restatement-site-count`，那是 verify 期跑一次
     的一次性断言；归档之后**没有任何东西会在下一个 change 里重跑它**。所以「新增一处复述」在今天
     的仓库里**恰恰是会静默通过的**——正是该 scenario 明令禁止的结果。

  需求正文与该 scenario 之间的落差不是实现债：把它当代码任务办，等于要求本刀违反自己已裁定的
  「不建新闸门」范围，是凭 scenario 一句话给自己加一个新的常驻闸门。因此**路由到这里而不是任务表**。

  **待裁定（下一位作者三选一，不要沉默地按第三条办）**：
  (a) **建闸门**——把站点计数做成 `scripts/` 下的常驻检查 + 一条 ratchet 基线（记录值 5），
      于是 scenario 按字面成立；代价是本刀之外的新机制，应当是独立 change。
  (b) **改 scenario 措辞**——去掉「the gate reports it」，改成「重新按本需求声明的口径测量时，计数
      高于记录值」，把它诚实地降级为**可复现的测量约定**而非自动执行；这与需求正文一致，也与本刀
      「补条款、不造闸门」的既定姿态一致（`migration-discipline` 需求就是这么老实写的：
      「This requirement SHALL NOT be read as claiming … is enforced」）。
  (c) 什么都不做——那么活 spec 里就留着一条**关于本仓为假**的断言，正是本 epic 反复付账的
      「一处为真、别处为假」。

  ⚠ 记一笔判据留给后来人：另外三条 scenario（口径复测 5 站点 / 4 文件、两处全量映射仍逐个枚举、
  燃尽未在别的 finding 类上冒出新数）verify 期**逐条实测为真**。本条被单独拎出来，是因为它断言的是
  **执行机制**，而这个需求通篇讲的是**测量口径**——两者不是一回事，混在一个需求里才让它看起来像
  已经满足。

  ✅ **已裁定（本刀内，取 (b)）**——不是留给下一位作者了，本条不再是开放项，保留在此是为了留住
  「它曾经开放过，以及是怎么关掉的」。`specs/task-lifecycle-vocabulary/spec.md:153-168` 已把
  「and the gate reports it」从 scenario 里删掉，改成「按本需求声明的口径重新测量时，计数高于记录
  值」，并在紧随其后的 ⚠ 段里把原措辞、三条使其为假的实测事实、以及「建闸门是正当的后续但属于
  独立 change」一并写进正文——**改的是措辞不是判据，降的是主张不是标准**。取 (b) 而非 (a) 的理由
  在上面三选一里已经写完，此处不重复。

  routing 期复核（对代码，不是对报告）：口径复测 = 5 站点，与记录值一致；再在一个生产文件里塞进
  一处合成的四字面量数组，复测 = 6，随即还原回 5——**scenario 2 由变异证明**，而不是由「读上去
  像是对的」证明。四条 scenario 现在逐条为真，本需求判 MET，不再路由为需求缺陷。

  ⚠ 留给建闸门那一刀的前置：真要走 (a)，口径脚本要连**这次变异实验**一起搬过去当自测——一个
  数不出新增站点的站点计数器，和现在这条不存在的闸门是同一种东西。
