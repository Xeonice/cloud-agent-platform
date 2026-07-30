# Product Layout Guide

What this software is made of, and what you have to run.

Its sibling, [`repo-layout.md`](./repo-layout.md), answers a different question —
how this repository's spec-and-change workflow is organised. If you came looking
for `openspec/` or `.claude/`, that is the guide you want.

## The shape

```
apps/
├── api                    the orchestrator — accepts tasks, provisions a sandbox
│                          per task, runs an agent in it, settles the result
├── web                    the operator console
├── www                    the public marketing site
├── sandbox-hooks          hooks that run inside a sandbox
└── release-cache-worker   a caching edge worker for release metadata

packages/
├── contracts              THE shared protocol — schemas, types, the WebSocket
│                          frame vocabulary. Both api and web depend on it
├── ui                     console component library (web only)
├── sandbox                the sandbox provider facade — api imports only this
│   ├── sandbox-core           the port every provider implements
│   ├── sandbox-provider-aio   ┐
│   ├── sandbox-provider-boxlite│ implementations
│   ├── sandbox-cloud-http      ┘
│   ├── sandbox-environment    provider-neutral environment model
│   └── sandbox-conformance    the suite every provider must pass
├── tsconfig               shared TypeScript config
└── eslint-config          shared lint config
```

Two facts about that graph are worth stating because they are easy to assume
wrongly:

**`api` and `web` do not depend on each other.** They never have. They share
`contracts` — both depend on it, neither depends on the other.

**`api` and `web` are leaves.** Nothing imports them. Everything reusable is in
`packages/`.

## What deploys

| unit | artifact | where |
|---|---|---|
| api | `ghcr.io/xeonice/cap-api` | container |
| console | `ghcr.io/xeonice/cap-web` | container |
| AIO sandbox | `ghcr.io/xeonice/cap-aio-sandbox` | container image tasks run in |
| BoxLite sandbox | `ghcr.io/xeonice/cap-boxlite-sandbox` | container image tasks run in |
| marketing site | static build | Vercel |
| release cache worker | worker bundle | Cloudflare |

`packages/*` are libraries. They ship inside the images above; none deploys on its
own.

## What you actually have to run

**The minimum is the api, a Postgres, and a sandbox image.** That is the core unit
in `docker-compose.prod.yml`, and it is enough to accept and run tasks through the
API and MCP surfaces.

Everything else is a profile:

| profile | what it adds | required? |
|---|---|---|
| — | api · postgres · aio-sandbox-image | **yes** |
| `web` | the operator console | no |
| `observability` | Loki + Grafana Alloy | no |
| `grafana` | Grafana | no |

```bash
# core only — API and MCP, no console
docker compose -f docker-compose.prod.yml up -d

# with the console
docker compose -f docker-compose.prod.yml --profile web up -d
```

**The console is optional on purpose.** A deployment driven entirely through the
public `/v1` API or MCP does not need it, and running without it removes a
container and a published port. This is the single fact this guide exists to
state — it was previously discoverable only by reading compose comments.

The marketing site and the release cache worker are not part of a deployment at
all. They serve this project's own website and release metadata, share no code
with the product, and a self-hoster never runs them.

## Where to look

| question | place |
|---|---|
| how do I self-host this | [`self-hosting.md`](./self-hosting.md) |
| how is the repo's workflow organised | [`repo-layout.md`](./repo-layout.md) |
| what is this subtree's boundary | the `CLAUDE.md` at its root |
| what does the system guarantee | `openspec/specs/` |
