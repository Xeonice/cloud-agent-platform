# Verification Report — automated-release-versioning

Spec: `specs/release-and-versioning/spec.md` (1 ADDED requirement, 5 scenarios).

Implemented artifacts re-traced:
- `.github/workflows/release-please.yml`
- `release-please-config.json`
- `.release-please-manifest.json`
- `.github/workflows/release.yml` (must remain unchanged — the existing image pipeline)
- `deploy/DEPLOY.md` (dogfood-loop docs)

## Adjudication summary

- Raw-unmet requirements supplied to this pass: **none** (`[]`).
- Re-opened code tasks this pass: **none**.
- Spec defects routed to design.md Open Questions: **none**.
- Requirements re-traced and confirmed **MET**: the single ADDED requirement (all 5 scenarios).

The two recorded findings below (CHANGELOG gap, `package-name` scope) are
**non-blocking**: neither is a code problem nor a spec defect. The requirement
re-traces end-to-end as satisfied; both findings are "met-as-written with a minor
gap / harmless extra that does not block the primary scenario."

## MET — Requirement: Releases are produced automatically from conventional commits via a human-merged release PR

Each SHALL clause in the requirement body traces to an implementation:

1. **Run release automation (release-please, `release-type: simple`) watching the default branch.**
   `release-please.yml` → `on: push: branches: [main]`; `release-please-config.json` →
   `packages["."].release-type = "simple"`, single package `"."`. MET.

2. **Maintain an always-open release PR with machine-computed semver + auto-generated `CHANGELOG.md`.**
   `googleapis/release-please-action@v4` wired with `config-file`/`manifest-file`; this is the
   action's native behavior, correctly configured. `changelog-path: CHANGELOG.md` set. MET.
   (See CHANGELOG gap note below — the file is created on the first run, not pre-committed.)

3. **Merging the release PR — and ONLY merging it — creates the `vX.Y.Z` tag + GitHub Release that drives the GHCR pipeline.**
   The release event is produced by merging the PR (release-please behavior); `release.yml`
   consumes it via `on: release: types: [published]`. No `push`-based image build exists. MET.

4. **SINGLE repo-level cap version, tracked in a manifest seeded from `v0.1.0`.**
   `.release-please-manifest.json = { ".": "0.1.0" }`; config has a single root package `"."`.
   `release.yml` maps `github.event.release.tag_name → CAP_VERSION` for one tag across all three
   images. `include-v-in-tag: true` + `include-component-in-tag: false` emit a plain `vX.Y.Z`
   tag, so the existing `tag_name → CAP_VERSION` mapping is unchanged. MET.

5. **SHALL NOT rewrite the `0.0.0` package.json placeholders.**
   `release-type: simple` does not bump `package.json`. Confirmed: all 8 `package.json` files
   (root + `packages/*` + `apps/*`) still read `"version": "0.0.0"`. MET.

6. **Release published under an identity OTHER THAN the built-in `GITHUB_TOKEN` (D5).**
   `release-please.yml` mints a short-lived repo-scoped GitHub App token via
   `actions/create-github-app-token@v2` and passes `token: ${{ steps.app-token.outputs.token }}`
   to the release-please action; a documented fine-grained-PAT alternative is commented at the
   bottom. The App-attributed Release fires `release.yml` (not suppressed by GitHub's
   `GITHUB_TOKEN` recursion prevention). MET — credential provisioning itself is the user-gated
   operational step (task 3.1), not a coded requirement.

7. **Inert-until-release property preserved; hand-typed versions eliminated.**
   `release.yml` triggers only on `release: published` / `workflow_dispatch` — a plain push
   builds nothing. `release-please.yml` only opens/updates the release PR on push; it never tags
   or builds. Versions are computed by release-please, not hand-typed. MET.

### Scenarios

- **A release PR is maintained from conventional commits** — MET. release-please reads
  conventional commits and opens/updates the PR; nothing tagged/built until merge.
- **Merging the release PR cuts the versioned Release that drives the image pipeline** — MET.
  Merge → tag + Release + `CHANGELOG.md` entry; the App-token (non-`GITHUB_TOKEN`) identity makes
  `release: published` fire, building/pushing `ghcr.io/xeonice/cap-*:vX.Y.Z` (+ `:latest`) and
  attaching the run package via the `event_name == 'release'`-gated `attach-run-assets` job.
- **Non-releasable commits propose no release** — MET. Inherent release-please behavior, correctly
  configured (no path filtering; bump by commit type per D3).
- **Versioning stays a single repo-level cap version** — MET. One `vX.Y.Z` for the matched
  three-image set; `0.0.0` placeholders untouched.
- **Committing the automation itself publishes nothing** — MET. `release.yml`'s only auto-trigger
  is `release: published`, not `push`; merging `release-please.yml`/config produces no tag,
  Release, or image until a release PR is merged.

`release.yml` confirmed **byte-for-byte unchanged** vs `HEAD`
(`git diff --quiet HEAD -- .github/workflows/release.yml` → exit 0), satisfying the
"release.yml unchanged" constraint that load-bears the `event_name == 'release'` asset-attach
gating.

## Findings (non-blocking)

### Gap — CHANGELOG.md not yet present at repo root
The requirement says the automation maintains an auto-generated `CHANGELOG.md`.
`release-please-config.json` correctly sets `changelog-path: CHANGELOG.md`, but no `CHANGELOG.md`
exists at the repo root yet. This is **not a missing implementation**: release-please creates the
file when it opens the first release PR, which is gated on the user-provisioned D5 credential
(task 3.1) and the first-release merge (task 3.2), both intentionally marked incomplete. Classified
**met-as-written with a minor gap that does not block the primary scenario** — the file's creation
is a runtime artifact of the first run, not a coded deliverable. No code task re-opened.

### Scope — `"package-name": "cap"` is configured but absent from all spec artifacts
`release-please-config.json` sets `packages["."].package-name = "cap"`, which is not mentioned in
`spec.md`, `proposal.md`, or `tasks.md`. With `include-component-in-tag: false` (and `simple`
mode), the package-name is **suppressed from tags and release names**, so it has no observable
behavioral effect on any scenario. Recorded as a scope note only — not a spec defect (the spec is
not contradicted) and not a code problem (behavior is correct). No action required; could be noted
in tasks for completeness in a future tidy-up.

### Note — `issues: write` permission
`release-please.yml` grants `permissions: contents/pull-requests/issues: write`, which matches
tasks.md task 1.3 exactly. In scope; no finding.

## Outstanding (user-gated, not coded requirements)
- Task 3.1 — user provisions the D5 credential (GitHub App install or fine-grained PAT).
- Task 3.2 — maintainer merges the first release PR (expected `v0.2.0`) and verifies the
  end-to-end build (`release.yml` fires, `ghcr.io/xeonice/cap-*:v0.2.0` + `:latest` built, run
  package attached, pulled `cap-api:v0.2.0` reports `GET /version = v0.2.0`).
These are operational steps requiring credentials the assistant cannot create; they are not
unimplemented code.
