# Verification Report — unlock-extension-axes

Adjudication pass: 2026-08-01(opsx-verify 三路裁定;裁定人对每项 raw-unmet 逐项重走代码,未 rubber-stamp skeptic)。
工作树状态:全部实现在 `chore/archive-deflake-change` 分支工作树内,未 commit。

---

## Re-verify pass 3 — 2026-08-01(本节为最新裁定,tally 以本节为准)

本轮输入:2 项 raw-unmet(均带 skeptic 动态复核 refuted=false);machine-routed mandatory public findings = **0**(空清单)。裁定人对两项均在当前工作树逐文件重走 + 亲跑动态检查,未 rubber-stamp skeptic。

### Three-way tally(pass 3)

| Route | Count | Ids |
| --- | --- | --- |
| MET(reclassified,本轮) | 2 | `agent-runtime/admitting-a-third-runtime-shall-cost-only-a-declaration-and-a-registration`、`frontend-console/runtime-display-surfaces-are-driven-by-contracts-metadata-with-no-console-branches` |
| UNMET(reopened,本轮新开) | 0 | — |
| SPEC-DEFECT(本轮) | 0 | —(本轮无 machine-routed undeclared-impact/false-exclusion 提交,不新增 blocking 条目) |

归档门禁注记:本轮不新增 blocker;归档仍受 tasks.md `## 9. Track: verify-reopened` 中 9.9-9.15 未勾任务约束(pass 2 遗留,与本轮两项裁定无涉)。裁定人本轮实测:9.9 的代码性缺陷(`zzz-drill` 残留)在当前树**已消除**——`packages/contracts/src/skill-catalog.ts:15` 现为 `['openspec', 'bmad'] as const` 且 dist 一致——但 9.9 的 lane 重跑部分未出证,任务保持未勾正确。

### Reclassified MET(pass 3)

**1. `agent-runtime/admitting-a-third-runtime-shall-cost-only-a-declaration-and-a-registration`** — skeptic 本轮做了**全新**准入演练(非复述旧 drill):注入 throwaway `'drill-third'` + 完整 `AgentRuntime` port stub 注册,编译器逐一点名的后续改动全部是总 Record 缺行(RUNTIME_METADATA / cliPins+夹具 / credential 解析 / SUPPORTED_AUTHORITIES / readinessPolicy / RUNTIME_PREFLIGHT_COMMANDS / conformance harness 账本 / web settings 凭据组字面量),四包 typecheck 全绿;全程 tsc 错误清单**从未点名**五个消费者面(runtime-label / new-task-dialog CLI-preview / credential-alert / runtime-credentials 组件本体 / transcript 派发接缝);逐字节 revert 后 `grep drill-third` 零残留、四包复绿。裁定人独立复核:`packages/contracts/src/agent-runtime-id.ts:24,107`(单一声明+总表)、五消费者面均为泛型 lookup/`Object.entries`/strategy-kind 派发,零 identity 分支;本会话亲跑 `node scripts/agent-identity-branch-check.mjs` → "no in-scope production source branches on runtime identity",EXIT 0。与 pass 1 对本项的 MET 裁定及 baseline.md 演练记录逐点吻合。**判 MET。**

随案注记(不破 MET):
- requirement 散文只点名 RUNTIME_METADATA 与 conformance 账本两张表,实测准入需 9 处表行填充——Scenario 实际判据是「table rows, never branches」,9 处全为表行,判据满足;散文精度差记为措辞注记,不构成 ambiguous/untestable,不入 Open Questions。
- 毗邻残余:`packages/sandbox/src/host-harness/configured-provider.ts:671` 本地手抄 `TranscriptReadStrategyKind` 字面量(裁定人本轮复核**仍在**,含 NOTE 注释自证待改指 contracts)。该残余属兄弟需求 `the-transcript-read-strategy-is-a-shape-named-vocabulary-with-real-dispatch`,已由**未勾**任务 9.11 在案追踪(9.2 勾选注记与代码实况的落差同样已写入 9.11 文本),不因本项另开任务、不影响本项 MET(第三 runtime 复用既有 shape 零额外编辑,baseline.md「transcript 策略零要求」)。

