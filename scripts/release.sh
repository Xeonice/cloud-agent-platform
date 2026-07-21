#!/usr/bin/env bash
#
# release.sh — the post-merge MECHANICAL TAIL of a release (add-release-upgrade-scripts,
# design D3). Given a target version (arg or the bumped manifest), it: creates the
# GitHub Release (so release.yml fires), watches the image build to success, and
# verifies all release images, sandbox image assets, AND the build-matched
# task-model attestation asset are present (and the attestation valid) at the tag.
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
#   - Docker is available to execute the published cap-api runtime dependency
#     smoke after the registry tag checks pass
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
RID="$(gh run list -R "$REPO" --workflow release.yml --branch "$VERSION" --event release \
  --limit 1 --json databaseId --jq '.[0].databaseId')"
if [[ -z "$RID" ]]; then
  echo "error: could not find a release.yml run — did the Release publish?" >&2
  exit 1
fi
gh run watch "$RID" -R "$REPO" --exit-status --interval 30 \
  || { echo "error: release.yml run $RID did not succeed" >&2; exit 1; }
echo "    release.yml run $RID success ✓"

# Verify release images at the tag on GHCR (anonymous pull token; images are public).
echo "==> verify GHCR images at $VERSION"
fail=""
for pkg in cap-api cap-web cap-aio-sandbox cap-boxlite-sandbox; do
  tok="$(curl -fsS "https://ghcr.io/token?scope=repository:${OWNER}/${pkg}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://ghcr.io/v2/${OWNER}/${pkg}/manifests/${VERSION}")"
  echo "    $pkg:$VERSION -> HTTP $code"
  [[ "$code" == "200" ]] || fail=1
done
[[ -z "$fail" ]] || { echo "error: not all release images are present at $VERSION" >&2; exit 1; }

# A registry manifest alone cannot prove the final runtime layer contains the
# executable used by authenticated remote-ref resolution. Pull the exact
# versioned API tag, execute Git, and invoke the same compiled startup preflight
# that bootstrap uses. The verifier never emits captured container diagnostics.
echo "==> verify published cap-api Git runtime at $VERSION"
node scripts/cap-api-image-smoke.mjs \
  --image "ghcr.io/${OWNER}/cap-api:${VERSION}" \
  --pull always || {
    echo "error: published cap-api:${VERSION} is missing its required Git runtime dependency" >&2
    exit 1
  }

echo "==> verify sandbox image Release assets at $VERSION"
required_assets=(
  docker-compose.prod.yml
  docker-compose.prod.env.example
  cap-image-assets.json
)
release_assets_json="$(gh release view "$VERSION" -R "$REPO" --json assets)"
asset_names="$(jq -r '.assets[].name' <<< "$release_assets_json")"
for asset in "${required_assets[@]}"; do
  if printf '%s\n' "$asset_names" | grep -Fxq "$asset"; then
    echo "    $asset -> present"
  else
    echo "    $asset -> missing" >&2
    fail=1
  fi
done

manifest_dir="$(mktemp -d "${TMPDIR:-/tmp}/cap-release-manifest.XXXXXX")"
trap 'rm -rf "$manifest_dir"' EXIT
gh release download "$VERSION" -R "$REPO" \
  --pattern cap-image-assets.json --dir "$manifest_dir" --clobber >/dev/null
manifest_path="$manifest_dir/cap-image-assets.json"
manifest_assets="$(node scripts/release-image-assets.mjs list \
  --version "$VERSION" --manifest "$manifest_path")" || {
  echo "error: invalid cap-image-assets.json for $VERSION" >&2
  exit 1
}
while IFS= read -r asset; do
  [[ -n "$asset" ]] || continue
  if printf '%s\n' "$asset_names" | grep -Fxq "$asset"; then
    echo "    $asset -> present"
  else
    echo "    $asset -> missing" >&2
    fail=1
  fi
done <<< "$manifest_assets"

