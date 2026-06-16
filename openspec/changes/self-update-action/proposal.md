## Why

Phase 2 tells the operator a new version is available; Phase 3 lets them apply it from the console — the differentiator cap can offer (unlike most self-hosted apps) BECAUSE it already holds `docker.sock` and, since `survive-api-redeploy`, a backend recreate no longer kills running tasks. This is **Phase 3** of the OSS self-update epic (`docs/oss-self-update-epic.md`): a one-click upgrade. It is also the most security-sensitive surface in the epic (a button that runs host-root container operations), so it ships HARD-GATED and INERT by default and is activated only deliberately by the operator.

> Side-car: `research-brief.md`; epic context `docs/oss-self-update-epic.md`. Builds on Phase 1 (pinned GHCR images, `docker-compose.images.yml`) + Phase 2 (`/update-status`) + `survive-api-redeploy`.

## What Changes

- **Add a hard-gated self-update endpoint.** `POST /self-update` (operator-guarded) that is REFUSED unless `SELF_UPDATE_ENABLED=true` (default OFF) — so merely shipping it is inert. When enabled, it upgrades to a BOUNDED target: only a validated semver tag that matches the latest from `/update-status` (no arbitrary user input), only the cap GHCR namespace images (`ghcr.io/xeonice/cap-*`), only the cap compose services. It NEVER accepts an arbitrary image/command.
- **Recreate-self via a detached updater (the api can't `compose up` itself while running).** On an enabled, confirmed request, the api launches a DETACHED one-shot updater (a short-lived helper that runs `docker compose -f docker-compose.yml -f docker-compose.images.yml pull && up -d` at the target `CAP_VERSION`) that OUTLIVES the api's own restart — the same detached-process idiom as survive-api-redeploy's tmux approach. `survive-api-redeploy` keeps in-flight sandbox tasks alive across the api recreate; the operator console reconnects via the existing WS auto-reconnect.
- **Surface an admin-gated "Upgrade" action on the update banner.** When `updateCheck` is live AND self-update is enabled AND the operator is an admin, the Phase-2 banner gains an "Upgrade to vY" action with a confirmation dialog (host-root warning). Otherwise the action is absent (notify-only, exactly Phase 2). Gated by a `selfUpdate` capability flag (initially `false`).
- **Document the activation + the threat model.** `SELF_UPDATE_ENABLED`, who may press it (admin allowlist), the bounded-operation guarantees, and that it is host-root-equivalent — in `deploy/DEPLOY.md` + `docs/self-hosting.md`.

## Capabilities

### New Capabilities
- `self-update-action`: A hard-gated (`SELF_UPDATE_ENABLED`, default off), operator-admin-only, BOUNDED one-click upgrade — `POST /self-update` validates the target against `/update-status`'s latest, then launches a detached updater that pulls the pinned cap GHCR image set and recreates the cap services (running tasks preserved by `survive-api-redeploy`); the console surfaces an "Upgrade" action with confirmation on the update banner only when enabled + admin. Ships inert (flag off → no button, endpoint refuses) and is host-root-equivalent, so it is activated deliberately, never by default.

## Impact

- **api:** new `POST /self-update` controller (operator-guarded + `SELF_UPDATE_ENABLED` gate + admin check), a self-update service that validates the target tag against the cached `/update-status` latest and launches the detached updater via dockerode/compose (reusing the existing `docker.sock` access); refuses (404/403) when disabled. Bounded to the cap GHCR namespace + cap compose services; no arbitrary image/command input.
- **updater mechanism:** a detached one-shot (helper container or detached process) running the compose pull+up at the target version, surviving the api's own recreate. Documented + scoped to the supported compose topology.
- **web:** an "Upgrade" action on the Phase-2 update banner (confirmation dialog, host-root warning), gated by a new `selfUpdate` capability flag (initially `false`) + an admin check; absent otherwise.
- **config/docs:** `SELF_UPDATE_ENABLED` (default false); `deploy/DEPLOY.md` + `docs/self-hosting.md` document activation, the admin gate, the bounded guarantees, and the host-root threat model.
- **Dependencies:** none new (dockerode + compose already present).
- **Explicitly NOT in this change:** enabling self-update in any deployment, the operator activation (repo/packages public, cut Release, prod migration), or auto-update. The button is INERT until `SELF_UPDATE_ENABLED=true` + the `selfUpdate` flag is flipped + a real Release exists — none of which this change does. Live verification of an actual upgrade is operator-gated (needs the GHCR images).
- **Specs:** 1 new (`self-update-action`). No existing requirements change.