**2. `frontend-console/runtime-display-surfaces-are-driven-by-contracts-metadata-with-no-console-branches`** — pass 1 的 V.8 UNMET(runtime-label.ts 手写 `AGENT_LABELS`)经 9.8 修复后,本轮端到端重走**成立**:
- `apps/web/src/lib/runtime-label.ts:34-38` 现为 `RUNTIME_METADATA[runtime]?.label ?? runtime`(ABSENT→codex 默认与未知 id 原样渲染语义保留),手写表已删——裁定人逐行复读确认;
- `apps/web/src/components/runtime-credential-alert.tsx:41` 纯 metadata lookup,唯一三目判 `failure.code`(failure code 非 runtime identity,系 requirement 自身的 carve-out);new-task-dialog.tsx:144-155,265-287 与 settings/runtime-credentials.tsx:127-243 均由 `RUNTIME_METADATA`/`AGENT_RUNTIME_IDS` 驱动;grep 四文件 `runtime === '<id>'`/`case '<id>'` 零命中(裁定人亲跑,EXIT 1=无匹配);
- 动态 ground-truth:skeptic 新写独立测试 `apps/web/src/components/runtime-credential-alert.ground-truth.test.tsx`(逐 AGENT_RUNTIME_IDS 渲染断言 expiredTitle/description/actionLabel 逐串来自 metadata 行 + 源文本静态断言禁用分支形状),裁定人本会话亲跑 `vitest run`(ground-truth 2 + 既有 alert 6 + runtime-label 3)= **11/11 绿**;
- baseline.md 第三 runtime demand 清单对这三个面零命中,与「新 runtime 零 console 编辑」scenario 一致。**判 MET(含一处不阻塞主场景的 minor 残余,见下)。**

随案注记(不破 MET):`apps/web/src/routes/_app/tasks/$taskId.tsx:358` 存量 `OFFICIAL_DEPENDENCY_LABELS: Record<string,string>`(codex/claude-code/openspec),仅用于沙箱依赖 VERSION 条,非本 requirement 枚举的 credential-alert/selector/settings/label 面;先于本 change 存在、`?? id` 优雅降级、不被 totality 机制看见——记为后续清理候选,非违规。另:ground-truth 测试文件为未跟踪新文件留在工作树(未 commit,遵全局「仅明示才提交」指令)。

### Gap findings(pass 3)

无覆盖缺口(`[]`)。7 个 spec 文件全部 requirement 在工作树均有可追溯实现(文件/符号/消费者与 scenario 文本对齐),与既有报告 gap 扫描一致,本轮按各 requirement 关键 artifact 逐一 grep 独立复核未推翻。

### Scope findings(pass 3,超需求实现)

reference-server 三处协议级强制逻辑(pass 1 记录)本轮独立复读 `specs/sandbox-provider-port/spec.md`(仅 3 requirement:7 端点真 HTTP conformance / 自描述优雅降级+版本协商 / secret-writer 拒绝保留)与 `packages/sandbox-cloud-http/test/http-cloud-provider.test.mjs` 后**维持有效**:

1. `reference-server.ts:154-159` — Bearer 鉴权(缺失/不匹配 `Authorization` 返 401):无 requirement 提及服务端鉴权,且现存 `apiToken` 用例全部打在 `HttpCloudSandboxProvider` 客户端头(手写 `makeFetch` stub),从未传给 `startHttpCloudSandboxReferenceServer`。
2. `reference-server.ts:249-257` — create 重放指名不同 `resourceGeneration` 返 409("conflicting resource generation"):不在任何 scenario,无测试驱动同 taskId 双 create 异 generation。
3. `reference-server.ts:329-357` — `fence()` 所有权强制(首 fence 收养 / If-Match/resourceGeneration 不匹配 412 / providerSandboxId 不匹配 409):spec 只要求两处 secret-writer 拒绝保留;conformance 仅行使匹配 fence happy-path,mismatch 分支零命中。

