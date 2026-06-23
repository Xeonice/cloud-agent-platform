# Scriptize release + upgrade — force both images together, end-to-end skill flow

## Why

A production upgrade must stage TWO same-versioned images — `cap-api` AND `cap-aio-sandbox` (the
per-task sandbox base, pinned to `${CAP_VERSION}`). The in-app one-click self-update already does
this correctly (it pulls the `aio-sandbox-image` pull-only stager alongside api — see
`self-update.service.ts` `PULL_ONLY_CAP_SERVICES`). But the **manual / operator upgrade path has no
such guarantee** — it relied on a human remembering `pull api aio-sandbox-image`. On the v0.20.0
deploy that human ran only `pull api`, so `cap-aio-sandbox:v0.20.0` was never staged → every new
task's sandbox provision hit `(HTTP 404) No such image` → tasks force-failed (`provision_failed`),
and their reaped/never-created sandboxes surfaced the misleading "已超过保留期被清理" replay state.

Separately, the release flow's mechanical tail (tag → build → verify all three images) is hand-run.
Both are scriptized here so a missed image **cannot happen by hand**, and the release skill is
extended to drive the upgrade end-to-end.

## What Changes

- **`scripts/upgrade.sh <version>`** — the ONLY manual upgrade path, with NO single-service door:
  it ALWAYS `pull` + `up -d` BOTH `api` and `aio-sandbox-image` (force both together) after backing
  up + pinning `.env` `CAP_VERSION`, then verifies `/version == <version>` AND runs a **provision
  smoke** (create a task → reaches `running` → stop) so a missing/unrunnable sandbox image is caught
  at upgrade time, not by a user later.
- **`scripts/release.sh [version]`** — the mechanical release TAIL (post-merge): read the bumped
  `.release-please-manifest.json` version (or arg), `gh release create v<X>` (PAT) to trigger
  `release.yml`, watch the run, and verify ALL THREE GHCR images (`cap-api` / `cap-web` /
  `cap-aio-sandbox`) are present. The PR / bump / CHANGELOG part stays with the `release-pr-bundle`
  skill (it needs judgment) — this script only removes the hand-run tag + verify.
- **Update the `release-pr-bundle` skill** — append a「更新服务端」step after the post-merge tag:
  point the operator at `scripts/upgrade.sh v<X>` (or the in-app one-click) to deploy, carrying the
  force-both + smoke guarantees, so the skill's flow is END-TO-END (PR → merge → tag → images →
  upgrade server → verify) instead of stopping at "images built".
- **`deploy/DEPLOY.md`** — replace the hand-typed upgrade commands with `scripts/upgrade.sh`, calling
  out that only-`pull api` is the exact footgun this removes.

## Impact

- Affected specs: `self-hostable-deployment` (manual upgrade forces both images + provision smoke),
  `release-and-versioning` (release script tags + verifies all three images).
- New files: `scripts/upgrade.sh`, `scripts/release.sh`. Updated:
  `.claude/skills/release-pr-bundle/SKILL.md`, `deploy/DEPLOY.md`.
- NO app code / API / schema change — pure ops tooling + docs + skill. Complements (does not replace)
  the in-app self-update, which already stages both images.
