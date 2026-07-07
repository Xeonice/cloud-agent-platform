# Custom Sandbox Images

CAP task sandboxes can run from operator-managed images. Use this when a task
needs company CA certificates, internal package registry config, language
toolchains, CLIs, system libraries, or other baseline tools that should be
available before the agent starts.

The product model is intentionally small:

- AIO uses one Docker image derived from
  `ghcr.io/xeonice/cap-aio-sandbox:<cap-version>`.
- BoxLite uses one BoxLite-compatible image derived from
  `ghcr.io/xeonice/cap-boxlite-sandbox:<cap-version>`.
- Image Management accepts registry image references. Deployment internals such
  as "loaded image" and "rootfs" are not user-facing image source types.

Chinese version: [`docs/sandbox-images.zh.md`](sandbox-images.zh.md).

In the web console, the same guide is available from `镜像管理` via
`查看文档`.

## Choose The Base

Build from the official image that matches the CAP version you deploy:

```bash
CAP_VERSION="$(curl -fsS http://<api-host>:<api-port>/version | jq -r .version)"
```

For AIO:

```dockerfile
ARG CAP_VERSION
FROM ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}
```

For BoxLite:

```dockerfile
ARG CAP_VERSION
FROM ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}
```

Start from the templates in `examples/sandbox-images/aio` and
`examples/sandbox-images/boxlite`. Keep the inherited entrypoint and command
unless you are deliberately changing the sandbox service contract.

## Image Contract

Custom images must preserve the runtime contract CAP validates before an image
becomes selectable:

- `/home/gem/workspace` exists and is writable by the task user.
- `sh` and `git` are available.
- If the image is restricted to `codex`, the `codex` CLI is available.
- If the image is restricted to `claude-code` or `claude`, the `claude` CLI is
  available.
- Do not bake operator tokens, SSH keys, PATs, or model credentials into the
  image. Use CAP account settings, provider env, registry credentials, or build
  secrets that do not remain in final layers.
- Do not overwrite the official sandbox entrypoint, ports, service user, or
  workspace path unless you also own the provider integration change.

## Build And Push

AIO currently runs on Linux/amd64 Docker hosts in the supported local provider
path:

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

BoxLite should be built for the architecture of the BoxLite host. macOS BoxLite
hosts are usually Linux/arm64; publish a multi-arch image if you operate mixed
BoxLite hosts and the official base supports each platform:

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

For private registries, CAP does not broker registry credentials. Ensure the
Docker host or BoxLite host can pull the image before registering it.

## Register In CAP

In the web console:

1. Open `镜像管理`.
2. Click `添加镜像`.
3. Choose `AIO` or `BoxLite`.
4. Enter the pushed image reference.
5. Optionally enter runtime ids such as `codex` or `claude-code`. Leave it empty
   only when the image supports every runtime you expose.
6. Save, then click `验证`.
7. When the status is `ready`, users can select the image in the task creation
   form or in `设置` as their default image.

The same model is available through the API:

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

Use `boxlite-image` for BoxLite images.

## Validate Before Rollout

Run a cheap local check before registering:

```bash
docker run --rm "$IMAGE" sh -lc '
  test -d /home/gem/workspace &&
  command -v sh &&
  command -v git &&
  command -v codex
'
```

CAP validation is still required. It creates a short-lived provider sandbox and
checks the workspace and runtime tools through the actual AIO or BoxLite path.
Only `ready` images are selectable for new tasks and default-image settings.

## Maintain Images

- Treat tags as immutable. Prefer `v0.31.0-1`, `v0.31.0-2`, or digest-pinned
  references over `latest`.
- Rebuild custom images after every CAP upgrade. The official base may include
  agent CLI pins, hooks, protocol fixes, or sandbox service changes that your
  custom image should inherit.
- Keep the Dockerfile and a short changelog in source control. Record the CAP
  base version, extra packages, and why they are needed.
- Keep at least the current and previous known-good image tags in the registry
  until in-flight tasks and rollback windows are finished.
- Patch OS packages on a regular cadence, then register and validate a new tag
  before changing defaults.
- Do not remove a `ready` image that operators still use as their personal
  default. Add the replacement, validate it, switch defaults, then retire the old
  tag.
- If a validation fails, inspect the latest validation detail in `镜像管理`.
  Common causes are an unreachable private registry, missing `git`, missing
  `codex`/`claude`, an overridden entrypoint, or an image built for the wrong
  architecture.

## Template Example

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

Use the BoxLite base image for BoxLite, but keep the same principles: extend the
official base, add only non-secret baseline tooling, and let CAP validation prove
the image works before users select it.