manifest_data_assets="$(jq -er '
  .assets[] |
    (if ((.parts // []) | length) > 0 then
      .parts[]
    else
      { asset: .asset, sha256: .sha256, sizeBytes: .sizeBytes }
    end) |
    [.asset, .sha256, (.sizeBytes | tostring)] | @tsv
' "$manifest_path")" || {
  echo "error: cap-image-assets.json does not contain physical asset digests" >&2
  exit 1
}
while IFS=$'\t' read -r asset expected_digest expected_size; do
  remote="$(jq -r --arg name "$asset" \
    '.assets[] | select(.name == $name) | [.digest, (.size | tostring)] | @tsv' \
    <<< "$release_assets_json" | head -1)"
  IFS=$'\t' read -r remote_digest remote_size <<< "$remote"
  if [[ "$remote_digest" == "sha256:${expected_digest}" && "$remote_size" == "$expected_size" ]]; then
    echo "    $asset -> digest and size verified"
  else
    echo "    $asset -> digest/size mismatch" >&2
    fail=1
  fi
done <<< "$manifest_data_assets"
[[ -z "$fail" ]] || { echo "error: not all sandbox image Release assets are present at $VERSION" >&2; exit 1; }

# Fail-closed task-model attestation verification (automate-task-model-
# attestation-in-ci): the release images were proven present above, so the
# build-matched attestation asset MUST be present, checksum-clean, valid
# against the unchanged contracts schema, and carry a buildIdentity equal to
# the GIT_SHA baked into the published cap-api image.
echo "==> verify task-model attestation asset at $VERSION"
attestation_asset="cap-task-model-attestation-${VERSION}.json"
attestation_checksum_asset="${attestation_asset}.sha256"
for asset in "$attestation_asset" "$attestation_checksum_asset"; do
  if printf '%s\n' "$asset_names" | grep -Fxq "$asset"; then
    echo "    $asset -> present"
  else
    echo "    $asset -> missing" >&2
    fail=1
  fi
done
[[ -z "$fail" ]] || {
  echo "error: release images are present but the task-model attestation asset is missing at $VERSION" >&2
  exit 1
}

gh release download "$VERSION" -R "$REPO" \
  --pattern "$attestation_asset" --pattern "$attestation_checksum_asset" \
  --dir "$manifest_dir" --clobber >/dev/null

# The attested buildIdentity must match the GIT_SHA the published cap-api image
# actually bakes (the value `GET /version` reports as gitSha) — read it from
# the exact versioned tag already pulled by the image smoke above.
image_git_sha="$(docker run --rm --pull=never --platform linux/amd64 \
  --entrypoint /usr/local/bin/node "ghcr.io/${OWNER}/cap-api:${VERSION}" \
  -e 'process.stdout.write(process.env.GIT_SHA ?? "")')" || {
  echo "error: could not read the baked GIT_SHA from published cap-api:${VERSION}" >&2
  exit 1
}

CAP_ATTESTATION_PATH="$manifest_dir/$attestation_asset" \
CAP_ATTESTATION_CHECKSUM_PATH="$manifest_dir/$attestation_checksum_asset" \
CAP_EXPECTED_BUILD_IDENTITY="$image_git_sha" \
node --input-type=module - <<'NODE' || { echo "error: task-model attestation asset for $VERSION failed verification (checksum/schema/buildIdentity)" >&2; exit 1; }
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const assetPath = process.env.CAP_ATTESTATION_PATH;
const bytes = readFileSync(assetPath);
const digest = createHash('sha256').update(bytes).digest('hex');
const checksumLine = readFileSync(process.env.CAP_ATTESTATION_CHECKSUM_PATH, 'utf8').trim();
if (checksumLine !== `${digest}  ${basename(assetPath)}`) {
  console.error(`attestation checksum mismatch for ${basename(assetPath)}`);
  process.exit(1);
}
const { validateAttestation } = await import(
  new URL('scripts/generate-task-model-attestation.mjs', pathToFileURL(`${process.cwd()}/`)).href
);
const attestation = await validateAttestation(JSON.parse(bytes.toString('utf8')));
const expected = process.env.CAP_EXPECTED_BUILD_IDENTITY ?? '';
if (!/^[0-9a-f]{40}$/.test(expected)) {
  console.error(`published cap-api did not report a full 40-hex baked GIT_SHA: ${JSON.stringify(expected)}`);
  process.exit(1);
}
if (attestation.reports.some((report) => report.buildIdentity !== expected)) {
  console.error('attestation buildIdentity does not match the published cap-api baked GIT_SHA');
  process.exit(1);
}
console.log(`    ${basename(assetPath)} -> checksum, schema, and buildIdentity verified`);
NODE

echo "==> release $VERSION done — release images, sandbox image assets, and task-model attestation verified"
echo "    next: on the prod host run  scripts/upgrade.sh $VERSION"
