# 任务准备诊断运维指南

任务准备诊断以有界、无密钥的方式记录 CAP 在选择 provider、创建沙箱、物化工作区、
准备运行时、启动 agent 和协调清理时发生了什么。它补充任务状态、生命周期 audit 和
运行日志，但不替代这些信息源，也不成为新的 admission 权威。

功能默认关闭：诊断写入有独立开关；读取与新建带 `tasks:diagnostics` scope 的凭据共用
一个全部署能力门禁。

## 契约与保留边界

当前存储与 wire 契约为 `schemaVersion = 1`。

| 边界 | 数值 | 含义 |
| --- | ---: | --- |
| 每个 attempt 的事件数 | 64 | 一个逻辑操作最多保留一个 start 和一个 terminal/degraded 事件；poll tick、attach frame 和输出 chunk 不逐条落事件。 |
| 每次响应的详细 attempt 数 | 8 | 更早的终态明细可折叠进类型化的 `compaction` 摘要。 |
| 默认事件页 | 50 | 省略 `limit` 时使用。 |
| 最大事件页 | 200 | 超过该值会校验失败。 |

同一任务的 attempt 单调编号。CAP 生成的 `attemptId`、`eventId`、`operationId` 用于关联
持久记录和结构化 stdout；绝不使用 provider 原生 sandbox/execution id 做关联。
事件序列与 operation-phase 幂等键保证重试和 replay 不重复写入。

诊断明细跟随所属 task 的保留边界，API 重启和日志轮转不会删除它；它不会逐事件复制到
生命周期 audit。删除 task 或执行明确的 task-retention 策略时，剩余 ledger 才按同一
归属边界删除。紧急回滚保留增量表，不执行破坏性的 down migration。

## Coverage 词汇

`coverage` 表示证据质量，不表示任务成功或失败。

| Coverage | 运维含义 |
| --- | --- |
| `not_started` | 工作已接受或排队，但尚未打开准备 attempt；事件为空是正常情况。 |
| `partial` | 已有部分证据，但存在写入失败、序列或生命周期不完整、attempt 中断、明细截断/压缩、不支持的事件版本，或 cleanup 仍 pending；不能推断缺失事实。 |
| `complete` | 终态 attempt 已写入显式持久 completeness marker，operation/sequence 不变量成立，且 cleanup 不为 pending。仅仅“没看到 gap”不能证明 complete。 |
| `unavailable` | task 早于诊断 expectation/ledger，或无法建立可信覆盖；CAP 不会从日志或 audit 文本伪造诊断。 |

attempt 的 `state`（`active`、`succeeded`、`failed`、`cancelled`、`interrupted`）和
`primary` 描述准备主流程；独立的 `cleanup.state`（`not_required`、`pending`、
`succeeded`、`failed`）描述物理清理和持久权威。cleanup 失败不会覆盖运行时或工作区的
primary failure。

`channel` 把 `primary`、`cleanup` 和编排 `coordination` 分开。对 durable attempt 而言，
`cleanup = pending` 表示清理 owner、lease 和并发 slot 必须继续保持权威，直到确认资源
不存在/已删除，或 terminal cleanup policy 完成结算。

## 安全字段与禁止字段

诊断 envelope 是严格的 discriminated union，只允许：

- 版本化 CAP 身份与顺序：`schemaVersion`、`taskId`、`attemptId`、attempt 编号、
  `eventId`、`operationId`、幂等键、sequence 和 observed time。
- 封闭分类：admission mode、provider family、stage、operation、channel、command kind、
  outcome、安全 cause、native state、anomaly 和 HTTP status class。
- 有界事实：duration、timeout、可空的数字 exit code、retryable。

严禁保存 command/argv、cwd 或任何文件/凭据路径、prompt、stdout/stderr/output、环境或
配置 dump、原始 error message/cause/stack、请求/响应 body、HTTP/WS header、token、
带凭据 URL、endpoint/connection URL、lease owner、账号或仓库身份，以及 provider 原生
sandbox/resource/execution id。

