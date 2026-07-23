# Verification Report — add-repo-content-store

Verify pass: 2026-07-23（三向路由裁定，非 raw skeptic 计数）。

裁定口径：skeptic 对全部 18 条 requirement 打了 raw-unmet，但其动态 refutation 全部源自同一条 **metadata-validation-failed**（public-surface base diff 不可解析，见 design.md Open Questions 的阻塞项）——那是核验工具链/元数据缺陷，不是对实现的反驳。逐条对照真实代码重走后：**16 条重判 MET**（下表），**2 条确认为真实代码缺口**重开任务（tasks.md `## Track: verify-reopened`），**18 条全部**因 public-surface 元数据不可判定而记为阻塞归档的 spec-defect（design.md Open Questions）。

## Reclassified MET（16）

以下各条的静态端到端追溯 + 本地测试执行均成立；skeptic 的 refuted 标记仅为核验元数据失败，不构成实现反例。各条 caveat（public-surface 动态核验待做）统一由 design.md 的阻塞 Open Question 承载，不重复展开。

### aio-sandbox-execution
1. **aio-workspace-materialization-injects-the-repo-copy-via-read-only-subpath-mount** — MET。ro subpath mount 构造（aio-local-provider.ts:214-243，`ReadOnly:true`+`VolumeOptions.Subpath`，拒绝 `..`/绝对路径）→ 容器创建期挂载（aio-provider.ts:321-331）→ 沙箱内本地 clone + `GIT_CONFIG_GLOBAL` safe.directory（packages/sandbox/src/workspace/git.ts:667-698,805-838）。repo-copy-injection.test.mjs 34 断言过（含无凭据/无网络 clone 断言）；tasks 4.2/4.7 [x]。

### boxlite-sandbox-provider
2. **boxlite-workspace-materialization-injects-the-repo-copy-via-archive-upload** — MET。`createArchiveTransferPort`→`uploadArchive`（boxlite-provider.ts:1068-1214），tar 真流式不整包进内存（repo-archive.ts:59-128），传输失败 typed 到 `workspace_transfer` stage（git.ts:955-998）。真 bare-mirror 往返测试（repo-copy-injection.test.mjs:192-333）34/34 过。

### local-repo-import
3. **local-path-import-is-fail-closed-behind-a-configured-allowlist-root** — MET。env 未配置即整体关闭（local-import.ts:61-71,87-152），lexical+realpath 双重包含校验先于任何 stat/读取，symlink 逃逸拒绝且不泄露目标信息（local-import-errors.ts:15-46）；前端 tab 禁用并点名 env（import-dialog.tsx:793-819）。local-import.spec.ts 9/9 过。
4. **local-import-target-must-be-a-git-repository** — MET。`detectGitRepository`（worktree `.git` 或 bare HEAD+objects+refs，local-import.ts:158-167）在建 Repo 行之前执行；422 `repo_local_import_not_a_git_repository` 可行动报错；同一 `git clone --mirror` 获取路径产出标准副本。local-import.spec.ts + repo-copy.spec.ts 覆盖（含 HEAD-only decoy 拒绝、无 Repo 行残留）。
5. **locally-imported-repos-record-their-source-and-stay-outside-forge-delivery** — MET。`gitSource=path` + `forge:null`（local-import.service.ts:103-116）；结构化判定 `repoOffersForgeDelivery`（contracts/task.ts:642-663，即使 forge 列被写也不会复活 delivery，有测试钉住）；`parseGitSource` 对路径 `new URL` 抛错→forge target 结构性不可达→deliverStatus:'skipped'；console 诚实展示「本地导入仓库，不提供 PR / MR 回写」；任务创建/物化不分叉。
6. **console-exposes-local-import-as-a-third-mode-when-enabled** — MET（met-as-written，minor gap 不阻塞主场景）。`ImportSourceKind` 含 `local` 第三模式，availability 探针驱动启用/禁用且禁用态点名 CAP_LOCAL_IMPORT_ROOT（import-dialog.tsx:439-916），后端 fail-closed 探针端点（repo-copy.controller.ts:55-61）。minor gap：前端覆盖是 source-text 断言而非渲染 DOM 交互测试——不阻塞两个 spec 场景的实现事实。

### multi-forge-repo-import
7. **forge-and-url-imports-acquire-the-content-copy-at-import-time** — MET。每条 forge/URL 导入分支收口 `acquireOnImport(repo, cloneAuthHeader)`（repos.service.ts:189-200），成功回 `copyStatus:'ready'`，失败 typed HTTP（403/503/400/409）且行保留为 `failed` 可经 refresh-copy 重试。repo-copy.spec.ts 12/12 过（两场景直测）。

