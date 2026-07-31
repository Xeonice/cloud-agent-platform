# 工件 01 — 上下文地图（contexts manifest）

机器可读版：`contexts-manifest.json`（唯一声明源，本文档是散文注释）。
消费者：layout-check v2（阶段 3 报告 / 阶段 6 拦截）、阶段 6 目录归拢。

## 一句话

`apps/api/src` 的 51 个平铺目录收敛为 **7 个上下文**（4 核心 + 2 支撑 + 1 通用），
每个上下文内部按 `interface → application → domain → store` 四层约束 import 方向。

## 分配总表

| 上下文 | 类型 | 目录数 | 聚合根 | 战术 DDD |
|---|---|---|---|---|
| task-execution | 核心 | 11 | Task | 全套（事件/仓储/聚合） |
| sandbox-provisioning | 核心 | 4 | SandboxRun、SandboxEnvironment | 全套 |
| agent-runtime | 核心 | 3 | 无（纯策略对象） | 不改造（现状正确） |
| delivery | 核心 | 3 | Repo | 仓储 |
| identity-access | 支撑 | 8 | User | 仅仓储 |
| interface | 支撑 | 10 | 无（协议/投影层） | 不适用 |
| platform-ops | 通用 | 12 | 无 | **豁免**（决策 7） |

51 个目录全部有归属，`pendingDecisions` 为空。

## 边缘裁定留痕

- **creds → task-execution**：不是 Identity。它是会话级临时凭据，铸造/销毁跟随
  任务会话生命周期，消费方是 tasks lifecycle 与 guardrails（creds.module.ts 自述）。
- **write-lock → interface**：终端单写者锁的帧协议，不是任务不变量。
- **task-provisioning-diagnostics → sandbox-provisioning**：名字带 task-，但
  通用语言是"开通证据/诊断"，与 provisioning 同域。
- **scheduled-tasks → task-execution**：调度是任务的产生方式之一，同一通用语言。
- **prisma / crypto / observability → platform-ops 但作为共享内核豁免跨上下文规则**：
  prisma fan-in 127，物理上不可能也不应该被上下文规则约束。
- **guardrails → task-execution**（决策 8）：阶段 4 拆解后，编排残余是该上下文的
  application 层，不是独立上下文。
- **inline-admission → task-execution**：保持目录级可删除性（退役 = rm -rf），
  阶段 6 归拢时它可以物理进入上下文目录，但内部结构不动。

## 层规则（layout v2 的生成依据）

```
interface    controller / gateway / resolver —— 协议翻译，禁止直接 Prisma
application  service —— 编排、事务边界的开启者
domain       纯领域对象 —— 零框架依赖（无 Nest 装饰器、无 Prisma import）
store        *.store.ts —— Prisma 的唯一栖息地
```

方向：只允许左 → 右。violation 分级：阶段 3 起报告 + ratchet，阶段 6 转 required。

## 与目录归拢（阶段 6）的关系

manifest 的 `directories` 数组在阶段 6 之前描述**现状归属**，阶段 6 之后描述
**物理目录**。归拢时目标形态为一个上下文一个顶层目录（51 → 7–10：7 个上下文
+ inline-admission 保持独立可删 + 可能的 shared-kernel 目录），manifest 同一
change 内同步更新——manifest 与磁盘不一致即 layout v2 红。
