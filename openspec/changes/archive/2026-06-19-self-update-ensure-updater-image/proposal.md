## Why

The detached self-update launcher creates the updater container directly from the configured updater image (`docker:27-cli`) via dockerode's `createContainer`, which NEVER auto-pulls. On any host that has not already staged that image — e.g. a fresh resident deploy whose `docker images` is empty — the whole `POST /self-update` request fails before the updater even starts, surfacing the Docker daemon's `(HTTP code 404) … No such image: docker:27-cli` as a confusing 404. This was hit in production on the v0.6.0→v0.7.0 one-click upgrade and required a manual `docker pull` to unblock.

## What Changes

- `DockerUpdaterLauncher.launch` ensures the updater image is present locally BEFORE `createContainer`: inspect first, and pull (with `followProgress`) only on a miss — so the steady-state path stays offline-friendly and a fresh host self-heals instead of 404-ing the request.
- No change to the bounded plan, the topology derivation, the pull-then-recreate ordering, or any gating.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `self-update-action`: the detached-updater requirement gains a guarantee that the updater image itself is ensured present before the updater container is created (a fresh host self-heals rather than failing the request).

## Impact

- Code: `apps/api/src/self-update/self-update.service.ts` (`DockerUpdaterLauncher.launch` + new private `ensureImage`).
- No API surface, env, or schema change. No behavior change on hosts that already have the updater image staged.
