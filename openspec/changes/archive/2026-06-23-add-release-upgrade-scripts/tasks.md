# Tasks

## 1. Track: upgrade script

- [x] 1.1 `scripts/upgrade.sh <version>` — force-both: `pull` + `up -d` of `api aio-sandbox-image` (NO single-service door). Back up `.env`, atomically pin `CAP_VERSION` (preserve other lines), pull BEFORE up. Project + compose file parametrizable via flags/env, defaulting to the resident prod stack (`-p cloud-agent-platform -f docker-compose.prod.yml`, dir `/etc/dokploy/compose/cloud-agent-platform/resident`). Header documents it mirrors self-update's `CAP_SERVICES` / `PULL_ONLY_CAP_SERVICES`.
- [x] 1.2 Provision smoke in `upgrade.sh`: after `up`, assert served `/version == <version>`; then create a throwaway task → poll until `running` → stop it. Skip-with-loud-warning when no session credential / repo id is supplied (env/flags); fail loudly on version mismatch or if the smoke task force-fails. Sandbox image staged by 1.1 is what this proves runnable.

## 2. Track: release script

- [x] 2.1 `scripts/release.sh [version]` — read target from arg or `.release-please-manifest.json`; check `gh auth status` is a non-`GITHUB_TOKEN` identity (warn otherwise); `gh release create v<X>` to trigger `release.yml`; watch the run to success; verify `cap-api` / `cap-web` / `cap-aio-sandbox` GHCR manifests return 200 at the tag. Fail fast per gate. Does NOT archive/bump/PR. Prints next step: "run `scripts/upgrade.sh v<X>` on the prod host".

## 3. Track: skill + docs

- [x] 3.1 `.claude/skills/release-pr-bundle/SKILL.md` — after the post-merge tag step (step 7), append a「更新服务端」step: run `scripts/upgrade.sh v<X>` on the prod host (or trigger the in-app one-click for an admin), force-both + provision smoke, resident topology; reframe the flow + summary as end-to-end (PR → merge → tag → images → upgrade server → verify). Reference `scripts/release.sh` for the tag+verify tail.
- [x] 3.2 `deploy/DEPLOY.md` — replace hand-typed upgrade commands with `scripts/upgrade.sh <version>`; explicitly call out that only-`pull api` (omitting `aio-sandbox-image`) is the footgun this removes (it 404s every new task's sandbox provision).

## 4. Track: tests (depends: upgrade script)

- [x] 4.1 Guard the single-truth: extend `scripts/docker-compose.deploy-config.test.mjs` (or a new test) to assert `upgrade.sh`'s pull/up service set contains BOTH `api` and `aio-sandbox-image`, so the force-both guarantee can't silently regress; parse/shellcheck both new scripts for basic soundness.
