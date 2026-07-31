# 工件 02 — 边界清单（boundaries manifest）

包级 + 上下文级 + app 内 seam 的 import 规则**单一声明**。
消费者：阶段 3 的 ESLint 规则生成器与同源 CI 闸门（两者必须从同一份数据生成，
不得各自维护）；CLAUDE.md 对账闸门。

状态：规则定稿。生成器的 JSON 格式在阶段 3 第一个 change 内落地，内容以本文档
的表为准。

## A. 包级规则（R1）

依据：现状实测（零越界）+ 4 份 CLAUDE.md 的散文声明 + repo-split §2.1。

| 规则 | 内容 | 现状 |
|---|---|---|
| P1 | `apps/web` 禁止 import `@cap-console/api`、`@cap-console/sandbox*`、`apps/api/*` 任何路径 | 事实成立，无机制 |
| P2 | `apps/api` 禁止 import `@cap-console/web`、`@cap-console/ui`、`apps/web/*` | 事实成立，无机制 |
| P3 | `apps/api` 对 sandbox 系列只准 import facade `@cap-console/sandbox`（+ devDep conformance 仅测试） | 有闸门（sandbox-package-boundary），阶段 1 扩域 |
| P4 | `packages/*` 禁止 import `apps/*` | 事实成立，无机制 |
| P5 | `packages/contracts` 禁止 import 任何内部包 | 事实成立，无机制 |
| P6 | `packages/sandbox-core` 保持零运行时依赖；contracts 仅 `import type`（D14 类型层） | 有一半机制（词表 parity），type-only 无守护 |
| P7 | facade `packages/sandbox` 的导出面显式白名单，禁止 `export *` 泄漏 provider 内部符号（R6） | ✅ 已落地（close-gate-blindspots 2.3–2.6）：`src/index.ts` 全命名导出（provider 符号仅 apps/api 经 barrel 实际触达的 26 个，逐条 phase-7a 注记）；闸门 `packages/sandbox/test/facade-surface.gate.mjs` 对账 committed `expected-facade-surface.json`，`export *` 即红，随包 test script 进 CI；scripts/ 金丝雀等非 api 消费者直连 provider 包 dist，不走白名单 |
| P8 | `apps/www` 与控制台/后端零 runtime 依赖 | 事实成立（刻意），无机制 |

## B. 上下文级规则（消费 contexts-manifest.json）

见 `contexts-manifest.json` 的 `crossContextRules`：跨上下文只准 port/DI token/
事件/module 组装四种形态；共享内核（prisma/crypto/observability）豁免。
层方向 interface→application→domain/store，Prisma 只在 `*.store.ts`。

## C. app 内 seam 规则（R2 + 交叉验证新增）

| 规则 | 内容 | 依据 |
|---|---|---|
| S1 | `apps/web` 出网只经 `src/lib/api/real.ts` 与 `src/lib/ws-client.ts`；其他文件禁止 `fetch(`/`new WebSocket` | 发现式扫描（非枚举 transport 文件），CORS 闸门的枚举依赖此规则 |
| S2 | mock/real 切换只经 `lib/api/capabilities.ts` 声明的 queryFn seam；组件禁止直接 import `real.ts` 的函数 | seam 已被旁路（api-stream-panel.tsx:28、session-cast-log.tsx:31-33），存量进 ratchet |
| S3 | `apps/api` 的 dockerode/Docker/provider 内部符号禁令全 src 生效 | ✅ 已落地（close-gate-blindspots 3.4/3.5）：import 与符号双扫描的 roots 均由 `contexts-manifest.json` `scope` 驱动（manifest 缺失/空 scope/零文件均红，无硬编码回退）；存量 5 文件走 `scripts/ratchets/r3.json`（共享 comparator，shrink-only），validator 一路阶段 7a 根治 |

## D. 安全 seam 登记（交叉验证采纳项）

被登记的"单一计算"接缝——上下文/目录重排时**必须保持唯一实现**，禁止第二份：

| seam | 位置 | 说明 |
|---|---|---|
| Origin 计算 | `apps/api/src/auth/request-origin.ts`（自述 "the ONE computation"） | 消费方：auth.guard 的 session CSRF 闸、origin-checked-ws-adapter、main.ts WS adapter 接线 |
| 会话校验 | rest-session-validation / ws-session-validation 的统一入口 | 已有 spec 测试锚定 |
| SSRF 闸 | `assertSafeProviderUrl`（forge-no-ssrf-gate.spec 锚定） | forge HTTP 直连的信任边界声明不变 |
| 凭据加密读取 | 三读取点共用 helper（multi-forge 时代裁定） | 禁止新读取点绕 helper |

规则：安全 seam 的移动必须在同一 change 内更新本表 + 对应锚定测试，闸门断言
"seam 声明的文件存在且唯一"。

## E. CLAUDE.md 对账（决策 3）

manifest 为唯一声明源；4 份 CLAUDE.md（apps/api、apps/web、packages/contracts、
packages/sandbox）保留散文解释，但其中的**依赖白名单清单**与本清单对账——
闸门解析 CLAUDE.md 的 "What this subtree may depend on" 段落，与 A 表比对，
不一致即红。CLAUDE.md 中的易腐数字（"454 source files" 等）降级为约数或删除，
不进对账。

## F. 生成物与执行位置

```
boundaries manifest (本文档 A/C/D 表 → 阶段3落成 JSON)
  ├─→ ESLint flat config 片段生成器（no-restricted-imports / no-restricted-syntax）
  │     → IDE 即时反馈 + pre-commit lint
  ├─→ CI 闸门脚本（同一 JSON，独立解释器做全量扫描兜底）
  └─→ CLAUDE.md 对账检查（E 节）
```

元规则约束：生成器与闸门不得各自内嵌规则数据；规则数据只在 JSON 一处。
