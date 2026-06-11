# Research Brief — console-design-pixel-merge

> 三路并行调研（Web 外部先例 / Codebase 现状勘察 / Archive 历史 change 先例）的合并简报。
> 每条发现标注来源路线与证据；末尾给出对 proposal 的约束性结论。
> 设计基准源：`openspec/changes/console-design-pixel-merge/design-baseline/`（index.html、screens/*.html、css/platform.css、css/responsive.css、components/runner-capsule.js）。

---

## Route: Web（外部先例与生态调研）

### Pool / Runner API 先例

- **W1 — GitHub Actions self-hosted runners 是逐 runner 行最接近的先例。** 每个 runner 对象携带 `{id, name, os, status: online/offline, busy: boolean, ephemeral, labels}`，池健康度由客户端从 status+busy 聚合得出，而非服务端预算 "healthy" 标志。
  证据：https://docs.github.com/en/rest/actions/self-hosted-runners
  含义：API 返回逐槽位原始状态、前端聚合出 "7/10 在线" 的 hero 数字，是行业惯例。

- **W2 — Buildkite Agent Metrics API 是"单聚合端点"先例。** `GET /v3/metrics` 一次返回 `agents{idle,busy,total,queues}` + `jobs{scheduled,running,waiting,total}`，同时喂 autoscaler 和 dashboard。
  证据：https://buildkite.com/docs/apis/agent-api/metrics
  含义：pool-hero、01-NN 槽位网格、pool-lane（空闲→已分配→可接管）可由单一 GET 端点驱动。

- **W3 — buildkite-agent-metrics 采集器佐证消费侧形态。** 轮询单一 metrics 端点，按队列派生 `IdleAgentCount/BusyAgentCount/TotalAgentCount/BusyAgentPercentage`。
  证据：https://github.com/buildkite/buildkite-agent-metrics
  含义：派生指标命名约定（online/total/busy/idle + 百分比）值得在响应里镜像；轮询（非推送）是池容量数据的行业默认传输方式。

### 容器/进程资源采样

- **W4 — Docker stats 单次调用即可算 CPU%。** `/containers/{id}/stats?stream=false` 同时返回 `cpu_stats` 与已填充的 `precpu_stats`，CPU% = delta(total_usage)/delta(system_cpu_usage)×online_cpus×100；docker CLI 显示 MEM% 前还会减去 page cache。
  证据：https://docs.docker.com/reference/cli/docker/container/stats/ 、https://github.com/docker/docker-py/issues/1685
  含义：API 应返回服务端预算好的 `cpuPercent/memUsed/memLimit`（CLI 等价语义），前端逐 runner 资源行无需客户端数学。

- **W5 — dockerode 的安全模式是一次性采样。** `container.stats({stream:false})` 是 `docker stats` 等价用法（issue #389）；长驻 stats 流不清理会泄漏进程（issue #166）。
  证据：https://github.com/apocas/dockerode/issues/389
  含义：每个轮询 tick 一次性采样是 Node 后端的安全模式，避免逐容器长驻流。

- **W6 — Kubernetes metrics-server 只存最新一帧。** PodMetrics 内存中仅保留最近一次采样（CPU millicores、memory working-set bytes），明确不做历史、不做聚合。
  证据：https://github.com/kubernetes-sigs/metrics-server（FAQ：in-memory store keeps only latest value）
  含义：为本次 change 的最小契约背书——仅暴露每个运行中任务的最新一帧（sampledAt + cpu + mem），时序/历史推迟到未来 change；与设计稿只展示当前值一致。

### 数据层、轮询与 mock 切换

- **W7 — TanStack Query 实时面板的文档化模式是 refetchInterval。** （+ refetchIntervalInBackground）；TanStack Start server function 的 SSE 是文档化但更重的备选，仅在轮询漏数据时推荐。
  证据：https://tanstack.com/query/latest/docs/framework/react/guides/polling 、https://ollioddi.dev/blog/tanstack-sse-guide
  含义：容量面板 + 逐 runner 资源行可用现有数据层的 ~5s refetchInterval 出货；SSE 写进 proposal 的 non-goal / 未来选项。

- **W8 — mock/real 切换的标准模式。** env 开关的 MSW worker（网络层拦截，TanStack Query 无感）；或本项目现行的 capability 对象切换——后者只需新池端点在 MOCK 与 Real 两套实现中以同一类型镜像落地。
  证据：https://mswjs.io/docs/faq/ 、https://www.callstack.com/blog/guide-to-mock-service-worker-msw
  含义：约束 proposal——每个新池/metrics 字段必须以带类型 capability 同时落 MOCK 与 Real 两个变体，使设计合并可在后端接线前先行构建并像素核对。

### runner-capsule 动画移植

- **W9 — React 19 通过全部 Custom Elements Everywhere 测试。** 客户端 props 设为元素属性、SSR 时原始类型作 attribute（非原始类型服务端省略），自定义事件经 `on<eventname>` 绑定——737 行原生 Web Component 技术上可不加 wrapper 直接 client-only 挂载。
  证据：https://react.dev/blog/2024/12/05/react-19 、https://aleks-elkin.github.io/posts/2024-12-06-react-19/
  含义：给 proposal 一个有文档背书的备选：WC 原样 client-only 挂载 vs React 重写。重写仍因代码库一致性（Tailwind token、SSR 渲染静态框架）更优，但决策需连同此 fallback 一起记录。

- **W10 — @lit/react createComponent() 是 WC→React 包装的成熟先例。** 其存在正是因为 React 19 之前无法设 property / 监听自定义事件。
  证据：https://lit.dev/docs/frameworks/react/
  含义：第二种集成选项；但 runner-capsule.js 是 vanilla（非 Lit）组件且目标是 SSR 渲染的营销页，带相同 loop 状态机的原生 React 移植仍是最干净的路径。

- **W11 — SSR 安全的 prefers-reduced-motion 模式。** matchMedia 驱动的 hook，首帧/服务端默认 REDUCED 以避免 hydration mismatch，挂载后再更新（Josh Comeau 的 usePrefersReducedMotion；framer-motion/react-spring 有等价 hook）。
  证据：https://www.joshwcomeau.com/react/prefers-reduced-motion/
  含义：runner-capsule.js 自带 reduced-motion 降级分支；TanStack Start SSR 页面里的 React 移植必须采用"默认降级、挂载后升级"模式（初始渲染不触碰 window）。

### 终端 SSR 约束

- **W12 — xterm.js 仅限浏览器，SSR 框架必须 client-only 动态加载。** 服务端 `window is not defined` 是长期文档化的通用限制，非项目特有。
  证据：https://github.com/vercel/next.js/discussions/22409
  含义：会话页现有 `ssr:false` 约束必须在重设计后存活；新 terminal-head、连接 pill、"正在连接" 空状态渲染在 SSR 外壳，xterm 本体留在空状态背后的 client-only 区域。

### 像素验证与 Token

- **W13 — Playwright toHaveScreenshot() 是像素级核对的标准工装。** 底层 pixelmatch，带 maxDiffPixels / maxDiffPixelRatio / threshold 旋钮，支持对设计捕获做基线比对。
  证据：https://playwright.dev/docs/test-snapshots
  含义：定义"全页面像素级核对"验收的 harness：把静态设计 stub 页（file:// 或本地 server）截为基线，按断点 diff 重建后的 apps/web 页面；也符合用户全局指令（高还原度时用 Playwright 截图比对）。

- **W14 — Tailwind v4 最佳实践：token 全部进 @theme（CSS 自定义属性，自动生成 utilities），base→semantic→component 分层。** 设计 CSS 的 `--console:#f8f9fb`、`--muted-2:#808080` 等变量可 1:1 映射进 @theme，无需任何 config 文件。
  证据：https://www.matchkit.io/blog/design-tokens-tailwind-v4 、https://seedflip.co/blog/tailwind-v4-theme-directive
  含义：支持 token 级合并方案——design-stub platform.css 变量与 apps/web app.css 的全量 diff 以 @theme 增改落地（console 背景、muted-2、shadow-card），维持 CSS-first/no-config 约束。

### 竞品交互先例

- **W15 — Cursor Cloud/Background Agents 是最接近的商业类比。** 并行 agent 会话面板（并发上限 8）、逐会话环境详情、运行中会话的显式人工接管入口。
  证据：https://cursor.com/docs/cloud-agent
  含义：验证设计稿的按状态分化行操作（运行→接管会话）与槽位上限池模型；"接管运行中的云会话"是既有交互，支持决策 (b)（排队任务保持可点击而非禁用）。

- **W16 — OpenAI Codex cloud 是 inbox 式任务列表先例。** 多并行任务排队、各自 sandbox 运行、以 review-queue 列表呈现，主操作随任务状态变化（review 完成的工作 vs 照看运行中的工作）。
  证据：https://developers.openai.com/codex/cloud
  含义：三列任务列表 + 按状态 CTA（处理输入/接管会话/查看记录/查看错误）+ 警示色 needs-input 行的先例——agent 平台主流模式是"需要人工注意的任务优先的收件箱"。

---

## Route: Codebase（现状勘察）

### Token 与底色

- **C1 — app.css 是唯一的 token 契约，且缺 --console/--muted-2。** Tailwind v4 CSS-first、无 config；@cap/ui 的 styles.css 复用之，token 改动会传播到共享组件。现有 `--shadow-card` 为 `0 0 0 1px var(--border), 0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06)`，设计稿为 `0 0 0 1px rgba(0,0,0,0.08), 0 2px 2px rgba(0,0,0,0.04), 0 8px 8px -8px rgba(0,0,0,0.04)`。
  证据：`apps/web/src/styles/app.css:1-21,279-292` vs `openspec/changes/console-design-pixel-merge/design-baseline/css/platform.css:3,6,29`
  含义：gap 5（token 级 diff）只落一个文件；加 `--console`/`--muted-2` + 重调 shadow-card 即可一次性重塑所有页面与 @cap/ui。

- **C2 — --console:#f8f9fb 现状是一处硬编码的任意值。** 仅作 `bg-[#f8f9fb]` 用在 app-shell 主画布（SidebarInset）；设计稿把 `var(--console)` 应用到整个 body，白卡片层叠其上。Landing/login 现在渲染在纯 `--background` 白底上。
  证据：`apps/web/src/routes/_app.tsx:83`（文档见 :12）；`openspec/changes/console-design-pixel-merge/design-baseline/css/platform.css:45`
  含义：整体底色改动需把该值提升为真 token，并在 app.css 的 `@layer base` html/body 级应用，替换一次性 arbitrary class。

### Pool / Metrics 后端现状

- **C3 — runner 池后端 API 已经存在且比 gap 表述更丰富。** session 门控的 `GET /metrics` 组合返回：`capacity{ceiling,active,free,queueDepth}` + `occupancy.slots[{slot,busy,taskId}]`（恰好 ceiling 个）+ `queuedTaskIds`（FIFO）+ runnerMinutes + 采样资源（逐容器 `{taskId,cpuPercent,memoryBytes,memoryLimitBytes,memoryPercent}`）+ 新鲜度状态 `available/stale/unavailable`。
  证据：`apps/api/src/metrics/metrics.controller.ts:20-23`、`metrics.service.ts:33-45`、`metrics-projection.ts:54-105`；契约 `packages/contracts/src/metrics.ts:184-194,127-168`
  含义：gap 2 的 pool-hero（7/10 在线）、编号槽位网格、逐 runner CPU/MEM 行均可前端组合：`occupancy.slots[].taskId × resources.containers[].taskId × tasksQuery`（repo/title/status）；`resources.status` 可驱动 healthy 徽标。proposal 应把后端工作圈定为小增量，而非新端点族。

- **C4 — 唯一真实的后端 delta：在 /metrics 内暴露全任务的 process-scope 读数。** /metrics 的 containers 是容器级聚合；codex 进程级读数目前只能逐任务 `GET /tasks/:taskId/metrics`（N 次调用）取得。但采样器已为所有运行中任务持有 `processSamples` map，把 process-scope 样本并入单一 /metrics payload 只是薄薄一层 projection 改动。
  证据：`apps/api/src/metrics/resource-sampler.service.ts:308-309`（processSamples map）、`:398-440`（taskReading）、`metrics.controller.ts:33-36`；契约 `metrics.ts:224-245`（TaskResourceResponse scope process|container）
  含义：capacity-modern 面板用一次轮询渲染逐 runner 资源行，而不是 5s 节奏下扇出 N 个 taskResourceQuery。

- **C5 — Web 数据层已通过 capability 接缝消费这一切。** metricsQuery/capacityQuery/taskResourceQuery（稳定 key、5s refetchInterval、`isCapable('metrics')` 真/mock 切换、zod 解析的 real fetcher）。所有 capability flag 当前均为 true（2026-06-06 e2e 验证）。
  证据：`apps/web/src/lib/api/queries.ts:104-140`、`capabilities.ts:68-81`、`real.ts:190-206`、`mock.ts:291-331`（mockMetrics 伪造 7/10 池）
  含义：新池面板必须复用 metricsQuery（一次网络读 + select 投影视图）并同步更新 mock.ts；不需要新的查询层架构。

### Dashboard 现状

- **C6 — Dashboard 现状盘点。** MetricStrip 4-up 渲染在 `dashboard.tsx:133-154`（按用户决策 a 删除）；workspace 网格为 `minmax(0,1fr)_minmax(300px,360px)`（:157-160）；QueuePanel 行已具备 dot+shortId+pill / prompt / 仓库 + 阶段/分支 上下文 + 单操作列，带 `data-task-state` 属性与等待输入置顶排序——接近 inbox 行，但缺按状态分化的操作、警示渐变行背景；`任务/GitHub 仓库|阶段/分支|操作` 列头已存在。
  证据：`apps/web/src/routes/_app/dashboard.tsx:133-160`；`components/dashboard/queue-panel.tsx:93-101`（sortQueue）、`:144-217`（QueueRow）、`:281-288`（表头）
  含义：gap 1 的 inbox 行改造是 QueueRow/QueuePanel 的原地演进而非重建；要改的文件与网格列已钉死。

- **C7 — task-status.ts 是唯一的状态→呈现映射，且与决策 (b) 直接冲突。** 当前把 queued/pending 标 `connectable:false`，QueueRow 渲染成 aria-disabled 的"等待接入" span（无 Link）。该映射的 connectable 语义 + QueueRow 的操作分支正是编码按状态按钮的接缝（等待输入→primary 处理输入、running→接管会话、done→ghost 查看记录/查看错误、queued→可导航 + 仅"等待 runner"文案）。
  证据：`apps/web/src/components/dashboard/task-status.ts:64-77,49-106`；`queue-panel.tsx:192-214`
  含义：proposal 必须显式 spec 该映射改动；映射对 8 成员 TaskStatus union（`contracts/src/task.ts:21-30`）穷尽，新增 action 字段漏状态会编译失败。

- **C8 — CapacityAside 是 capacity-modern 要替换的组件。** 今天渲染：当前占用摘要 + ceiling 驱动的 SlotCell 网格（每个 occupancy.slots 一列、warn 色由逐容器 memoryPercent≥60 派生）+ CPU/MEM ResourceMeter 条 + 硬编码 ConfigList（调度区域 iad-02/接管策略/写入边界）。已完全由实时 ceiling 数据驱动。
  证据：`apps/web/src/components/dashboard/capacity-aside.tsx:130-217`（尤其 :187-203 动态 gridTemplateColumns）
  含义：pool-hero/编号槽位 01-NN/pool-lane/逐 runner 行/pool-policy 替换此文件；"ceiling-many（1–20，非固定 10）"渲染规则必须按 configurable-task-slots 延续。

- **C9 — 槽位上限是运行时可变的系统状态，不是常量。** `ConcurrencySemaphore.setMaxConcurrentTasks`（调高→立即 FIFO 放行，调低→不驱逐），以 `AccountSettings.maxConcurrentTasks`（系统级，1–20，默认 5）经 `PATCH /settings` 写入；settings-form.tsx 已有"任务槽位上限"字段。
  证据：`apps/api/src/guardrails/semaphore.ts:77-92`；`packages/contracts/src/settings.ts:83-86`；`apps/api/src/settings/settings.controller.ts:91`；`apps/web/src/components/settings/settings-form.tsx:64-83,284`
  含义：约束像素合并——设计稿字面的"7/10 online · slots 01-10"必须渲染为 ceiling-many 槽位与实时计数；这也是要在 proposal 里重申的 4 个拍板 slot 决策之一的语境。

- **C10 — 过滤 tab 现状无计数，但组件 API 已就绪。** 现有 tab 为 全部/等待输入/排队中（无计数）；共享 SegmentedControl 接受 ReactNode label，设计稿的 tab-count 计数 chip（全部/待处理/运行/排队 + counts）可直接内嵌，无需改组件 API；CountChip 已存在。
  证据：`apps/web/src/components/dashboard/queue-panel.tsx:45-49,266-277`；`components/segmented-control.tsx:29-34`；`components/count-chip.tsx`
  含义：钉死 gap 1 中 tab 计数需求的最小改动路径。

### Landing 现状

- **C11 — HeroPreview 是全静态 SSR 安全 mock；apps/web 尚无任何 prefers-reduced-motion 处理。** HeroPreview（硬编码行/瓦片/日志行）即 runner-capsule-demo 要替换的组件；process-rail + boundary-ledger 要替换的是 3 步 WorkflowRow（index.tsx:161-172）与 3 卡 FeatureGrid（index.tsx:196-206）。grep 确认 apps/web/src 中 prefers-reduced-motion 零匹配；landing 已用挂载门控 reconcile 模式（SSR 渲染匿名态、useEffect 挂载后翻转），动画移植必须遵循同一模式。runner-capsule.js 737 行已确认。
  证据：`apps/web/src/components/landing/hero-preview.tsx:100-183`；`routes/index.tsx:52-58,161-172,196-206`；grep prefers-reduced-motion → 无匹配；`openspec/changes/console-design-pixel-merge/design-baseline/components/runner-capsule.js`
  含义：gap 3 范围 = 把 Web Component 状态机移植为 client 挂载的 React 组件，挂载后读 `matchMedia('(prefers-reduced-motion)')` 以保持 SSR 安全。

### Session 页现状

- **C12 — gap 4 大部分已实现。** SessionHeader 已渲染面包屑 + 实时连接 pill + 返回任务/复制会话记录/暂停输出/停止任务（两步确认）；上下文条已有 4 项含守护栏（空闲回收/运行时限，从 task.idleTimeoutMs/deadlineMs 回读）；SessionTerminal 已有 terminal-head（headLabel `{agent} · {repo}#{branch}` + **硬编码** `pty: /dev/pts/4`）与精确的空状态文案 ○ 正在连接…键入暂不发送 / × 连接失败… / ○ 连接已断开…。该路由是唯一 ssr:false 路由，带 TerminalSkeleton pendingComponent。
  证据：`apps/web/src/components/session/session-header.tsx:84-173`；`routes/_app/tasks/$taskId.tsx:54-58,116-149`；`components/session/session-terminal.tsx:500-503,574-577`
  含义：gap 4 归约为标记/布局重组（session-toolbar 摆位、3+1 上下文条分组）而非新行为；pty 路径是虚构的（无后端字段）——proposal 须按项目 D5.5 诚实规则裁决保留原样 vs 删除。

### 其余页面与杂项

- **C13 — tasks/new 守护栏预设阶梯与设计稿不同。** 代码出货 IDLE_TIMEOUT_OPTIONS 关闭/10分钟/30分钟/1小时/3小时、DEADLINE_OPTIONS 无/30分钟/1小时/2小时/6小时（dashboard 对话框与 /tasks/new 共享）；设计稿为 关闭/15/30 分钟 与 无/1h/4h。值在 CreateTaskRequest 上是自由毫秒数，预设改动契约安全。
  证据：`apps/web/src/components/dashboard/new-task-dialog.tsx:82-100`；`routes/_app/tasks/new.tsx:43-49,379-423`
  含义：gap 6 在 queue=tasks/new 页的具体 diff；只改一处共享目录（对话框与页面自动保持同步）。

- **C14 — 移动断点二元性。** Console 页与 shell 用 ≤820px CSS 断点（max-[820px]/min-[821px] utilities，MobileNav 在 ≤820px 接管），而 use-mobile.ts JS hook 用 768。设计稿新增的 mobile-inbox/mobile-workbench-meta/mobile-pool-summary 规则位于 responsive.css。
  证据：`apps/web/src/components/dashboard/queue-panel.tsx:283`、`routes/_app.tsx:5-15`；`hooks/use-mobile.ts:3`；`openspec/changes/console-design-pixel-merge/design-baseline/css/responsive.css`（mobile-pool-summary ×6、mobile-workbench-meta ×4、task-kicker ×3）
  含义：gap 1 的 mobile-inbox 处理必须选定并记录一种断点约定（现有 820px CSS 模式是既定约定）。

- **C15 — OpenSpec 脚手架已存在且仅有 .openspec.yaml。** 要打 delta 的现有 spec 是 frontend-console 与 resource-metrics；archive 持有前几轮 change（2026-06-06-rebuild-console-tanstack-start、2026-06-09-console-task-metrics-and-navigation、2026-06-10-configurable-task-slots）。
  证据：`openspec/changes/console-design-pixel-merge/.openspec.yaml`；`openspec/specs/{frontend-console,resource-metrics}`；`openspec/changes/archive/`
  含义：产物写入既有 change 目录；spec delta 目标 = frontend-console（页面）+ resource-metrics（/metrics payload 扩展）。

- **C16 — login/history/repositories/settings 是上一轮设计的忠实重建。** 各按其原型 html 实现（screen-header + strips + panels），全部只经 query factory 读数据；settings 有 4 锚点侧导航 + SystemStrip + Codex 凭证工作区。
  证据：`apps/web/src/routes/login.tsx:1-40`、`routes/_app/history.tsx:1-32`、`routes/_app/repositories.tsx:1-28`、`routes/_app/settings.tsx:1-33`
  含义：确认 gap 6 框定——这四页只需对迭代后设计做像素复核而非结构性工作；按 audit-and-adjust 任务圈定范围。

- **C17 — 新设计迭代的全部 class 体系在解包设计文件中确认存在。** capacity-modern/pool-hero/pool-lane/pool-policy（platform.css）、mobile-inbox/task-kicker/tab-count（dashboard.html）、runner-capsule-demo/process-rail/boundary-ledger（index.html）、session-toolbar/terminal-head（session.html）、mobile-*（responsive.css）。
  证据：grep over `openspec/changes/console-design-pixel-merge/design-baseline/{index.html,screens/dashboard.html,screens/session.html,css/platform.css,css/responsive.css}`（计数：pool-policy×4、task-kicker×5+3+3、tab-count×4、runner-capsule-demo×4、boundary-ledger×3、session-toolbar×2+1）
  含义：gap 清单已对照 proposal 将引用的实际设计源完成验证。

---

## Route: Archive（历史 change 先例）

- **A1 — rebuild-console-tanstack-start 是直系祖先与结构模板。** 同一 Open Design 原型（10 页）在 TanStack Start + shadcn + Tailwind v4 上重建并在同一 change 内扩展后端；结构 = proposal + 436 行 design.md（D1-D6 决策，各带 Alternatives considered）+ research-brief.md sidecar（路由图、页面→数据 real/mock 矩阵、token 计划、track DAG）+ 19 并行 track 的 tasks.md（顺序：be-contracts → backend tracks → fe-scaffold/fe-tokens/fe-data-layer → 每页一 track → integration-delivery）。
  证据：`openspec/changes/archive/2026-06-06-rebuild-console-tanstack-start/{proposal.md,design.md,research-brief.md,tasks.md}`
  含义：像素合并 change 直接复用此结构——这是"全页面 + 后端配菜"的已验证形态；其 token 计划章节（app.css 单一来源、shadow-ring 替代 border、@theme inline）是 gap 5 的模板。

- **A2 — configurable-task-slots 的 "pre-made and RESOLVED" 决策块写法 + 4 个绑定约束。** 其 proposal 以"四个操作者决策已预先拍板（勿重议）"开篇，编号 accept/reject 成对列出；4 个决策（缩容不踢任务、单全局池、DB 覆盖 env、重启 re-offer）对任何 slot/pool 工作是绑定约束；归档时附 opsx-verify 的 verification-report.md（7/7 requirements MET）。
  证据：`openspec/changes/archive/2026-06-10-configurable-task-slots/proposal.md`（14-28 行）与 verification-report.md
  含义：把当前用户决策 a-d（MetricStrip 删除是有意的、排队任务保留可进详情、池后端 API 在范围内、全页面合并）按同一格式写进新 proposal；新池面板不得重议 4 个 slot 决策；ceiling 动态 1-20 与设计稿固定 "7/10 online · slots 01-10" 的张力必须在 proposal 中解决。

- **A3 — slot change 的 frontend-console delta 已强制动态槽位。** "Slot meter sizes to the live ceiling"（从 occupancy.slots.length 派生分段，禁止硬编码 grid-cols-10）+ "mock metrics 路径 SHALL 与后端默认 ceiling（5）一致" + 保存 ceiling 须使 metrics query 失效。
  证据：`openspec/changes/archive/2026-06-10-configurable-task-slots/specs/frontend-console/spec.md`
  含义：capacity-modern 面板 MODIFIES 的正是这些 requirement——重写必须保留动态槽位数派生与 mock/real ceiling 一致；设计稿的 7/10 与 01-10 是样例数据而非 spec 常量；不得重新引入硬编码十槽布局。

- **A4 — 逐任务 CPU/MEM 已采集且已暴露；先例是 MODIFIED delta、不铸新 capability。** /metrics 聚合携带按 taskId 键的 SampledResources.containers[]；`GET /tasks/:taskId/metrics` 返回判别联合（state: sampled|not-running）带 scope: 'process'|'container'（codex 进程树为主、容器兜底）、carry-forward 采样器保证瞬时读失败不会把运行中任务翻成 not-running；两次改动均以 resource-metrics 的 MODIFIED delta 落地，从未新增 capability。
  证据：`openspec/changes/archive/2026-06-09-task-codex-process-metrics/proposal.md` 与 `archive/2026-06-09-console-task-metrics-and-navigation/{proposal.md,tasks.md}`
  含义：gap 2（池后端）比 prompt 假设的小：逐 runner 资源行大体可由现有 /metrics containers[] + occupancy 组合；新端点工作应是 resource-metrics 上的 MODIFIED delta（遵循先例——不要铸 "runner-pool" capability），复用 scope 判别器与"not-running/not-sampled、绝不伪造零值"的诚实降级语言。

- **A5 — console-task-metrics-and-navigation 是"小型 expose+display change"的 track 模板。** 4 个 track（api-per-task-metrics → web-display，web-create-navigation 独立，verify 收尾）、鉴权继承全局 APP_GUARD（无逐路由代码）、契约类型进 @cap/contracts、共置 .mjs 测试驱动真实编译产物、verify track 拆 static-gates 与 post-deploy-live。它还确立了 create-task → navigate-to-session 与排队任务的 PreRunningPlaceholder——这是用户决策 (b) 的底座（排队行保持可进入；设计稿的禁用"等待 runner"按钮不得采用 disabled 语义）。
  证据：`openspec/changes/archive/2026-06-09-console-task-metrics-and-navigation/tasks.md`
  含义：池 API 后端部分复用此 track 形态：contracts type → api 组合端点 → web query+panel → verify。

- **A6 — console-terminal-1to1：会话页工具条原语已在 + "改动须 live 验证"纪律。** 会话页已有 返回任务/复制会话记录/暂停输出（rebuild task 18.1）、连接状态徽标、终端几何同步；该 change 在 150ms CR hack 前提被实证推翻后确立了"UI 删改须以 live 验证为门"的纪律；xterm 钉 ^5.5.0，DEC-2026 闪烁 caveat 有记录。
  证据：`openspec/changes/archive/2026-06-08-console-terminal-1to1/{proposal.md,tasks.md}` 与 `archive/2026-06-06-rebuild-console-tanstack-start/tasks.md` task 18.1
  含义：gap 4 是对既有已实现 UI 的 diff 而非绿地——proposal 应枚举工具条项的"已有 vs 新增"（注意：codebase 勘察 C12 显示 停止任务 现已实现，以 codebase 为准）；任何触及输入/连接语义的终端改动需 live-verify 门；保持 ssr:false + pendingComponent skeleton 与 raw-bytes-bypass-Query 不变量。

- **A7 — auth-redirects-and-landing 的落地修缮必须随重设计携带前行。** LandingFooter 链到 #security、CJK 标题 `[word-break:keep-all]`+`<wbr/>` 断行、trust pills 环形 chip、单 primary CTA 层级、mounted-flag + authSessionQuery 的 SSR 安全会话感知 CTA、匿名访客 #preview 锚点；同 change 还加固了 open-redirect 并修了 cookie-shadow 缺陷。
  证据：`openspec/changes/archive/2026-06-09-auth-redirects-and-landing/{proposal.md,tasks.md}`
  含义：gap 3 的 landing 改造（runner-capsule demo + process-rail + boundary-ledger 替换 3 步工作流 + 3 安全卡）正好替换这些修缮所在的 section——proposal 必须延续会话感知 CTA 逻辑、footer #security 锚点目标（boundary-ledger 很可能成为新 #security）、CJK 断行处理、SSR 安全（737 行 WC 动画移植须 mounted-effect/prefers-reduced-motion 安全，镜像 mounted-flag 模式）。

- **A8 — Playwright 截图比对在 rebuild 中是可选门，本次应升为必需。** rebuild 把逐页截图对照原型基线列为可选高保真验收（task 19.5 + design.md Open Question "Visual-fidelity acceptance"）；用户全局指令在高保真场景要求 Playwright 截图比对。
  证据：`openspec/changes/archive/2026-06-06-rebuild-console-tanstack-start/tasks.md` line 179 与 design.md Open Questions
  含义：本 change 明确以"像素级"为名，应把 Playwright 页面-vs-设计 html 截图比对从可选升为逐页必需 verify 步骤——本地 openspec/changes/console-design-pixel-merge/design-baseline html 文件可作为活基线，补上 rebuild 留下的缺口。

---

## Implications for the proposal

1. **后端范围 = 小增量，不是新端点族。** /metrics 已返回 capacity/occupancy/queue/资源（C3）；唯一真实 delta 是把已在内存里的 process-scope 样本并入 /metrics 单 payload（C4），按 A4 先例以 **resource-metrics 的 MODIFIED delta** 落地（不铸新 capability），返回服务端预算的 cpuPercent/memUsed/memLimit（W4）、仅最新一帧（W6）、复用 "not-running/not-sampled、绝不伪造零值" 的诚实降级语言（A4）。单聚合端点 + 客户端聚合 + 轮询传输有 Buildkite/GitHub 双重先例背书（W1-W3）。

2. **数据层零新架构，mock/real 锁步。** 新字段经既有 metricsQuery（5s refetchInterval、select 投影）消费（C5、W7）；每个新字段必须在 mock.ts 与 real.ts 以同一 zod 类型镜像落地，使前端可在后端接线前先行构建并像素核对（W8、C5）；mock 默认 ceiling 须与后端默认（5）一致（A3）。SSE 写入 non-goal（W7）。

3. **Token 合并只落 app.css 一个文件。** 以 @theme 增补 `--console`/`--muted-2`、重调 `--shadow-card`（C1、W14），并把 console 底色从 `_app.tsx` 的一次性 `bg-[#f8f9fb]` 提升到 `@layer base` 的 body 级应用（C2）；改动自动传播到 @cap/ui。

4. **Dashboard inbox = 原地演进。** 删除 MetricStrip（决策 a，C6）；按状态操作分化落在 task-status.ts 单一映射 + QueueRow 操作分支（C7），映射对 8 成员 TaskStatus union 穷尽、漏状态即编译失败；**决策 (b) 必须显式推翻现有 `connectable:false` 语义**——排队行保持可导航（A5 的 PreRunningPlaceholder 是底座，W15/W16 提供竞品背书），设计稿的禁用按钮不得采用 disabled 语义。tab 计数经 SegmentedControl ReactNode label + CountChip 内嵌，无组件 API 改动（C10）。

5. **capacity-modern 替换 CapacityAside，但必须保留动态 ceiling。** pool-hero/编号槽位/pool-lane/逐 runner 行/pool-policy 替换 capacity-aside.tsx（C8）；设计稿 "7/10 online · slots 01-10" 是样例数据而非 spec 常量——渲染必须 ceiling-many（1-20，运行时可变，C9），禁止硬编码十槽布局（A3）；不得重议 4 个已拍板 slot 决策（A2）。逐 runner 行 = occupancy.slots × resources.containers/process × tasksQuery 的客户端 join（C3+C4）。

6. **Landing：React 移植 runner-capsule，记录 WC 直挂 fallback。** 选择带相同 loop 状态机的原生 React 移植（代码库一致性 + SSR 静态框架），但把 React 19 直挂 WC（W9）与 @lit/react 包装（W10）作为已考虑备选记录进 design.md。动画必须遵循"SSR 默认 reduced、挂载后升级"模式（W11），与 landing 既有 mounted-flag 模式一致（C11，apps/web 当前零 prefers-reduced-motion 处理）。必须携带前行：会话感知 CTA、#security 锚点（boundary-ledger 接任）、CJK 断行（A7）。

7. **Session 页 = 标记重组，非新行为。** 工具条/上下文条/terminal-head/空状态大部分已实现（C12）；保持 ssr:false + pendingComponent + raw-bytes-bypass-Query 不变量（W12、A6）；触及输入/连接语义的改动需 live-verify 门（A6）；硬编码 `pty: /dev/pts/4` 无后端字段支撑，proposal 须按 D5.5 诚实规则裁决保留 vs 删除（C12）。

8. **gap 6 的具体 diff 已钉死。** 守护栏预设阶梯改一处共享目录（C13，契约安全）；login/history/repositories/settings 四页按 audit-and-adjust 圈定（C16）；mobile-inbox 采用既有 ≤820px CSS 断点约定并在 spec 中记录（C14）。

9. **验证：Playwright 截图比对升为必需。** 逐页、逐断点以 `toHaveScreenshot()`（maxDiffPixels/threshold）对照 openspec/changes/console-design-pixel-merge/design-baseline 的设计 html 活基线（W13、A8），写入每页 track 的 verify 步骤，补上 rebuild 留下的可选缺口；符合用户全局高保真指令。

10. **产物结构与落点。** 写入既有 `openspec/changes/console-design-pixel-merge/` 目录（C15）；复用 rebuild 的 proposal + design.md（决策带 Alternatives）+ research-brief sidecar + 并行 track tasks.md 形态（A1）；proposal 开篇以 A2 的 "pre-made and RESOLVED" 格式固化用户决策 a-d；spec delta 目标 = frontend-console（页面级 MODIFIED，含改写 "Dashboard lists tasks as a fleet" 中被删除的 4-MetricTile ops-status-bar 条款）+ resource-metrics（/metrics payload 扩展）；后端部分 track 形态沿 A5：contracts → api → web → verify。新迭代术语（capacity-modern/pool-hero/mobile-inbox/boundary-ledger/runner-capsule）在 archive 中零先例，全部作为新增/MODIFIED requirement 落 spec。
