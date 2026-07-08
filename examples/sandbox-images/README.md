# Sandbox Image Templates

These templates show the supported extension path for CAP managed sandbox
environments:

1. Pick the provider runtime: `aio` or `boxlite`.
2. Extend the matching official CAP release image.
3. Build and push the custom image to a registry reachable by the CAP host.
4. Register that image reference in CAP Image Management and validate it.

CAP does not manage registry access for custom images. Operators must make sure
the Docker or BoxLite host can pull the image.
For GHCR, publish with `write:packages` and grant the provider host read access.
For internal HTTP-only registries or private CAs, configure the Docker or
BoxLite host before CAP validation.

```bash
export CAP_VERSION=v0.27.1

docker build \
  --build-arg CAP_VERSION="$CAP_VERSION" \
  -t registry.example.com/cap-aio-sandbox-custom:"$CAP_VERSION" \
  ./examples/sandbox-images/aio

docker push registry.example.com/cap-aio-sandbox-custom:"$CAP_VERSION"
```

Use `./examples/sandbox-images/boxlite` for BoxLite images and replace the tag
with your registry, namespace, and CAP version.

These templates are for registry image references registered in CAP Image
Management. BoxLite local rootfs assets are a deployment-level default configured
with `BOXLITE_ROOTFS_PATH`; they are not image-library records and are documented
in the full guide.

For the full build, validation, rollout, and maintenance workflow, see
[`docs/sandbox-images.md`](../../docs/sandbox-images.md) or
[`docs/sandbox-images.zh.md`](../../docs/sandbox-images.zh.md).
