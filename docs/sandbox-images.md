# Sandbox Images

CAP managed sandbox environments support two image types:

- AIO image: a pinned Docker image derived from
  `ghcr.io/xeonice/cap-aio-sandbox:<cap-version>`.
- BoxLite image: a pinned BoxLite-compatible image derived from
  `ghcr.io/xeonice/cap-boxlite-sandbox:<cap-version>`.

Removed concepts such as AIO loaded image and BoxLite rootfs are deployment
internals. They are not product-level image sources in Image Management.

## Extend A Base Image

Start from the templates under `examples/sandbox-images/`:

```bash
export CAP_VERSION=v0.27.1

docker build \
  --build-arg CAP_VERSION="$CAP_VERSION" \
  -t registry.example.com/cap-aio-sandbox-custom:"$CAP_VERSION" \
  ./examples/sandbox-images/aio

docker push registry.example.com/cap-aio-sandbox-custom:"$CAP_VERSION"
```

For BoxLite, build `./examples/sandbox-images/boxlite` and push the resulting
image to a registry reachable by the BoxLite host.

## Register In CAP

In Image Management:

1. Choose `AIO` or `BoxLite`.
2. Enter the pushed image reference.
3. Optionally restrict the runtime ids, such as `codex` or `claude-code`.
4. Save and run validation.

Validation creates a temporary sandbox through the selected provider, checks the
workspace path and core tools, and marks the image selectable only when the
provider probe passes.
