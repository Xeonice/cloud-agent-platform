# Research Brief — add-repo-content-store

本简报固化 2026-07-23 explore 会话的三路研究：业界产品调研（联网）、双沙箱注入通道实测、代码库摸底。proposal/design/specs/tasks 均以此为地面事实。

## 0. 前史：同名工作曾完成但已丢失

上一轮 `add-repo-content-store` 曾 apply 完成（40 任务、全仓 42/42 绿）但**从未 commit**，其所在 Orca worktree 已删除；本轮为重做。已全盘核实（分支/stash/悬空提交/过期工作副本）均无残留。教训直接进入本轮约束：

- **工件与实现必须尽早、频繁 commit**。
- 上轮死因（工程侧）：并行 track 各做一半，**没人端到端接住"内容进沙箱"的传输接缝**（built-but-unreachable）。本轮 tasks 必须把注入接缝设为单一 owner 的独立任务并有端到端验证任务。
- 上轮副本形态选了 git bundle；本轮改为 bare repo（见 §3）。

## 1. 业界调研结论（联网，2026-07-23）

| 产品 | 仓库进沙箱方式 |
|---|---|
| OpenAI Codex cloud | 沙箱内 clone + 容器状态缓存 12h；setup 阶段有网、agent 阶段默认断网 |
| Google Jules | 一次性 VM 内 clone + environment snapshot 复用 |
| Devin | VM 快照里预先 clone 好（自研 blockdiff，20GB/200ms CoW 快照）；session 只 `git pull` |
| OpenHands | 自托管：宿主目录 bind-mount（`SANDBOX_VOLUMES=/host:/ctr:rw`）为一等公民；SaaS：provider token 拼 URL 沙箱内 clone |
| Cursor cloud agents | 全新 VM 内 clone；Dockerfile+environment.json layer 缓存 |
| GitHub Copilot coding agent | Actions 驱动，每任务 ephemeral clone，无跨 session 持久化 |
| Vercel Sandbox | `Sandbox.create({ source: git \| tarball \| snapshot })` 三种注入一等参数 |
| Daytona | `git.clone()` 主路径 + `upload_files()` 批量 + stream；Snapshots/Volumes |
| Modal | `add_local_dir()` 烘镜像 / Volumes 挂载（官方推荐反复使用的内容走 volume）/ 沙箱内 clone |
| E2B / Cloudflare Sandbox | 逐文件 write 为主，公认对大 repo 不友好；Cloudflare 有 `gitCheckout()` 无 bulk 上传 |

横向结论：

- **A. 主流是「沙箱内 clone + 快照/缓存加速」**；没有主流产品做「宿主 clone 后逐文件流式注入」——文件级注入对大仓库性能差，宿主侧预备一律走块级机制（volume/镜像层/快照）。tar 单次传输是文件级注入的公认正确形态（Vercel 做成一等 `tarball` source）。
- **B. 本地路径导入**：商业 SaaS 均不支持（拿不到用户机器）；自托管产品必做（OpenHands 一等公民）。本平台是自托管形态，做本地路径导入与 OpenHands 定位一致。
- **C. 我们与业界的有意差异**：各家的快照/缓存是为了摊薄"每任务 clone+装依赖"的冷启动；我们把 clone 挪到 import 时刻后，bare repo 副本本身就是跨任务复用的"缓存"，且实时性用户自管砍掉了缓存失效问题。

## 2. 注入通道实测（2026-07-23，本机 + 生产版本比对）

### AIO（aio-local，dockerode 建兄弟容器）——挂载路线，四项全过

本机 docker 29.5.3 与生产 bwg-jp 完全同版本（API 1.54，≥26）：

1. 命名卷内写 bare repo（模拟 api 写 repo-store）✔
2. 兄弟容器只读挂载整卷 + 容器内 `git clone /repo-store/demo.git`（本地 clone，秒级）✔
3. **卷 subpath 挂载**（`Mounts` + `VolumeOptions.Subpath=demo.git`, ro）——任务只见自己的 repo ✔
4. 非 root（uid 1000 ≙ AIO gem 用户）：git `safe.directory` 所有权校验拦截，`git -c safe.directory=<path> clone` 解决 ✔

### BoxLite——挂载路线被 REST API schema 判死，走 uploadArchive(tar)

- CLI 层有 `-v hostPath:boxPath[:ro]`，且 virtiofs 管道实测双向通（guest 在 host rw 卷创建了文件）。
- **决定性**：`boxlite serve`（0.9.5）的 `POST /v1/default/boxes` 拒绝 `volumes` 字段并枚举全部合法字段：`name, image, rootfs_path, cpus, memory_mib, disk_size_gb, working_dir, env, entrypoint, cmd, user, network, auto_remove, detach`——无任何挂载类字段。挂载是 CLI/本地 runtime 能力，未暴露于我们 provider 走的 REST API。
- 结论：boxlite 注入走既有 `uploadArchive`（`PUT .../files?path=`（native）/ `PUT /v1/sandboxes/{id}/archive?path=`，生产在用代码，workspace-security 三处调用）。顺带消掉"repo-store 对 boxlite daemon host 可见性"难题。未来 BoxLite API 若补 volumes 字段可用 capability 探测升级。
- 本机 0.9.5 runtime 不稳（前台 attach 被 SIGKILL、`exec` 有 procfs panic），完整 tar→box 内 clone 端到端验证放到 verify 阶段在真机（vibe-zlyan）做。

### 注入矩阵（收敛结果）

```
repo-store（docker 命名卷）: /repo-store/<repoId>.git (bare, git clone --mirror 产物)
   ├─ aio-local:  dockerode 建容器时 Mounts+VolumeOptions.Subpath 只读挂单个
   │              bare repo → 沙箱内本地 clone（+safe.directory）      【实测通过】
   ├─ boxlite:    api 打 tar → uploadArchive(PUT) → box 内解包+本地 clone【通道在用】
   └─ 远程 HTTP:  tar 兜底（AIO 官方 API 仅 /v1/file/read|write 单文件，无批量端点）
```

## 3. 代码库摸底要点

- `Repo` 模型只存 `gitSource` URL + forge 元数据，从不持有内容（apps/api/prisma/schema.prisma）。
- 现行 clone 发生在 task 启动时、沙箱内部：`packages/sandbox/src/workspace/git.ts`（1807 行）的 detached clone 机器（parking/传输重试/stall abort/进度解析）全部是对抗"启动时经公网 clone"的复杂度；clone 挪到 import 时刻（API host 上、有网、可重试、可展进度）后大部分存在理由消失。
- 注入接缝位置现成：`SandboxProviderPort` 有 capability 声明 + workspace descriptor（`mode: 'git'`、`git.materialized/deliverable`）；Vercel 的 `source` 联合类型是 port API 泛化范本（`WorkspaceSource = git | archive | volume`，git 保留做渐进迁移）。
- deliver（push 回 forge）链路不变：副本进沙箱后仍将 `origin` remote 指回真实 `gitSource`，multi-forge delivery 的"只有 git push 进沙箱"架构原样保留。
- 部署现实：api 在容器内，"本地路径"解析于 **api 容器文件系统**；host 目录须经 compose 挂载才可见 = 天然显式 opt-in。多用户风险 = 任意路径读取（如读他人 workspace）；三道锁：`CAP_LOCAL_IMPORT_ROOT` 白名单根（不设=功能关）+ 目标必须是 git repo + （可选）admin 门禁。
- workspaces 卷先例：生产 workspaces 是 docker 命名卷（`cloud-agent-platform_workspaces`）；repo-store 采用同型命名卷即可被 api 与 aio 兄弟容器共享。
