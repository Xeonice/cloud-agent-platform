# Design

## Context

Two same-versioned images must reach the host on every upgrade: `cap-api:${CAP_VERSION}` (recreated)
and `cap-aio-sandbox:${CAP_VERSION}` (staged for the per-task DooD sandbox `docker run`). The
`aio-sandbox-image` compose service is a never-starts, pull-only stager (`entrypoint: ["true"]`,
`restart: "no"`) whose sole job is to make `docker compose pull` stage the sandbox image. The in-app
self-update already splits cap services into a recreate set (api/web) + a pull set (those plus the
pull-only stager). The manual path had no equivalent guard; this change gives it one and scriptizes
the release tail.

## Goals / Non-goals

- **Goal:** make it IMPOSSIBLE to upgrade prod with only one of the two images by hand; catch a bad
  sandbox image at upgrade time; remove the hand-run release tag/verify; make the release skill drive
  the server upgrade end-to-end.
- **Non-goal:** replacing the in-app self-update (kept — already correct); changing app/API/schema;
  fully automating the judgment part of releasing (change selection, version bump, CHANGELOG stay
  with the skill); auto-deploying from CI (upgrade runs on the prod host, deliberately operator-run).

## Decisions

**D1 — `upgrade.sh` forces both images; no single-service door.** The service set passed to BOTH
`pull` and `up -d` is fixed to `api aio-sandbox-image` (mirroring self-update's recreate∪pull split;
prod does not run `web` so it is omitted). Only the project name + compose file are parametrizable
(flags/env, defaulting to the resident `-p cloud-agent-platform -f docker-compose.prod.yml`). There
is intentionally NO flag to upgrade api alone — that is the footgun being removed. `aio-sandbox-image`
on `up -d` runs its `entrypoint: true` and exits immediately, which is how its image gets staged.

**D2 — `upgrade.sh` ends with a provision smoke.** After `/version` confirms the new tag, the script
creates a throwaway task, polls until it reaches `running` (sandbox provisioned successfully), then
stops it. This is the exact check that would have caught v0.20.0's missing image at deploy time
rather than when a user created a task. The smoke needs a session credential + a repo id —
operator-supplied via env/flags; if absent the script SKIPS the smoke with a loud warning (still
upgrades) rather than failing the deploy.

**D3 — `release.sh` is the post-merge mechanical tail only.** Inputs: an optional version (else read
`.release-please-manifest.json`). Steps: `gh release create v<X>` with the operator's PAT (a
non-`GITHUB_TOKEN` identity, or `release.yml` won't fire — same rule the skill documents), watch the
`release.yml` run to success, then assert all three GHCR manifests (`cap-api` / `cap-web` /
`cap-aio-sandbox`) return 200 at the tag. It does NOT archive changes, bump, or open the PR — those
stay in the `release-pr-bundle` skill. Fail-fast with a clear message at each gate.

**D4 — `release-pr-bundle` skill gains a「更新服务端」step.** After its existing post-merge tag step,
append a deploy step: run `scripts/upgrade.sh v<X>` on the prod host (or trigger the in-app one-click
for an admin), noting the force-both + smoke guarantees and the prod topology (resident dir, `-p
cloud-agent-platform`). This makes the skill's narrative end-to-end (PR → merge → tag → images →
**upgrade server** → verify) instead of ending at GHCR.

**D5 — Safety: `.env` backup, atomic pin, pull-before-up, idempotent.** `upgrade.sh` copies `.env`
to a timestamped backup, pins `CAP_VERSION` atomically (temp+mv, preserving other lines — same idiom
as self-update's `buildPlan`), and pulls BEFORE `up -d` so a failed pull leaves the prior version
running. Re-running with the same version is a no-op-ish (re-pulls + recreates to the same tag).

**D6 — One declared cap-service truth.** The force-both list and the self-update `CAP_SERVICES` /
`PULL_ONLY_CAP_SERVICES` describe the same fact (api + the aio-sandbox stager). The script documents
that it mirrors self-update; if the cap topology ever changes, both must move together (called out
in the script header + the deploy-config test).

## Risks / Trade-offs

- **Smoke needs credentials on the host.** A real session token + repo id must be available to the
  script for the provision smoke; without them it skips (warns) rather than blocking the upgrade —
  so the smoke is best-effort, the force-both pull is the hard guarantee.
- **`release.sh` PAT.** Relies on the operator's `gh` auth being a PAT, not `GITHUB_TOKEN`; the
  script checks `gh auth status` and warns if it can't confirm a non-actions identity.
- **Drift between script and self-update service set.** Mitigated by D6 (documented single-truth +
  the existing `docker-compose.deploy-config.test` can assert `aio-sandbox-image` is present).

## Migration

None — additive scripts + docs + skill text. Existing in-app self-update and manual flows keep
working; the scripts become the recommended manual path.
