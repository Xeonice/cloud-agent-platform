# Design

## Decision: one-line install means release artifacts

The site installer is intentionally a wrapper over `quick-deploy.sh`, not a second provisioning
implementation. `install.sh` keeps the friendly `curl ... | sh` UX and performs only local
preflight checks before executing the release-image installer. The direct `quick-deploy.sh` path
remains inspectable and is still the single operational implementation for source-free installs.

## Decision: resolve `latest` before composing

The script resolves `CAP_VERSION=latest` or an unset value to the latest GitHub Release tag before
writing `.env` and calling compose. This keeps image tags reproducible for that run and prevents
stale `.env` values such as `CAP_VERSION=unknown` from hiding the release version in `/version`.

Manual compose usage may still omit `CAP_VERSION` to pull Docker's `latest` tag, but
`docker-compose.prod.yml` no longer writes a runtime `CAP_VERSION=latest` into the API container.
That avoids overriding the image-baked concrete version.

## Decision: provider gate, not architecture-only gate

The previous quick-deploy behavior treated the prebuilt path as amd64/AIO-only. With BoxLite support
available, architecture alone is no longer the correct gate. The selected provider controls the
rules:

- macOS auto-selects BoxLite and can run api/web prebuilt images with a `linux/amd64` platform pin.
- Linux auto-selects AIO and stages the release's AIO sandbox image.
- explicit AIO on non-amd64 is rejected before image staging with remediation guidance.

This preserves clear failure for unsupported combinations without forcing macOS users back to a
source build.

## Rejected Alternative: keep `install.sh` as source-build

Keeping `install.sh` on `git clone && make up` would preserve the old local-dev path but would keep
private deployments vulnerable to unversioned local images. It also contradicts the current product
promise that macOS private installs are supported through the release installer.
