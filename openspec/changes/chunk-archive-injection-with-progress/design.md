# Design — chunk-archive-injection-with-progress

## Context

真机证据链（2026-07-23，vibe-zlyan task e39bc147，全部实测）：BoxLite serve 0.9.5 `/v1/default/boxes/{id}/files` 路由存在（对缺失 box 返回 404 box not found）、接受 chunked 编码，但**整包缓冲请求体且上限 2MB**（1MB→204，3MB→413 length limit exceeded）；流式 869MB 上传在 api 侧表现为 `fetch failed: write EPIPE`，诊断落 `workspace_transfer / cause: unknown`。诊断链（`workspaceSourceKind: archive`）工作正常，5 秒定位。

进度侧现状：detached clone 时代的完整通道仍在——`task_admission_work.stage/progress_*` 列（CHECK 数字化、percent null=不确定且绝不渲染 0%）、`TaskProvisioningProgressSchema`、前端 `task-provisioning-status.tsx` 在 `stage==='workspace_transfer'` 且 percent 有值时渲染「传输仓库工作区 · N%」。注入路径没有数据源喂它。vibe-zlyan 跑 legacy admission（诊断事件 `admission_mode: legacy`，work 行 0 rows）——快照通道在该机不存在，需按 `TASK_ADMISSION_V2_CUTOVER.md` 开启 v2。

## Goals / Non-Goals

**Goals:**
- boxlite archive 注入对任意大小副本可用（限额感知分片 + 校验重组）。
- 传输期任务页可见「传输仓库工作区 · N%」（1s 节流写快照，字节为源）。
- mock daemon 补 2MB 限额，堵住这次的测试盲区。
- vibe-zlyan rollout：升级 + admission v2 + zhiwen 端到端活验（补 v0.45.0 的真机首验）。

**Non-Goals:**
- 不改 daemon（BoxLite 上游限额是外部事实；可另行提 issue，不阻塞）。
- 不改 wire schema / 前端（通道现成）。
- 不把 percent 塞进诊断事件（spec 明令 per-poll 进度不入库，维持）。
- 不动 aio 挂载路径与 git 兜底路径。
- 不在本轮修 console refresh-copy 卡"刷新中"的前端 bug（已另行记录）。

## Decisions

### D1. 分片形态：定长切流 + box 内 cat 重组 + 双重校验

- api 侧从 tar spawn 的 stdout 流按**默认 1.5MB**（`CAP_BOXLITE_ARCHIVE_PART_BYTES` 可覆盖，留 0.5MB 余量给 2MB 限额）切片，逐片 `PUT .../files?path=<dir>/.parts/NNNNNN`（零填充序号保证字典序）；片内容即原始字节，不 base64（files 端点收原始 body）。
- box 内重组：`cat .parts/* > archive.tar && rm -rf .parts`，随后校验**总字节数**与**SHA-256**（api 侧切流时同步累计）一致才解包；不符 → typed `workspace_transfer` 失败并清理，不留半成品。
- 否决方案：base64 过 shell exec（编码膨胀 33% + exec 通道不为大载荷设计）；`boxlite cp`（CLI 在 host，看不见 docker 卷内的 repo-store）；让 box 从 api 拉 git http（引入新网络面，超出修复范畴）。
- 顺序上传（不并发）：保证重组序与失败定位简单；869MB ≈ 580 片，每片往返 <100ms（本机回环），预计 1-2 分钟，可接受。

### D2. 进度：字节为源、1s 节流、估算总量（用户拍板）

- 上传器每片完成回调累计字节；**写库按 ≥1s 时间节流**（580 片不产生 580 次 update）。
- 总量 = bare mirror 目录磁盘占用估算（`du` 语义；tar 无压缩故误差极小）；percent = min(99, uploaded/total)，完成事件才落 100 语义（复用现有"完成即 stage 前进"）；总量不可得时 percent=null（走既有"不确定"渲染，绝不显示 0%）。
- 写入 seam 复用 `prisma-task-admission.store` 的既有 progress 列更新路径；throughput 由节流窗口内字节差计算。
- legacy admission 下无 work 行：进度回调发现无快照可写时静默跳过（不报错、不改变物化行为）——与现状一致，诊断 timeline 仍可见阶段进入/离开。

### D3. mock daemon 限额模拟

- `repo-copy-injection.test.mjs` 的 FakeBoxLiteClient/daemon 层强制 2MB body 上限（413 + 连接中断两种形态都模拟），断言：>2MB 单片必失败；分片路径全量通过且重组后 SHA-256 与源一致。这是"mock 没模拟真实限额"盲区的直接回填。

### D4. vibe-zlyan rollout 属运维任务不属代码

- 步骤：升级到含本修复的版本 → 按 `TASK_ADMISSION_V2_CUTOVER.md` 开 admission v2 → zhiwen 跑任务活验（诊断 `workspaceSourceKind: archive` + 任务页出现「传输仓库工作区 · N%」+ workspace 物化成功）。git 兜底开关保持关闭（若中途需应急，开 `CAP_WORKSPACE_GIT_FALLBACK_ENABLED=true` 即回 v0.43.x 行为）。

## Risks / Trade-offs

- [限额值随 daemon 版本漂移] → 分片大小 env 可调且默认远低于已知限额；单片 413 的失败信息明确指向调小分片。
- [顺序上传吞吐低于流式] → 本机回环往返代价小；实测预估 1-2 分钟可接受；不做并发以保住重组简单性。
- [du 估算总量与 tar 实际字节有偏差] → percent 封顶 99%，偏差只影响中间读数不影响完成判定。
- [1s 节流下短传输（<1s）可能一次快照都不写] → 可接受：小副本传输瞬间完成，stage 本身的进入/离开仍可见。
- [legacy admission 部署看不到 percent] → 明确记录为部署形态差异；vibe-zlyan 本轮开 v2，其余自托管按需。

## Migration Plan

随补丁版本发布（建议 v0.45.1）；无 migration、无 env 必改项。vibe-zlyan rollout 见 D4。回滚 = git 兜底开关（不变）。

## Open Questions

（无阻塞项）BoxLite 上游是否愿意提高/流式化 files 端点限额——可提 issue，与本修复解耦。