处置建议不变:补 requirement+测试或裁掉未行使分支,归档前不阻塞。其余改动文件无超需求行为——`apps/web/src/routes/_app/settings.tsx` diff 即任务 4.3 要求的消费者接线;pass 2 记录的 `skill-catalog.ts` `zzz-drill` 残留在当前树已移除(与 9.9 未勾并存的原因见上:任务剩余实质是 lane 重跑出证)。

---

## Re-verify pass 2 — 2026-08-01(历史存档——tally 已被上方 pass 3 取代)

### Three-way tally(pass 2)

| Route | Count | Ids |
| --- | --- | --- |
| MET(reclassified,本轮新增) | 1 | `sandbox-host-harness/the-tmux-session-protocol-has-one-declaration-in-the-sandbox-facade`(动态 ground-truth 5/5 通过,见下) |
| UNMET(reopened → tasks.md `## 9. Track: verify-reopened` 9.9-9.15) | 7 | 7 × machine-routed dynamic-evidence-missing(四 lane registry/restMetadata/mcpSdkMetadata/behavior 均未产出通过记录;不可改判) |
| SPEC-DEFECT(→ design.md Open Questions;全部 blocking) | 7 需求 id / 4 findings | machine-routed undeclared-impact ×4(publicV1/mcp/openapi/apiPlayground sidecar 矛盾**再提起**),挂在全部 7 项 public-surface 需求上 |

归档门禁:8 条 machine-routed public findings(4 × dynamic-evidence-missing + 4 × undeclared-impact)全部 blocking——9.9-9.15 清零且 sidecar 矛盾以新一轮绿 lane 记录或 sidecar 升级解决前不可 archive。

### Reclassified MET(pass 2)

**`sandbox-host-harness/the-tmux-session-protocol-has-one-declaration-in-the-sandbox-facade`** — 静态 trace 与动态 ground-truth 双通过(dynamic refuted=false),端到端重走成立:

- 单一声明:`packages/sandbox/src/terminal/session-commands.ts` 声明全部 tmux 协议 helper(CODEX_PROMPT_FILE_PATH、buildCodexLaunchLine、detachedSessionName、wrapInDetachedSession、headlessExitFile、buildHasSessionCommand 等 13 符号),facade `packages/sandbox/src/index.ts:586-599` 再导出;api 侧副本 `apps/api/src/agent-runtime/codex-launch.ts` 已删(工作树 D,HEAD 尚存旧 162 行副本,删前逐符号 byte-identical 比对)。
- 动态 ground-truth(独立 node:test,5/5 pass,不入库):递归扫 apps/api/src 全部 .ts,13 个 helper 名零本地 `function|const|let|var|class` 声明(正则经合成正/负例验非空洞);codex-launch.ts 磁盘不存在;两 importer(codex-runtime.ts / claude-code-runtime.ts)均 `from '@cap-console/sandbox'`;动态 import 构建后 facade dist 确认每个 helper 实际导出;调用 buildHasSessionCommand/detachedSessionName/wrapInDetachedSession 断言逐字节确定性输出(`tmux has-session -t taskgt42`)。红鲱鱼已排除:`sandbox-provider-aio/dist/codex-launch.d.ts` 是 gitignored 过期构建产物,无对应 src,非第二声明。
- R6 facade-surface 闸绿(314 value/309 type exports match),`pnpm --filter @cap-console/sandbox run test` 41/41。

### UNMET(reopened,pass 2)

**V2.1-V2.7(machine-routed,不可改判)**:同七项 public-surface 需求(RUNTIME_METADATA 表 / TranscriptReadStrategy 派发 / SKILL_CATALOG_IDS 单一声明 / provider-snapshot+boxlite-rootfs 语义 pin / source-kind 派生链 / checksums partial 语义 / source-kind 单一声明+extension tier)的静态 trace 经裁定人逐项重走全部成立,但四条强制动态 lane 本轮均未产出通过记录。**本轮定位到真实根因(非 lane 流程缺席)**:contracts `SKILL_CATALOG_IDS` 残留未 revert 的演练成员 `'zzz-drill'`(src+dist 均在)致 api/web typecheck 双红(裁定人本轮亲跑:api `skill-allowlist.ts(55,14) TS2741`、web `new-task-dialog.tsx(171,12) TS1360` + `(182,46) TS7053`),整树红则四 lane 物理产不出通过记录;9.1-9.7 的旧 lane 注记先于该破坏,对当前树失效。另:9.2 声明「顺带落掉」的 `configured-provider.ts:671` 本地 `TranscriptReadStrategyKind` 字面量副本本轮复核**仍在**(contracts 词表在该文件零 import、R5 PAIRS 无对账条目),该残余并入 9.11。逐项任务 9.9-9.15。

