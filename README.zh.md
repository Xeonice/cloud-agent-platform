# cloud-agent-platform

> English version: [README.md](README.md)

一个可自托管的控制面，驱动真实的交互式 Codex CLI，并把它字节级一致的终端
流式传输到浏览器。该平台在主机上的容器里运行每个任务，并通过网页控制台暴露
任务启动、实时工作台/终端、仓库导入、历史/审计、指标与设置。

> **先说安全：** 后端通过 Docker socket（`docker.sock`）以主机 root 身份运行任务。
> 因此控制台访问权等同于一项主机 root 权限。部署前请先阅读
> [鉴权与主机 root 边界](#鉴权与主机-root-边界)。

## monorepo 布局

这是一个 pnpm + Turborepo 工作区。

```
apps/
├── web/            # @cap/web — TanStack Start 控制台 (Vite + Nitro)，部署到 Vercel
├── api/            # @cap/api — NestJS 后端：OAuth/会话/白名单、任务、仓库、
│                   #   指标、审计/历史、设置、GitHub 导入、终端 WS 网关
├── runner/         # 任务 runner
└── sandbox-hooks/  # 沙箱生命周期钩子
packages/
├── contracts/      # @cap/contracts — 共享的 Task/Repo/TaskStatus 类型、WS 帧、schema
└── ui/             # @cap/ui — 共享的 shadcn 派生组件 (Button/Card/Badge/Terminal)
docs/               # 面向贡献者的导览文档 (见 docs/repo-layout.md)
openspec/           # spec 内容：specs、changes、schema fork
```

关于 openspec / `.claude` 双桶模型，以及 change/spec 约定，参见
[`docs/repo-layout.md`](docs/repo-layout.md)。

## 网页控制台 (TanStack Start)

`apps/web` 已从 Next.js 重建为 **TanStack Start** —— 原生 Vite（无
Vinxi），采用 **Nitro** 服务端构建，并**通过 Nitro 的 `vercel` 预设部署到
Vercel**（旧的 Next 形态 `vercel.json` 已移除）。它在 shadcn/ui + Tailwind v4
上复刻了全部 10 个设计页面（landing、login、workspace、resume、dashboard、
repositories、settings、history、create-task、session）。

应用层面的细节（数据访问接缝、capability flag、跨域契约）参见
[`apps/web/README.md`](apps/web/README.md)。

## 命令

Node/pnpm 由工作区统一管理（pnpm 10，Node ≥ 22）。请在仓库根目录运行。

| 任务 | 命令 |
| --- | --- |
| 安装 | `pnpm install` |
| 校验所有内容 | `pnpm verify` (= `turbo typecheck lint build`) |
| Web 开发服务器 | `pnpm --filter @cap/web dev` (端口 3000) |
| Web 生产构建 | `pnpm --filter @cap/web build` |
| Web 类型检查 | `pnpm --filter @cap/web typecheck` |
| Web 单元测试 | `pnpm --filter @cap/web test` |
| 构建全部 | `turbo build` |
| 类型检查全部 | `turbo typecheck` |
| Lint 全部 | `turbo lint` |

## 本地一键启动

一个全新克隆的仓库，只需一条命令即可从零变为一个可运行、**可登录**的后端
（需要 Docker + 主机上的 `docker.sock`）：

> **一键安装（封装 `make up`）。** 公开的宣传站点托管了一个 `install.sh`，你可以
> 把它管道给 shell —— 它会预检 Docker、克隆本仓库、替你运行 `make up`，然后呈现
> 打印出的 Bearer 令牌：
>
> ```bash
> curl -fsSL https://<site-domain>/install.sh | sh
> ```
>
> 它是一层薄封装，而非替代品：**下文的 `make up` 仍是事实来源**，且脚本以纯文本
> 提供，你可以先读后跑（站点同样给出等价的手动 `git clone … && make up` 路径）。
> 在 Apple Silicon 上它默认使用更快的 `make up-cp`。详情见公开站点和
> [自托管指南](docs/self-hosting.zh.md)。

> **让 Claude Code 帮你部署（推荐）。** 如果你装了 Claude Code，把下面这段提示词贴给它，它会读安装脚本、预检 Docker、克隆本仓库跑 `make up`，并引导你完成 GitHub OAuth：
>
> ```text
> 在这台机器上部署 cloud-agent-platform。先读取 https://<site-domain>/install.sh 安装脚本，确认 Docker 与可用的 docker.sock 已就绪。然后克隆 https://github.com/<owner>/cloud-agent-platform，进入目录运行 `make up` 构建并启动整套栈。帮我创建 GitHub OAuth 应用并填好 .env，以便用白名单做生产登录；最后告诉我控制台地址和它打印的 Authorization: Bearer 令牌。
> ```
>
> 它同样只是对 `make up` 的封装而非替代 —— Claude Code 会照着可读的 `install.sh` 执行，你全程可以接管。

```bash
make up        # 引导生成 apps/api/.env（若不存在）+ 构建并启动整套栈，
               # 然后等待 /health 并打印本地认证令牌
make up-cp     # 仅控制面 (api + postgres) —— 跳过沉重的 amd64
               # 沙箱镜像构建；在 Apple Silicon 上很快
make down      # 停止整套栈（保留 pgdata / workspaces 卷）
make down-v    # 停止并删除卷（破坏性操作 —— 本地数据丢失）
```

`make up` **仅在 `apps/api/.env` 尚不存在时**才生成它（已有的真实本地 env
会被原样复用）。生成的 env 用随机密钥启用了 **legacy 操作者令牌**路径，因此你在
本地用打印出的 `Authorization: Bearer <token>` 认证 —— 本地开发无需 GitHub OAuth
应用。生产环境保持 OAuth 优先 / fail-closed；生成的 legacy env 已被 gitignore，
绝不提交。

注意：

- 每任务的沙箱镜像（`cap-aio-sandbox:pinned`）**仅用于构建** —— 实际的
  `cap-aio-<taskId>` 沙箱会在你创建任务时按任务即时配置。
- 在 Apple Silicon 上，`amd64` 的 AIO 基础镜像首次运行会在模拟下构建
  （慢，之后会缓存）；用 `make up-cp` 做仅控制面的快速拉起。
- **网页控制台现在随 compose 栈一起发布**（一个 `web` Node 服务，端口 3000），
  因此 `docker compose up` 会把 web + api + Postgres 一起拉起；本地开发时你
  仍可独立运行它（`pnpm --filter @cap/web dev`）。

要进行真正的、OAuth 优先的**生产自托管**（通过 `docker compose up` 拉起完整的
web + api + Postgres 栈、GitHub OAuth 应用、白名单，以及公网域名 / cookie 作用域
配置），参见[自托管指南](docs/self-hosting.zh.md)。

## 鉴权与主机 root 边界

该平台**通过 `docker.sock` 以主机 root 身份**运行任务。因此
**「谁能登录」就等于「谁能在主机上以 root 运行」** —— 所以控制台鉴权是一道
承重的安全边界，而非便利层。

鉴权是**由硬白名单把关的多用户 GitHub OAuth**：

- **白名单以不可变的数字 GitHub `id` 为键**，绝不用可变的 `login`
  （被改名/重建的 GitHub 账号无法冒充白名单内的操作者；`login` 仅用于展示）。
  见 `apps/api/src/auth/allowlist.ts`。
- **处处 fail-closed：** 空的/缺失的/无法解析的白名单会拒绝所有访问；缺少
  OAuth 凭据或会话密钥则拒绝运行该流程（不会回退到未认证或共享令牌登录）。
  白名单成员资格会**在请求时重新确认**，因此把某操作者移出白名单会立即生效。
  见 `apps/api/src/auth/oauth-config.ts` 与 `auth.guard.ts`。
- **应急通道（break-glass）：** legacy 的单一共享 `AUTH_TOKEN` 操作者路径位于
  `AUTH_TOKEN_LEGACY_ENABLED` 之后，且**默认关闭** —— 只有显式的真值
  （`true`/`1`/`yes`）才会重新启用它。

一个成功通过认证、但不在白名单上的 GitHub 用户会被拒绝访问控制台，且无法触及
任何运行任务的界面。

## 部署拓扑（跨域）

网页控制台（Vercel）与 api（Fly / docker-compose 主机）运行在**不同的源
(origin)** 上。web 通过 `VITE_API_BASE_URL` / `VITE_WS_URL` 指向 api。会话
cookie 以 `credentials: include` 跨域发送，api 必须把 web 源加入 CORS 白名单。
终端 WebSocket 用一个 bearer 子协议（`bearer.<token>`）认证，它同样能跨域工作。
关于 OAuth 会话迁移期间当前的 REST/WS 鉴权姿态，参见 `apps/web/README.md`。
