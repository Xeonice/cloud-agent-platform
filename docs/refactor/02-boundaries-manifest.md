# 工件 02 — 边界清单（boundaries manifest）

包级 + 上下文级 + app 内 seam 的 import 规则**单一声明**。
消费者：阶段 3 的 ESLint 规则生成器与同源 CI 闸门（两者必须从同一份数据生成，
不得各自维护）；CLAUDE.md 对账闸门。

状态：✅ 规则定稿并已落地执行（enforce-boundaries-from-manifest）。机器可读声明源 =
`docs/refactor/boundaries-manifest.json`，A/C/D 表逐条转写，每条的 `provenance` 指回本文件行号。

## A. 包级规则（R1）

依据：现状实测（零越界）+ 4 份 CLAUDE.md 的散文声明 + repo-split §2.1。

| 规则 | 内容 | 现状 |
|---|---|---|
| P1 | `apps/web` 禁止 import `@cap-console/api`、`@cap-console/sandbox*`、`apps/api/*` 任何路径 | ✅ 已落地（enforce-boundaries-from-manifest）：manifest 条目 P1，ESLint + CI 解释器双回路 |
| P2 | `apps/api` 禁止 import `@cap-console/web`、`@cap-console/ui`、`apps/web/*` | ✅ 已落地（enforce-boundaries-from-manifest）：manifest 条目 P2，双回路 |
| P3 | `apps/api` 对 sandbox 系列只准 import facade `@cap-console/sandbox`（+ devDep conformance 仅测试） | 有闸门（sandbox-package-boundary），阶段 1 扩域；enforce-boundaries-from-manifest 按引用登记进 manifest（`enforcement: existing-gate`），不派生第二份执行 |
| P4 | `packages/*` 禁止 import `apps/*` | ✅ 已落地（enforce-boundaries-from-manifest）：manifest 条目 P4，双回路 |
| P5 | `packages/contracts` 禁止 import 任何内部包 | ✅ 已落地（enforce-boundaries-from-manifest）：manifest 条目 P5，双回路 |
| P6 | `packages/sandbox-core` 保持零运行时依赖；contracts 仅 `import type`（D14 类型层） | ✅ 已落地（enforce-boundaries-from-manifest）：manifest 条目 P6，type-only 区分两侧各自实现（ESLint `allowTypeImports` / 解释器 import-kind 判定） |
| P7 | facade `packages/sandbox` 的导出面显式白名单，禁止 `export *` 泄漏 provider 内部符号（R6） | ✅ 已落地（close-gate-blindspots 2.3–2.6）：`src/index.ts` 全命名导出（provider 符号仅 apps/api 经 barrel 实际触达的 26 个，逐条 phase-7a 注记）；闸门 `packages/sandbox/test/facade-surface.gate.mjs` 对账 committed `expected-facade-surface.json`，`export *` 即红，随包 test script 进 CI；scripts/ 金丝雀等非 api 消费者直连 provider 包 dist，不走白名单 |
| P8 | `apps/www` 与控制台/后端零 runtime 依赖 | ✅ 已落地（enforce-boundaries-from-manifest）：manifest 条目 P8，只禁值 import（规则原文限定 runtime） |

## B. 上下文级规则（消费 contexts-manifest.json）

见 `contexts-manifest.json` 的 `crossContextRules`：跨上下文只准 port/DI token/
事件/module 组装四种形态；共享内核（prisma/crypto/observability）豁免。
层方向 interface→application→domain/store，Prisma 只在 `*.store.ts`。

## C. app 内 seam 规则（R2 + 交叉验证新增）

| 规则 | 内容 | 依据 |
|---|---|---|
| S1 | `apps/web` 出网只经 `src/lib/api/real.ts` 与 `src/lib/ws-client.ts`；其他文件禁止 `fetch(`/`new WebSocket` | ✅ 已落地（enforce-boundaries-from-manifest）：发现式扫描，transports 与 G8 的 CONSOLE_TRANSPORTS 同一份枚举；存量 3 文件走 manifest 三字段豁免 |
| S2 | mock/real 切换只经 `lib/api/capabilities.ts` 声明的 queryFn seam；组件禁止直接 import `real.ts` 的函数 | ✅ 已落地（enforce-boundaries-from-manifest）：谓词＝只禁取数函数的值 import，`allowNames` 登记非取数导出、新导出默认被禁；存量 3 文件（实测，非「基线 2」）走 manifest 三字段豁免 |
| S3 | `apps/api` 的 dockerode/Docker/provider 内部符号禁令全 src 生效 | ✅ 已落地（close-gate-blindspots 3.4/3.5）：import 与符号双扫描的 roots 均由 `contexts-manifest.json` `scope` 驱动（manifest 缺失/空 scope/零文件均红，无硬编码回退）；存量 5 文件走 `scripts/ratchets/r3.json`（共享 comparator，shrink-only），validator 一路阶段 7a 根治 |