### SPEC-DEFECT(blocking,pass 2)

machine-routed undeclared-impact ×4 **再提起**:code-evidence 判定 `publicV1`/`mcp`/`openapi`/`apiPlayground` 被触及 vs sidecar 四面 unchanged。pass 1 的「裁定结案」(以双档 14/14 行为证据驳回)在本轮不能维持——其行为证据对当前树(zzz-drill 破坏后)不可复现。已按路由更新 design.md Open Questions(再提起条目,不开实现任务),并因「archive 不能接受 false sidecar claim」列入 blockingSpecDefects,挂全部 7 项 public-surface 需求 id。

### Gap findings(pass 2)

无覆盖缺口(gap=null):pass 1 的 21 项 requirement 逐一 trace 结论在本轮抽查(tmux facade、skill-catalog、transcript 派发、source-kind 派生、checksums)中未被推翻,实现均可追溯。

### Scope findings(pass 2,超需求实现)

1. **`packages/contracts/src/skill-catalog.ts:15` — `SKILL_CATALOG_IDS = ['openspec', 'bmad', 'zzz-drill']`**:第三个 skill id `'zzz-drill'` 是未 revert 的 totality-guard 演练成员(镜像本 change 第三 runtime 演练的注入-revert 手法,但漏了 revert),已烤进 `packages/contracts/dist/skill-catalog.js` 与 `.d.ts`。无任何 frontend-console / agent-runtime requirement 声明或预期该 id——skill catalog spec 只要求 web/api 对 `'openspec'`/`'bmad'` 同源。**当前令 apps/api typecheck 红**:`skill-allowlist.ts:55 TS2741 Property '"zzz-drill"' is missing`(裁定人亲跑复现),且连带 web `new-task-dialog.tsx:171/182` 双错。这同时是 V2 全部七项 lane 缺失的根因;修复已作为代码任务落 9.9(该面本身属 `frontend-console/the-skill-catalog-id-vocabulary-is-declared-once-in-contracts` 的 UNMET 重开范围,不另立 id)。

pass 1 的三处 reference-server 超范围强制逻辑(Bearer 鉴权/409 冲突检测/fence 所有权)记录仍然有效,处置建议不变(归档前不阻塞)。

---

## Three-way tally(pass 1,2026-08-01 首轮,历史存档——tally 已被上方 pass 2 取代)

| Route | Count | Ids |
| --- | --- | --- |
| MET(reclassified) | 1 | `agent-runtime/admitting-a-third-runtime-shall-cost-only-a-declaration-and-a-registration` |
| UNMET(reopened → tasks.md `## Track: verify-reopened`) | 8 | 7 × machine-routed dynamic-evidence-missing(V.1-V.7)+ 1 × 裁定人确认的真实缺口(V.8 runtime-label.ts) |
| SPEC-DEFECT(→ design.md Open Questions;全部 blocking) | 7 | machine-routed undeclared-impact ×4(publicV1/mcp/openapi/apiPlayground sidecar 矛盾),挂在全部 7 项 public-surface 需求上 |

归档门禁:8 条 machine-routed public findings(4 × dynamic-evidence-missing + 4 × undeclared-impact)全部 blocking——verify-reopened track 清零且 sidecar 矛盾解决前不可 archive。

## Reclassified MET

### agent-runtime/admitting-a-third-runtime-shall-cost-only-a-declaration-and-a-registration

Skeptic 将其计入 raw-unmet,裁定人端到端重走后判 MET,依据:

