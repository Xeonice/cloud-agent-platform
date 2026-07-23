# Design — add-repo-content-store

## Context

现状：`Repo` 只存 `gitSource` URL；task 启动时由沙箱内部经公网 `git clone` 物化 workspace（`packages/sandbox/src/workspace/git.ts` 的 detached clone 机器，1807 行，含 parking/传输重试/stall abort/进度解析）。网络不确定性发生在每个任务的关键路径上。

本 change 把内容获取挪到 import 时刻：导入即在 API host 上落一份 bare repo 副本（repo-store），task 启动只做本地注入。三路研究（业界调研/双沙箱实测/代码摸底）已固化在 `research-brief.md`，本文的决策均以其为地面事实，不重复论证。

前史约束：同名工作曾 apply 完成但未 commit 而丢失；死因是并行实现时"内容进沙箱"的传输接缝无人端到端负责（built-but-unreachable）。本轮 tasks 将注入接缝设为单一 owner 的串行任务并配端到端验证。

## Goals / Non-Goals

**Goals:**
- 导入自闭环：导入完成 = 内容副本就绪（forge/URL 与本地路径两路归一）。
- task 启动零公网 clone：按 provider 分层做本地注入（aio=卷挂载、boxlite=tar、远程=tar 兜底）。
- 本地路径导入：白名单根门禁下从 api 容器可见路径导入现有 git repo。
- 副本实时性用户自管：启动不 fetch；提供手动刷新把手。
- deliver（git push 进沙箱）链路不变。

**Non-Goals:**
- 不做启动时自动刷新/缓存失效管理（业界快照失效那套复杂度被"用户自管"砍掉）。
- 不做依赖安装缓存/环境快照（Codex 12h 缓存、Devin blockdiff 属于另一维度）。
- 不做浏览器上传本机 repo（"本地"指 api 容器可见的服务器路径）。
- 不删除 detached-job 原语本身（其余长任务仍用）。
- BoxLite 挂载注入不做（REST API 无 volumes 字段，实测判死）；留 capability 探测升级空间即可。

## Decisions

### D1. 副本形态：bare repo（`git clone --mirror`），存 docker 命名卷

- 一份形态同时服务三个消费者：手动刷新（`git fetch`）、aio 挂载后沙箱内本地 clone、tar 打包传输。
- 否决 git bundle（上轮选择）：refresh 需整包重建，且到达沙箱后仍要 clone，一步不省；否决纯 tar 快照：丢 git 历史，agent 无法 log/diff/建分支。
- 命名卷（如 `repo-store`）复用 workspaces 卷的既有共享模式，api 与 aio 兄弟容器天然可共享；卷内布局 `/repo-store/<repoId>.git`。

### D2. 导入即取内容，clone 发生在 API host 上

- 导入流程（forge picker / by-URL / 本地路径）在导入时刻完成副本落地，带进度与失败报告；导入完成的定义 = 元数据 + 副本就绪。
- host 侧 clone 有网、可重试、可展进度；沙箱内 clone 机器的进度/重试语义迁移到这里，复杂度天然低一个量级（无 exec 通道转译、无 parking）。
- 本地路径导入 = `git clone --mirror <local-path> /repo-store/<id>.git`，与 forge 导入产物同形态。

### D3. 本地路径导入的安全模型：三道锁

1. `CAP_LOCAL_IMPORT_ROOT` 白名单根，env 不配置 = 功能整体关闭（fail-closed，与 BoxLite provider 注册同哲学）；路径解析后必须落在根内（防 `..`/symlink 逃逸，用 realpath 比对）。
2. 目标必须是 git 仓库（含 `.git` 或本身是 bare），把任意文件读取收窄为读一个 git 仓库。
3. 部署现实即第零道锁：api 在容器内，host 目录须操作者显式 compose 挂载才可见。
- 多用户风险（读他人 workspace / 应用文件）由锁 1+2 覆盖；admin 门禁本轮不强制（白名单根已把暴露面交给操作者定义），specs 不作要求。

### D4. 注入矩阵：per-provider 分层（实测收敛）

