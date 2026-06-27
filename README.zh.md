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
├── api/            # @cap/api — NestJS 后端：本地账号/会话、任务、仓库、
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

私有化 / 自托管安装默认走已发布产物（需要 Docker + 主机上的 `docker.sock`）：

> **一键安装（预构建发布镜像）。** 公开宣传站点托管了一个 `install.sh`，你可以
> 把它管道给 shell。它会预检 Docker，委托 `quick-deploy.sh`，下载
> `docker-compose.prod.yml`，在 `CAP_VERSION` 未设置时解析最新 Release tag，并运行已发布的
> `ghcr.io/xeonice/cap-*:${CAP_VERSION}` 镜像。它**不会**克隆仓库、不会跑
> `make up`，也不会在本机源码构建：
>
> ```bash
> curl -fsSL https://<site-domain>/install.sh | sh
> ```
>
> `CAP_VERSION` 可以钉到某个 Release tag；未设置时，安装器会先解析最新 Release tag。
> macOS 默认使用 BoxLite sandbox provider，因此运行前需要设置 `CAP_SANDBOX_PROVIDER=boxlite` 以及
> `BOXLITE_ENDPOINT`、`BOXLITE_API_TOKEN`、`BOXLITE_IMAGE`；Linux 默认使用 AIO。
> 脚本以纯文本提供，你可以先读后跑；等价手动路径是
> `docker-compose.prod.yml` + 本地 `.env`，不是 `git clone && make up`。详情见公开站点和
> [自托管指南](docs/self-hosting.zh.md)。

> **让 Claude Code 帮你部署（推荐）。** 如果你装了 Claude Code，把下面这段提示词贴给它；它会读安装脚本、预检 Docker，并运行同一条发布镜像路径：
>
> ```text
> 在这台机器上部署 cloud-agent-platform。先读取 https://<site-domain>/install.sh 和 https://<site-domain>/quick-deploy.sh，确认 Docker 与可用的 docker.sock 已就绪，然后运行发布镜像安装路径。不要 git clone，不要 make up，不要本地 build。默认使用最新 Release；如需固定版本我会设置 CAP_VERSION。macOS 使用 CAP_SANDBOX_PROVIDER=boxlite，并在运行前确认 BOXLITE_ENDPOINT、BOXLITE_API_TOKEN、BOXLITE_IMAGE 已设置；Linux 使用默认 AIO 路径。最后告诉我控制台地址、/version 返回值，以及脚本打印的 Authorization: Bearer 令牌。
> ```
>
> Claude Code 会照着可读脚本执行，你全程可以接管。

如果你是在已克隆仓库里做本地源码开发，再使用平台感知的 make target：

```bash
make up          # 自动选择 sandbox provider（macOS→BoxLite，Linux→AIO），
                 # 引导生成 apps/api/.env、等待 /health 并打印本地认证令牌
make up-aio      # 强制 AIO 完整栈（含 cap-aio-sandbox 镜像）
make up-boxlite  # 强制 BoxLite endpoint-backed 栈（api + postgres）
make up-cp       # 仅控制面 (api + postgres)，无 sandbox provider
make down      # 停止整套栈（保留 pgdata / workspaces 卷）
make down-v    # 停止并删除卷（破坏性操作 —— 本地数据丢失）
```

`make up` **仅在 `apps/api/.env` 尚不存在时**才生成它（已有的真实本地 env
会被原样复用）。生成的 env 用随机密钥启用了 **legacy 操作者令牌**路径，因此你在
本地用打印出的 `Authorization: Bearer <token>` 认证 —— 本地开发无需 GitHub OAuth
应用。自托管控制台使用本地账号（默认管理员 + 可选密码/邮箱验证码账号）；生成的
legacy env 已被 gitignore，绝不提交。

注意：

- 每任务的沙箱镜像（`cap-aio-sandbox:pinned`）**仅用于构建** —— 实际的
  `cap-aio-<taskId>` 沙箱会在你创建任务时按任务即时配置。
- macOS `make up` 默认使用 BoxLite。CAP 尚不内置 BoxLite daemon；运行前请设置
  `BOXLITE_ENDPOINT`、`BOXLITE_API_TOKEN` 和 `BOXLITE_IMAGE` 指向你的 BoxLite 控制面。
- `api` 和可选 `web` 主机端口默认监听 `0.0.0.0`。公开暴露前请自行配置 DNS、TLS、
  反向代理、cookie 作用域和防火墙。
- **网页控制台现在随 compose 栈一起发布**（一个 `web` Node 服务，端口 3000），
  因此 `docker compose up` 会把 web + api + Postgres 一起拉起；本地开发时你
  仍可独立运行它（`pnpm --filter @cap/web dev`）。

要进行真正的**生产自托管**（通过 `docker compose up` 拉起完整的 web + api +
Postgres 栈、本地账号登录、PAT 仓库访问，以及公网域名 / cookie 作用域配置），
参见[自托管指南](docs/self-hosting.zh.md)。

## 鉴权与主机 root 边界

该平台**通过 `docker.sock` 以主机 root 身份**运行任务。因此
**「谁能登录」就等于「谁能在主机上以 root 运行」** —— 所以控制台鉴权是一道
承重的安全边界，而非便利层。

鉴权基于**本地账号**：

- 自托管会种下默认管理员账号；管理员可继续创建密码账号或邮箱验证码账号。
- **处处 fail-closed：** 禁用账号、过期/吊销 session、无效机器凭据都会在进入受保护
  handler 前被拒绝。账号启用状态会在请求时重新确认，因此禁用操作者会立即生效。
- **仓库访问与控制台登录分离：** GitHub/GitLab/Gitee 仓库导入和 push/PR 流程使用
  每账号 forge PAT 凭据，不依赖 GitHub OAuth 或 GitHub App。
- **应急通道（break-glass）：** legacy 的单一共享 `AUTH_TOKEN` 操作者路径位于
  `AUTH_TOKEN_LEGACY_ENABLED` 之后，且**默认关闭** —— 只有显式的真值
  （`true`/`1`/`yes`）才会重新启用它。

## 部署拓扑（跨域）

网页控制台（Vercel）与 api（Fly / docker-compose 主机）运行在**不同的源
(origin)** 上。web 通过 `VITE_API_BASE_URL` / `VITE_WS_URL` 指向 api。会话
cookie 以 `credentials: include` 跨域发送，api 必须把 web 源加入 CORS 白名单。
终端 WebSocket 用一个 bearer 子协议（`bearer.<token>`）认证，它同样能跨域工作。
关于当前 REST/WS 鉴权姿态，参见 `apps/web/README.md`。
