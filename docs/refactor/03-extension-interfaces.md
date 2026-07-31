# 工件 03 — 扩展轴接口定稿

三条扩展轴（provider / runtime / 自定义镜像）的目标接口形状与词表归属。
消费者：阶段 2 全部 change、阶段 7a。

统一验收标准：**新增一个扩展 = 1 声明 + 1 注册 + N 行数据，零代码分支。**

## A. 词表三分类规则（D14 判例的推广）

| 类别 | 特征 | 归属 | 守护 |
|---|---|---|---|
| 线协议词表 | 封闭、需 zod 校验、api↔web 共用 | contracts 单一声明 | contracts-shared/executed 闸门 |
| provider port 词表 | 开放、第三方可扩展、零依赖前提 | sandbox-core 保留副本 | vocabulary-parity 闸门（D14 运行时层） |
| 操作员配置词表 | 成员集是运营决策，≠ family 本身 | 使用点独立声明 | **覆盖对账闸门**（新增，见 B.2） |

任何新词表必须先归类再落位；归错类按规则登记制（工件 04）的元规则处理。

## B. 轴 A — sandbox provider

### B.1 SandboxProviderPlugin 接口（阶段 7a 落地）

```ts
interface SandboxProviderPlugin {
  family: SandboxProviderFamily;                    // 来自 contracts 唯一词表
  envSchema: ZodSchema;                             // 自己的 CAP_* 配置声明
  createDescriptor(config): SandboxProviderDescriptor;  // 现有工厂原样接入
  environmentSourceKinds: readonly SourceKind[];    // 轴C交叉点：接受哪些镜像 source
  validateEnvironment(source): Promise<ValidationReport>; // 镜像校验收进 provider 端口
  deploymentBehavior: DeploymentBehaviorSpec;       // 收编 deployment-environment 的 6 处分支
}
```

host-harness 只做"遍历注册的 plugin"；`createConfiguredSandboxProvider` 的
三段 if 消灭。前端 `IMAGE_PROVIDERS`（含 Dockerfile 模板）从 plugin 元数据派生。

### B.2 操作员配置词表修法（阶段 2，决策 2）

`host-harness/config.ts` 的 `ConfiguredSandboxProviderFamily` **保留独立声明**
（D14：它是操作员配置取值，非 family），修法：

1. 显式补 `'cloud-http'` 成员（修"物理无法显式选中"的真缺陷）；
2. `providerFamilyAllowsAio/BoxLite/CloudHttp` 三函数改一张全量
   `Record<ConfiguredFamily, readonly SandboxProviderFamily[]>` 表；
3. 新增覆盖对账闸门：断言 操作员词表 ⊇ {可显式选中的 families} ∪ {'auto','control-plane'}，
   模板 = `provider-contract-parity-check.mjs`。
4. 同类第五份词表 `provider-terminal-story.ts` 的 `'auto'|'aio'|'boxlite'`
   纳入同一闸门。

### B.3 信任边界声明（交叉验证采纳，随接口定稿）

双层承诺，写进 plugin 接口文档与 conformance 套件引言：

- **fork 级（进程内 plugin）**：源码级扩展，与平台同进程、同信任域。插件面
  携带 secret-writer 与 docker.sock 级能力——**仅限自部署者 fork 使用**，
  平台不承诺加载第三方进程内插件（root+docker.sock 已被 spike 否决）。
- **CSPP 协议级（cloud-http）**：第三方扩展的唯一通道。跨信任域，secret 不出
  控制面（http-cloud-provider 现有的两处硬拒绝保持）；协议需版本握手与
  capability 自描述端点（现状是 operator 通过 env 他描述，升级为协议自描述
  作为阶段 2 cloud-http change 的附带项）。

### B.4 cloud-http 参考控制面服务端（阶段 2 配套）

协议承诺通电：README 散文的 7 端点落成最小参考实现（可为独立测试服务或
examples/ 下的可运行样例），conformance 套件对打真 HTTP 而非手写 stub。
这是"解锁显式选中"的前置——不能解锁一个从未通电的通道。

## C. 轴 B — agent runtime

### C.1 RUNTIME_METADATA 全量表（阶段 2）

contracts 新增：

```ts
const RUNTIME_METADATA: Record<AgentRuntimeId, {
  label: string;          // 替 task-failure.ts:80/94/226 三元、runtime-credential-alert
  cliPreview: string;     // 替 new-task-dialog:271 三元
  credentialKind: 'oauth-device' | 'token' | ...;  // 驱动 runtime-credentials.tsx 集合渲染
}>
```

全量 Record + 编译期强制（模板 = `agent-runtime-registration.typecheck.ts` 的
`@ts-expect-error` 夹具）。web/api 双端同源 import。

### C.2 收敛与派发（阶段 2）

- `RuntimeArtifactChecksumsSchema` → `z.record(RuntimeSchema, Sha256ChecksumSchema)`
  （消灭轴 B×C 交叉的唯一物理 reject）。
- `runtime-model-adapter-snapshot.ts:6` 残存手写 union → 改契约类型（交叉验证发现）。
- `TranscriptReadStrategy` 从单成员断言（`assertSingleNewestJsonlSupported` 大声
  抛错）升级为真派发架子；第二成员随 opencode 接入落地。
- tmux 会话协议双声明去重：删 `apps/api/src/agent-runtime/codex-launch.ts`
  副本，api 改 import `@cap-console/sandbox` 的 `session-commands.ts`。
- SKILL_CATALOG：skill id 词表上移 contracts，web 目录数据与 api allowlist
  两端同源 import（消灭"MUST match"注释同步）。

### C.3 runtime-conformance 套件（阶段 2 骨架，opencode 接入的 checklist）

对标 sandbox-conformance 的 scenario family 结构：

| family | 内容 | 种子 |
|---|---|---|
| launch | launch line 逐字节形状、wrapper/prompt 注入 | codex-launch.test.mjs golden |
| lifecycle | exit 检测、DSR/自动提交策略、quiesce | agent-runtime.test.mjs |
| transcript | 格式解析、artifact 定位、read strategy | parse-transcript 测试 |
| headless | headless/resume argv | headless-execution.spec |
| **secret-canary** | 凭据注入一次性、进程列表/日志/transcript 零泄漏、销毁后不可读 | workspace-git-conformance 的 secretCanary 模式移植 |

participation 账本同 sandbox-conformance：runtime 声明的 executionModes/能力
反推必跑 family，覆盖 map 对词表 total（漏登记 = 编译错误）。

## D. 轴 C — 自定义镜像

- source-kind 唯一词表：`sandbox-environment.ts` 的
  `SandboxEnvironmentSourceKindSchema` 为唯一声明；`runtime-model.ts` 的
  `RuntimeExecutionEnvironmentSourceSchema` 改为派生。
- **前置兼容决策（阶段 2 轴 C change 内必须裁定）**：`provider-snapshot` 在
  `runtime-model-environment.resolver` 仍有活产生分支、`boxlite-rootfs` 仅剩
  历史快照消费——两者的处置（迁移语义 vs 显式保留为 legacy 词表成员）在删除前
  定案，不得直接删。
- `providerFamiliesForEnvironmentSource` 的 switch → 从 plugin 的
  `environmentSourceKinds` 派生（阶段 7a 完成闭环）。
- 参数注入机制（private-file 端口、0600、双形态 scrub）**不动**——它已是
  provider-agnostic 正面范例，新 provider 实现 private-file 端口即自动获得。
