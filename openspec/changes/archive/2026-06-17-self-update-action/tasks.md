<!-- Track-annotated tasks. Each numbered group is a parallel Track.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: api-self-update (depends: none)

<!-- Files this track touches (all under apps/api/src/, disjoint from web + docs):
       NEW  apps/api/src/self-update/self-update.service.ts
       NEW  apps/api/src/self-update/self-update.controller.ts
       NEW  apps/api/src/self-update/self-update.module.ts
       NEW  apps/api/src/self-update/self-update.spec.ts
       NEW  apps/api/src/auth/admin.ts   (the admin gate — auth has NO admin concept today;
            add a self-contained env-allowlist admin check rather than editing operator-principal.ts)
       EDIT apps/api/src/app.module.ts   (register SelfUpdateModule — INTERNAL to this track:
            only task 1.3 touches it; no other track edits app.module.ts, so it is NOT shared)
     Reads-only (does NOT edit): update-status.service.ts (UpdateStatusService for the
       latest-target cross-check — injected via the module), aio-sandbox.provider.ts
       (the `new Docker()` dockerode/docker.sock idiom is the reference for the detached updater).
     The compose files (docker-compose.yml / docker-compose.images.yml) appear only as
       command-string args the service constructs — they are NOT edited.
     NOTE: do NOT add a `packages/contracts` self-update schema here — a contract would be
       imported by both api + web and become a cross-track shared file. Keep the request/
       response shape local to this track; web mirrors it with a local type (see Track 2). -->

- [x] 1.1 Add a self-update service: gated by `SELF_UPDATE_ENABLED` (default off → the service refuses); given a target, VALIDATE it is a semver tag matching the cached `/update-status` latest; construct the BOUNDED updater command (`docker compose -f docker-compose.yml -f docker-compose.images.yml pull && up -d` with `CAP_VERSION=<target>`, cap namespace + cap services only); launch it DETACHED so it outlives the api restart (helper container or detached process via the existing docker access), pulling BEFORE recreating. Never accepts an arbitrary image/tag/command.
- [x] 1.2 Add `POST /self-update` (`self-update.controller.ts`) + the admin gate (NEW `apps/api/src/auth/admin.ts`, self-contained — auth has no admin concept today): operator-guarded + admin check + `SELF_UPDATE_ENABLED` gate; refuse (403/404) when disabled or non-admin; on a valid request, ack "update started" then trigger the detached updater. Reuse the update-status service for the latest cross-check.
- [x] 1.3 Add `self-update.module.ts` and register it in `apps/api/src/app.module.ts` (the only task editing app.module.ts — intra-track, not shared); add `self-update.spec.ts` tests: disabled-by-default refuses; non-admin rejected; target-mismatch rejected; enabled+admin+valid constructs the bounded updater command (cap namespace + services only, target pinned) and acks before restart; pull-then-recreate ordering. (Do NOT actually recreate in the test — assert the command/plan.)

## 2. Track: web-upgrade-action (depends: none)

<!-- Files this track touches (all under apps/web/, disjoint from api + docs):
       EDIT apps/web/src/lib/api/capabilities.ts   (add `selfUpdate` flag, default false)
       EDIT apps/web/src/lib/api/real.ts            (add `postSelfUpdate`, local request/response type)
       EDIT apps/web/src/lib/api/mock.ts            (add the mock postSelfUpdate)
       EDIT apps/web/src/lib/api/queries.ts         (queryKeys entry if needed for invalidation)
       EDIT apps/web/src/lib/api/mutations.ts       (selfUpdate mutation factory)
       EDIT apps/web/src/components/shell/update-banner.tsx  (Upgrade action + confirm dialog;
            admin gate reads the auth session INSIDE the banner — _app.tsx renders <UpdateBanner/>
            with no props and is NOT touched. Reuse the shadcn dialog under components/ui/.)
       EDIT apps/web/src/components/shell/update-banner.test.ts  (task 2.3)
     All five api-client files (capabilities/real/mock/queries/mutations) are web-only and
       touched ONLY by this track, so the five tasks here run serially within the track but
       conflict with no other track. Consumes the Phase-2 banner. Disjoint from api.
     NOTE: do NOT add a packages/contracts self-update schema (it would be shared with api).
       Type `postSelfUpdate`'s payload locally; the target version comes from
       `UpdateStatus.latestVersion` the banner already reads. -->

- [x] 2.1 Add a `selfUpdate` capability flag (initially `false`) in `capabilities.ts`, and `real.postSelfUpdate` + a mock + `queryKeys`/mutation wiring in the api client layer.
- [x] 2.2 Extend the Phase-2 update banner with an admin-gated "Upgrade to vY" action shown ONLY when `selfUpdate` is enabled AND the operator is an admin AND an update is available; clicking opens a confirmation dialog with an explicit host-root warning, then POSTs `/self-update` and shows an "updating… reconnecting" state (the existing WS auto-reconnect resumes the session).
- [x] 2.3 Add tests: the Upgrade action is ABSENT when `selfUpdate` is off / non-admin / no update; present + confirm-gated when enabled+admin+update-available.

## 3. Track: docs (depends: none)

<!-- Files this track touches (disjoint from api + web):
       EDIT deploy/DEPLOY.md
       EDIT docs/self-hosting.md
     (docs/oss-self-update-epic.md is the epic overview; update it too if the Phase-3 status
      needs reflecting, still docs-only and disjoint.) -->

- [x] 3.1 Document self-update in `deploy/DEPLOY.md` + `docs/self-hosting.md`: `SELF_UPDATE_ENABLED` (default off), the admin gate, the bounded guarantees (validated target, cap namespace + services only, no arbitrary command), the detached-updater self-recreate (running tasks preserved by survive-api-redeploy), and the HOST-ROOT threat model ("who can press it = who can run as root"). Mark enabling it an explicit operator decision.

## 4. Track: integration-verify (depends: api-self-update, web-upgrade-action, docs)

<!-- No cross-track shared file exists: Track 1 is apps/api/* (+ its own app.module.ts edit),
     Track 2 is apps/web/*, Track 3 is docs — all disjoint. This track therefore holds NO
     reassigned shared-file tasks; it is pure post-merge verification (suite/build/typecheck)
     run serially after the three parallel tracks land. -->

- [x] 4.1 Run the api test suite + web build + workspace typecheck/lint green. Confirm the change ships INERT: `SELF_UPDATE_ENABLED` unset → `POST /self-update` refuses, and `selfUpdate` flag false → no console action. Deploying it adds no live host-root button.
- [x] 4.2 NOTE (operator-gated, not done here): the true end-to-end (enable the env + flag, press Upgrade → detached updater pulls the GHCR image set → api recreates → reconnect → `/version` shows the new tag, running task survived) requires Phase-1 activation (public repo + a published Release + prod on release images) and is verified by the operator at activation.
