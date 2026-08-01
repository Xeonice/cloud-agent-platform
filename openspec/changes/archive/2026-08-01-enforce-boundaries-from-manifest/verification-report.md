# Verification Report — enforce-boundaries-from-manifest

Adjudication pass: 2026-08-01(opsx-verify 三路裁定)。裁定人对每项 raw-unmet 在当前工作树逐文件重走代码 + 亲跑动态探针,未 rubber-stamp skeptic。
工作树状态:全部实现未 commit(`git status` 见 `docs/refactor/boundaries-manifest.json`、`packages/eslint-config/boundaries.js`、`scripts/*.mjs` 四闸门 + 配对自测、15 份 `eslint.config.*`、4 份 `CLAUDE.md`、`turbo.json`、`.github/workflows/ci.yml` 均在盘)。

---

## Re-verify pass 1 — 2026-08-01(本节为最新裁定,tally 以本节为准)

本轮输入:1 项 raw-unmet(带 skeptic 动态复核 `refuted=false`);machine-routed mandatory public findings = **0**(空清单)。

### Three-way tally(pass 1)

| Route | Count | Ids |
| --- | --- | --- |
| MET(reclassified,本轮) | 1 | `boundary-lint-rules/s2-forbids-components-bypassing-the-capabilities-seam` |
| UNMET(reopened,本轮新开) | 0 | — |
| SPEC-DEFECT(本轮) | 0 | —(无 machine-routed undeclared-impact/false-exclusion 提交,不新增 blocking 条目) |

归档门禁注记:**本轮不新增 blocker**。`surface-impact.json` 声明 `publicV1/mcp/openapi/apiPlayground = unchanged`、`internalOnly = changed`、`protocolDifferences: []` —— 裁定人复核属实:本 change 全部落点在 dev/CI 工具面(manifest JSON、ESLint 片段生成器、四个 gate 脚本、CLAUDE.md/登记表),零运行时代码路径、零对外面,sidecar 无虚假排除。

### Reclassified MET(pass 1)

**1. `boundary-lint-rules/s2-forbids-components-bypassing-the-capabilities-seam`** — 判 **MET**(端到端重走成立,含一处不阻塞主场景的措辞注记,见下)。

裁定人本会话独立取证(非复述 skeptic):

- **单一声明源**:`docs/refactor/boundaries-manifest.json` `seamRules[id=S2]` —— `appliesTo=["apps/web/src/components"]`、`target.path=apps/web/src/lib/api/real.ts`、`target.specifiers=["@/lib/api/real"]`、`allowTypeImports=true`、6 条 `allowNames`(全为错误类/错误分类器,逐条带 reason/owner/change)、3 条 `exemptions`(api-stream-panel.tsx、session-cast-log.tsx、codex-direct-dialog.tsx,逐条带 owner/change)、`provenance=docs/refactor/02-boundaries-manifest.md:36`。
- **规则消息的规范源引用是真的**:`apps/web/src/lib/api/capabilities.ts` 文件头确实载有 "the SINGLE real/mock switch point…queryFn is the only place real-vs-mock is chosen",message 引的不是杜撰句。
- **消费者 1(ESLint 工厂)**:`packages/eslint-config/boundaries.js` `seamBypassPattern()`(L437-474)由 manifest 派生 `@typescript-eslint/no-restricted-imports`,`allowImportNames` 取自 `allowNames`,`allowTypeImports` 透传;`exemptionConfigs()`(L477-500)把 manifest 豁免转成 per-file 关闭片段。
- **消费者 2(CI 解释器,不经 ESLint 管线、disable 注释免疫)**:`scripts/boundaries-manifest-check.mjs` L1169-1192 处理 `rule.kind === 'seam-import'`,逐 binding 排除 typeOnly、比对 `allowNames`;L1197-1209 的 stale-exemption 检测提供 shrink-only 棘轮(豁免不再覆盖任何违规即失败)。
- **动态 ground-truth(裁定人亲跑)**:临时写入 `apps/web/src/components/__verify_probe_s2.tsx`,值 import 非白名单的取数函数 `listTasks`。
  - `npx eslint`(apps/web 真 config)报出且仅报出 S2:`'listTasks' import from '@/lib/api/real' is restricted because only 'ApiError,…,sessionCastUnavailableReasonFromApiError' import(s) is/are allowed. … [S2 · docs/refactor/02-boundaries-manifest.md:36] @typescript-eslint/no-restricted-imports`,消息内含 capabilities seam 引文 —— 对上 Scenario「A new seam bypass is reported」。
  - 同一探针下 `node scripts/boundaries-manifest-check.mjs` 亦报 `[S2/seam-bypass] apps/web/src/components/__verify_probe_s2.tsx:1` —— 两条回路对同一新违规判定一致。
  - 删除探针后:`node scripts/boundaries-manifest-check.mjs` → `11 rule(s) over 603 file(s) — no boundary violations`;`git status --porcelain` 对该路径零残留。
- **配对自测**:`node --test scripts/boundaries-manifest-check.test.mjs` → **50/50 pass**(含 seam-bypass 检出、type-import/allowNames 放行、tsconfig alias 解析、allowNames 字段完整性校验、stale-exemption 检出)。
- **「恰好一本账」(Scenario: Tolerated bypasses live in exactly one ledger)**:裁定人实测 `apps/web/eslint-suppressions.json` 只剩 2 条,且均为 `.test.tsx`/`.test.ts`(claude-credential.test.tsx、smtp-config-section.test.ts);解释器 `isGeneratedOrTest()`(L791-797,L876 应用)按 `*.test.*` 不扫这两个文件。manifest 的 3 条 S2 豁免全部是生产组件,与 suppressions 两条**零重叠**(交集 = ∅),与 tasks.md 6.7 集成实测记录逐点吻合。每处存量恰好落一本账,无双重记账。
- **其余组件面**:`app-error.tsx`/`runtime-model-selector.tsx`/`new-task-dialog.tsx`/`import-dialog.tsx` 只值 import `allowNames` 内的错误分类器,不需要豁免 —— 与 D4「错误分类器不在运行时选择 transport,不是假债」的拍板一致。