已有的内部沙箱所有权列可以保留 fenced cleanup 必需的精确 provider resource id；这个
例外不扩展到诊断数据库、stdout envelope、metrics、REST、MCP、OpenAPI、Playground 或
Console。严格 schema 会在持久化和日志输出前拒绝未知字段；logger redaction 只是第二层
防御，不是接受不安全对象的理由。

## 权限与传输行为

普通 task create/list/get/stop 响应保持不变，绝不嵌入诊断 ledger。

- Public V1：`GET /v1/tasks/{id}/provisioning-diagnostics` 要求 API key 绑定账号、携带
  `tasks:diagnostics`，并且账号拥有该 task；Public V1 没有管理员例外。
- MCP：`get_task_provisioning_diagnostics` 要求同样的显式 scope 和 owner。
  `structuredContent` 是 canonical response 对象，text content 是同一个值的 JSON
  序列化；operation registry 声明 REST/MCP 没有语义差异。
- Console：`GET /tasks/{id}/provisioning-diagnostics` 只接受已认证的人类 session。
  member 只能读自己的 task；每次请求都从实时 User 行重新确认的 enabled admin，可以读
  跨 owner 和 ownerless 的历史 task。

identity-less principal 不能调用 Public V1/MCP 诊断操作；ownerless task 在这两个传输上
按不枚举的 not-found 处理。`tasks:read` 不隐含 `tasks:diagnostics`，旧凭据也不会自动得到
新增 scope。

REST 与 MCP 都接受 `id`、可选 `limit` 和不透明的 `cursor`。使用 `nextCursor` 继续翻页，
直到它为 `null`；集成方不得解析或自行构造 cursor。

## 部署门禁与分阶段启用

诊断写入独立于 admission-v2：

```dotenv
CAP_TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED=false
```

读取和新增诊断 scope 凭据要求每个 API serving instance 同时配置：

```dotenv
CAP_TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED=false
CAP_TASK_PROVISIONING_DIAGNOSTICS_ATTESTATION_JSON=
```

attestation 由部署控制器提供且带过期时间。`expectedWorkers` 必须包含所有 API/MCP/Web
serving role；每个预期的 instance-role 组合都必须报告以下五项兼容能力：

- `task-provisioning-diagnostics-schema-v1`
- `task-provisioning-diagnostics-owner-required-v1`
- `task-provisioning-diagnostics-scope-parser-v1`
- `task-provisioning-diagnostics-registry-v1`
- `task-provisioning-diagnostics-wire-fixture-v1`

所有 report 必须 ready、未过期、属于预期成员，并使用同一 build identity。API 进程的
instance id 必须等于 `CAP_INSTANCE_ID`（或运行时 hostname fallback），build identity 必须
等于 `GIT_SHA` 或 `CAP_VERSION`。无效、缺失、未来生效、已过期、混合 build、不完整或
意外成员的证据都会关闭门禁。关闭时读取返回可重试的
`task_provisioning_diagnostics_unavailable`，不返回数据库证据；请求
`tasks:diagnostics` 的 API key/MCP token 铸造也会被拒绝。

按以下顺序发布：

1. 应用增量 migration，部署 schema/reader 代码，保持写入和读取关闭；普通 task、API、
   MCP 路径必须继续健康。
2. 向所有 serving role 部署兼容的 sandbox-core/providers、Guardrails/admission、logger、
   metrics、API/MCP 和 Web。执行 migration、provider conformance、wire compatibility、
   public-surface 和 secret-canary 门禁。
3. 只开启写入。在适用的两种 admission mode 中验证一次成功、代表性受控失败、cleanup
   失败和 create request 断连；检查记录有界、事件可关联、secret 匹配为零。
4. 生成完整且新鲜的 attestation，开启读取，确认 REST、MCP、Console、OpenAPI、
   Playground 一致。只有此后才允许铸造带 `tasks:diagnostics` 的凭据。