## D. 安全 seam 登记（交叉验证采纳项）

被登记的"单一计算"接缝——上下文/目录重排时**必须保持唯一实现**，禁止第二份：

| seam | 位置 | 说明 |
|---|---|---|
| Origin 计算 | `apps/api/src/auth/request-origin.ts`（自述 "the ONE computation"） | 消费方：auth.guard 的 session CSRF 闸、origin-checked-ws-adapter、main.ts WS adapter 接线；唯一性谓词 `export function isTrustedRequestOrigin` |
| 会话校验 | rest-session-validation / ws-session-validation 的统一入口 | 已有 spec 测试锚定；实测入口 = `apps/api/src/auth/auth-session.service.ts` 的 `resolveSession(` |
| SSRF 闸 | `assertSafeProviderUrl`（forge-no-ssrf-gate.spec 锚定） | forge HTTP 直连的信任边界声明不变；唯一性谓词 `export async function assertSafeProviderUrl` |
| 凭据加密读取 | 三读取点共用 helper（multi-forge 时代裁定） | 禁止新读取点绕 helper；实测 helper = `apps/api/src/crypto/secret-storage.ts` 的 `decryptStored` |

规则：安全 seam 的移动必须在同一 change 内更新本表 + 对应锚定测试，闸门断言
"seam 声明的文件存在且唯一"——✅ 已落地：`scripts/security-seam-check.mjs`（enforce-boundaries-from-manifest）。

## E. CLAUDE.md 对账（决策 3）

manifest 为唯一声明源；4 份 CLAUDE.md（apps/api、apps/web、packages/contracts、
packages/sandbox）保留散文解释，但其中的**依赖白名单清单**与本清单对账——
闸门解析 CLAUDE.md 的 "What this subtree may depend on" 段落，与 A 表比对，
不一致即红。CLAUDE.md 中的易腐数字（"454 source files" 等）降级为约数或删除，
不进对账。

✅ 已落地（enforce-boundaries-from-manifest）：闸门 `scripts/claude-md-dependency-reconcile.mjs`
（段落缺失/不可解析/零 governed 文件一律 fail-closed）；`packages/contracts` 与
`packages/sandbox` 两份缺失段落本次补齐；三处易腐精确数字（api 454、web 261、
contracts 45）已降为约数。

## F. 生成物与执行位置

✅ 已落地（enforce-boundaries-from-manifest）——无 codegen、无中间产物，两个消费者
在各自加载时直读同一份 JSON：

```
docs/refactor/boundaries-manifest.json   (本文档 A/C/D 表的机器可读转写)
  ├─→ packages/eslint-config/boundaries.js  规则工厂（配置加载期直读 JSON）
  │     → 15 个 eslint.config.* 各自传自己的 packageDir → IDE 即时反馈 + pre-commit lint
  ├─→ scripts/boundaries-manifest-check.mjs 独立解释器（自己重扫全树，不经 ESLint 管线，
  │     故 eslint-disable 对它天然不可见；覆盖动态 import 与 window.fetch 等变体拼法）
  ├─→ scripts/security-seam-check.mjs       D 表 seam 存在性 + 唯一性断言（R9）
  └─→ scripts/claude-md-dependency-reconcile.mjs  CLAUDE.md 依赖段对账（E 节，R10）
```

元规则约束：生成器与闸门不得各自内嵌规则数据；规则数据只在 JSON 一处。两个消费者
各自从 manifest 派生、**绝不互相派生**——解释器的输入只有 manifest 与源码，
不含 ESLint 输出、ESLint 配置或 suppression 账本。

存量账本（一债一账）：解释器扫描范围内的 S1/S2 存量一律记在 manifest 的三字段
`exemptions`（两个消费者都直读同一处，且闸门对「不再覆盖任何违规」的豁免报红，
保住 shrink-only 语义）；只有解释器不扫的 ESLint-only 存量（`apps/web` 的两个测试
文件）留在 `apps/web/eslint-suppressions.json`。两本账互不重叠。