- **动态 ground-truth drill 通过(refuted=false)**:活树准入演练——向 `packages/contracts/src/agent-runtime-id.ts` 注入 throwaway `'opencode'`(1 声明)并在 `apps/api/src/agent-runtime/agent-runtime.integration.ts` 注册(1 注册),随后编译器要求的全部 9 处后续改动**均为已有总 Record 的缺 key 表行**(RUNTIME_METADATA 行、CLI version pin 行+夹具、credential 解析行、catalog 描述符行、readiness 行、sandbox preflight 行、web runtime-label 行、web settings 凭据组接线行、conformance participation 账本行),零新增词表声明、零展示/派发分支;填齐后 contracts build + api/web/runtime-conformance typecheck 全绿;演练改动逐字节 revert 后四包 typecheck 复绿。
- **与 requirement 文本逐句对齐**:spec 明文允许「one data row in each compile-time-total per-runtime policy table」,且 scenario「A hypothetical third runtime needs no display or dispatch branch」要求的是零 *branch* 编辑——9 处全是 total-Record 数据行,无一是 label/CLI-preview/credential-alert/settings/transcript-read 消费者代码的分支编辑,与 drill 结果一致。
- **独立复现**:drill 结果与 `baseline.md` 记录的 7.6-7.8 演练在文件/行位上逐一吻合;本 change 不在 machine-routed public findings 的 requirementIds 之列,无强制路由约束。
- 注:web `runtime-label.ts` 的 `AGENT_LABELS` 行在**本** requirement 口径下是合法表行(总 Record 数据),但在 `frontend-console/runtime-display-surfaces...` 的更严格口径(「no console code edit」+「labels SHALL resolve RUNTIME_METADATA」)下是缺口——后者已独立重开为 V.8,不影响本项 MET。

## UNMET(reopened)

- **V.1-V.7(machine-routed,不可改判)**:7 项 public-surface 需求的静态 trace 经裁定人复核全部成立(表/闸/测试/注入红证均实存且本会话有活跑记录),但强制动态证据 lane(registry / restMetadata / mcpSdkMetadata / behavior)未产出通过记录;按裁定规则 public-surface 需求的静态 trace 仅 advisory,不可代偿动态 lane。逐项任务见 tasks.md verify-reopened track。
- **V.8(裁定人确认的真实缺口)**:`apps/web/src/lib/runtime-label.ts:22-25` 手写 `AGENT_LABELS: Record<Runtime, string>`(codex/claude-code 标签的第二份声明)而非读 `RUNTIME_METADATA[runtime].label`,消费于 history.tsx:118/255、schedules.tsx:871、queries.ts:645——正是 contracts 侧注释宣称 label 字段服务的「task lists」面;`baseline.md:67` 自证第三 runtime 仍需手改此文件,直接违反 requirement 明文「runtime labels SHALL resolve the RUNTIME_METADATA row … SHALL appear across these surfaces with no console code edit」。scenarios 1-2(credential alert / settings 集合驱动)已满足,但 requirement 正文的 label 子句未满足且缺口可测试、修法明确,故判 UNMET 而非 met-with-minor-gap。

## SPEC-DEFECT(blocking)

machine-routed undeclared-impact ×4:verify 公共面 code-evidence 判定 `publicV1`/`mcp`/`openapi`/`apiPlayground` 被本 change 触及,而 `surface-impact.json` 四面全声明 unchanged;与任务 7.8 的 grep 复核结论(零引用/零触碰)直接矛盾。已按路由写入 design.md Open Questions(不开实现任务),并因「archive 不能接受 false sidecar claim」列入 blockingSpecDefects。涉及全部 7 项 public-surface 需求(id 清单见 design.md 该条)。

## Gap findings(requirement 覆盖缺口扫描)

无缺口。逐一核对 `openspec/changes/unlock-extension-axes/specs/` 7 个 spec 文件的全部 21 项 requirement,对工作树均有可追溯实现:

