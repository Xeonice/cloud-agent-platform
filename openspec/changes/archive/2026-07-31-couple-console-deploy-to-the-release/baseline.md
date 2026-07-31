# Pre-change baseline

Working tree at `83bb319`. Every figure here is a command's output, not a
recollection. Task 4.2 compares against it.

## The bypass, as it exists today (task 1.1)

```
vercel ls cap-web
  → production deployment, 14h old

vercel inspect https://cap-4jhl5p09o-xeonices-projects.vercel.app
  Aliases
    https://cap-web-kappa.vercel.app
    https://cap-console.douglasdong.com                     ← the operator's console
    https://cap-web-xeonices-projects.vercel.app
    https://cap-web-git-main-xeonices-projects.vercel.app   ← the tell
```

The last alias is the evidence. Vercel assigns the `…-git-<branch>-…` form to the
deployment a branch tracks; its presence on the PRODUCTION deployment is what says
production follows `main`. Nothing in `.github/workflows/` touches Vercel, so this
deploy is driven by Vercel's own git integration and passes through no release
gate.

## How far the two sides have drifted (task 1.1)

```
git tag --sort=-creatordate | head -1                      v0.46.1
git rev-list --count v0.46.1..HEAD                         19
git log --oneline v0.46.1..HEAD -- apps/web packages/contracts | wc -l    10
```

Ten of the nineteen commits past the newest tag touched the console or the shared
contract. Two of them moved a wire shape and removed the console's tolerance for
the old one:

- `81a115d` — `/runtimes` converged from `{ runtimes: [...] }` to the bare array
  its contract always declared, and `real.ts`'s both-branch tolerance was deleted
  with it.
- `83bb319` — the `/mcp-tokens` list envelope converged the same way.

So a console built from `main` against an api still on `v0.46.1` reads an empty
runtime list in the create-task dialog. This is not a hypothetical about the
repository split; it is the state of the two deployed surfaces today.

## The identity plumbing, per path (task 1.1)

```
IMAGE PATH   release.yml:222      VITE_BUILD_ID=${version}
             apps/web/Dockerfile:40  ARG VITE_BUILD_ID=dev
             vite.config.ts:38       define import.meta.env.VITE_BUILD_ID
             config.ts:249           buildId() → the release version          ✓

VERCEL PATH  apps/web/vercel.json    passes no build env
             config.ts:249           buildId() → "dev"                        ✗
```

`buildId()` has **zero callers**, which is why one path returning a real version
and the other returning a sentinel has never been visible to anything.

## What is already coordinated and needs no repair (task 1.1)

```
release.yml   one tag → one commit → cap-api · cap-web · cap-aio-sandbox · cap-boxlite-sandbox
compose       web profile pins cap-web:${CAP_VERSION}, the same variable as the api
```

A self-hosted stack therefore cannot skew. The guarantee the epic attributes to
the monorepo comes from here — the coordinated release — which is why one topology
never lost it and the other never had it.

## Suite counts to compare against (task 4.1)

```
api  test:compiled   1599 run / 1595 pass / 4 skipped
api  test:src         293 / 293
api  test:suite        26 /  25 / 1 skipped
contracts             236 / 236
web                   613 across 82 files
test:scripts          248 run / 246 pass / 2 skipped
repository gates      7, all passing
```
