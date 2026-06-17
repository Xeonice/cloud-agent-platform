## Why

cap's version only moves when someone manually publishes a GitHub Release: `package.json` is a
`0.0.0` placeholder, there is no local tag discipline (the sole `v0.1.0` tag lives only on the
remote, created by hand), and `release.yml` is inert on push — so a maintainer must remember to
invent a version number and run `gh release create` before any image is built. This is exactly
the gap that just bit us: 6 commits have landed since `v0.1.0` with no Release cut, the run
package's `:latest` still points at `v0.1.0`, and the live api reports `/version: unknown`. The
pain becomes acute once the resident-compose cutover lands: on a resident GHCR stack, **push no
longer updates prod at all** — only a new Release does — so "forgot to release" silently freezes
production. We want releasing to be effortless and mechanical (no hand-typed versions, no
forgetting) while keeping a deliberate human gate, because a host-root self-update product must
release on purpose, not on every commit.

## What Changes

- Add a **release-please** GitHub Action (`release-type: simple` — a single repo-level cap
  version, NOT per-package npm bumps) that watches `main`, reads the conventional-commit history,
  and maintains an always-open **release PR** ("chore: release vX.Y.Z") containing the
  machine-computed next version (feat→minor, fix→patch, `!`/BREAKING→major) and an auto-generated
  `CHANGELOG.md`.
- Merging that release PR is what **tags `vX.Y.Z` + publishes the GitHub Release** — which the
  EXISTING `release.yml` already consumes (`release: published`) to build and push the matched
  GHCR image set. `release.yml` is unchanged.
- Bootstrap from the current state: `.release-please-manifest.json` pinned to `0.1.0` and a
  `release-please-config.json` that emits plain `vX.Y.Z` tags and does NOT rewrite the `0.0.0`
  package.json placeholders. The first run will propose **v0.2.0** (the accumulated feats since
  `v0.1.0`), which on merge also ships the just-added observability/run-package as the v0.2.0
  Release asset.
- Document the new dogfood loop (merge feature PRs → merge the release PR → images build → pull
  the new pinned set) in `deploy/DEPLOY.md`.

## Capabilities

### New Capabilities
<!-- none — extends the existing release-and-versioning capability -->

### Modified Capabilities
- `release-and-versioning`: ADD a requirement that Releases are produced automatically from
  conventional commits via a human-merged release PR (machine-computed semver + changelog,
  emitting `vX.Y.Z` tags that drive the existing image pipeline). The existing "merely committing
  publishes nothing / inert until a Release is published" property is PRESERVED and strengthened
  (random merges only update the release PR; only merging it releases; versions are computed, not
  hand-typed).

## Impact

- **Files (new):** `.github/workflows/release-please.yml`, `release-please-config.json`,
  `.release-please-manifest.json`; `CHANGELOG.md` (generated/maintained by the tool).
- **Files (touched):** `deploy/DEPLOY.md` (the dogfood-loop section gains the release-PR flow);
  no change to `release.yml` (it still triggers only on `release: published` / `workflow_dispatch`).
- **Permissions:** the release-please workflow needs `contents: write` + `pull-requests: write`
  to open/maintain the release PR and create the tag/Release. It does NOT push images (that stays
  with `release.yml`).
- **Versioning model:** a single cap version per Release (matches decision ⑤ — one tag unifies the
  three images); the `0.0.0` package.json placeholders are intentionally left untouched.
- **No app-source change.** First release-please release rebuilds identical-code images at the new
  tag (acceptable churn) and finally makes `/version` truthful on the resident stack.
- **OUT OF SCOPE (separate concerns):** the deploy-side trigger that makes the resident stack
  actually pull+run a new release (that rides with the deferred B-cutover via the existing
  `self-update-action` / a pull mechanism); path-based release filtering (we bump by commit type);
  per-package npm versioning.
