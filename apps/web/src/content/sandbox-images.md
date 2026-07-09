# 创建和维护自定义镜像

自定义镜像用于给任务 sandbox 预装基础能力，例如公司 CA 证书、内网包源配置、语言工具链、CLI、系统库或常用调试工具。镜像里只放可复用的基础层；任务目标、仓库内容和账号凭据仍由 CAP 在创建任务时注入。

CAP 是控制面，不是镜像构建、上传、发布或 registry 托管平台。管理员需要先在自己的 Docker / CI / registry 流程里构建并发布镜像，然后在 CAP 中注册这个已发布的 registry image reference。

## 1. 选择正确的基镜像

先确认当前 CAP 版本：

```bash
CAP_VERSION="$(curl -fsS http://<api-host>:<api-port>/version | jq -r .version)"
```

AIO 镜像从 AIO 官方镜像扩展：

```dockerfile
# 构建时必须覆盖为正在运行的 CAP 版本。
ARG CAP_VERSION=v0.0.0
FROM ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}
```

BoxLite 镜像从 BoxLite 官方镜像扩展：

```dockerfile
# 构建时必须覆盖为正在运行的 CAP 版本。
ARG CAP_VERSION=v0.0.0
FROM ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}
```

仓库里有两个模板：

- `examples/sandbox-images/aio/Dockerfile`
- `examples/sandbox-images/boxlite/Dockerfile`

通常只需要在官方镜像上安装额外工具。不要覆盖官方镜像继承下来的 entrypoint、command、服务端口、任务用户或工作目录。

## 2. 满足镜像契约

CAP 验证镜像时会通过真实 provider 创建短生命周期 sandbox，并检查以下能力：

- `/home/gem/workspace` 存在且任务用户可写。
- `sh` 和 `git` 可用。
- 如果镜像用于 `codex` runtime，`codex` CLI 必须可用。
- 如果镜像用于 `claude-code` 或 `claude` runtime，`claude` CLI 必须可用。

不要把操作员 token、SSH key、PAT、模型账号凭据写进镜像。凭据应通过 CAP 账号设置、provider 环境变量、registry 登录或不会进入最终 layer 的 build secret 提供。

## 3. 镜像参数

如果自定义镜像里安装了需要 token 或地址参数的工具，不要在 Dockerfile 里写 token，也不要要求用户在任务里手动 export。管理员在 **镜像管理** 注册镜像时配置参数：

- 普通参数：例如 `GCODE_API_BASE_URL`
- 密钥参数：例如 `GCODE_TOKEN`，保存后不再回显

任务使用该镜像时，CAP 会在 agent 启动前写入：

- `/home/gem/.cap/image-env`

镜像里只需要提供一个 wrapper，在调用真实 CLI 前读取这个 env 文件：

```sh
#!/usr/bin/env sh
set -eu

if [ -r /home/gem/.cap/image-env ]; then
  . /home/gem/.cap/image-env
fi

exec /opt/gcode/gcode "$@"
```

如果所用 `gcode` 版本要求先初始化，把 `gcode init` 放在 wrapper 里，以非交互参数或配置文件读取上述环境变量。不要在 `RUN` layer 里执行带 token 的 init，也不要把 init 生成的账号状态复制进镜像。

CAP 会在 workspace materialize 之后、agent runtime setup 之前写入这些文件，并在 sandbox 停止或清理前 best-effort 删除。镜像验证只检查基础工具；真实参数是否可用，需要创建使用该镜像的任务后验证。

## 4. 构建并推送

AIO 本地 provider 通常运行在 Linux/amd64 Docker host：

```bash
export CAP_VERSION=v0.31.0
export IMAGE=registry.example.com/cap-aio-sandbox-custom:${CAP_VERSION}-1

docker buildx build \
  --platform linux/amd64 \
  --build-arg CAP_VERSION="$CAP_VERSION" \
  -t "$IMAGE" \
  --push \
  ./examples/sandbox-images/aio
```

BoxLite 镜像要匹配 BoxLite 宿主机架构。macOS BoxLite 通常使用 Linux/arm64：

