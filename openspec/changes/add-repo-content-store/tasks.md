# Tasks — add-repo-content-store

<!-- 注意（来自 research-brief §0）：上轮同名工作死于"注入接缝无人端到端负责"。
     Track injection-seam 刻意做成单 owner 串行段，且含每 provider 的端到端任务，不得再拆分给并行 track。 -->

## 1. Track: workspace-source-types (depends: none)

- [ ] 1.1 在 `packages/sandbox-core` 定义 `WorkspaceSource` 联合类型（`volume` | `archive` | `git`），`git` 变体包裹既有 `GitCloneSpec`；导出类型守卫
  - requirements: ["sandbox-provider-port/provision-context-carries-a-typed-workspacesource-union"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 1.2 扩展 capability 词汇：provider 声明支持的注入变体（volume/archive/git），并接入既有 `SANDBOX_PROVIDER_CAPABILITIES` 声明机制
  - requirements: ["sandbox-provider-port/provision-context-carries-a-typed-workspacesource-union"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 1.3 `ProvisionContext` 从裸 clone spec 迁移为携带 `WorkspaceSource`（保留过渡兼容读取），更新 sandbox-core 单测与 conformance 契约
  - requirements: ["sandbox-provider-port/provision-context-carries-a-typed-workspacesource-union"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 2. Track: repo-store-service (depends: none)

- [ ] 2.1 Prisma migration：`Repo` 增加副本状态（`ready`/`missing`/`refreshing`/`failed`）与副本时间戳；存量行默认 `missing`
  - requirements: ["repo-and-task-management/repo-carries-a-content-copy-status-and-task-creation-gates-on-copy-readiness"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 2.2 新建 repo-store 服务（apps/api）：卷内布局 `/repo-store/<repoId>.git`，`git clone --mirror` 落副本，staging 目录 + 原子 rename 保证无半成品，进度与 typed 失败上报
  - requirements: ["repo-content-store/every-importable-repo-owns-a-bare-mirror-content-copy-in-the-shared-repo-store-volume", "repo-content-store/import-acquires-the-content-copy-with-progress-and-atomic-completion"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 2.3 实现手动刷新（`git fetch` 语义，含 ref 更新）：失败保留 last-good 副本并报 typed 失败；刷新期间状态 `refreshing`
  - requirements: ["repo-content-store/copy-freshness-is-user-managed-via-explicit-refresh-only"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 2.4 Repo 删除级联删除副本目录；启动时不做任何自动批量补建
  - requirements: ["repo-content-store/copy-lifecycle-follows-the-repo"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 2.5 repo-store 服务单测：原子完成、失败重试无需清理、刷新失败保留 last-good、级联删除
  - requirements: ["repo-content-store/import-acquires-the-content-copy-with-progress-and-atomic-completion", "repo-content-store/copy-freshness-is-user-managed-via-explicit-refresh-only", "repo-content-store/copy-lifecycle-follows-the-repo"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 3. Track: import-flows (depends: repo-store-service)

- [ ] 3.1 forge picker / by-URL 导入流程接入内容获取：导入完成 = 元数据 + 副本 ready；获取失败在导入结果与 Repo 状态上可见且可重试
  - requirements: ["multi-forge-repo-import/forge-and-url-imports-acquire-the-content-copy-at-import-time"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 3.2 repo 读 API（console 与 /v1 及 MCP 工具投影）暴露副本状态与时间戳（additive）；新增刷新端点（复用 2.3）
  - requirements: ["repo-and-task-management/repo-carries-a-content-copy-status-and-task-creation-gates-on-copy-readiness"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "public-surface-fast"
- [ ] 3.3 本地路径导入 API：`CAP_LOCAL_IMPORT_ROOT` 未配置整体关闭（fail-closed）；realpath 包含校验拒绝 `..`/symlink 逃逸；目标必须是 git 仓库（worktree 或 bare）；产出与 forge 导入同形态副本
  - requirements: ["local-repo-import/local-path-import-is-fail-closed-behind-a-configured-allowlist-root", "local-repo-import/local-import-target-must-be-a-git-repository"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 3.4 本地导入 Repo 的语义：gitSource 记录源路径、不提供 forge PR/MR delivery 选项
  - requirements: ["local-repo-import/locally-imported-repos-record-their-source-and-stay-outside-forge-delivery"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 3.5 导入流程单测：三种导入模式的副本落地、白名单根门禁与逃逸拒绝、非 git 目标拒绝、失败可见性
  - requirements: ["multi-forge-repo-import/forge-and-url-imports-acquire-the-content-copy-at-import-time", "local-repo-import/local-path-import-is-fail-closed-behind-a-configured-allowlist-root", "local-repo-import/local-import-target-must-be-a-git-repository"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 4. Track: injection-seam (depends: workspace-source-types, repo-store-service)

<!-- 单 owner 串行段：编排选型 → aio 挂载 → boxlite tar → 兜底 → 端到端。禁止拆给并行 track。 -->

- [ ] 4.1 编排层按 provider capability 选择注入变体；无可用变体且 git 兜底关闭时 fail-closed 报可行动错误；git 兜底走显式 env 开关（默认关）
  - requirements: ["sandbox-provider-port/repo-copy-injection-is-the-primary-materialization-path-and-git-fallback-is-explicitly-gated"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 4.2 aio-local 挂载注入：dockerode 建容器时 `Mounts` + `VolumeOptions.Subpath=<repoId>.git`（ro）；沙箱内 `git -c safe.directory=<mount> clone` 到 workspace；处理副本卷名与容器内挂载点配置
  - requirements: ["aio-sandbox-execution/aio-workspace-materialization-injects-the-repo-copy-via-read-only-subpath-mount", "repo-content-store/copies-are-exposed-to-sandboxes-read-only-and-per-task-scoped"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 4.3 boxlite 归档注入：api 侧流式打 tar（bare mirror，不整包进内存）→ 既有 `uploadArchive` → box 内解包 + 本地 clone；传输失败报 typed materialization 失败
  - requirements: ["boxlite-sandbox-provider/boxlite-workspace-materialization-injects-the-repo-copy-via-archive-upload"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 4.4 注入后统一收尾：workspace `origin` remote 指回 Repo 的 gitSource（本地导入指源路径）；与 deliver 链路回归验证
  - requirements: ["sandbox-provider-port/injected-workspaces-converge-to-the-same-git-shape-as-cloned-ones"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 4.5 workspace-materialization 诊断：事件标注所用变体与阶段（mount 准备/archive 传输/本地 clone），typed 失败区分 copy-not-ready / 传输失败 / 本地 clone 失败；沿用有界/无密钥约束
  - requirements: ["task-provisioning-diagnostics/workspace-materialization-diagnostics-identify-the-injection-variant-and-its-stages"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 4.6 detached clone 降级接线：默认路径不再启动沙箱内 detached 公网 clone；`git` 兜底保留既有 detached-job 契约；清理 `packages/sandbox/src/workspace/git.ts` 中仅服务主路径公网 clone 的死代码（保留兜底所需）
  - requirements: ["sandbox-detached-jobs/in-sandbox-network-clone-is-no-longer-the-primary-workspace-materialization-consumer"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 4.7 端到端（aio）：本地 docker 起真容器跑「导入→副本→subpath 挂载→沙箱内本地 clone→origin 校验」全链（脚本或集成测试，纳入 aio-e2e）
  - requirements: ["aio-sandbox-execution/aio-workspace-materialization-injects-the-repo-copy-via-read-only-subpath-mount", "repo-content-store/copies-are-exposed-to-sandboxes-read-only-and-per-task-scoped"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [ ] 4.8 端到端（boxlite）：tar 注入链路的集成测试（mock daemon 层校验 uploadArchive 内容与 box 内命令序列）；真机端到端标注为 verify 阶段在 vibe-zlyan 执行
  - requirements: ["boxlite-sandbox-provider/boxlite-workspace-materialization-injects-the-repo-copy-via-archive-upload"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 5. Track: task-gating (depends: repo-store-service, import-flows)

- [ ] 5.1 task 创建（console 与 /v1、MCP 共享路径）前置校验副本 `ready`，非 ready 拒绝并给出刷新/重导入指引；在跑任务不受副本状态变化影响
  - requirements: ["repo-and-task-management/repo-carries-a-content-copy-status-and-task-creation-gates-on-copy-readiness"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "public-surface-fast"
- [ ] 5.2 task-gating 单测：missing/refreshing/failed 三态拒绝文案、ready 放行、升级存量 repo 场景
  - requirements: ["repo-and-task-management/repo-carries-a-content-copy-status-and-task-creation-gates-on-copy-readiness"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 6. Track: console (depends: import-flows, task-gating)

- [ ] 6.1 导入对话框第三种模式（本地路径）：启用时出现、禁用时不可选；路径校验与获取结果展示
  - requirements: ["local-repo-import/console-exposes-local-import-as-a-third-mode-when-enabled"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [ ] 6.2 repo 列表展示副本状态/时间戳 + 刷新按钮（含 refreshing 中间态与失败重试）
  - requirements: ["repo-and-task-management/repo-carries-a-content-copy-status-and-task-creation-gates-on-copy-readiness"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [ ] 6.3 任务创建页副本未就绪引导（禁用提交 + 指向刷新）
  - requirements: ["repo-and-task-management/repo-carries-a-content-copy-status-and-task-creation-gates-on-copy-readiness"]
  - surfaces: ["contracts"]
  - verify: "openapi-playground"
- [ ] 6.4 前端 contracts 同步与既有 e2e/像素基线修正
  - requirements: ["local-repo-import/console-exposes-local-import-as-a-third-mode-when-enabled"]
  - surfaces: ["contracts", "ci"]
  - verify: "openapi-playground"

## 7. Track: deploy-and-docs (depends: none)

- [ ] 7.1 compose（dev + prod.yml + 生成器）增加 `repo-store` 命名卷：api 挂载；`.env.example` 增加 `CAP_LOCAL_IMPORT_ROOT` 与 git 兜底开关
  - requirements: ["repo-content-store/every-importable-repo-owns-a-bare-mirror-content-copy-in-the-shared-repo-store-volume"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "public-surface-fast"
- [ ] 7.2 部署/升级文档：存量 Repo 升级后 `missing` 需逐个刷新补建；回滚 = git 兜底开关；本地导入的 compose 挂载示例
  - requirements: ["repo-content-store/copy-lifecycle-follows-the-repo", "local-repo-import/local-path-import-is-fail-closed-behind-a-configured-allowlist-root"]
  - surfaces: ["docs", "developer-workflow"]
  - verify: "docs"
