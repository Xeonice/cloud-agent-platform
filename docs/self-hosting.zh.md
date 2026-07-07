# 自托管 cap

这是面向操作者的指南，教你用 `docker compose up` 搭起自己的 cap 实例。cap
自托管使用**本地账号登录**：栈会种下默认管理员，管理员可以继续创建密码账号或邮箱验证码账号。
仓库访问与控制台登录分离，通过每个账号自己的代码托管 PAT 配置。

> **先说安全须知。** cap 通过 Docker socket（`/var/run/docker.sock`）以**主机 root**
> 身份运行任务。因此「谁能登录」就等于「谁能在主机上以 root 身份运行」。账号访问
> 是一道承重的安全边界，而不是一层便利封装 —— 务必收紧。参见 README 的
> [鉴权与主机 root 边界](../README.zh.md#鉴权与主机-root-边界)。

本指南是 [OSS 自更新 epic](./oss-self-update-epic.md) 的 Phase 0（「陌生人也能跑起来」）：
一套完整、可用 env 配置、本地账号登录的 compose 栈。推荐安装路径运行已发布镜像；
源码构建仍保留给开发或自定义镜像工作，但一键安装和 agent 路径不应该 clone 仓库或运行
`make up`。

自定义任务基础镜像的创建和维护流程见
[`docs/sandbox-images.zh.md`](sandbox-images.zh.md)。

应用内升级是后续阶段，今天自托管并不需要它。

> **想在一台全新的本地主机上试试？** 公开宣传站托管了一个一键安装脚本，运行预构建
> 发布镜像运行包 —— 它会预检 Docker，委托 `quick-deploy.sh`，下载
> `docker-compose.prod.yml`，在 `CAP_VERSION` 未设置时解析最新 Release tag，拉取
> `ghcr.io/xeonice/cap-*:${CAP_VERSION}`，并把打印出的管理员邮箱和密码呈现给你。
> macOS 默认 BoxLite，Linux 默认 AIO；可用
> `CAP_SANDBOX_PROVIDER=aio|boxlite|control-plane` 覆盖。
>
> ```bash
> curl -fsSL https://<site-domain>/install.sh | sh
> ```
>
> 它只是面向**本地**试用的便利封装，而非完整生产域名配置：它会写本地账号 `.env`，
> DNS/TLS/反代/cookie 作用域仍由你配置。脚本以纯文本提供 —— 先读一遍，或使用等效的
> `docker-compose.prod.yml` + `.env` 手动路径。它不会 `git clone`、不会 `make up`、
> 也不会本地构建镜像。
>
> Docker 处理是保守的：如果 Docker CLI、Docker Compose 或 macOS 的 Colima formula
> 缺失，安装器会走当前主机支持的安装路径，并且只安装缺失的组件。macOS 只有在确实需要安装
> Docker/Compose 且 Homebrew 也不存在时，才会非交互 bootstrap Homebrew。如果 Docker
> 已安装且 `docker info` 可用，它不会动 Docker/Homebrew/Colima。如果 Docker 已安装但
> daemon/socket/context 不可达，它只做有界的安全启动尝试，然后带明确修复步骤失败；不会通过重装或升级 Docker 掩盖坏状态。
>
> api/web 主机端口默认监听 `0.0.0.0`。公共 DNS、TLS、反向代理、认证 callback、
> cookie 域与防火墙仍需由你在公开暴露前自行配置。

> **快速路径 —— 运行预构建镜像，无需 `git clone`。** 一旦有了某个 Release，
> 你根本不需要源码：从
> [Releases 页面](https://github.com/Xeonice/cloud-agent-platform/releases)下载
> `docker-compose.prod.yml` + `docker-compose.prod.env.example`，
> `cp docker-compose.prod.env.example .env`，填好它（下文第 1–5 节会讲解这些值），
> 然后 `docker compose -f docker-compose.prod.yml pull && docker compose
> -f docker-compose.prod.yml up -d api postgres`（要带上 compose 内置控制台就加 `web`，
> Linux/AIO 再带上 `aio-sandbox-image`）。这个无源码运行包正是构建/运行分离 ——
> 构建留在构建平台，运行就是这一个文件。详见：
> [从预构建镜像运行（无源码）](#或者免源码运行包无需-clone)。

> **让 Claude Code 帮你部署。** 装了 Claude Code 的话，把下面这段提示词贴给它；它会读
> `install.sh`/`quick-deploy.sh`、预检 Docker，并运行同一条发布镜像路径：
>
> ```text
> 在这台机器上部署 cloud-agent-platform。先读取 https://<site-domain>/install.sh 和 https://<site-domain>/quick-deploy.sh，确认 Docker 与可用的 docker.sock 已就绪，然后运行发布镜像安装路径。不要 git clone，不要 make up，不要本地 build。默认使用最新 Release；如需固定版本我会设置 CAP_VERSION。macOS 使用 CAP_SANDBOX_PROVIDER=boxlite，并在运行前确认 BOXLITE_ENDPOINT、BOXLITE_API_TOKEN 已设置；不设置 BOXLITE_IMAGE 时使用匹配版本的 Release-asset rootfs，也可以设置 BOXLITE_IMAGE 强制走 registry 镜像模式。Linux 使用默认 AIO 路径。最后告诉我控制台地址、/version 返回值，以及脚本打印的管理员邮箱和密码。
> ```
>
> 脚本以纯文本提供、可先读后跑，你全程可接管。

## 这套栈会拉起什么

用 `web` profile（`COMPOSE_PROFILES=web`）启用 compose 内置控制台；
`api` + `postgres` 始终运行。

| 服务       | 角色                                                              |
| ---------- | ----------------------------------------------------------------- |
| `web`      | TanStack Start 控制台（Nitro `node-server`），主机端口 3000 —— **`web` profile** |
| `api`      | NestJS 编排器（本地会话、任务、WS），8080 |
| `postgres` | 支撑任务/审计/历史的数据库                          |

网页控制台**只通过 api 的公开 URL**（`VITE_API_BASE_URL`
/ `VITE_WS_URL`）与之通信。cap 为**跨域**拓扑而设计（web 与 api 位于不同源），
因此把 URL 和 cookie 作用域配对是整个搭建中最重要 —— 也最易出错 —— 的部分。请仔细阅读
[第 3 节](#3-配置你的公开域名易出错的一步)。

## 前置条件

- 一台可以运行 **Docker** + Docker Compose 的主机；如果使用 AIO，api 容器还需要可用的
  `/var/run/docker.sock`。
- 为网页控制台和 api 所用域名准备好公共 DNS / TLS
  （在 api 前用 Cloudflare 或 nginx 之类的反向代理终结 HTTPS —— 参见
  `docker-compose.yml` 中可选启用的 `proxy` profile）。Cookie 在跨域时以
  `Secure` 发送，因此生产环境中 api 必须可经 **HTTPS** 访问。
- 默认管理员的邮箱 / 初始密码规划，以及需要导入私有仓库时对应代码托管平台的 PAT。

### 发布镜像安装路径的依赖模型

一键 `install.sh` / `quick-deploy.sh` 路径按依赖发生的时间拆开处理：

- **安装期必需：** POSIX shell、`curl`、`bash`、`openssl`、`awk`、Docker
  Engine、Docker Compose v2、访问站点托管安装资产的网络、未设置 `CAP_VERSION`
  时访问 GitHub Release metadata 的网络，以及从 GHCR 拉取
  `ghcr.io/xeonice/cap-*:${CAP_VERSION}` 控制面镜像的网络。sandbox runtime
  镜像可以来自 GHCR，也可以来自 GitHub Release assets。脚本不会运行 `git clone`、
  `make up`、`docker build` 或 `docker compose up --build`。
- **Docker 行为：** Docker 缺失时才通过检测到的支持路径安装；如果只是 Compose plugin
  缺失，只补 Compose，不重装 Docker Engine；已有且可用的 Docker 保持不动；已安装但不可达的 Docker 被视作 daemon/socket/context 状态问题，在有界安全启动后失败并给出修复步骤。
- **BoxLite 宿主依赖：** 本机 BoxLite 控制面依赖宿主虚拟化能力，而不只是可安装包。
  macOS 需要 Apple Silicon、macOS 12.0+，并且 `kern.hv_support=1` 以启用
  Hypervisor.framework；Linux/WSL2 需要可读写的 `/dev/kvm`。这些能力不能由安装脚本补出来；
  缺失时脚本会在探测 BoxLite endpoint 前失败。如果 `BOXLITE_ENDPOINT` 指向外部
  BoxLite 宿主机，安装脚本会跳过本机 Hypervisor/KVM 检查，只验证 endpoint。
- **所选 provider 就绪：** Linux/AIO 在成功前会 staging
  `ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}`。macOS/BoxLite 需要
  `CAP_SANDBOX_PROVIDER=boxlite`、`BOXLITE_ENDPOINT`、`BOXLITE_API_TOKEN`。
  `CAP_SANDBOX_IMAGE_DELIVERY=auto|registry|release-assets` 控制 sandbox runtime
  来源。`auto` 下 BoxLite 会先尝试同版本 GitHub Release asset，并写入
  `BOXLITE_ROOTFS_PATH`；asset 不可用时回落到 `BOXLITE_IMAGE`。AIO 默认走 registry，
  只有显式 `release-assets` 时才下载并校验
  `cap-aio-sandbox-<version>-linux-amd64.docker.tar.zst`，然后 `docker load`。BoxLite
  `release-assets` 会下载并校验
  `cap-boxlite-sandbox-<version>-<platform>.oci.tar.zst`，解压到
  `CAP_SANDBOX_ASSET_DIR` 下，写入 `BOXLITE_ROOTFS_PATH`，清空 image env，并要求原生
  BoxLite 协议（`BOXLITE_PROTOCOL_MODE=native`、`BOXLITE_PATH_PREFIX=default`）。
  registry 模式才默认把 `BOXLITE_IMAGE` 写成同版本的
  `ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}`，除非你显式设置
  `BOXLITE_IMAGE` 或带 default 的 `BOXLITE_IMAGE_MAP`。就绪检查会验证
  endpoint/token，不带不兼容的 create-time 字段创建短生命周期 probe sandbox，通过原生
  BoxLite API 启动它，再确认 image、workspace 与 AIO sandbox runtime 对齐的工具集
  （默认 `bash`、`claude`、`codex`、`git`、`gzip`、`node`、`openspec`、
  `sh`、`tar`、`tmux`），然后删除 probe sandbox。只有在明确使用更窄的自定义
  runtime image 时才覆盖 `BOXLITE_RUNTIME_REQUIRED_TOOLS`。官方 BoxLite 镜像使用
  `/home/gem/workspace`，与 AIO runtime 的启动路径一致。
- **可选任务期依赖：** 导入/clone/push 私有仓库需要 forge PAT；邮箱验证码登录需要
  SMTP；生产公开需要 DNS/TLS/反代/cookie 作用域；不用内置数据库时需要外部 Postgres；
  特定 runtime 可能需要 `CLAUDE_CODE_OAUTH_TOKEN`；本地可选的
  `RUN_GITHUB_VALIDATION=1` 冒烟检查会读取 `GITHUB_VALIDATION_TOKEN` 或被忽略的
  `.env.github-validation`。

## 1. 配置本地账号登录

自托管控制台使用本地账号登录。无需 GitHub OAuth 应用、GitHub App、回调 URL 或 GitHub 白名单。

必要的鉴权相关环境变量：

```ini
SESSION_SECRET=<64 位以上随机字符串>
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=<初始管理员密码>
PASSWORD_AUTH_ENABLED=true
```

邮箱验证码登录需要 SMTP。未配置 SMTP 时，登录页不会展示验证码方式：

```ini
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=...
SMTP_FROM=noreply@example.com
```

管理员可以在控制台继续创建 / 禁用账号。账号启用状态会在每次 session / API key / MCP token
解析时重新确认，因此禁用账号会在下一次请求立即生效。

## 2. 用 PAT 连接仓库

控制台登录和仓库访问是两件事。要导入私有仓库，或让任务推分支 / 开 PR，每个操作者需要在控制台
**设置 -> 代码托管连接**里连接自己的 forge 凭据。

GitHub 使用 Personal Access Token：

- 细粒度 PAT：给目标仓库授予 Contents + Pull requests 写权限。
- 经典 PAT：私有仓库使用 `repo`，仅公开仓库可用 `public_repo`。

GitLab / Gitee 使用各自平台的 PAT，并可填写自托管实例地址。PAT 按账号保存，仅用于仓库列表、
导入、clone、push 和 PR/MR 操作。

## 3. 配置你的公开域名（易出错的一步）

大多数自托管失败都出在这里。cap 以 `credentials: include` **跨域**发送会话 cookie，
因此 web 源、api 的 CORS 白名单以及 **cookie 作用域**三者必须一致。挑选与你 DNS
匹配的拓扑。

### 这些变量

| 变量                    | 位置             | 含义                                                       |
| ----------------------- | ---------------- | ---------------------------------------------------------------- |
| `VITE_API_BASE_URL`     | `apps/web` 构建 | api 的 HTTP base URL，例如 `https://cap-api.example.com`     |
| `VITE_WS_URL`           | `apps/web` 构建 | api 的 WebSocket URL，例如 `wss://cap-api.example.com`       |
| `WEB_ORIGIN`            | `apps/api/.env`  | api 做 CORS 白名单、并在登录后重定向到的、以逗号分隔的 web 源 |
| `SESSION_COOKIE_DOMAIN` | `apps/api/.env`  | cookie 的 `Domain` 属性（见下）—— **最常见的错误** |

> **`VITE_*` 是构建期变量，被烘焙进镜像。** web 镜像是**域名专属**的：
> `VITE_API_BASE_URL` / `VITE_WS_URL` 在打包构建时由 Vite 读取，而非容器启动时。
> 把它们作为构建参数传入（`docker compose build` 会从你的 env 读取），并在更改 api
> 域名时重新构建 `web` 镜像。它们无法通过编辑运行中容器的 env 来更改。

### 拓扑 A —— 跨子域（推荐）

web 与 api 位于**同一个可注册域名下的兄弟子域** —— 例如 web 在
`cap.example.com`，api 在 `cap-api.example.com`。

```ini
# apps/api/.env
WEB_ORIGIN=https://cap.example.com
SESSION_COOKIE_DOMAIN=.example.com
```

```ini
# web 构建参数（例如 apps/web/.env，或为 `docker compose build` 准备的 shell env）
VITE_API_BASE_URL=https://cap-api.example.com
VITE_WS_URL=wss://cap-api.example.com
```

把 `SESSION_COOKIE_DOMAIN` 设为**可注册的父域**（`.example.com`），可以让 cookie
同时随浏览器对 web 源的顶层请求（这样在服务端拉取 api 的 SSR loader 才能收到它）
以及 api 自身的跨域读取一起发送。在这种模式下 api 以 `SameSite=None; Secure` 发出
cookie，因此 api 必须经 HTTPS 提供服务。

### 拓扑 B —— 跨站（例如 web 在 `*.vercel.app`）

web 与 api 位于**两个不同的可注册域名** —— 例如 web 在
`your-app.vercel.app`，api 在 `cap-api.example.com`。没有任何父域能桥接两个可注册
域名，因此**让 `SESSION_COOKIE_DOMAIN` 保持未设置**：

```ini
# apps/api/.env
WEB_ORIGIN=https://your-app.vercel.app
# SESSION_COOKIE_DOMAIN 有意不设 → host-only 的 SameSite=None cookie
```

cookie 是 host-only 的 `SameSite=None; Secure`（这是浏览器在跨可注册域名时唯一允许的
选项）。两个源都必须是 HTTPS。

### 拓扑 C —— 同源

api 也在同一个源上提供 web 应用。**让 `WEB_ORIGIN` 和
`SESSION_COOKIE_DOMAIN` 两者都保持未设置**：回调使用相对重定向，并使用默认的 host-only
`SameSite=Lax` cookie。

> **通配符 CORS 会被拒绝。** 因为请求携带凭据，api 必须回显一个**精确的**
> `Access-Control-Allow-Origin` —— `*` 通配符会被浏览器拒绝。`WEB_ORIGIN` 就是那份
> 精确的源列表。

## 4. 生成所需密钥

```ini
# apps/api/.env

# 给认证/session cookie 和不透明会话签名 —— 要长且随机。
SESSION_SECRET=...          # 生成方式：openssl rand -hex 32

# AES-256-GCM 密钥，用于在静态存储时加密兼容 provider 的 API 密钥。
# 64 位十六进制字符（32 字节），或 32 字节的 base64。
CODEX_CRED_ENC_KEY=...      # 生成方式：openssl rand -hex 32
```

两个一起生成：

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)"
echo "CODEX_CRED_ENC_KEY=$(openssl rand -hex 32)"
```

缺少 `SESSION_SECRET` 时登录流程会 fail-closed。请妥善保密这两个值并使其不进入版本控制——`apps/api/.env` 已被 gitignore。

## 5.（可选）指向外部数据库

默认情况下，整套栈自带一个 Postgres，api 使用 compose 内部连接（`postgresql://cap:cap@postgres:5432/cap?schema=public`）。若想改用外部 / 托管的 Postgres，请设置 `DATABASE_URL`：

```ini
# apps/api/.env
DATABASE_URL=postgresql://user:password@db.example.com:5432/cap?schema=public
```

不设置则保留内置的 Postgres 服务。这里没有写死任何维护者专属的值——每个部署值都由你自己设定。

## 6. 拉起整套栈

```bash
cp apps/api/.env.example apps/api/.env   # 然后填好 Steps 1–5 的内容

# 构建 web 镜像（把你的域名烤进去），然后启动全部服务。
# compose 内的控制台位于 `web` profile 之后 —— 在这里启用它：
COMPOSE_PROFILES=web docker compose up --build
```

这会构建 `web` 镜像（传入 `VITE_API_BASE_URL` / `VITE_WS_URL`）、`api`，并启动 Postgres。网页控制台发布在主机端口 **3000**（用 `WEB_HOST_PORT` 覆盖），api 在 **8080**（用 `API_HOST_PORT` 覆盖）。两者默认绑定 `0.0.0.0`；如需仅本机访问，可把 `WEB_HOST_BIND` 或 `API_HOST_BIND` 设为 `127.0.0.1`。

> `web` 服务位于 `web` compose profile 之后（与 `observability`/`grafana`/`proxy` 一样），所以你必须启用它（`COMPOSE_PROFILES=web`，或 `docker compose --profile web up`）。如果你在别处（例如 Vercel）提供控制台，就让该 profile 关着，compose 内的 web 服务永不会被构建或运行。

拉起后：

1. 打开网页控制台（你的 web origin）。
2. 使用第 1 节配置的默认管理员邮箱 / 密码登录。
3. 按需在 **账号管理**里创建更多本地账号；导入私有仓库前，在**设置 -> 代码托管连接**里连接 PAT。

如果登录被弹回，或 cookie 不生效，请重读 [第 3 节](#3-配置你的公开域名易出错的一步)——几乎每次都是 `WEB_ORIGIN`、`SESSION_COOKIE_DOMAIN` 与写死的 `VITE_API_BASE_URL` 三者不一致所致。

## 运行预构建镜像而非从源码构建

上面的源码 compose 流程会在你的主机上**从源码**构建 `api` / `web` / AIO-sandbox 镜像。安装 / 私有化部署请优先使用发布镜像：每个 GitHub Release 都会向 GHCR 发布一组**匹配的、版本钉死的**镜像（`ghcr.io/xeonice/cap-api`、`cap-web`、`cap-aio-sandbox`、`cap-boxlite-sandbox`，全都在同一个 `vX.Y.Z`）。同一个 Release 还会附带带 checksum 的 sandbox runtime assets，installer 可以在不走 registry 拉 sandbox 的情况下，从 GitHub Release assets staging AIO 或 BoxLite。之后你就可以**拉取**这组钉死的镜像而不必编译，方法是在基础 compose 之上叠加 `docker-compose.images.yml` **override**。

> **你仍然需要 Steps 1–5。** override 只改变镜像**来自哪里**（拉取 vs. 构建）。你的本地账号鉴权、域名、密钥以及（可选的）外部 DB 与上文完全一样配置——预构建镜像读取的是同一份 `apps/api/.env` 和同一套构建期 `VITE_*`（Release 已把它们烤进发布出来的 `cap-web`）。

把整套栈钉到某个已发布的 Release tag，并在**不带 `--build`** 的情况下拉起：

```bash
# 把 v1.2.3 换成你想运行的 Release tag。
export CAP_VERSION=v1.2.3

# 拉取这组匹配的镜像，然后启动。不要传 --build（那会从源码
# 重新构建，使 override 失效）。
COMPOSE_PROFILES=web \
  docker compose -f docker-compose.yml -f docker-compose.images.yml pull
COMPOSE_PROFILES=web \
  docker compose -f docker-compose.yml -f docker-compose.images.yml up -d
```

- **同一个版本。** `${CAP_VERSION}` 把 `cap-api`、`cap-web`、`cap-aio-sandbox`（每任务执行镜像）以及 `cap-boxlite-sandbox` 钉到同一个 tag，让你永远不会跑到不匹配的一组。它被刻意设为**必填**——不设 `CAP_VERSION` 会让 `docker compose config` 大声告警 / 失败，而不是悄悄解析成一个空 tag。请始终把它设为一个真实已发布的 Release tag。
- **sandbox runtime assets 也匹配版本。** Release 上的 `cap-image-assets.json` 和 AIO/BoxLite `.tar.zst` assets 带同一个版本与 checksum；`quick-deploy.sh` 和 self-update 会校验 checksum 后再 load/extract。
- **默认行为不变。** 去掉第二个 `-f docker-compose.images.yml`（即纯 `docker compose up --build`），你就回到从源码构建。该 override 纯属附加且需主动选用——它的存在不会改变从源码构建路径的任何方面。
- **确认你在跑什么。** 已发布的 `cap-api` 会在 `GET /version`（无需鉴权）自报其构建：`curl -s https://<api-origin>/version` 返回 `{ version, gitSha, buildTime }`——`version` 即 Release tag。

> 发布到 GHCR 的包是**公开的**（由 release workflow / 一次性的 owner 设置决定），所以 `docker compose pull` 无需 `docker login` 即可工作。关于受操作者把关的激活（把仓库 + 包设为公开、发出第一个 Release、把现有的 build-on-push 部署迁移到钉死的 Release），见 [`deploy/DEPLOY.md`](../deploy/DEPLOY.md)。

### 或者：免源码运行包（无需 clone）

上面的 override 仍然需要**源码树**（它叠加在 `docker-compose.yml` 之上），而单 compose 文件的平台（例如 Dokploy）无法叠加 `-f a -f b`。要做到干净的**构建 / 运行分离**——在**没有 `git clone`** 的情况下运行——请使用自包含的 **`docker-compose.prod.yml`**。它随每个 Release 与 `docker-compose.prod.env.example` 一同附带，**没有** `build:` 块、**没有**源码树 bind-mount，运行的是钉死的 `ghcr.io/xeonice/cap-*:${CAP_VERSION}` 这组镜像：

```bash
# 从 Releases 页面下载这两个文件（无需 clone），然后：
cp docker-compose.prod.env.example .env     # 鉴权/密钥/域名（Steps 1–5）；CAP_VERSION 可选（默认 latest）
COMPOSE_PROFILES=web docker compose -f docker-compose.prod.yml pull api postgres web
COMPOSE_PROFILES=web docker compose -f docker-compose.prod.yml up -d api postgres web
# Linux/AIO：两条命令都额外带上 aio-sandbox-image
```

- **版本：** `CAP_VERSION` 是**可选**的——不设则运行 `latest`（最新的 Release），所以一个裸的 `up -d` 就是一个常驻的「永远跑最新 release」栈。钉一个 tag（`CAP_VERSION=v0.1.0`）可获得可复现 / 可回滚的部署。
- **平台 / provider：** 发布镜像当前默认 `linux/amd64`，运行包会固定
  `platform: ${CAP_IMAGE_PLATFORM:-linux/amd64}`，因此 Apple Silicon Docker Desktop /
  Colima 会用模拟运行 api/web，而不是退回本地源码构建。macOS 使用
  `CAP_SANDBOX_PROVIDER=boxlite` + `BOXLITE_ENDPOINT`、`BOXLITE_API_TOKEN`，
  默认写入同版本官方 BoxLite 镜像，使用原生协议默认值，不要 staging
  `aio-sandbox-image`。Linux/AIO 需要 staging `aio-sandbox-image`，确保每任务 sandbox
  镜像在创建任务前已存在。同机 BoxLite 控制面必须通过上面的宿主虚拟化检查；
  如果嵌套 macOS VM 返回 `kern.hv_support=0`，它就不是有效的同机 BoxLite 目标。
  如果 BoxLite 跑在 Docker/Colima 同一台 Mac 宿主机上，
  API 容器的运行时地址使用 `BOXLITE_ENDPOINT=http://host.docker.internal:7331`，
  安装期宿主机探针使用 `BOXLITE_READINESS_ENDPOINT=http://127.0.0.1:7331`。
- **核心 + 可选的可观测性。** 它运行 api + Postgres（+ 可选的 `web` profile，+ 选择 AIO 时的镜像 staging），并且还附带一套需主动选用的可观测性栈（loki + alloy + grafana），其配置**内联**随附，以保持免源码。只有反向代理被排除（其 nginx 配置与源码耦合）——请用你自己的 TLS / 代理（Cloudflare Tunnel / Caddy / Traefik / nginx）来挡在 api（`:8080`）前面。
- **启动时启用可观测性**（默认：全都不运行）：
  ```bash
  # 日志（Loki+Alloy）；要 UI 就再加 ,grafana（回环 127.0.0.1:3001，用你的代理挡在前面）：
  COMPOSE_PROFILES=observability,grafana docker compose -f docker-compose.prod.yml up -d
  ```
  Grafana 的 Loki 面板开箱即用；Postgres-Audit 面板需要一次性的 `deploy/observability/grafana-ro-role.sql` + `GRAFANA_PG_*`/`GRAFANA_ADMIN_PASSWORD` env（见 `docker-compose.prod.env.example`）。需要 Docker Compose ≥ v2.23.1（内联 configs）。
- **单文件平台（Dokploy）：** 把应用的 compose 文件指向 `docker-compose.prod.yml`，并在其 Environment 中设置 env（`CAP_VERSION` 可选——默认 `latest`）；更新 = 重新部署（或抬升钉死的 `CAP_VERSION`）。
- **`web` 注意事项：** 预构建的 `cap-web` 在构建期烤入 `VITE_*`（默认指向 localhost），所以 compose 内的控制台只对同主机试用正确；要用真实域名，请在别处（例如 Vercel）提供控制台，或重新构建 `cap-web`。

### 或者：agent 一键（`scripts/quick-deploy.sh`）——预构建镜像

要一个**可由 agent 驱动**、**无需源码构建**的拉起方式，仓库提供了 `scripts/quick-deploy.sh`。它通过 `docker-compose.prod.yml` 运行预构建的 `ghcr.io/xeonice/cap-*:${CAP_VERSION}` 镜像，并为本地试用**合成或更新一份本地账号 `.env`**：

```bash
# 从一个 clone 运行（用仓库的 docker-compose.prod.yml），或在任意位置运行（它会自行抓取）：
CAP_VERSION=v0.24.0 scripts/quick-deploy.sh        # Linux/AIO localhost 试用，web 在 :3000
CAP_SANDBOX_PROVIDER=boxlite BOXLITE_ENDPOINT=... BOXLITE_API_TOKEN=... scripts/quick-deploy.sh
CAP_SANDBOX_PROVIDER=boxlite BOXLITE_ENDPOINT=http://host.docker.internal:7331 BOXLITE_READINESS_ENDPOINT=http://127.0.0.1:7331 BOXLITE_API_TOKEN=... scripts/quick-deploy.sh
CAP_SANDBOX_IMAGE_DELIVERY=release-assets CAP_SANDBOX_PROVIDER=aio scripts/quick-deploy.sh
WITH_WEB=0 scripts/quick-deploy.sh                 # 仅 api + postgres
CAP_SMOKE_REPO_ID=<id> CAP_SMOKE_COOKIE=<cap_session> RUN_SMOKE=1 scripts/quick-deploy.sh   # + 预置冒烟测试
CAP_HEALTH_TIMEOUT_SECONDS=600 scripts/quick-deploy.sh   # 慢速 Docker emulation / 嵌套 VM 启动
```

它以 fail-closed 的**关卡（gates）**方式运行：① 平台 / provider（auto 选择 macOS BoxLite、Linux AIO；非 amd64 主机会固定 `CAP_IMAGE_PLATFORM=linux/amd64`；非 amd64 显式 AIO 会失败并提示 BoxLite/control-plane），② 基础工具链，③ **Docker 已安装且可达**——Docker 缺失时走支持的主机安装路径，已有可用 Docker 保持不动，已安装但不可达时只做有界安全启动并给出人工修复步骤（例如 Docker Desktop **WSL Integration**、`sudo systemctl restart docker` 或切到可用 docker context），④ 拉取/刷新带 CAP managed marker 的 `docker-compose.prod.yml`，⑤ 幂等地写出本地账号 `.env`（`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`PASSWORD_AUTH_ENABLED=true`、session secrets、provider pins、sandbox image delivery mode 与 BoxLite 原生/rootfs 默认值；已存在的 `.env` 会被复用并保持 gitignore），⑥ 验证所选 provider（AIO registry/image-asset staging 或 BoxLite endpoint/runtime probe），⑦ `pull` 然后 `up`，⑧ 等待 `/health` 并打印管理员邮箱和密码。健康等待默认 120 秒；macOS/arm64 跑当前 amd64 release images 时默认放宽到 600 秒，因为 QEMU/Colima emulation 下 Node 启动可能需要数分钟；必要时可用 `CAP_HEALTH_TIMEOUT_SECONDS=<秒>` 覆盖。

设置 `RUN_GITHUB_VALIDATION=1` 会在 pull 前增加 GitHub API 可达/鉴权冒烟检查。它从进程环境或运行包旁边被忽略的 `.env.github-validation` 读取 `GITHUB_VALIDATION_TOKEN`，日志只打印已脱敏的 token 来源；没有 token 时退化为未鉴权可达性检查。

> 这条路径**等同于主机 root**（它挂载主机的 `docker.sock`），所以谁能登录，谁就能在主机上以 root 身份运行——请收紧账号访问。打印的密码是初始管理员凭据，首次登录会要求修改。预构建的 `cap-web` **仅限 localhost**（其 `VITE_*` 烤死为 localhost）；要用真实域名，请按上文配置本地账号、域名和 cookie。

## 可选：应用内一键自更新（`SELF_UPDATE_ENABLED`，默认 OFF）

一旦你跑起上面那条钉死-release 的命令，cap 就能**在控制台内**应用一个可用的更新：管理员在更新横幅上按下 **Upgrade** 按钮，api 会先 staging 匹配的目标 Release，再重建 cap 服务——正在运行的任务能在重建中存活。控制面镜像仍来自 GHCR；sandbox runtime staging 跟随 `CAP_SANDBOX_IMAGE_DELIVERY`（`registry` 拉 stager 镜像，`release-assets` 在重建前下载并校验 GitHub Release asset）。这是**需主动选用且默认关闭**的；自托管并不需要它。

> **安全提示——这是按钮背后的主机 root。** Upgrade 动作驱动主机的 Docker socket，与任务已经在用的主机 root 权能是同一份。**谁能按它 = 谁能在主机上以 root 运行。** 启用它是一个深思熟虑的决定，而非默认。该功能以**惰性（inert）**出厂：不设 `SELF_UPDATE_ENABLED` 时，`POST /self-update` 会拒绝，按钮也不出现（横幅保持仅通知）。除非你有理由开启它，否则请让它关着。

它能做什么——即便启用——也是刻意**有界**的：

- 它只会升级到与更新检查（`GET /update-status`）所报**最新版相匹配**的目标；任意 / 不匹配的目标会被拒绝。
- 它只会为 cap 服务拉取 cap 的 GHCR 命名空间（`ghcr.io/xeonice/cap-*:<target>`），并在 Release-asset 模式下只下载同一目标版本的 sandbox assets；它**只**重建 cap 的 compose 服务。没有通往任意镜像、tag 或 shell 命令的路径。
- 它在重建**之前**完成 staging/pull，所以 sandbox asset 下载、checksum、Docker load、rootfs 解压或镜像拉取失败，都会让正在运行的栈完好无损。

要激活它（在已有 Release 且 prod 跑着钉死-release 命令之后）：

- 在 `apps/api/.env` 中设置 `SELF_UPDATE_ENABLED=true`；
- 确认可按 Upgrade 的操作者拥有 `role = admin`；
- 把 web 的 `selfUpdate` capability flag 翻为 `true`（`apps/web/src/lib/api/capabilities.ts`）并重新部署控制台。

完整的激活步骤、分离式自重建机制以及威胁模型，见 [`deploy/DEPLOY.md`](../deploy/DEPLOY.md)（self-update 一节）。

## 可选：更新检查镜像（`GITHUB_API_BASE`）

cap 的更新检查（`GET /update-status`——它驱动通知横幅以及上面的自更新交叉校验）会把你正在运行的 `CAP_VERSION` 与最新的 GitHub Release 作比较。**默认**这次查询不会直接打到 GitHub：它经由 cap 公开的、**纯缓存**镜像（`https://releases.cap.douglasdong.com`），那是一个小型 Cloudflare Worker，代理 GitHub 的 `releases/latest` 并从 Cloudflare 边缘缓存提供。这让整个机群收敛到同一个被缓存的上游，并在 GitHub API 短暂抖动期间（缓存窗口内）让检查继续工作。该镜像是**纯缓存**——无鉴权、无 GitHub token、无遥测，且绝不改写 release 载荷。

如果你宁可不依赖那个镜像，把上游指回 GitHub 即可。查询随后会直接与 GitHub 通信、**零第三方依赖**——这个逃生口完全受支持：

```bash
# apps/api/.env
GITHUB_API_BASE=https://api.github.com
```

这与 `GITHUB_RELEASES_REPO`（检查哪个仓库的 Releases）是正交的：镜像会透明地代理你配置的任意 `owner/repo`，所以指向你自己的 fork，无论经由镜像还是直连都能工作。

## 可选：邮箱 OTP 登录（经 Resend 的 SMTP）

邮箱验证码（OTP）登录方式在**配置 SMTP 之前是关闭的**。设置那五个 `SMTP_*` 变量（全部必填——配置不全会 fail-closed，隐藏 OTP 方式并拒绝 OTP 请求），控制台便会显示「邮箱验证码」方式；密码登录不受影响。cap 可经任何标准 SMTP provider 发送；推荐的默认是 **Resend**（标准 SMTP，无需审批 / 实名 / ICP，免费额度对 OTP 绰绰有余，且 Cloudflare 能一键写入其 DNS）。

> **中国大陆注意：** Resend——和所有国际发件方一样——投递到 `@qq.com` / `@163.com` / `@126.com` 并不可靠。大陆运营方应保留密码登录。专门的大陆通道（例如阿里云 DirectMail）是未来的附加项；邮件模块已经为此带有收件人路由的接缝。

### 1 — Resend 账号 + 发件域名

创建一个 Resend 账号，**Add Domain**（用一个子域名如 `auth.yourdomain.com` 可保持你根域名的信誉干净），并创建一个 **API key**。Resend 随后会列出要添加的 DNS 记录。

### 2 — 后端 env（`apps/api/.env`，常驻栈则为 `files/api.env`）

```ini
SMTP_HOST=smtp.resend.com
SMTP_PORT=465                          # implicit TLS (or 587 for STARTTLS)
SMTP_USER=resend                       # literal value, NOT your email
SMTP_PASS=re_xxxxxxxxxxxx              # a Resend API key
SMTP_FROM=no-reply@auth.yourdomain.com # the verified (sub)domain
```

重启 api；`isOtpAuthEnabled` 翻为 true，「邮箱验证码」方式便出现在登录弹窗里。

### 3 — Cloudflare DNS（针对 `auth.yourdomain.com`）

添加 Resend 列出的记录——**使用你 Resend 仪表盘里的确切值**（它们因区域而异）；通常是：

| Type | Name | Value |
|------|------|-------|
| MX | `send` | `feedback-smtp.<region>.amazonses.com`（优先级 10） |
| TXT (SPF) | `send` | `v=spf1 include:amazonses.com ~all` |
| TXT (DKIM) | `resend._domainkey` | Resend 展示的那串很长的 `p=…` 密钥 |
| TXT (DMARC, 可选) | `_dmarc` | `v=DMARC1; p=none;` |

> **坑：** 在 Cloudflare 里，DKIM 的 TXT 记录必须是 **DNS-Only（灰云）**——如果它被代理（橙云）验证会失败。

**没有沙箱 / 审批**步骤——域名验证通常几分钟（最长约 72 小时）。要写入记录可用 Resend 的 "Sign in to Cloudflare" 一键、Cloudflare 仪表盘，或一个带 `Zone:DNS:Edit` 的 token（cap 内置的 wrangler/MCP 工具对 DNS 是只读的）。在 Resend 里点 **Verify**；一旦变绿，OTP 投递即生效。

## 可选：legacy 令牌（仅限 dev）

那条 legacy 的单一共享 `AUTH_TOKEN` 操作者路径**默认 OFF**，且**对常规本地账号自托管并不需要**。它的存在是为了本地 dev（`make up` 会生成一个）和应急通道（break-glass）。要启用它你必须同时设置两者：

```ini
AUTH_TOKEN_LEGACY_ENABLED=true   # only true/1/yes turns it on
AUTH_TOKEN=<a-long-random-token>
```

对于本地账号生产部署，让这两者保持默认（`false` / 空）——api 无需 legacy 令牌即可启动。

## 可选：远程 MCP 服务器（`mcpServerEnabled`，默认 OFF）

远程 MCP 服务器让 MCP 客户端（Claude Desktop、Cursor、VS Code、`mcp-remote`）驱动平台的沙箱——创建 / 获取 / 列出 / 停止任务、读取已完成任务的 transcript、列出仓库——通过 MCP 工具完成。它以**惰性（inert）**出厂：这个最危险的对外执行面在管理员开启之前是 OFF 的，即便开启后，每个请求也都受一份设置铸造的凭据把关。

### 端点与资源身份

- **端点**：`https://<your-api-domain>/mcp`（例如 `https://cap-api.douglasdong.com/mcp`）。它是单个 streamable-HTTP 路由（POST/GET/DELETE），由 api 进程内提供（没有单独的 MCP 进程）。
- **规范资源 URI**：`cap:mcp`——每个铸造出来的 `mcp_` 令牌所对应的固定 RFC 8707 资源标识符。在设置铸造模型里**没有** OAuth audience 协商，也**没有** `.well-known` 发现面：令牌本身即凭据。
- **鉴权**：把一个设置铸造的 `mcp_` 令牌粘进客户端的 `Authorization: Bearer mcp_…` 头。api 在每个请求上校验它（哈希 → 查表 → 拒绝已撤销 / 已过期 → 再次确认持有者账号仍启用），所以撤销一个令牌或禁用其持有者，会在下一次调用时拒绝它。`/mcp` 的 CORS 是仅 bearer 且**非凭据式**的（那里永不接受任何 cookie）；控制台的凭据式 CORS 是另一个域名，且绝不包含 MCP 客户端的 origin。

### 开启它

1. 设置 `mcpServerEnabled = true`——这是控制台 **Settings → MCP Server** 卡片里的系统级开关（仅 `role = admin` 的账号可操作）。当为 `false` 时，`/mcp` 返回一个 JSON-RPC "disabled" 响应且不连接任何 transport，所以那里没有令牌能用。
2. 在同一张卡片里，**铸造一个 MCP 令牌**：选一个名字 + scope（`tasks:read`、`tasks:write`、`repos:read`），可选一个过期时间。原始的 `mcp_…` 令牌**只展示一次**——当场复制；之后只会再展示它的 `mcp_` 前缀 + 末 4 位。撤销是幂等且仅限自身 scope 的。

### 各客户端的连接配置

Cursor（`~/.cursor/mcp.json` 或项目级 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "cap": {
      "url": "https://<your-api-domain>/mcp",
      "headers": { "Authorization": "Bearer mcp_REPLACE_WITH_YOUR_TOKEN" }
    }
  }
}
```

VS Code（`.vscode/mcp.json`）使用相同的 `url` + `headers` 结构。对于只会说 stdio 的客户端，用 `mcp-remote` 桥接：

```jsonc
{
  "mcpServers": {
    "cap": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-api-domain>/mcp",
        "--header",
        "Authorization: Bearer mcp_REPLACE_WITH_YOUR_TOKEN"
      ]
    }
  }
}
```

### 部署期验收

在隧道存活、`mcpServerEnabled` 开启的情况下，铸造一个令牌，把它作为 `Authorization` bearer 粘进客户端，并确认一次经由 `https://<your-api-domain>/mcp` 的端到端 `tools/list` + `create_task` 往返。一个**无法**传静态 bearer 头的客户端（某些 web 客户端只支持 OAuth connector）无法用设置铸造的令牌连接——那是本模型一个有记录的局限，OAuth 自动连接是一个可能的未来附加项，不属于这个面。

## 参考

- 反向代理（Cloudflare → nginx → api）位于 `proxy` compose profile 之后；在 VPS 上用 `docker compose --profile proxy up -d --build` 启用它。
- 完整变量参考：`apps/api/.env.example` 与 `apps/web/.env.example`。
- 背景与路线图：[OSS self-update epic](./oss-self-update-epic.md)。