```bash
export CAP_VERSION=v0.31.0
export IMAGE=registry.example.com/cap-boxlite-sandbox-custom:${CAP_VERSION}-1

docker buildx build \
  --platform linux/arm64 \
  --build-arg CAP_VERSION="$CAP_VERSION" \
  -t "$IMAGE" \
  --push \
  ./examples/sandbox-images/boxlite
```

私有 registry 的访问由运维侧保证。CAP 不保存 registry token；需要确保 Docker host 或 BoxLite host 自己能 pull 这个镜像。

registry 相关操作由运维侧自己保证：

- GHCR 发布 token 需要 `write:packages`，并且要给实际 pull 镜像的 Docker host 或 BoxLite host 配置 package 读取权限。
- 私有 registry 需要先在 provider host 上配置凭据，例如 `docker login`、节点本地 credential helper，或 BoxLite 支持的 registry 配置。
- BoxLite 必须能从 BoxLite host 访问 registry。优先使用 HTTPS；如果内网 registry 只能走 HTTP 或使用私有 CA，需要先在 BoxLite 或宿主机 registry 配置里允许 insecure registry 或信任该 CA。
- CAP 只保存非密的镜像地址和验证结果；不会构建、上传、托管、发布镜像，保存 registry token，或者替用户打通私有 registry 网络。

## 5. 在控制台注册

1. 打开左侧 **镜像管理**。
2. 点击 **注册镜像**。
3. 选择 `AIO` 或 `BoxLite`。
4. 填入已经发布到 registry、并且 provider host 可以拉取的镜像地址。
5. 可选填写 runtime id，例如 `codex` 或 `claude-code`。留空表示这个镜像可用于所有当前暴露的 runtime。
6. 点击 **保存引用**，再点击 **验证**。
7. 验证通过后状态变为 `ready`，该镜像才会出现在创建任务和 **设置 → 默认镜像** 下拉框里。

## 6. 维护策略

- 不要使用可变的 `latest`。建议使用 `v0.31.0-1`、`v0.31.0-2` 或 digest-pinned reference。
- 每次 CAP 升级后，都应基于新的官方镜像重建自定义镜像。官方基镜像可能包含 agent CLI pin、hook、协议修复或 sandbox service 变化。
- 把 Dockerfile 和变更记录放进源码仓库，记录基于哪个 CAP 版本、额外安装了什么、为什么需要。
- 至少保留当前和上一个已验证可用 tag，直到运行中的任务和回滚窗口结束。
- 定期重建以获取系统包安全更新。先发布新 tag，注册并验证，再切换默认镜像。
- 不要直接删除仍被用户设为默认的镜像。先添加替代镜像、验证、切换默认值，再下线旧 tag。
- 如果验证错误提示 registry authorization，通常是 package 私有、GHCR 权限不足，或 provider host 没有读取权限。transport 类错误通常是 BoxLite host 无法使用 HTTPS 访问 registry、不信任私有 CA，或 HTTP-only registry 没有配置为 insecure registry。

## 常见失败原因

| 现象 | 检查方向 |
| --- | --- |
| 验证时无法创建 sandbox | 镜像地址是否可由 Docker host / BoxLite host 拉取；私有 registry 是否已在 provider host 登录 |
| 启动后立即失败 | 是否覆盖了官方 entrypoint 或 command |
| runtime 检查失败 | 是否缺少 `codex`、`claude`、`git` 或 `sh` |
| registry authorization failed | GHCR package 权限、`write:packages` 发布 token、provider host 读取权限 |
| registry transport failed | BoxLite host 是否能用 HTTPS 访问 registry；HTTP-only registry 是否已配置 insecure registry 或私有 CA |
| BoxLite 拉取失败 | 镜像架构是否匹配 BoxLite 宿主机；registry reference 是否存在 |
| 创建任务不可选 | 镜像是否已经验证为 `ready`，runtime id 是否匹配 |

## 最小模板

```dockerfile
# 构建时必须覆盖为正在运行的 CAP 版本。
ARG CAP_VERSION=v0.0.0
FROM ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    jq \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

USER gem
WORKDIR /home/gem/workspace
```

BoxLite 只需要把 `FROM` 改成 `ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}`。核心原则不变：扩展官方基镜像，只放非密的基础能力，推到 provider 能访问的 registry，然后在 CAP 里验证通过后再给用户选择。
