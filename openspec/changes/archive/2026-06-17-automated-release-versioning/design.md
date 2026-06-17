## Context

Versioning is fully manual today (see proposal): `package.json` is `0.0.0`, the only tag/Release
is a hand-made `v0.1.0`, and `release.yml` builds the GHCR image set ONLY on `release: published`
/ `workflow_dispatch`. The repo has flawless conventional-commit discipline (every commit is
`feat()/fix()/chore()/docs()`), and the release model is a SINGLE cap version per Release that
unifies the three images (decision ⑤). We want to remove the "remember to invent a version and
cut a Release" friction without surrendering the deliberate human gate that suits a host-root
self-update product.

## Goals / Non-Goals

**Goals:**
- Machine-computed semantic version from conventional commits — no hand-typed tags.
- A deliberate human gate: nothing releases on a normal merge; releasing = merging a release PR.
- Emit `vX.Y.Z` tags + GitHub Releases that drive the EXISTING `release.yml` image pipeline.
- Auto-maintained `CHANGELOG.md`.
- Preserve (and strengthen) the "committing publishes nothing / inert until a Release" property.

**Non-Goals:**
- The deploy-side trigger that makes a resident stack actually pull+run a new release (rides with
  the deferred B-cutover via the existing `self-update-action`).
- Path-based release filtering (we bump by commit TYPE, accepting identical-image rebuilds for
  docs/compose-only feats).
- Per-package npm versioning / touching the `0.0.0` placeholders.
- Restructuring `release.yml`'s build logic.

## Decisions

### D1 — release-please (not semantic-release, not a custom action)
release-please maintains an always-open **release PR** that accumulates conventional commits and
shows the computed next version + changelog; merging it cuts the tag + Release. Chosen because it
(a) keeps a human gate (merge the PR) — unlike semantic-release which releases on every qualifying
push; (b) fits the repo's conventional commits natively; (c) emits `vX.Y.Z` Releases that the
existing pipeline already consumes; (d) auto-generates the changelog; (e) batches many feats into
one release rather than churning a version per merge. A custom action would reinvent this worse.

### D2 — `release-type: simple` (single repo-level version)
The cap version is one number per Release (decision ⑤), NOT eight npm package versions. release-
please's `simple` type tracks a single version via `.release-please-manifest.json` and does NOT
rewrite `package.json` files, so the `0.0.0` placeholders stay as-is. Config emits a plain
`vX.Y.Z` tag (no component prefix) so `release.yml`'s `tag_name → CAP_VERSION` mapping is unchanged.

### D3 — Bump by commit type, no path filtering
feat→minor, fix→patch, `!`/`BREAKING CHANGE`→major; `chore`/`docs`/etc. are non-releasable. We do
NOT gate on whether app source changed — a `feat(deploy): …` that only touches compose/docs still
bumps + rebuilds (identical) images. Accepted: simple, predictable semantics over a perfectly
code-correlated version (the maintainer chose this).

### D4 — Bootstrap from v0.1.0
`.release-please-manifest.json = { ".": "0.1.0" }` seeds the current version so the next computed
release is correct. The 4 feats since `v0.1.0` → the first release PR proposes **v0.2.0**; merging
it also finally ships the observability/run-package as the v0.2.0 Release asset.

### D5 — release-please needs a NON-`GITHUB_TOKEN` identity so its Release triggers `release.yml` ⚠️
This is the load-bearing gotcha. GitHub deliberately **does not** let an event created by the
built-in `GITHUB_TOKEN` trigger another workflow (recursion prevention). So if release-please
publishes the Release using the default `GITHUB_TOKEN`, `release.yml` (`on: release: published`)
will **silently NOT fire** — no images get built. To keep `release.yml` truly unchanged (it relies
on the real `release` event — e.g. `attach-run-assets` is gated on `github.event_name == 'release'`
and uploads the run package), release-please must publish the Release under a real identity:

- **Recommended:** a **GitHub App token** (via `actions/create-github-app-token`) — short-lived,
  scoped to this repo's contents+PRs, no long-lived secret. The App-attributed Release fires
  `release.yml` naturally and all its `event_name == 'release'` logic stays correct.
- **Alternative:** a **fine-grained PAT** (`contents: write`, `pull-requests: write`) stored as a
  secret — simpler to set up, but a long-lived credential.

Either way this is a **user-provisioned credential** — the assistant cannot create secrets/Apps,
so apply has a user-gated step (add the token), mirroring the cutover's operator-gated steps.
Rejected alternative: converting `release.yml` into a `workflow_call` reusable workflow invoked by
release-please — it would need NO secret, but it ripples into `release.yml` (the
`event_name == 'release'` asset-attach gating breaks under `workflow_call`), violating "release.yml
unchanged". The token approach is the least-disruptive, most-correct path.

## Risks / Trade-offs

- **[Default `GITHUB_TOKEN` → Release doesn't trigger `release.yml`]** → D5: publish the Release
  with a GitHub App token / fine-grained PAT. Verify at apply: cut a test release and confirm
  `release.yml` actually runs.
- **[A non-conventional commit slips in]** → release-please ignores it for versioning (a missed
  bump), not a failure. Mitigation: the repo is disciplined; optionally add PR-title linting later
  (out of scope).
- **[`feat(docs/compose)` bumps + rebuilds identical images]** → accepted churn (D3); images are
  cheap and the version still moves forward monotonically.
- **[First release jumps 0.1.0 → 0.2.0 with no app-code change]** → expected and fine; it makes
  `/version` truthful and ships the run-package assets that `v0.1.0` lacks.
- **[Two release-creating paths now exist]** (manual `gh release` + release-please) → harmless;
  both produce a `release: published` event. Convention going forward: release via the PR.

## Migration Plan

1. Land `release-please.yml` + `release-please-config.json` + `.release-please-manifest.json`
   (seeded at 0.1.0). On the next push to `main`, release-please opens the "chore: release v0.2.0"
   PR (no release yet — inert).
2. User provisions the release-please token (GitHub App install or fine-grained PAT secret) — the
   one user-gated step.
3. Merge the release PR → tag `v0.2.0` + GitHub Release + `CHANGELOG.md` → `release.yml` fires →
   GHCR `cap-*:v0.2.0` + `:latest` built, run package attached to the Release.
4. Verify: `release.yml` actually ran; `ghcr …:v0.2.0` exists; a pulled api reports
   `/version: v0.2.0`.
- **Rollback:** delete `release-please.yml` (+ config/manifest); manual `gh release create` still
  works exactly as before. Nothing about `release.yml` changed.

## Open Questions

- **Token type for D5: RESOLVED → fine-grained PAT** (route B; maintainer chose simplicity). The
  workflow is wired to `secrets.RELEASE_PLEASE_TOKEN`; the App-token approach stays commented as a
  no-long-lived-secret alternative. Remaining user step (task 3.1): create the PAT + add the secret.
- Whether to add commit-lint / PR-title validation to enforce conventional commits (currently by
  convention only) — likely a later, separate change.
