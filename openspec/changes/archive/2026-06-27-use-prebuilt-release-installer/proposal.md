## Why

The site-hosted one-line installer and Claude prompt still described the old source-build path:
clone the repository and run `make up`. A private macOS deployment installed through that path built
local `cloud-agent-platform-*` images with `CAP_VERSION=unknown`, so `/version` and the update check
reported `currentVersion: "unknown"` even though a release existed.

The latest install surface now supports macOS through BoxLite, so the default self-host install must
use the same published release artifacts everywhere. A user or agent running the one-line installer
should get versioned GHCR images, not an unversioned local source build.

## What Changes

- Make `apps/www/public/install.sh` a lightweight preflight wrapper around the site-hosted
  `quick-deploy.sh`; it no longer requires `git`, clones the repository, or invokes `make up`.
- Make `scripts/quick-deploy.sh` resolve `CAP_VERSION=latest` or an unset `CAP_VERSION` to the
  latest GitHub Release tag before writing `.env`, pulling images, or starting compose.
- Make the prebuilt path platform-aware:
  - macOS/Darwin defaults to BoxLite and requires `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, and
    `BOXLITE_IMAGE` or `BOXLITE_IMAGE_MAP`.
  - Linux defaults to AIO and stages the matching prebuilt AIO image.
  - non-amd64 hosts pin api/web release images to `linux/amd64` when needed, while explicit AIO on
    non-amd64 fails before staging with BoxLite/control-plane guidance.
- Stop overriding the image-baked API version with a runtime `CAP_VERSION=latest` in
  `docker-compose.prod.yml`; the baked `/version` value remains concrete unless an operator
  deliberately pins a version.
- Update the landing content, docs, env examples, and OpenSpec specs so the installer, Claude
  prompt, and manual alternatives all describe the release-image path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `one-line-installer`: site installer delegates to the release-image prebuilt path, with
  platform-aware macOS BoxLite / Linux AIO defaults and no source clone/build.
- `agent-oneclick-deploy`: quick-deploy resolves the latest release tag, updates stale operational
  pins in `.env`, and gates by provider/platform instead of rejecting every non-amd64 host.
- `release-and-versioning`: release run package semantics preserve baked concrete versions and
  document platform/provider behavior.
- `marketing-www`: hero install copy and Claude prompt advertise the release-image installer and
  current local-account positioning.

## Impact

- Modified: `apps/www/public/install.sh`, `apps/www/scripts/inject-install-sh.mjs`,
  `scripts/quick-deploy.sh`, `docker-compose.prod.yml`, `docker-compose.prod.env.example`.
- Modified: landing content/components, README files, self-hosting docs, env examples, and relevant
  OpenSpec specs.
- Behavior: new one-line installs pull published release images and report a concrete `/version`;
  macOS private deployments use BoxLite by default instead of producing unversioned local images.