### repo-and-task-management
8. **repo-carries-a-content-copy-status-and-task-creation-gates-on-copy-readiness** — MET。migration + CHECK 约束（存量默认 missing）；创建闸单一漏斗 `resolveTaskCreateFoundation`→console//v1/MCP/schedule 全走同一 gate，unknown 值 fail-closed，报错点名 refresh-copy；在跑任务不受影响（gate 仅 create）；读 API 三面投影 copyStatus/copyUpdatedAt。task-repo-copy-gate.spec.ts 10/10 + repo-copy.spec.ts 12/12 过。
9. （repo-content-store）**every-importable-repo-owns-a-bare-mirror-content-copy-in-the-shared-repo-store-volume** — MET。`git clone --mirror` 原子落 `<storeRoot>/<repoId>.git`，三种导入模式共用 `acquireOnImport` 接缝，同一份副本同时服务 volume 与 archive 消费者无转换；dev/prod compose 均带 `repo-store` 命名卷。
10. **import-acquires-the-content-copy-with-progress-and-atomic-completion** — MET（met-as-written，minor gap 不阻塞主场景）。staging+原子 rename、finally 清理保证重试零人工清理、状态序列 refreshing→ready/failed 均有直接单测（repo-store.service.spec.ts 15/15）。minor gap：字节级 onProgress 回调仅测试用，生产观测走 copyStatus 轮询（5s）+ 导入中文案——「reports acquisition progress」以粗粒度状态满足，不阻塞两个 spec 场景。
11. **copy-freshness-is-user-managed-via-explicit-refresh-only** — MET。任务启动路径只 stat 不 fetch（workspace-source-resolver.ts:96-141）；全库唯一 `git fetch` 在显式 refresh 内（repo-store.service.ts:263-296），仅 console 端点暴露（刻意不进 /v1 与 MCP）；无任何 cron/interval 自动刷新；失败保留 last-good 副本有逐字节断言（spec 15/15 过）。
12. **copies-are-exposed-to-sandboxes-read-only-and-per-task-scoped** — MET。ro + per-repo subpath 由构造保证（SAFE_REPO_ID 正则 + subpath 断言），直通 dockerode 无中间层丢失；aio-provider.test.mjs 38/38 过；apps/api/test/repo-copy-injection-e2e.mjs 为真 docker e2e（写探针必败 + 兄弟 repo 不可见），两 spec 场景端到端覆盖。

### sandbox-detached-jobs
13. **in-sandbox-network-clone-is-no-longer-the-primary-workspace-materialization-consumer** — MET。默认路径 injection≠null 时 workspace_transfer 走普通 stage 执行、无 setsid/cap-jobs（有专门断言 `!/setsid|cap-jobs/`，34 断言过）；`git` 兜底 env 开关（默认关）保留原 detached-job 机器不分叉。task 4.6 [x]。

### sandbox-provider-port
14. **provision-context-carries-a-typed-workspacesource-union** — MET。sandbox-core 联合类型 + capability 词汇映射；durable 与 legacy 两条 provision 路径均接线；router 把 workspaceSource 所需 capability 并入选型集合；aio-provider.test.mjs 38/38（含 fail-closed 不支持变体用例）+ workspace-source-resolver.spec 过。
15. **repo-copy-injection-is-the-primary-materialization-path-and-git-fallback-is-explicitly-gated** — MET。选型接缝 fail-closed（无 capability 且兜底关→typed 错误点名缺失 capability 与 env 闸）；provider 边界二次断言；兜底默认关。resolver spec 11/11 + injection 测试 34/34 过。（「observable 变体命名」句由 task-provisioning-diagnostics 独立 requirement 承载，该条确认未满足并已重开 V.2，不影响本条两场景。）
16. **injected-workspaces-converge-to-the-same-git-shape-as-cloned-ones** — MET。volume/archive 两变体收尾统一 `checkout --force -B` + `remote set-url origin <gitSource>`（真上游而非 store 镜像路径）；volume 变体有真容器 e2e 断言 `remote get-url origin === GIT_SOURCE`；archive 变体 mock-daemon 覆盖（真机归 vibe-zlyan verify 段，per tasks 4.8 备注）。

## UNMET → 已重开（2，见 tasks.md Track: verify-reopened）

- **repo-content-store/copy-lifecycle-follows-the-repo** — 场景 2（升级不批量补建）成立；场景 1（删除 Repo 移除副本）为 built-but-unreachable：`RepoStoreService.remove()` 零生产调用点，产品无任何 Repo 删除面（本次 verify 复核 grep 再确认：repos 无 `@Delete` 路由、web 无删除 UI、唯一 `repo.deleteMany` 在 provider-terminal-story fixture 且不清副本）。→ V.1。
- **task-provisioning-diagnostics/workspace-materialization-diagnostics-identify-the-injection-variant-and-its-stages** — typed-cause 区分（transfer vs local-clone via stage 值）成立；但「SHALL name the variant」无实现：封闭诊断词汇无 volume/archive/git 取值或变体字段，emit 从不读 WorkspaceSource.kind，测试也只断言 operation:outcome 序列。→ V.2。

## Gap finding（复核确认）

再次确认——`apps/api/src/repos` 与 `apps/api/src/tasks` 中不存在任何真实 Repo 删除路径。18 条 requirement 中 16 条有扎实可用的实现；2 条（上节）字面行为无代码路径实现：级联删除原语存在但不可达；诊断变体命名在封闭 enum 中无字段可承载且无自由文本 detail 可借用。

## Scope findings（超 spec 面，均为轻微、可辩护的实现细节，不重开任务）

1. `GET /repos/local-import/availability` 向任意已认证会话返回实际解析后的 allowlist 根文件系统路径（不止 enabled 标志）— local-import.service.ts:35-44、contracts/local-repo-import.ts:38-44。
2. 本地路径导入读取源仓 HEAD 自动检测并记录默认分支（与 forge 导入对齐的 parity 行为，spec 未要求）— local-import.ts:181-199。
3. 本地路径导入在操作者未提供名称时用目录 basename 派生显示名（UX 便利，spec 未要求）— local-import.ts:170-173。

置信说明：三条均为「第三模式 UX / Repo 行 parity」上可辩护的实现细节而非功能蔓延；~9000 行 diff 其余部分（repo-store 服务、workspace-source 联合、AIO 挂载注入、BoxLite 归档流式、任务闸门、诊断分类器、部署文档/compose、console UI）均可直接追溯到 tasks.md 条目与其引用的 requirement，未发现无关功能、多余端点或投机能力。

## 三向 tally

- reclassifiedMet：16
- reopenedTasks：2（V.1 / V.2）
- specDefects（含 blocking）：18（全部 requirement 的 public-surface 核验元数据不可判定，metadata-validation-failed；详见 design.md Open Questions，归档前必须修正并重跑）
