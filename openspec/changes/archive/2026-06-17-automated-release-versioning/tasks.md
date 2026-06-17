<!-- Track-annotated tasks. Numbered groups are parallel Tracks; tasks within a track run serially. -->

## 1. Track: release-please-setup (depends: none)

- [x] 1.1 Add `release-please-config.json` at repo root: `release-type: simple`, single package `"."`, plain `vX.Y.Z` tag (`include-component-in-tag: false`, `include-v-in-tag: true` — so `release.yml`'s `tag_name → CAP_VERSION` mapping is unchanged), changelog enabled, and explicitly NO package.json version bumping (left the `0.0.0` placeholders).
- [x] 1.2 Add `.release-please-manifest.json` seeded `{ ".": "0.1.0" }` so the next computed release follows the existing `v0.1.0`.
- [x] 1.3 Add `.github/workflows/release-please.yml`: trigger `on: push: branches: [main]`; `permissions: contents/pull-requests/issues: write`; release-please-action@v4 (`config-file`/`manifest-file`) maintaining the release PR; Release-publishing identity wired to a NON-`GITHUB_TOKEN` token (D5). **Chosen route: fine-grained PAT** (`token: ${{ secrets.RELEASE_PLEASE_TOKEN }}`) — primary; the GitHub App token (`actions/create-github-app-token@v2`) is kept as a documented commented alternative. `release.yml` NOT modified.
- [x] 1.4 Validate: `release-please-config.json` / `.release-please-manifest.json` valid JSON; `actionlint` clean on `release-please.yml` AND `release.yml`; `release.yml` byte-for-byte unchanged (`git diff --quiet HEAD` ✓).

## 2. Track: docs (depends: release-please-setup)

- [x] 2.1 `deploy/DEPLOY.md`: rewrote the dogfood-loop (§11.3 step 4) to the release-please flow — land feature PRs → merge the auto-maintained "chore: release vX.Y.Z" PR → tag + Release + CHANGELOG → existing `release.yml` builds. Documented the D5 token requirement + the "`GITHUB_TOKEN`-created Release does NOT trigger `release.yml`" gotcha.

## 3. Track: token-and-first-release (depends: release-please-setup, docs) — USER-GATED

- [ ] 3.1 (User-provisioned — assistant cannot create credentials) **Decision: fine-grained PAT** (route B). Create a fine-grained PAT scoped to this repo with Contents: RW + Pull requests: RW, then add it as the repo secret `RELEASE_PLEASE_TOKEN` (`gh secret set RELEASE_PLEASE_TOKEN --repo Xeonice/cloud-agent-platform --body '<pat>'`). The workflow is already wired to this secret; rotate the PAT before its expiry. (App-token alternative remains commented in the workflow.)
- [ ] 3.2 (Maintainer-run) After release-please opens the first release PR (expected **v0.2.0** — the feats since v0.1.0), merge it and VERIFY end-to-end: `release.yml` actually fires (not silently skipped), `ghcr.io/xeonice/cap-*:v0.2.0` + `:latest` are built, the run package is attached to the v0.2.0 Release, and a pulled `cap-api:v0.2.0` reports `GET /version` = `v0.2.0`.