- `RUNTIME_METADATA` 表 + 自失效 typecheck 夹具:`packages/contracts/src/agent-runtime-id.ts`、`runtime-metadata.typecheck.ts`
- task-failure 三元替换 / parse 位保留:`apps/api/src/task-failure/task-failure.ts`
- `TranscriptReadStrategy` 真派发:`packages/sandbox/src/host-harness/configured-provider.ts`
- 控制台三面(credential alert、settings、new-task dialog)读 `RUNTIME_METADATA`:`apps/web/src/components/...`
- skill id 词表共享:`packages/contracts/src/skill-catalog.ts`,`apps/web` 与 `apps/api/src/sandbox/skill-allowlist.ts` 双端真 import
- runtime-conformance 包(harness-maker 接缝、participation 账本、5 scenario family、报告、CI 目录招收):`packages/runtime-conformance/`
- source-kind 派生 + provider-snapshot/boxlite-rootfs 语义 pin:`packages/contracts/src/runtime-model.ts`、`sandbox-environment.ts`
- `RuntimeArtifactChecksumsSchema` record 化:`packages/contracts/src/sandbox-environment.ts`;R5 闸覆盖:`scripts/sandbox-core-vocabulary-parity.mjs`
- `cloud-http` 操作员词表成员 + D14 注记、总 allowance 表、R8 闸、tmux facade 去重(api 侧 `codex-launch.ts` 已删):`packages/sandbox/src/host-harness/config.ts`、`scripts/operator-provider-vocabulary-parity.mjs`
- `sandbox-cloud-http` reference server(7 端点、版本协商 counter-offer、secret-writer 拒绝)在 workspace 构建圈:`packages/sandbox-cloud-http/src/reference-server.ts`、`http-cloud-provider.ts`

tasks.md 原 51/51 全勾与上述 trace 一致。工作全部未 commit(交付状态注记,非覆盖缺口)。

## Scope findings(超需求实现扫描)

对全部改动文件逐 diff 复核,实现整体紧贴 requirement/scenario,仅一处文件含无 requirement 背书且无测试行使的行为——`packages/sandbox-cloud-http/src/reference-server.ts` 超出 sandbox-provider-port 三项 requirement(README 7 端点 + 可选自描述 + secret-writer 拒绝保留)的协议级强制逻辑:

1. `reference-server.ts:154-159` — Bearer-token 鉴权(`apiToken` 选项,缺失/不匹配 `Authorization` 头返 401);无任何 sandbox-provider-port requirement 提及服务端鉴权,且无测试向 `startHttpCloudSandboxReferenceServer` 传过 `apiToken`——分支未测试、未被需求要求。
2. `reference-server.ts:249-257` — `createSandbox` 对指名不同 `resourceGeneration` 的 create 重放返 409("conflicting resource generation");该冲突检测语义不在三项 requirement/scenario 之列,任何测试均未触发。
3. `reference-server.ts:329-357` — `fence()` 的所有权 fencing 强制(providerSandboxId 不匹配 409、If-Match/resourceGeneration 不匹配 412、首 fence 收养);spec 无对应 requirement,共享 ownership conformance 场景仅行使 happy-path 收养——mismatch/拒绝分支从未被任何测试命中。

处置建议(归档前不阻塞,供后续 change 参考):要么为这三处补 requirement + 测试,要么裁掉未行使分支——保持 reference server 「协议可执行文档」的定位不含未成文协议。

## Verification verdicts carried from live runs(裁定人本会话亲跑)

- contracts:`sandbox-environment.test.mjs` 18/18、`runtime-model.test.mjs` 10/10;tsc 注入两探针红证(缺 metadata 行 / Partial 弱化)后 revert 复绿
- api:`runtime-model-environment.resolver.spec` 10/10、`sandbox-environments.service.spec` 35/35
- 闸门:`sandbox-core-vocabulary-parity.mjs` 绿(11 vocabularies)+ 自测 16/16;`operator-provider-vocabulary-parity` 自测 10/10;`agent-identity-branch-check.mjs` 绿;`contracts-shared-export-check.mjs` 绿
- 准入 drill:四包 build/typecheck 注入-填表-revert 全流程绿(见 Reclassified MET)