| provider | 注入方式 | 依据 |
|---|---|---|
| aio-local | dockerode 建容器时 `Mounts` + `VolumeOptions.Subpath=<repoId>.git`, ro → 沙箱内 `git -c safe.directory=<path> clone`（本地，秒级） | 四项实测通过；subpath 保证任务只见自己的 repo；ro 保证副本不可污染 |
| boxlite | api 打 tar（bare repo）→ 既有 `uploadArchive`（PUT）→ box 内解包 + 本地 clone | REST API 实测无 volumes 字段；uploadArchive 是生产在用代码 |
| 远程 HTTP | 同 boxlite 的 tar 形态走各自文件通道兜底 | AIO 官方 API 仅单文件 read/write，无批量端点 |

- 注入后统一在 workspace 里 `git remote set-url origin <gitSource>`，deliver 链路原样。

### D5. Port 泛化：`WorkspaceSource` 联合类型（Vercel `source` 范本）

- `packages/sandbox-core` 定义 `WorkspaceSource = { kind: 'git', spec: GitCloneSpec } | { kind: 'archive', ... } | { kind: 'volume', ... }`；`ProvisionContext` 携带它取代裸 `CloneSpec`。
- provider 以 capability 声明支持的 kind；编排层按矩阵选择，不支持则明确失败（fail-closed），`git` 变体保留用于渐进迁移与紧急兜底（env 开关），不静默降级。

### D6. Repo 副本状态与任务门禁

- `Repo` 增加副本状态（ready / missing / refreshing / failed + 时间戳），Prisma migration。
- task 启动前置校验副本 ready；不 ready 给出可行动错误（引导刷新/重导入）。**存量 Repo 升级后为 missing**，由操作者逐个触发补建（一次性刷新即可），不做自动批量回填（避免升级时不可控的批量公网 clone）。

## Risks / Trade-offs

- [boxlite 端到端未在本机跑通（0.9.5 runtime 不稳）] → uploadArchive 为生产在用代码，风险限于"tar 内容为 bare repo"这一新用法；verify 阶段在真机（vibe-zlyan）做端到端。
- [大 repo 的 tar 通道内存/耗时（boxlite/远程）] → bare mirror 本身已是最小内容集；tar 走流式（不整包进内存）；aio 主路径（挂载）完全不受影响。
- [副本磁盘占用随 repo 数增长] → bare mirror 远小于工作树；删除 Repo 级联删副本；卷用量暴露给 metrics 属后续。
- [导入耗时变长（从"写行"变"真 clone")] → 导入本来就是低频操作；带进度展示；失败可重试且不影响既有 Repo。
- [git 兜底路径长期滞留] → 兜底受 env 开关控制且默认关闭，specs 写明主路径必须为注入。
- [并行实现再次丢接缝] → tasks 把 D4 注入链设为单 owner 串行段 + 每 provider 一条端到端验证任务。

## Migration Plan

1. compose 增加 `repo-store` 命名卷（api 挂载；aio 兄弟容器按任务挂 subpath）。
2. 发版后存量 Repo 副本状态 = missing；console 提示逐个刷新补建；补建完成前该 Repo 无法启动新任务（旧任务不受影响）。
3. 回滚：git 兜底 env 开关可让 workspace 物化临时回到沙箱内 clone；repo-store 卷保留无副作用。

## Open Questions

- （无阻塞项）BoxLite 未来版本 REST API 若增加 volumes 字段，可加 capability 探测升级为挂载注入——不影响本轮设计。
- **【阻塞归档】public-surface 验证元数据不可判定（verify pass 2026-07-23，metadata-validation-failed）**：本 change 全部 18 条 requirement 的 deterministic-public-surface-cli 动态核验因「Unable to resolve a complete public-surface base diff. Set CAP_PUBLIC_SURFACE_BASE_SHA or configure a branch upstream.」而无法执行——当前工作树处于 detached HEAD 且无 branch upstream，任务元数据声明的 public-surface 核验面（surface-impact.json / tasks.md 的 `verify:` 标注）在此环境下不可测试。这是规格/元数据缺陷而非实现缺陷：要么补齐 `CAP_PUBLIC_SURFACE_BASE_SHA`（或配置 branch upstream）使基线 diff 可解析，要么修正各任务的 verify 元数据使其在 detached 工作树下可判定。在该缺陷修正并重跑 public-surface 核验之前，archive 不得接受 sidecar 的 public-surface 声明（false claim 风险）。涉及全部 18 个 requirement id（aio-sandbox-execution 1、boxlite-sandbox-provider 1、local-repo-import 4、multi-forge-repo-import 1、repo-and-task-management 1、repo-content-store 5、sandbox-detached-jobs 1、sandbox-provider-port 3、task-provisioning-diagnostics 1）。
