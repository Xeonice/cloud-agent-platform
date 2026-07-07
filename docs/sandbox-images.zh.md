# 自定义 Sandbox 镜像

当任务启动前就需要公司 CA 证书、内网包源配置、语言工具链、CLI、系统库或其他基础工具时，可以维护自己的任务基础镜像。

当前产品模型只有两类用户可见镜像：

- AIO 镜像：从 `ghcr.io/xeonice/cap-aio-sandbox:<cap-version>` 扩展。
- BoxLite 镜像：从 `ghcr.io/xeonice/cap-boxlite-sandbox:<cap-version>` 扩展。
- 镜像管理只注册 registry image reference。AIO loaded image、BoxLite rootfs 这类概念属于部署实现细节，不是用户创建镜像时需要理解或选择的来源类型。

在控制台里也可以从左侧 `镜像管理` 进入，点击 `查看文档` 打开同一份指南。

## 选择基镜像

先确认正在运行的 CAP 版本：

```bash
CAP_VERSION="$(curl -fsS http://<api-host>:<api-port>/version | jq -r .version)"
```

AIO Dockerfile 从 AIO 官方镜像开始：

```dockerfile
ARG CAP_VERSION
FROM ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}
```

BoxLite Dockerfile 从 BoxLite 官方镜像开始：

```dockerfile
ARG CAP_VERSION
FROM ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}
```

仓库里已经提供了模板：

- `examples/sandbox-images/aio/Dockerfile`
- `examples/sandbox-images/boxlite/Dockerfile`

通常只需要在官方镜像上安装额外工具。不要覆盖官方镜像继承下来的 `ENTRYPOINT`、`CMD`、服务端口、任务用户或工作目录，除非你也准备同时修改 provider 集成。

## 镜像需要满足的契约

CAP 在镜像进入可选状态前会做真实 provider 验证。自定义镜像至少要满足：

- `/home/gem/workspace` 存在，并且任务用户可写。
- `sh` 和 `git` 可用。
- 如果镜像只给 `codex` runtime 使用，需要 `codex` CLI 可用。
- 如果镜像只给 `claude-code` 或 `claude` runtime 使用，需要 `claude` CLI 可用。
- 不要把操作员 token、SSH key、PAT、模型账号凭据写进镜像。凭据应通过 CAP 账号设置、provider 环境变量、registry 登录或不会留在最终 layer 的 build secret 提供。
- 不要把镜像做成一次性任务镜像。它应该是可复用的基础层，任务目标和仓库内容仍由 CAP 在创建任务时注入。

## 构建并推送

AIO 本地 provider 的受支持路径通常是 Linux/amd64 Docker host：

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

BoxLite 镜像应匹配 BoxLite 宿主机架构。macOS 上的 BoxLite 通常使用 Linux/arm64；如果你有多种 BoxLite 宿主机，并且官方基镜像支持对应平台，可以发布 multi-arch 镜像：

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

如果使用私有 registry，CAP 不负责分发 registry 凭据。需要确保 Docker host 或 BoxLite host 自己能 pull 这个镜像，例如提前完成 `docker login` 或在 BoxLite 侧配置 registry 访问能力。

## 在 CAP 中注册

管理员在控制台操作：

1. 打开左侧 `镜像管理`。
2. 点击 `添加镜像`。
3. 选择 `AIO` 或 `BoxLite`。
4. 填入已经 push 的镜像地址。
5. 可选填写 runtime id，例如 `codex` 或 `claude-code`。如果留空，表示这个镜像可用于所有当前暴露的 runtime。
6. 保存后点击 `验证`。
7. 验证通过后状态变为 `ready`，该镜像才会出现在创建任务和用户 `设置` 的默认镜像下拉框里。

API 也使用同一套模型：

```bash
curl -fsS -X POST "$CAP_API/sandbox-environments" \
  -H "content-type: application/json" \
  -H "cookie: cap_session=$CAP_SESSION" \
  -d '{
    "name": "AIO base with jq and ripgrep",
    "source": {
      "kind": "aio-docker-image",
      "image": "registry.example.com/cap-aio-sandbox-custom:v0.31.0-1"
    },
    "runtimeIds": ["codex"]
  }'
```

BoxLite 使用 `boxlite-image`：

```json
{
  "source": {
    "kind": "boxlite-image",
    "image": "registry.example.com/cap-boxlite-sandbox-custom:v0.31.0-1"
  }
}
```

## 本地预检

注册前可以先做一个低成本检查：

```bash
docker run --rm "$IMAGE" sh -lc '
  test -d /home/gem/workspace &&
  command -v sh &&
  command -v git &&
  command -v codex
'
```

这个检查不能替代 CAP 的 `验证`。CAP 验证会走真实 AIO 或 BoxLite provider，创建短生命周期 sandbox，并在实际 provider 路径里检查 workspace 和 runtime 工具。只有 `ready` 镜像可用于新任务和默认镜像设置。

## 维护策略

- 不要使用可变的 `latest`。建议使用 `v0.31.0-1`、`v0.31.0-2` 这样的不可变 tag，或者使用 digest-pinned reference。
- 每次 CAP 升级后都应该基于新的官方镜像重建自定义镜像。官方基镜像里可能包含 agent CLI pin、hook、协议修复或 sandbox service 变化。
- 把 Dockerfile 和变更记录放进源码仓库，记录基于哪个 CAP 版本、额外安装了什么、为什么需要。
- 至少保留当前和上一个已验证可用 tag，直到运行中的任务和回滚窗口结束。
- 定期重建以获取系统包安全更新。先发布新 tag，注册并验证，再切换默认镜像。
- 不要直接删除仍被用户设为默认的镜像。先添加替代镜像、验证、切换默认值，再下线旧 tag。
- 私有 registry 的可达性由运维侧保证。CAP 只记录非密的镜像地址和验证结果，不保存 registry token。

## 常见失败原因

- Docker host 或 BoxLite host 拉不到私有镜像。
- 镜像架构和实际 provider 宿主机不匹配。
- 镜像缺少 `git`、`sh`、`codex` 或 `claude`。
- Dockerfile 覆盖了官方 entrypoint，导致 sandbox service 没起来。
- `/home/gem/workspace` 不存在或不可写。
- 把 runtime id 限制错了，例如给 `claude-code` 任务选择了只含 `codex` 的镜像。

## 最小模板

```dockerfile
ARG CAP_VERSION
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