**随案注记(不破 MET)**:requirement 散文写「exactly one ratchet mechanism(**ESLint bulk suppressions 或 shared `scripts/ratchets` comparator** —— design 拍板选哪个)」,而最终落地的存量账本是 **manifest 三字段 exemptions**(第三种机制,由 tasks.md 集成期裁定记录 L253-259 把 D5 的「eslint-suppressions.json 是唯一账本」改写而来:解释器按 spec 不得读 suppression file,故存量下沉进 manifest 以补回 shrink-only 语义,suppressions 从 7 条收缩到 2 条)。可测判据(两条 Scenario:新违规被报、每处存量恰好一本账、修复不缩账本即红)全部满足,散文括号内的二选一枚举属叙述精度差,不构成 ambiguous/untestable,**不入 Open Questions、不阻塞归档**。附带文档漂移:`design.md` D5 正文仍写「eslint-suppressions.json 是唯一账本」,未随集成裁定回写 —— 记为归档前可选的文档订正,非代码缺陷。

### Gap findings(pass 1)

无覆盖缺口(`[]`)。

`openspec/changes/enforce-boundaries-from-manifest/specs` 六份 spec 共 33 条 requirement(agent-docs-reconciliation 5 / boundaries-manifest 6 / boundary-ci-interpreter 5 / boundary-lint-rules 8 / context-layout-report 5 / security-seam-assertions 4)在工作树均有可追溯实现:`docs/refactor/boundaries-manifest.json`(P1–P8/S1–S3/D 表全量条目 + provenance/change 字段)、`packages/eslint-config/boundaries.js`(fail-closed 工厂 + exemption/allowNames 校验 + esquery S1 选择器)、`scripts/boundaries-manifest-check.{mjs,test.mjs}`、`scripts/security-seam-check.{mjs,test.mjs}`、`scripts/claude-md-dependency-reconcile.{mjs,test.mjs}`、`scripts/context-layout-check-v2.{mjs,test.mjs}`、4 份 CLAUDE.md 依赖段 + 降级易腐计数、`turbo.json` `globalDependencies`、`.github/workflows/ci.yml`(既有步骤名逐字节不变)、`package.json` scripts、15 份 `eslint.config.*`、`docs/refactor/04-rules-registry.md` 与 `02-boundaries-manifest.md` 登记格(每格写本 change 名)。

四个新 gate 在真实树上均**实跑退出 0**(裁定人本会话逐个执行:`boundaries-manifest-check.mjs`、`security-seam-check.mjs`、`claude-md-dependency-reconcile.mjs`、`context-layout-check-v2.mjs`),证明端到端接线而非仅文件在盘。

### Scope findings(pass 1,超需求实现)

以下 7 处实现行为在六份 spec 的 requirement/scenario 文本中找不到对应条款。均不阻塞归档,处置建议:补 requirement + 测试,或裁掉未行使分支。

1. `scripts/security-seam-check.mjs:249` — `missing-implementation`(唯一性 pattern 命中数 < `expectedCount`)。security-seam-assertions 只要求「seam 文件缺失」与「重复实现」两个 scenario,该分支无 fixture/自测。
2. `scripts/security-seam-check.mjs:258` — `relocated-implementation`(命中数正确但不在声明的 canonical 路径)。无对应 scenario,未测。
3. `scripts/claude-md-dependency-reconcile.mjs:219` — `missing-doc`(受管子树整份 CLAUDE.md 缺失)。agent-docs-reconciliation 的 fail-closed 只覆盖既有文件内**段落**缺失/不可解析,不含整份文件缺失,该路径未测。
4. `scripts/claude-md-dependency-reconcile.mjs:254` — `no-governing-rule`(受管子树零 A 表条目适用)。无 requirement 描述该情形。
5. `scripts/claude-md-dependency-reconcile.mjs:137` — `ambiguous-declaration`(段落既写 "None" 又列包名)。不在任何 scenario。
6. `scripts/context-layout-check-v2.mjs:342-522` — scope 下某顶层目录映射不到任何已声明 context(`unmappedDirectories`)时**整闸失败**(非产出 finding)。context-layout-report 的三类检查 + unclassified-file scenario 讲的是逐文件分类,不含「未映射目录导致整闸中止」。
7. `scripts/boundaries-manifest-check.mjs:695,703,1138` — 包级规则(P1–P8)支持通用 `allow`/`allowSpecifiers` 放行清单。boundaries-manifest 与 boundary-ci-interpreter 均无「包规则 per-rule 白名单」要求(S2 的 `allowNames` 有明文,这条平行机制没有);裁定人 grep 确认**shipped manifest 中零条目使用**,且无自测行使。

已排除的候选(经复核可追溯到明文 scenario 或 tasks.md 集成期裁定,不计为超需求):`forbid.paths` 的 own-package 豁免、manifest 豁免的 stale-entry 收紧检查、egress `reference` 形态检出、`--root`/`--manifest` CLI flag、`design-baseline` 跳过目录。
