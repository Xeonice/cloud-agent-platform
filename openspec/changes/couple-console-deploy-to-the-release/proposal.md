## Why

The release pipeline already does the right thing: one tag, one commit, four
images — `cap-api`, `cap-web`, `cap-aio-sandbox`, `cap-boxlite-sandbox` — and
`docker-compose.prod.yml` pins the console and the api to the same
`${CAP_VERSION}`. A self-hosted stack therefore *cannot* skew.

The console that is actually in front of an operator does not come from there.

```
cap-console.douglasdong.com
   └─ aliases the Vercel `cap-web` PRODUCTION deployment
        └─ production branch = main   (the deployment carries the
                                       `cap-web-git-main-…` alias Vercel only
                                       assigns when production tracks a branch)
```

So every merge to `main` publishes a console, bypassing the release workflow, the
tag, and `CAP_VERSION` entirely. Measured: the newest tag is `v0.46.1`, `main`
carries **19 commits past it**, and **at least 10 of those touched `apps/web` or
`packages/contracts`** — including two contract convergences that moved a wire
shape (`/runtimes` from `{ runtimes: [...] }` to a bare array) and deleted the
console's tolerance for the old one. A console built from `main` against an api
still on `v0.46.1` reads an empty runtime list in the create-task dialog.

This is not a risk the repository split would introduce later. It is the state
today, and the split only removes the last thing holding the other topology
together.

There is a second, quieter half. `VITE_BUILD_ID` is plumbed end to end on the
IMAGE path — `release.yml:222` passes it, `apps/web/Dockerfile:40` accepts it,
`vite.config.ts:38` defines it, `config.ts:249` reads it — and not at all on the
Vercel path, where `apps/web/vercel.json` passes no build env. The same
`buildId()` returns a real version in the image and the literal string `"dev"` in
the console anyone actually uses. Nothing has ever noticed, because `buildId()`
has **zero callers**.

## What Changes

- **The release becomes the only way a production console ships.** Vercel's
  git-driven production deploy is turned off for `main`; `release.yml` publishes
  the console after the image set verifies, with the release version passed as
  `VITE_BUILD_ID`. Preview deployments on pull requests are untouched — they are
  not production and never were.
- **The console tells the api which build it is**, on the REST path and on the
  WebSocket handshake, and the api compares it against its own version.
- **BREAKING (deployment, not wire)**: a mismatch fails closed. Under the
  invariant this change exists to establish — the two sides move together or not
  at all — a mismatch is a deployment defect, not a supported configuration, and
  serving through it is what produced the empty runtime list above.
- **The sentinel stops being a valid production answer.** `VITE_BUILD_ID`
  defaulting to `"dev"` is what let the Vercel path stay unplumbed and
  indistinguishable from a laptop build. Local development keeps the sentinel;
  a sentinel arriving from a deployed console is a failure.
- **`docs/repo-split-epic.md` §4 Phase 2 is rewritten.** It states that the
  "deployed api and deployed web agree" guarantee disappears at the moment of the
  split. The guarantee comes from the coordinated RELEASE, not from the monorepo —
  which is why one topology never had it and another keeps it after the split, so
  long as the umbrella tag keeps coordinating.

## Capabilities

### Modified Capabilities

- `release-and-versioning`: the release publishes the console, not only images;
  and the baked build id stops being allowed to fall back to a sentinel in a
  deployed build — a requirement written when nothing consumed it.
- `multi-target-deploy`: "independently deployable" is separated into its two
  senses. Web and api remain independently ADDRESSABLE — different origins, env
  configured, unchanged. They stop being independently VERSIONED.

## Impact

**Deployment wiring, mostly.** `apps/web/vercel.json` (disable the git production
deploy), `.github/workflows/release.yml` (one job publishing the console),
`apps/web/Dockerfile` (sentinel default). One repository secret — a Vercel token
plus the org/project ids — which the operator creates; this change writes only the
workflow that consumes it.

**Code, narrowly.** The console attaches its build id to REST requests and to the
WebSocket handshake URL — the same channel it already uses for the token, because
it does not send a connect frame at all — and the api compares and rejects a
mismatch. An api that does not read the added header or parameter ignores both,
which is the compatibility direction that matters while this rolls out.

**Verification.** The claim is that a production console can no longer ship
outside a release. That is proved by observing a merge to `main` produce no
production deployment, and a release produce one — not by reading the config.

**Non-Goals**

1. A per-schema compatibility negotiation. The invariant is that the two sides are
   the same build; comparing identity is a different and much smaller question
   than deciding what "compatible" means, and the epic's five-input audit of that
   question is superseded rather than implemented.
2. Moving the marketing site. `cap-www` is independently maintained and continues
   to deploy from `main`.
3. Upgrading the running host. The operator has said the stack will be rebuilt
   after the current refactor lands.
