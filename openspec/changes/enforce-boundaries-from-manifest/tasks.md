<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.

     PARTITION CORRECTED against real file coupling (apply 阶段扫描结果)。与 draft 的差异：
     1. draft 的 5.（security-seams，2 tasks）与 6.（agent-docs，4 tasks）合并为
        `assertion-gates`（6 tasks）：两者文件集互不相交、依赖同为 manifest、都只新增
        scripts/ 闸门 + 文档段落；2-task 轨过小，合并后与最长的 eslint-rules 齐平，
        关键路径不变（manifest → 6 → integration），少一个 worktree/合并面。
        任务号随之重编：旧 6.1–6.4 → 5.3–5.6，旧 7.x → 6.x。
     2. 其余轨的成员不变——扫描确认 tracks 2/3/4/5 的写入文件集两两不相交（见下方文件所有权）。

     文件所有权（并行期唯一写者，越界即冲突）：
     - manifest        → docs/refactor/boundaries-manifest.json（新建，本轨唯一产物）
     - eslint-rules    → packages/eslint-config/**、apps/web/eslint.config.js（试点）、
                         apps/web 的 eslint-suppressions 账本
     - ci-interpreter  → scripts/<boundaries 解释器>.mjs + .test.mjs + 其 fixtures 子目录
     - layout-v2       → docs/refactor/contexts-manifest.json、docs/refactor/07-baselines-and-dependencies.md、
                         scripts/<layout-v2>.mjs + .test.mjs、scripts/ratchets/<rule-id>.json
                         （scripts/ratchets/comparator.mjs 只读 import，禁止修改）
     - assertion-gates → 四份 CLAUDE.md（apps/api、apps/web、packages/contracts、packages/sandbox）
                         + scripts/<R9 seam>.mjs、scripts/<R10 对账>.mjs 及其 .test.mjs
     ⚠ 四份 CLAUDE.md 由 assertion-gates 独占：layout-v2 即使新增 v2 闸门也不得去
       apps/api/CLAUDE.md 补文档（该文件现有 api-module-layout-check 段落是诱因），
       需要的文档改动留给 integration 或后续 change。

     SERIAL integration track 独占全部共享文件（A2）：
       14 个非试点 eslint.config.*（全仓实测共 15 个，试点占 1）、packages/eslint-config
       的扇出改动、根 package.json、turbo.json、.github/workflows/ci.yml、
       docs/refactor/04-rules-registry.md、docs/refactor/02-boundaries-manifest.md。
     本 tasks.md 本身也是共享文件：各轨只勾自己的行，红证块只由 integration（6.5）回填。

     跨轨读依赖（非写冲突，但有顺序性）：
     - 3.2 读 eslint-suppressions 账本，而账本由 2.6 建 → ci-interpreter 轨内只用 fixtures
       自证，真实树「每处存量恰好落一本账」的对账在 6.7（integration）做。
       ⚠ 另注：specs/boundaries-manifest.md 的「The interpreters do not feed each other」
       场景明写解释器输入中 **不得含 suppression file**，与 design D5 / 3.2 冲突——
       实现前须先裁定（改为豁免数据落 manifest，或修正该 spec 场景），勿默默二选一。
     - 新增 scripts/*.test.mjs 由根 `test:scripts` glob 自动发现，无需改
       scripts/test-discovery-check.mjs 或 quarantined-suites.mjs（已核）。 -->

## 1. Track: manifest (depends: none)

- [x] 1.1 创建 `docs/refactor/boundaries-manifest.json`：转写工件02 A 表 P1–P8（含 P6 type-only 语义数据）、C 表 S1–S3、D 表 4 个安全 seam（声明路径 + 唯一性谓词），每条带 `provenance`（工件02 行号）+ `change` 字段，规则内容零发明、零遗漏
  - requirements: ["boundaries-manifest/a-machine-readable-boundaries-manifest-is-the-single-declaration-source"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.2 顶部加 `$comment`（同 contexts-manifest.json 契约：修改本文件 = 架构决策，须经 OpenSpec change 留痕）
  - requirements: ["boundaries-manifest/manifest-edits-are-architecture-decisions-carried-with-provenance"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.3 P3/P7/S3 条目写成对既有执行器仓库路径的引用（不含可执行规则数据，防止双实现）
  - requirements: ["boundaries-manifest/already-landed-rules-are-incorporated-by-reference-never-re-implemented"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 1.4 S1 存量按 D3 分流落数据：`lib/mock-session.ts` 5 处 fetch 记三字段豁免 `{reason, owner, change}`；S2 条目带 `allowNames` 数据字段（登记 `ApiError`、`runtimeModelErrorFromApiError` 等非取数值导出，新导出默认被禁）；transports 枚举钉 `[lib/api/real.ts, ws-client]`
  - requirements: ["boundaries-manifest/exemption-entries-are-three-field-reviewable-data"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 2. Track: eslint-rules (depends: manifest)

- [x] 2.1 `packages/eslint-config` 建规则工厂：加载时直接 `import` manifest JSON；manifest 缺失/不可解析/空规则集/条目缺 `provenance`/`change` 一律 config-load 抛错（fail-closed，lint 非零退出）
  - requirements: ["boundaries-manifest/two-consumers-derive-independently-from-the-manifest-with-no-codegen", "boundary-lint-rules/lint-fails-closed-when-the-manifest-cannot-be-loaded"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.2 P1–P8 emit 包名 pattern 的 `no-restricted-imports` 并按消费包身份分发（P1 只作用于 apps/web 等）；P6 用 `@typescript-eslint/no-restricted-imports` + `allowTypeImports: true`
  - requirements: ["boundary-lint-rules/package-boundary-rules-p1-p8-are-derived-from-the-manifest-as-package-name-patterns", "boundary-lint-rules/p6-permits-type-only-imports-and-rejects-value-imports"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.3 S1：`no-restricted-syntax` esquery selector 发现式抓 `fetch(...)` / `new WebSocket(...)`，flat config per-file 豁免恰好两个 transport 文件（不做文件枚举）
  - requirements: ["boundary-lint-rules/s1-flags-network-egress-outside-the-designated-transport-files-by-discovery"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.4 S2：组件目录禁 import real.ts 的数据获取值导出（type import 放行），`allowNames` 从 manifest 读，报错文案引用 capabilities.ts 文件头 SINGLE-switch-point 注释为规范出处
  - requirements: ["boundary-lint-rules/s2-forbids-components-bypassing-the-capabilities-seam"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.5 单点端到端试点（D9）：只接 apps/web 的 eslint.config 验证完整回路——violation 单文件 ESLint 红 + 仓库 lint task 红；其余 14 个 config 留给 integration 扇出（全仓实测共 15 个 eslint.config.*）
  - requirements: ["boundary-lint-rules/boundary-rules-reach-every-package-through-the-shared-config"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 2.6 用 ESLint bulk suppressions 建唯一账本 `eslint-suppressions.json` 收 S1 2 处（admin-reveal-modal.tsx、update-banner.tsx）+ S2 存量（api-stream-panel.tsx、session-cast-log.tsx；⚠ 实测 `components/settings/codex-direct-dialog.tsx` 也值导入 start/poll/cancelCodexDeviceLogin，按 D4 谓词多半是第三处，开工先实测定账本大小，别照抄「基线 2」）；验证修复违规不缩账本会因 unused suppression 变红
  - requirements: ["boundary-lint-rules/pre-existing-non-seam-egress-sites-are-dispositioned-and-the-tree-lints-green"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 3. Track: ci-interpreter (depends: manifest)

- [x] 3.1 新建 `scripts/` 独立解释器（配对 .mjs）：直接读 manifest 全树扫描，覆盖静态 import + 动态 `import('…')`、复刻 P6 import-kind 区分、按包身份执行 P1–P8；不经 ESLint 管线（disable 注释天然免疫）
  - requirements: ["boundary-ci-interpreter/an-independent-interpreter-scans-the-whole-tree-from-the-manifest", "boundary-ci-interpreter/the-interpreter-covers-dynamic-imports-and-replicates-the-type-only-distinction"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.2 S1 egress 变体拼法覆盖：`window.fetch` / `globalThis.fetch` / 本地 alias 调用；存量容忍来源按上方裁定（design D5 说读 `eslint-suppressions.json` 作已提交数据上限并自己独立重扫重计数，spec「interpreters do not feed each other」说不得读 suppression file——先裁定再实现，头注释写明所选边界）；本轨内只用 fixtures 自证，真实树对账留 6.7
  - requirements: ["boundary-ci-interpreter/the-interpreter-catches-egress-spellings-the-selector-layer-cannot"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.3 三字段豁免消费：缺 `reason`/`owner`/`change` 任一字段 fail-closed 点名条目；空扫描（scan roots 解析出零文件）即败
  - requirements: ["boundaries-manifest/exemption-entries-are-three-field-reviewable-data"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 3.4 配对自测 `node --test`：fixtures 证 6 条红路径（禁用静态 import / 动态 import / P6 值 import / 带 disable 注释仍红 / egress 变体 / 缺字段豁免），不改动真实树
  - requirements: ["boundary-ci-interpreter/the-interpreter-is-a-canon-gate"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 4. Track: layout-v2 (depends: none)

- [x] 4.1 文件→层判定规则落 `docs/refactor/contexts-manifest.json` 单一声明（`*.controller`/`*.gateway`→interface、`*.service`→application、`*.store`→domain/store 等命名映射，受顶部 $comment 管辖）；判不出层的文件报 unclassified、绝不静默跳过
  - requirements: ["context-layout-report/file-to-layer-classification-is-declared-once-and-fails-closed"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.2 新建 layout v2 独立脚本（配对 .mjs）：读 contexts-manifest.json 做三类检查——跨上下文 import 合法形态、层方向（interface→application→domain/store）、Prisma（`@prisma/client`/`PrismaService`）只在 `*.store.ts`（shared-kernel 声明豁免除外）
  - requirements: ["context-layout-report/a-layout-v2-script-performs-three-check-classes-from-the-contexts-manifest", "context-layout-report/the-v1-layout-gate-is-untouched-and-v2-runs-in-parallel"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.3 import 共享 comparator（`scripts/ratchets/comparator.mjs`，只读 import、字节不动）接 `scripts/ratchets/<rule-id>.json` 基线；基线数字开工活测（不信 112/260 快照），测得数按工件07 §E 回写；基线内退零并打印分类计数、超基线非零
  - requirements: ["context-layout-report/the-report-ratchets-against-a-live-measured-baseline-via-the-shared-comparator"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 4.4 配对自测：fixtures 证三类违规 + unclassified 四条红路径（不碰已提交基线）；空扫描即败；确认 v1 `api-module-layout-check.mjs` 字节不动、其 CI step 照跑
  - requirements: ["context-layout-report/the-v2-script-is-a-canon-gate"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 5. Track: assertion-gates (depends: manifest)

<!-- 合并自 draft 的 security-seams（R9）+ agent-docs（R10）：同依赖、文件集不相交、
     draft 的 2-task 轨过小。轨内先 R9（5.1–5.2）后 R10（5.3–5.6），互不阻塞。 -->

- [x] 5.1 新建 R9 seam 断言脚本（配对 .mjs）：从 manifest D 表读 4 个 seam 的路径与唯一性谓词（脚本内不嵌副本）——文件存在 + grep 全树唯一实现（消费方 import 不计重）；manifest 缺失/D 表空集 fail-closed
  - requirements: ["security-seam-assertions/the-four-security-seams-are-asserted-to-exist", "security-seam-assertions/each-seam-has-a-uniqueness-predicate-proving-a-single-implementation", "security-seam-assertions/the-seam-list-is-manifest-data-not-gate-embedded"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.2 配对自测：missing-seam / duplicate-implementation / empty-seam-set 三条红路径 fixtures
  - requirements: ["security-seam-assertions/the-seam-assertion-gate-is-a-canon-gate"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.3 给 `packages/contracts`、`packages/sandbox` 两份 CLAUDE.md 补「What this subtree may depend on」段（内容与 manifest A 表一致）
  - requirements: ["agent-docs-reconciliation/every-governed-claude-md-carries-the-dependency-section"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 5.4 三处易腐精确数字降约数：apps/api CLAUDE.md「454 source files」、apps/web「261 source files」、packages/contracts「45 modules」
  - requirements: ["agent-docs-reconciliation/perishable-exact-counts-are-demoted-to-approximations"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 5.5 新建 R10 对账脚本（配对 .mjs）：解析 4 份 governed CLAUDE.md 的依赖段与 manifest A 表比对，点名文件 + 失配条目；段落缺失/不可解析 fail-closed（拒绝而非跳过）；解析出零 governed 文件即败
  - requirements: ["agent-docs-reconciliation/a-gate-reconciles-the-dependency-sections-against-the-manifest", "agent-docs-reconciliation/a-missing-section-fails-closed"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 5.6 配对自测：missing-section / contradicting-declaration / empty-governed-set 三条红路径 fixtures
  - requirements: ["agent-docs-reconciliation/the-reconciliation-gate-is-a-canon-gate"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"

## 6. Track: integration (depends: manifest, eslint-rules, ci-interpreter, layout-v2, assertion-gates)

- [x] 6.1 规则扇出其余 14 个 `eslint.config.*`（共享 config 单点覆盖还是 per-package 按「12 个三行转发 config 是否需差异化」判据现场定，A9；全仓实测共 15 个 eslint.config.*，试点已占 apps/web），全仓 lint 绿
  - requirements: ["boundary-lint-rules/boundary-rules-reach-every-package-through-the-shared-config"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.2 根 package.json 加 4 个新 gate 的配对 scripts（`node X.mjs && node --test X.test.mjs` 模式）
  - requirements: ["boundary-ci-interpreter/the-interpreter-is-a-canon-gate", "context-layout-report/the-v2-script-is-a-canon-gate"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.3 ci.yml 既有 required job 内加 4 个新 step（boundaries 解释器 / layout v2 / R9 / R10）；`git diff | grep 'name:'` 核查全部既有显示名字节不变
  - requirements: ["boundary-ci-interpreter/the-interpreter-is-wired-into-ci-without-renaming-any-existing-check"]
  - surfaces: ["ci"]
  - verify: "workflow-gates"
- [x] 6.4 manifest 路径接进 turbo.json globalDependencies（或 lint inputs）；实测改 manifest → lint cache miss 重跑，不回放旧绿
  - requirements: ["boundary-lint-rules/manifest-edits-invalidate-cached-lint-results"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.5 注入探针红证：每个新 gate 各注入一处违规实测变红（含 disable 注释对解释器无效、S2 新导出默认被禁），红证记录进本 tasks.md 后回滚
  - requirements: ["boundary-ci-interpreter/the-interpreter-is-a-canon-gate", "context-layout-report/the-v2-script-is-a-canon-gate"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 6.6 翻转登记表：`docs/refactor/04-rules-registry.md` R1/R2/R9/R10 行与 `02-boundaries-manifest.md` 相关 A/C/D/E 行，每格写 `enforce-boundaries-from-manifest`
  - requirements: ["boundaries-manifest/boundary-registries-record-the-enforcing-change"]
  - surfaces: ["docs"]
  - verify: "workflow-gates"
- [x] 6.7 集成树真跑每条声明 lane（全仓 lint + 4 个新 gate 配对自测 + 既有闸门套件）全绿；核查 S1/S2 每处存量恰好落一本账（豁免或 suppressions，绝不两本/零本），并核实解释器与 ESLint 两条回路对同一批存量的判定一致
  - requirements: ["boundaries-manifest/two-consumers-derive-independently-from-the-manifest-with-no-codegen", "boundaries-manifest/exemption-entries-are-three-field-reviewable-data"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "workflow-gates"

<!-- 注入探针红证（6.5 实测回填；每条注入后实跑、记录、随即回滚，工作树已复原且
     四个闸门在回滚后均 exit 0）：

  A. boundaries 解释器 / disable 注释对它无效（新建 apps/web/src/components/probe-disable.tsx：
     `// eslint-disable-next-line no-restricted-imports` + `import { createTask } from "@cap-console/api"`）
       ESLint       → exit 0（被 disable 注释静音，这正是解释器存在的理由）
       解释器       → exit 1
         [P1/forbidden-import] apps/web/src/components/probe-disable.tsx:2
           static import of '@cap-console/api' matches P1's forbidden pattern '@cap-console/api'

  B. boundaries 解释器 / S2 新导出默认被禁（新建 apps/web/src/components/probe-seam.tsx：
     `import { listTasks } from "@/lib/api/real"`——listTasks 不在 manifest allowNames）
       ESLint       → exit 1，1:10 error … only 'ApiError,…' import(s) is/are allowed
                      [S2 · docs/refactor/02-boundaries-manifest.md:36]  @typescript-eslint/no-restricted-imports
       解释器       → exit 1
         [S2/seam-bypass] apps/web/src/components/probe-seam.tsx:1
           value import of 'listTasks' from '@/lib/api/real' bypasses the capabilities seam S2 declares

  C. layout v2（新建 apps/api/src/tasks/probe-layout.service.ts：`import { PrismaClient } from "@prisma/client"`）
       → exit 1
         prisma-outside-store:apps/api/src/tasks/probe-layout.service.ts: 1 measured violation(s)
           with no baseline entry — new violations the baseline does not cover
         [prisma-outside-store] apps/api/src/tasks/probe-layout.service.ts:1
           reaches '@prisma/client' outside a '.store.ts' file (and outside the declared shared kernel)

  D. R9 seam 断言（新建 apps/api/src/settings/probe-seam-duplicate.ts：第二个
     `export async function assertSafeProviderUrl`）
       → exit 1
         [duplicate-implementation] ssrf-gate
           `export async function assertSafeProviderUrl` has 2 implementation(s), expected 1;
           canonical apps/api/src/settings/assert-safe-provider-url.ts,
           also in apps/api/src/settings/probe-seam-duplicate.ts

  E. R10 对账（把 packages/contracts/CLAUDE.md 的依赖段从 "None" 改成 `@cap-console/sandbox-core`）
       → exit 1
         [contradicting-declaration] packages/contracts/CLAUDE.md
           declares `@cap-console/sandbox-core`, which A-table entry P5 forbids for packages/contracts
           (pattern `@cap-console/*`, docs/refactor/02-boundaries-manifest.md:20)

  F. turbo 缓存失效（6.4 实测，非注入违规）：`pnpm turbo lint` 连续两跑 = 24/24
     FULL TURBO；只改 docs/refactor/boundaries-manifest.json 后第三跑 = 24 个
     `cache miss`；还原后又回到 24/24 FULL TURBO。 -->

<!-- 集成期裁定与实测记录（integration track，6.1/6.7）：

  1. 跨轨 schema 冲突（必须裁定，否则解释器对真实 manifest 全条报错）。
     ci-interpreter 轨按自己文档的形状实现（`rules[].kind` + 字符串数组
     `forbid`/`egress`/`target`），manifest 轨落成的实际声明源是另一种形状
     （`packageRules`/`seamRules` + `enforcement` + 对象 `forbid{packagePatterns,
     paths,allowTypeImports}` / `egress{calls,constructors,receivers}` /
     `target{path,specifiers}`）。裁定：**改解释器就 manifest**——manifest 是唯一
     声明源且已有三个消费者（ESLint 工厂、R9、R10）读它，改 manifest 要动三处、
     改解释器只动一处。落地：
       - 规则 kind 由条目自身数据推导（`enforcement: existing-gate` → reference；
         `forbid`/`egress`/`target` → 三种执行），不再读会与数据相左的 `kind` 字段；
       - `appliesTo` 支持 `*` 段展开（`packages/*/src`），展开为零仍按空扫描报红；
       - `forbid.paths` 只判跨包越界（manifest conventions 的明文语义）——解析结果
         落在文件自身包内的 import 不算违规，否则 P5 会把 contracts 对自己的每个
         相对 import 判红；
       - `egress.receivers` 从 manifest 读，不再硬编码在扫描器里；
       - 全部 fixtures 与自测内联 manifest 一并迁到真实 schema，并去掉第三种容器键
         拼写（只认 `packageRules`/`seamRules`）。
     解释器自测 48 → 50 条（新增「豁免失效即红」「同包 import 不越界」两条）。

  2. 存量账本冲突（tasks.md 顶部 ⚠ 预告的裁定，D5 vs spec）。
     spec `boundaries-manifest`「The interpreters do not feed each other」明写解释器
     输入不含 suppression file；而 D5 把 S1 两处 + S2 存量放进 eslint-suppressions
     账本。两者并存的后果是解释器在已提交树上直接报红（spec 又要求「clean tree
     passes」）。裁定：**解释器扫描范围内的存量一律落 manifest 三字段 exemptions**
     （两个消费者都直读同一处，一债一账），并给解释器加「豁免不再覆盖任何违规即报红」
     以补回 suppressions 的 shrink-only 语义；ESLint 侧新增按 manifest 逐文件豁免
     S2（此前只有 S1 有）。`apps/web/eslint-suppressions.json` 因此从 7 条收缩到 2 条，
     只留解释器不扫的测试文件——两本账零重叠（6.7 实测见下）。

  3. 6.1 的 A9 判据（共享 config 单点 vs per-package）：判为 **per-package 显式传
     `packageDir: import.meta.dirname`**。规则内容不需要差异化，但规则是按包身份
     scope 的，共享 config 是静态数组、拿不到消费方目录；用 `process.cwd()` 推断会让
     「编辑器从仓根跑 ESLint」得到一份更小且静默的规则集——正是本 change 要消灭的
     静默变绿。15 个 eslint.config.* 全部接入（试点 apps/web + 扇出 14）。

  4. 6.7 实测：
     - 全仓 `pnpm turbo lint` 24/24 成功；4 个新配对 gate（test:boundaries /
       test:context-layout-v2 / test:security-seams / test:agent-docs）全 PASS；
       既有 8 个 gate 套件全 PASS；`pnpm test:scripts` 424 tests / 422 pass / 2 skip / 0 fail。
     - 一债一账：manifest exemptions 6 条（S1×3：admin-reveal-modal、update-banner、
       mock-session；S2×3：api-stream-panel、session-cast-log、codex-direct-dialog）
       ∩ eslint-suppressions 2 条（claude-credential.test.tsx、smtp-config-section.test.ts）
       = 空集；零本的也没有（把 exemptions 摘掉后两条回路各自都报出全部存量）。
     - 两条回路判定一致：临时摘掉 manifest 的 exemptions 并绕开 suppressions 后，
       解释器报出的 6 个文件与 ESLint 报出的前 6 个逐一相同；ESLint 另报 2 个测试文件，
       正是解释器按 `*.test.*` 不扫的那两个，也正是 suppressions 账本里的那两条——
       差集可解释、无遗漏。
     - S2 存量实测为 3 个文件（proposal 的「基线 2」是开工前快照），codex-direct-dialog
       的 start/poll/cancelCodexDeviceLogin 确为第三处，已按实测落账。 -->
