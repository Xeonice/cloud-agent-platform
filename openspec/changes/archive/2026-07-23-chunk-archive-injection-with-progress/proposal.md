# chunk-archive-injection-with-progress

## Why

v0.45.0 的 boxlite archive 注入在真机首验（vibe-zlyan，task e39bc147）即失败：BoxLite serve 0.9.5 的 `/files` 上传端点**整包缓冲且 body 上限 2MB**（实测 1MB→204、3MB→413 "Failed to buffer the request body: length limit exceeded"），流式大传输被 daemon 掐断（api 侧 `write EPIPE`）。两个真实副本（869MB / 11MB）都超限——**archive 注入对任何真实仓库都不可用**，4.8 的 mock daemon 没有模拟真实限额所以没抓到。同时，传输期间用户在任务页看不到任何"正在传入仓库"的反馈：detached clone 时代建成的 provisioning 进度快照通道（`workspace_transfer` 阶段 + percent 渲染，前端文案「传输仓库工作区 · N%」现成）在注入路径上没有数据源。

## What Changes

- **boxlite archive 注入改分片上传**：api 侧把 tar 流切成不超过 daemon body 限额的分片（默认 ≤1.5MB，留余量），逐片 `PUT` 到 box 内 parts 目录，box 内重组并做完整性校验（字节数 + 校验和）后解包、本地 clone；任何一片失败或校验不符 → typed workspace_transfer 失败，不留半成品。
- **传输进度贯通到任务页**：分片上传器以字节为源喂 provisioning 进度快照（现有 `task_admission_work.progress_*` 列与 `TaskProvisioningProgressSchema`，零 schema 变更）——总量用 bare mirror 磁盘占用估算、percent 封顶 99% 直到完成、含 throughput；**写库按 ≥1s 时间节流**（用户拍板）。前端零改动即渲染「传输仓库工作区 · N%」。
- **mock daemon 补真实限额模拟**：archive 注入的集成测试 fake daemon 强制 2MB body 上限，>2MB 单片上传必须失败（防回归，这次漏抓的测试盲区）。
- 部署文档与 rollout：记录 daemon 限额事实与分片参数；vibe-zlyan 升级 + 按 `TASK_ADMISSION_V2_CUTOVER.md` 开启 admission v2（进度快照通道在 legacy admission 下不存在，这台机器目前看不到任何阶段卡片）+ zhiwen 任务端到端活验（补上 v0.45.0 未完成的 boxlite 真机首验）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `boxlite-sandbox-provider`: archive 注入的传输契约从"单请求流式上传"改为"限额感知分片 + 完整性校验重组"；新增对 daemon body 限额的行为要求。
- `sandbox-provider-port`: workspace 物化的 archive 传输 SHALL 以字节进度喂 provisioning 进度快照（1s 节流、估算总量、percent 不确定语义保留）。

## Impact

- **后端**: `packages/sandbox/src/workspace/repo-archive.ts`（分片切流）、`packages/sandbox-provider-boxlite`（分片 PUT、box 内重组命令、限额参数）、`packages/sandbox/src/workspace/git.ts`（archive 步骤接进度回调）、`apps/api` 注入编排（进度回调 → admission store 1s 节流写快照）。
- **测试**: `packages/sandbox/test/repo-copy-injection.test.mjs` fake daemon 加 2MB 限额 + 分片重组断言；进度写库节流单测。
- **前端 / wire**: 零变更（复用既有 stage 文案、progress schema、渲染逻辑）。
- **部署**: 无新 env 必需项（分片大小可选 env 覆盖）；vibe-zlyan 侧 rollout 步骤（升级 + admission v2 开启）是运维动作不改代码。
