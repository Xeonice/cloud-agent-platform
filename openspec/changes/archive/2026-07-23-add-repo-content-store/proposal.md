# add-repo-content-store

## Why

仓库获取目前发生在 task 启动时、沙箱内部经公网 `git clone`——启动路径被网络不确定性绑架（62 秒低速中止、晚高峰直连劣化都发生过），为此维护着 1807 行的 detached clone 对抗机器（parking/传输重试/stall abort），且每个任务重复付一次 clone 成本。把内容获取挪到 import 时刻一次性完成（导入即持有副本），task 启动只做本地注入，网络不确定性从"每任务"收敛为"每导入"，同时解锁自托管场景的本地路径导入（业界调研：自托管产品的一等能力，商业 SaaS 做不了）。实时性由用户自管，不做启动时刷新。

## What Changes

- 新增 host 侧 **repo 内容副本库（repo-store）**：docker 命名卷中按 repo 存 bare 镜像（`git clone --mirror`），forge URL 导入与本地路径导入归一到同一形态；提供手动"刷新副本"（`git fetch`）把手。
- **导入即取内容**：forge/URL 导入流程在导入时刻于 API host 上完成 clone（有网、可重试、可展进度），导入完成 = 副本就绪。
- 新增**本地路径导入**：在既有 forge picker / by-URL 之外增加第三种导入方式——从 api 容器可见的白名单根（`CAP_LOCAL_IMPORT_ROOT`，不配置=功能关闭）下选择现有 git repo 导入；目标必须是 git 仓库。
- **task 启动不再在沙箱内发起网络 clone**：改为按 provider 分层注入副本——aio-local 用卷 subpath 只读挂载单个 bare repo 后沙箱内本地 clone（实测通过）；boxlite 用既有 `uploadArchive` tar 通道（其 REST API 实测无挂载字段）；远程 HTTP provider 走 tar 兜底。**BREAKING**（内部行为）：无副本的 Repo 无法启动任务，存量 Repo 需补建副本。
- `SandboxProviderPort` 的 workspace 来源从单一 `GitCloneSpec` 泛化为 **`WorkspaceSource` 联合类型**（git｜archive｜volume），provider 声明支持的注入方式；`git` 变体保留用于渐进迁移与兜底。
- 沙箱内 workspace 的 `origin` remote 仍指回真实 `gitSource`，deliver（git push 进沙箱）链路不变。
- detached clone 机器降级：沙箱内公网 clone 不再是主路径，其进度/重试语义迁移到 import 时刻的 host 侧 clone 任务上。

## Capabilities

### New Capabilities
- `repo-content-store`: host 侧 bare repo 副本库——导入时落副本、副本生命周期（建/刷新/删）、命名卷布局与多租户只读暴露约束。
- `local-repo-import`: 本地路径导入——白名单根门禁、git repo 校验、与 forge 导入归一的副本落地，及其 console 入口。

### Modified Capabilities
- `multi-forge-repo-import`: 导入不再只写元数据——导入流程须同步获取内容副本并报告进度/失败；导入完成的定义改变。
- `sandbox-provider-port`: `ProvisionContext` 的 clone spec 泛化为 `WorkspaceSource` 联合类型；provider 声明注入能力（mount/archive/git）。
- `aio-sandbox-execution`: workspace 物化从沙箱内网络 clone 改为卷 subpath 只读挂载 + 沙箱内本地 clone（含 `safe.directory` 处理）。
- `boxlite-sandbox-provider`: workspace 物化从沙箱内网络 clone 改为 `uploadArchive` tar 注入 + box 内本地 clone。
- `repo-and-task-management`: `Repo` 增加副本状态（就绪/缺失/刷新中）；task 启动前置校验副本就绪；实时性自管语义（启动不 fetch）。
- `sandbox-detached-jobs`: 沙箱内 detached 公网 clone 不再是 workspace 物化主路径；detached-job 原语保留给其余长任务。
- `task-provisioning-diagnostics`: workspace 物化阶段的诊断事件从"clone 进度"改为"注入（挂载/传输）进度"；import 侧新增 clone 进度事件。

## Impact

- **后端**: `apps/api/src/repos/*`（导入流程、新导入方式、副本状态）、`apps/api/prisma/schema.prisma`（Repo 副本字段，migration）、`apps/api/src/sandbox/*` 与 `packages/sandbox/src/workspace/git.ts`（物化路径重构、clone 机器迁移/降级）、`packages/sandbox-provider-aio`（dockerode Mounts 注入）、`packages/sandbox-provider-boxlite`（uploadArchive 注入）、`packages/sandbox-core`（`WorkspaceSource` 类型）。
- **前端**: 导入对话框第三种方式（本地路径）、repo 列表副本状态与刷新按钮、任务创建时副本未就绪的引导。
- **部署**: 新 docker 命名卷 `repo-store`（compose 变更，api 与沙箱容器共享）；新 env `CAP_LOCAL_IMPORT_ROOT`；存量 Repo 的副本补建路径（升级兼容）。
- **不变**: deliver/push 链路（origin 指回 gitSource）、forge 凭据模型、SSRF 边界（forge HTTP 仍是受信任直连）。
