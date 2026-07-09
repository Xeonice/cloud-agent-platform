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

Do not bake user, forge, or service tokens into these images. If a preinstalled
CLI needs task-time parameters, configure them on the image record in CAP Image
Management and wrap the CLI so it sources `/home/gem/.cap/image-env` when the
file exists.

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

For the full build, validation, rollout, and maintenance workflow, see
[`docs/sandbox-images.md`](../../docs/sandbox-images.md) or
[`docs/sandbox-images.zh.md`](../../docs/sandbox-images.zh.md).
