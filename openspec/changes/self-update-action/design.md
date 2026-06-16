## Context

Phase 3 (capstone) of the OSS self-update epic. It exposes a one-click upgrade — the
differentiator cap can offer because it already holds `docker.sock` (`aio-sandbox.provider.ts:74`)
and, since `survive-api-redeploy`, a backend recreate preserves running tasks. It is ALSO
the most dangerous surface in the epic (a button that runs host-root container ops), so the
design is dominated by containment: hard-disabled by default, bounded, admin-gated, and the
self-recreate done via a detached updater. It cannot be live-verified without the gated Phase-1
activation (GHCR images), so it ships INERT and its activation is a deliberate operator step.

## Goals / Non-Goals

**Goals:**
- An operator-admin can apply an available update from the console, bounded + confirmed.
- Hard-disabled by default (`SELF_UPDATE_ENABLED=false`) → endpoint refuses, no button → inert.
- Bounded: target validated against `/update-status` latest, cap GHCR namespace only, cap
  services only; never an arbitrary image/command.
- Self-recreate via a detached updater that outlives the api restart; running tasks survive.
- Ships safe: deploying it adds no live host-root button.

**Non-Goals:**
- Enabling it in any deployment; the Phase-1 operator activation; auto/background update.
- Live-verifying a real upgrade (needs GHCR images — operator-gated).

## Decisions

### D1 — Hard env gate, default OFF (inert)
`POST /self-update` is REFUSED (403/404) unless `SELF_UPDATE_ENABLED=true`. Default off, so
shipping + deploying is inert. The web "Upgrade" action is behind a `selfUpdate` capability
flag (default false) AND the enabled state, so the button is absent by default.

### D2 — Operator-admin-only + confirmation
The endpoint requires the operator-auth guard AND an admin check (an allowlisted admin, the
narrowest principal available); the console action shows a confirmation dialog with an
explicit host-root warning before POSTing. "Who can press it" = "who can run as root on the
host" — stated in the UI + docs.

### D3 — Bounded target, no arbitrary input
The upgrade target is a VALIDATED semver tag that MUST match the latest reported by the
cached `/update-status` (server-side cross-check), not free-form client input. The updater
pulls ONLY `ghcr.io/xeonice/cap-*:<target>` and recreates ONLY the cap compose services.
There is NO path to an arbitrary image, tag, or command. An invalid/mismatched target is
rejected.

### D4 — Self-recreate via a detached updater (the api can't `compose up` itself)
On an enabled, confirmed, validated request the api launches a DETACHED one-shot updater
that runs `docker compose -f docker-compose.yml -f docker-compose.images.yml pull && up -d`
at `CAP_VERSION=<target>` and OUTLIVES the api's own recreate (a helper container, or a
detached process via the existing docker access — same detached idiom as survive-api-redeploy).
The endpoint returns "update started" BEFORE the api goes down; the console shows an
"updating…" state and reconnects via existing WS auto-reconnect once the new api is up.
`survive-api-redeploy` keeps in-flight sandbox tasks alive across the recreate.

### D5 — Ships INERT; activation is deliberate
Deploying this change changes nothing observable (flag off → no button; env off → endpoint
refuses). Activation = set `SELF_UPDATE_ENABLED=true` + flip `selfUpdate` + have real GHCR
images (Phase-1 activation). Documented as an operator decision, never done by the change.

## Risks / Trade-offs

- **Host-root button (the central risk).** → Hard env gate off-by-default + admin-only +
  bounded target (no arbitrary image/command) + confirmation. Defense in depth; documented
  threat model. The bound is the load-bearing control: even enabled, it can only pull the cap
  namespace at a `/update-status`-validated tag and recreate cap services.
- **Self-recreate reliability.** → The detached updater must survive the api going down;
  if it fails mid-pull, compose `up -d` is idempotent and the prior containers keep running
  (no destructive teardown before the new images are pulled). Pull-then-up ordering matters.
- **Cannot be live-verified without GHCR images.** → Ships inert; the true end-to-end (press
  → pull → recreate → reconnect) is an operator-gated check at activation. Unit-test the
  gate/validation/bounding logic + the updater command construction; dry-run the disabled path.
- **Version drift / triplet** — the updater pins all three images to one `CAP_VERSION` via the
  images override (Phase 1 D2), so the matched set upgrades together.
- **Partial-cluster / non-compose topologies.** → Supported only for the documented compose
  topology; on others the feature stays disabled (notify-only).

## Migration Plan
1. Ship the gated endpoint + updater + console action, all default-off → inert. Safe deploy.
2. OPERATOR activation (not here): Phase-1 (repo/packages public, cut Release, prod on
   release-images) → set `SELF_UPDATE_ENABLED=true` + flip `selfUpdate` → verify a real
   one-click upgrade end-to-end (press → detached updater pulls → api recreates → reconnect →
   `/version` shows the new tag, running task survived).
- **Rollback:** additive + default-off; remove the endpoint/action or leave the flags off.

## Open Questions
- Updater form: a one-shot helper CONTAINER (clean isolation, needs an image with compose) vs
  a detached host PROCESS via the api's docker access. Lean: whichever the supported topology
  makes most robust; decided at apply against the real compose/host setup.
- Admin definition: a dedicated admin allowlist vs "any allowlisted operator." Lean: a
  narrower admin set (env), since this is host-root.
- Progress/streaming of the update to the console vs a simple "updating… reconnecting" state.
  Lean: simple state first (the WS reconnect already exists); streamed logs are a follow-up.
