# Tasks — chunk-archive-injection-with-progress

## 1. Track: chunked-upload (depends: none)

- [ ] 1.1 `packages/sandbox/src/workspace/repo-archive.ts`：tar 流定长切片（默认 1.5MB，`CAP_BOXLITE_ARCHIVE_PART_BYTES` 覆盖），切流同步累计总字节数与 SHA-256，产出有序 part 流 + 汇总
  - requirements: ["boxlite-sandbox-provider/boxlite-archive-injection-chunks-uploads-under-the-daemon-body-limit-with-verified-reassembly"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 1.2 boxlite 注入链改分片：逐片顺序 `PUT <dir>/.parts/NNNNNN`（零填充序号），box 内 `cat` 重组 + 字节数/SHA-256 双重校验通过才解包；任何片失败或校验不符 → typed `workspace_transfer` 失败并清理 parts/半成品
  - requirements: ["boxlite-sandbox-provider/boxlite-archive-injection-chunks-uploads-under-the-daemon-body-limit-with-verified-reassembly"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 1.3 集成测试：fake daemon 强制 2MB body 上限（413 与连接中断两种形态），断言 >2MB 单片必失败、分片路径全量通过且重组后 SHA-256 与源一致、校验不符时 typed 失败且无残留
  - requirements: ["boxlite-sandbox-provider/boxlite-archive-injection-chunks-uploads-under-the-daemon-body-limit-with-verified-reassembly"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 2. Track: progress-feed (depends: chunked-upload)

- [ ] 2.1 传输进度回调贯通：上传器每片累计字节 → 物化上下文进度回调 → apps/api 注入编排以 ≥1s 时间节流写 `prisma-task-admission.store` 既有 progress 列（receivedBytes/percent/throughput）；总量用副本磁盘占用估算、percent 封顶 99、不可估时 percent=null；legacy admission 无 work 行时静默跳过
  - requirements: ["sandbox-provider-port/archive-workspace-transfer-feeds-the-provisioning-progress-snapshot"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [ ] 2.2 进度单测：多片跨节流窗口的递增快照、1 秒内多片仅一次写库、无估算时 percent=null、legacy 模式零写入零报错；任务读投影里 `workspace_transfer` 阶段带 percent 的 round-trip
  - requirements: ["sandbox-provider-port/archive-workspace-transfer-feeds-the-provisioning-progress-snapshot"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 3. Track: docs-and-rollout (depends: none)

- [ ] 3.1 文档：部署文档记录 BoxLite serve 0.9.5 的 2MB body 限额事实、`CAP_BOXLITE_ARCHIVE_PART_BYTES` 参数、以及"进度快照需要 admission v2（legacy 只见诊断 timeline 阶段无 percent）"的形态差异；`.env.example` 补该可选参数注释
  - requirements: ["boxlite-sandbox-provider/boxlite-archive-injection-chunks-uploads-under-the-daemon-body-limit-with-verified-reassembly"]
  - surfaces: ["docs", "developer-workflow"]
  - verify: "docs"
- [ ] 3.2 rollout 核对单（文档化，执行属发版后运维）：vibe-zlyan 升级含本修复版本 → 按 `TASK_ADMISSION_V2_CUTOVER.md` 开启 admission v2 → zhiwen 任务活验（诊断 `workspaceSourceKind=archive`、任务页「传输仓库工作区 · N%」、workspace 物化成功）——补 v0.45.0 未完成的 boxlite 真机首验
  - requirements: ["sandbox-provider-port/archive-workspace-transfer-feeds-the-provisioning-progress-snapshot"]
  - surfaces: ["docs", "developer-workflow"]
  - verify: "docs"
