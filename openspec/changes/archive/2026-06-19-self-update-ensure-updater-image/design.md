## Context

`DockerUpdaterLauncher.launch` (`apps/api/src/self-update/self-update.service.ts`) launches the detached updater by calling `this.docker.createContainer({ Image: image, … })`, where `image` is the fixed server-side updater image (`docker:27-cli`, or `SELF_UPDATE_UPDATER_IMAGE`). dockerode's `createContainer` is a thin wrapper over `POST /containers/create`, which does NOT pull a missing image — it returns the daemon's `(HTTP code 404) … No such image`. On a host whose image cache never staged the updater image (a fresh resident deploy), the entire `POST /self-update` request fails at this point, before the updater starts. This was hit on the production v0.6.0→v0.7.0 upgrade and worked around with a manual `docker pull docker:27-cli`.

The cap GHCR target images are unaffected by this bug — they are pulled by the updater's own `docker compose pull` step inside the helper container. The gap is solely the helper image itself.

## Goals / Non-Goals

**Goals:**
- A host with no updater image self-heals by pulling it before container creation, instead of 404-ing the request.
- The steady-state path (image already present) incurs no extra pull and stays offline-friendly.
- No change to the bounded plan, topology derivation, pull-then-recreate ordering, or any gating.

**Non-Goals:**
- Changing how the cap GHCR target images are pulled (already handled by the updater's compose step).
- Pre-staging / warming the updater image at deploy time (out of scope; the runtime self-heal covers it).
- Retry/backoff or registry-auth handling for the updater image pull (the default image is public on Docker Hub).

## Decisions

- **Inspect-then-pull, gated on a miss.** `launch` calls a new private `ensureImage(image)` before `createContainer`. It runs `getImage(image).inspect()`; on success it returns immediately (no pull), and only on a thrown error (image absent) does it `pull` and await completion via `docker.modem.followProgress`. Rationale: keeps the common path a single cheap local inspect with zero network, while making the cold path self-healing. Alternative considered — always pull (let the daemon no-op when cached): rejected because it forces a registry round-trip on every upgrade and breaks air-gapped/offline hosts that legitimately pre-stage the image.
- **Pull completion awaited via `followProgress`.** `docker.pull` resolves with a stream that must be drained to know the pull finished; `modem.followProgress(stream, onFinished)` is the dockerode-idiomatic await. Rationale: createContainer must not run until the image is fully present.
- **Live launcher only.** The unit tests inject the `UPDATER_LAUNCHER` port with a fake, so the real `DockerUpdaterLauncher` (which talks to docker) is not exercised by unit tests; the change is confined to it and does not alter the port contract or the plan-construction logic the tests assert.

## Risks / Trade-offs

- [A pull failure now surfaces during `launch` instead of `createContainer`] → Same observable outcome for the operator (request fails, prior version keeps running because nothing was recreated yet); the error message becomes a clearer pull error rather than a misleading "no such image" 404. Pull-then-recreate safety for the cap images is unchanged.
- [First upgrade on a fresh host is slower by one image pull (~tens of MB)] → Acceptable one-time cost; subsequent upgrades hit the inspect fast-path.
- [Private/custom `SELF_UPDATE_UPDATER_IMAGE` without registry creds would fail the pull] → Pre-existing operator responsibility; the default `docker:27-cli` is public, and a host using a private updater image can still pre-stage it (inspect fast-path skips the pull entirely).

## Migration Plan

- Pure additive code change to the live launcher; ships with the next release. No env, schema, or API change. Production was already manually unblocked with `docker pull docker:27-cli`, so this change makes future fresh hosts self-heal without that manual step.
- Rollback: revert the commit; behavior returns to requiring the updater image be pre-staged.
