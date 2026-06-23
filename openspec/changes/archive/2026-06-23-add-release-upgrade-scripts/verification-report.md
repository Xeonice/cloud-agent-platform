# Verification Report — add-release-upgrade-scripts

Adjudication of the raw verify pass. The skeptic returned an EMPTY raw-unmet list;
every spec requirement was re-traced end-to-end against the actual code before being
folded here. Result: **4 MET, 0 UNMET (no reopened code tasks), 0 SPEC-DEFECT.**

## Met requirements (re-traced end-to-end)

### self-hostable-deployment — "Manual upgrade is scriptized and stages BOTH the api and sandbox images" — MET

`scripts/upgrade.sh`:
- `SERVICES=(api aio-sandbox-image)` is hardcoded (line 49); there is no flag or path
  that operates on only one service. Both `pull` (line 68) and `up -d` (line 73) run
  against `"${SERVICES[@]}"` — proven by `scripts/docker-compose.deploy-config.test.mjs`
  ("SERVICES forces BOTH api and aio-sandbox-image" + "pull AND up -d both operate on the
  full SERVICES set").
- Backs up `.env` to a timestamped `.env.bak.*` (lines 60-62), atomically pins
  `CAP_VERSION` preserving all other lines via temp+mv (line 63), and pulls BEFORE `up -d`
  (lines 68 then 73) so a failed pull leaves the prior version running.
- Project + compose file parametrizable via `CAP_PROJECT` / `CAP_COMPOSE_FILE` /
  `CAP_COMPOSE_DIR`, defaulting to the resident prod stack.
- Validates the version is a semver tag (lines 38-42), rejecting moving/arbitrary tags.

### self-hostable-deployment — "Upgrade verifies the version and runs a sandbox provision smoke" — MET

`scripts/upgrade.sh`:
- `/version == <target>` verify with retry loop, failing loudly on mismatch (lines 76-87).
- Provision smoke: create throwaway task → poll until `running` → stop (lines 93-124).
  Fails loudly if the task force-fails or never reaches `running`.
- Skip-with-loud-warning when `CAP_API_URL` / `CAP_SMOKE_COOKIE` / `CAP_SMOKE_REPO_ID`
  are unset (lines 121-124); the force-both pull remains the hard guarantee.

### release-and-versioning — "Release tail is scriptized and verifies all three images" — MET

`scripts/release.sh`:
- Reads target from arg or `.release-please-manifest.json` (`jq -r '."."'` correctly reads
  the `.` package key → confirmed returns `0.20.0` against the live manifest).
- Checks `gh auth status` and warns when a non-`GITHUB_TOKEN` identity can't be confirmed
  (lines 44-50).
- `gh release create` (idempotent — skips if the release exists), watches `release.yml` to
  success (`gh run watch --exit-status`), then verifies all three GHCR manifests
  (`cap-api` / `cap-web` / `cap-aio-sandbox`) return HTTP 200 at the tag (lines 77-86).
- Does NOT bump/changelog/PR; prints next step `scripts/upgrade.sh <version>`.
- Three-image verify guarded by the deploy-config test.

### release-and-versioning — "The release skill drives the server upgrade end-to-end" — MET

`.claude/skills/release-pr-bundle/SKILL.md`:
- Step 8 「更新服务端」 appended AFTER the post-merge tag step (step 7), pointing to
  `scripts/upgrade.sh v<NEW>` (with the in-app one-click as the admin alternative).
- Carries the force-both guarantee explicitly ("forces `cap-api` AND `cap-aio-sandbox`
  together … NEVER hand-run `docker compose pull api` alone").
- Reframes the flow + summary as end-to-end (PR → merge → tag → images → upgrade server →
  verify). Step 7 references `scripts/release.sh` for the tag+verify tail.

## Static checks

- `bash -n scripts/upgrade.sh` and `bash -n scripts/release.sh` — both syntactically sound.
- `node scripts/docker-compose.deploy-config.test.mjs` — 13 passed, 0 failed (includes the
  3 add-release-upgrade-scripts guards).
- `deploy/DEPLOY.md` replaces the hand-typed upgrade commands with `scripts/upgrade.sh`,
  calling out the only-`pull api` footgun (the v0.20.0 incident, lines ~410-413).

## Gap / scope findings

**Gap:** None blocking. Every spec requirement maps to a concrete implementation; all task
items are checked off; all four artifacts (upgrade.sh, release.sh, SKILL.md step 8,
DEPLOY.md) are present and back their requirements; the deploy-config test guards the
force-both + three-image invariants. The only runtime-dependent surfaces (the `/version`
verify and provision smoke in `upgrade.sh`, and the `gh`/GHCR network calls in
`release.sh`) are by-design operator-run on the prod host and are statically guarded as far
as a unit test can reach. No primary scenario is blocked.

**Scope:** The working tree contains many `apps/api/src/` modifications (api-keys, audit,
auth, mcp-tokens, mcp, rate-limit, repos, sandbox, tasks, v1) plus an untracked
`openspec/changes/fix-local-account-github-identity-gates/` folder. These belong to a
SEPARATE change (`fix-local-account-github-identity-gates` and sibling
fix-rate-limit / fix-local-account-* changes) and are NOT part of
add-release-upgrade-scripts. This change's footprint is scripts-only:
`scripts/upgrade.sh`, `scripts/release.sh`, `scripts/docker-compose.deploy-config.test.mjs`
(add-release-upgrade-scripts guards), `.claude/skills/release-pr-bundle/SKILL.md` (step 8),
and `deploy/DEPLOY.md`. The api/src changes must be committed under their own change and
kept out of this one's commit.