5. admission-v2 使用自己的 attestation 与权威独立发布。调整诊断门禁不得启用、关闭或
   绕过 `TaskAdmissionWork`、durable lease 或 SandboxRun ownership。

## 凭据授权时机

`tasks:diagnostics` 是显式 opt-in，不在新 API key/MCP token 的默认 scope 中。只有完整
部署的 read gate 已确认打开后，才能把它授予可信诊断客户端；该客户端还必须具有正确的
task owner 身份。如需普通 task 读取，仍要单独授予 `tasks:read`。

原始 `cap_sk_` 或 `mcp_` 值只展示一次。应在 CAP 外记录 owner、用途与有效期，但不得把
诊断输出或凭据复制进日志。撤销继续通过 Settings 的 API Keys/MCP Server 操作完成，并在
下一次凭据解析时生效。

## 运维排查流程

1. 先读普通 task，记录 status 和安全的 provisioning stage；不要因为状态为 `creating`
   就假设 provider 尚未执行。
2. 使用 Console 面板、Public V1 endpoint 或 MCP tool，并提供 owner 与显式诊断 scope。
   若门禁返回 unavailable，应修复部署兼容性，而不是绕过门禁读取数据库或 provider 原始
   输出。
3. 先看顶层 `coverage` 和 `admissionState`。`not_started` 可识别 queued/unclaimed；
   `partial` 会限制后续所有结论。
4. 按单调 attempt number 检查 attempt，先比较终态 `primary` 与独立 `cleanup` 摘要，再看
   具体事件。
5. 沿 `operationId` 从一个 `started` 跟到唯一 terminal/degraded 事件。使用 `stage`、
   `operation`、`outcome`、安全 `cause`、`retryable`、`exitCode` 与 anomaly；不要寻找原始
   command output。
6. 如果短期日志仍存在，用 `eventId`、`attemptId`、`operationId` 关联结构化
   `task_provisioning_diagnostic_event`；不需要按时间或自由文本猜测。
7. 用 `GET /metrics` 判断全局模式和 cleanup 压力，再用 task ledger 判断单个事件。
   生命周期 audit 仍负责产品里程碑，而非 provider operation 明细。

## Metrics 解读

session 鉴权 metrics 响应中可选的 `provisioningDiagnostics` block 保持低基数：

- `observedSince` 是进程窗口计数器的起点；重启后不能把这些 counter 当作 lifetime total。
- `attemptOutcomes`、`stageOutcomes`、`retries`、`cleanupOutcomes`、`anomalies` 只使用封闭的
  provider/stage/outcome/cause tuple 与有界 count/sum/max duration，不带 task/resource label。
- `durableGauges` 从持久状态重建：`available` 表示新鲜，`stale` 携带最后样本和 age，
  `unavailable` 使用 `null` 而不是伪造 0。应组合观察 `activeAttempts`、
  `oldestActiveAttemptAgeMs`、`cleanupPendingRuns`、`confirmedOrphanRuns`。

该 block 降级不会改写既有 capacity、occupancy、runner-minute 与 sampled-resource block 的
可用性语义。

## 先关门禁的回滚与撤销

必须按以下顺序回滚：

1. 在所有实例设置 `CAP_TASK_PROVISIONING_DIAGNOSTICS_READS_ENABLED=false`（或撤回/让
   attestation 过期），确认 REST/MCP/Console 读取和新增诊断 scope 授权 fail closed。
2. 在部署任何不认识该 scope 的旧版本前，撤销所有携带 `tasks:diagnostics` 的 API key 和
   MCP token。
3. 设置 `CAP_TASK_PROVISIONING_DIAGNOSTICS_WRITES_ENABLED=false`，等待已进入边界的准备流程
   完成；不能为了加速回滚而改变 admission-v2 ownership 或释放 durable slot。
4. 确认普通 task 路径健康后再回滚应用组件；保留增量诊断表和记录，交给后续清理版本处理。

这个顺序可防止混合部署读取证据，或向旧进程无法安全识别的 scope 继续授权。
