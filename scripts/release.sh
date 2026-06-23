#!/usr/bin/env bash
#
# release.sh — the post-merge MECHANICAL TAIL of a release (add-release-upgrade-scripts,
# design D3). Given a target version (arg or the bumped manifest), it: creates the
# GitHub Release (so release.yml fires), watches the image build to success, and
# verifies ALL THREE images (cap-api, cap-web, cap-aio-sandbox) are present at the tag.
#
# It does NOT pick changes / bump the version / write the CHANGELOG / open the PR —
# those need judgment and stay with the `release-pr-bundle` skill. This script only
# removes the hand-run tag + verify so the tail can't be half-done (e.g. forgetting
# the sandbox image — the same one upgrade.sh forces).
#
# USAGE
#   scripts/release.sh [version]      # default: read .release-please-manifest.json
#
# PRECONDITIONS
#   - on a merged, version-bumped main (manifest already at the target version)
#   - `gh` authenticated as a PAT / real user (NOT GITHUB_TOKEN), or release.yml
#     will not fire
#
# ENV
#   CAP_REPO         GitHub repo slug      (default: Xeonice/cloud-agent-platform)
#   CAP_GHCR_OWNER   GHCR namespace owner  (default: xeonice)
#
set -euo pipefail

REPO="${CAP_REPO:-Xeonice/cloud-agent-platform}"
OWNER="${CAP_GHCR_OWNER:-xeonice}"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="v$(jq -r '."."' .release-please-manifest.json)"
fi
[[ "$VERSION" == v* ]] || VERSION="v$VERSION"
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$VERSION' is not a semver tag" >&2
  exit 2
fi
echo "==> release $VERSION (repo $REPO, ghcr owner $OWNER)"

# Warn if the gh identity can't be confirmed as a real user/PAT. release.yml is
# `on: release: published`, which does NOT fire for a release created by the default
# GITHUB_TOKEN — it must be a PAT / user identity.
if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated — run 'gh auth login' with a PAT" >&2
  exit 1
fi
if ! gh auth status 2>&1 | grep -qiE "Logged in to github.com"; then
  echo "warning: could not confirm a non-GITHUB_TOKEN gh identity — release.yml may not fire" >&2
fi

# Create the Release (skip if it already exists — idempotent re-runs).
if gh release view "$VERSION" -R "$REPO" >/dev/null 2>&1; then
  echo "    release $VERSION already exists — skipping create"
else
  notes="$(sed -n "/## \[${VERSION#v}\]/,/## \[/p" CHANGELOG.md | sed '$d')"
  gh release create "$VERSION" -R "$REPO" --target main \
    --title "$VERSION" --notes "${notes:-Release $VERSION}"
  echo "    created release $VERSION"
fi

# Watch the release.yml run to success.
echo "==> waiting for release.yml build..."
sleep 6
RID="$(gh run list -R "$REPO" --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
if [[ -z "$RID" ]]; then
  echo "error: could not find a release.yml run — did the Release publish?" >&2
  exit 1
fi
gh run watch "$RID" -R "$REPO" --exit-status --interval 30 \
  || { echo "error: release.yml run $RID did not succeed" >&2; exit 1; }
echo "    release.yml run $RID success ✓"

# Verify ALL THREE images at the tag on GHCR (anonymous pull token; images are public).
echo "==> verify GHCR images at $VERSION"
fail=""
for pkg in cap-api cap-web cap-aio-sandbox; do
  tok="$(curl -fsS "https://ghcr.io/token?scope=repository:${OWNER}/${pkg}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/${OWNER}/${pkg}/manifests/${VERSION}")"
  echo "    $pkg:$VERSION -> HTTP $code"
  [[ "$code" == "200" ]] || fail=1
done
[[ -z "$fail" ]] || { echo "error: not all three images are present at $VERSION" >&2; exit 1; }

echo "==> release $VERSION done — all three images present"
echo "    next: on the prod host run  scripts/upgrade.sh $VERSION"
