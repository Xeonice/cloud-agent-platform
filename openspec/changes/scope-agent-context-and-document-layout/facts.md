# Derived facts

Everything below is read from source at `82b0b66`, not recalled. Tracks 2 and 3
write from this; task 4.3 checks against §3.

## 1. Subtree dependency facts (task 1.1)

| subtree | files | depends on | depended on by |
|---|---|---|---|
| `apps/api` | 454 | contracts, sandbox, sandbox-conformance | — |
| `apps/web` | 261 | contracts, ui | — |
| `packages/contracts` | 45 | — (tooling only) | web, api, sandbox-hooks, ui, sandbox |
| `packages/sandbox` | 40 | contracts, sandbox-{core,cloud-http,environment,provider-aio,provider-boxlite,conformance} | api |

All four expose `build`, `typecheck`, `lint`, `test`.

**`apps/api` and `apps/web` are depended on by nothing.** Neither is importable;
both are leaves. `contracts` is the only package both sides share.

### Boundaries already enforced by gates

These are not invented for the instruction files — they are the reasons emitted by
`apps/api/src/sandbox/sandbox-package-boundary.test.mjs` and its siblings:

- concrete provider factories belong in `@cap-console/sandbox` or provider packages
- Docker/provider lifecycle must not be implemented in API sandbox or terminal code
- provider env and family parsing must stay behind the sandbox host harness
- provider terminal clients/transports must live behind the sandbox terminal harness
- provider protocol strings must not be registered or switched on in API
- API must not export an AIO provider class
- `@cap-console/sandbox-environment` must stay provider-neutral and framework-free
- api may import `@cap-console/sandbox` but **not** `@cap-console/sandbox-*` sub-packages

`apps/web` has **no** boundary gate. Its only structural constraint is the package
graph: it depends on `contracts` and `ui`, and cannot reach `apps/api`.

## 2. Product layout (task 1.2)

### Published images (`release.yml`)

```
ghcr.io/xeonice/cap-api             ← apps/api        (Dockerfile)
ghcr.io/xeonice/cap-web             ← apps/web        (Dockerfile)
ghcr.io/xeonice/cap-aio-sandbox     ← sandbox image
ghcr.io/xeonice/cap-boxlite-sandbox ← sandbox image
```

### `docker-compose.prod.yml` services

| service | image | profile |
|---|---|---|
| api | cap-api | **always** |
| postgres | postgres:16-alpine | **always** |
| aio-sandbox-image | cap-aio-sandbox | **always** |
| web | cap-web | `["web"]` — optional |
| loki, grafana-alloy | — | `["observability"]` — optional |
| grafana | — | `["grafana"]` — optional |

**The minimum deployable unit is api + Postgres + a sandbox image.** The console is
opt-in. This is the fact that is currently only discoverable from compose comments.

### Non-container deployment units

- `apps/www` → Vercel (`vercel.json`)
- `apps/release-cache-worker` → Cloudflare Worker (`wrangler.toml`)

Neither shares any dependency with the product packages.

## 3. CI cost and job classification (task 1.3)

Timings from the most recent `main` run. **That run had six jobs; this branch has
seven** — `package suites` was added in `43aca22` and has not run in CI yet, so it
has no measured cost.

| job | min | starts Postgres | subject | conditionable |
|---|---|---|---|---|
| typecheck + lint + test | 4.8 | no | whole repo (`turbo build/typecheck/lint`) | **no** |
| scheduled tasks browser e2e | 2.2 | no | web **and** api together | **no** |
| public-surface-parity | 1.8 | no | api `/v1` + MCP registries | yes |
| boot-smoke | 1.7 | **yes** | boots api against a database | yes |
| task model N-1 compatibility | 0.9 | no | api + prisma | yes |
| task admission migration compatibility | 0.8 | **yes** | api + prisma + database | yes |
| package suites | — | no | `./packages/*` only | *see below* |
| **total measured** | **12.2** | | | |

Conditionable **by subject**: 5.2 runner-min, 43% of measured cost.

### Correction after task 3.2 — subject is not the only constraint

`main` requires two status checks: **`typecheck + lint + test`** and
**`public-surface-parity`**. The second is conditionable by subject and is *not*
conditionable in fact: a required check that is skipped rather than reported
leaves the merge permanently pending. That is the same class of silent failure as
an unconditioned job burning minutes — in the opposite direction, and worse,
because it blocks rather than wastes.

So the classification needed a second column, and the achievable saving is
smaller than §3 first stated:

| job | min | conditionable by subject | required check | conditioned |
|---|---|---|---|---|
| task model N-1 compatibility | 0.9 | yes | no | **yes** |
| task admission migration compatibility | 0.8 | yes | no | **yes** |
| boot-smoke | 1.7 | yes | no | **yes** |
| public-surface-parity | 1.8 | yes | **YES** | no — would block merges |
| typecheck + lint + test | 4.8 | no | **YES** | no |
| scheduled tasks browser e2e | 2.2 | no | no | no |
| package suites | — | yes | no | no — see below |

**Achievable saving: 3.4 runner-min** on a change that cannot reach the api,
against a new `changes` job whose cost has not been measured (it checks out with
full history and runs one `git diff`; no CI run has included it yet).

The gap between 5.2 and 3.4 is not a misclassified subject — `public-surface-parity`
really is api-only. It is a constraint the subject analysis did not model at all,
found by checking branch protection before editing rather than after.

`package suites` is **deliberately left unconditioned** despite qualifying by
subject. It filters `./packages/*`, which an `apps/`-only change cannot affect, but
it is also sensitive to lockfile and root-config edits — which are common and easy
to mis-classify — and it has no measured cost to weigh against that risk. Revisit
once it has run.

There are no job-level conditions today: the three `if:` in `ci.yml` are all
`always()` on artifact-upload steps.

---

## 4. What this change did and did not address (task 4.4)

The epic (`docs/repo-split-epic.md` §5) records: *«Phase 0 做完可能发现痛点已大幅
缓解 — 这是好结果。届时重新评估 Phase 1–4 是否仍值得。»* This section is the
evidence that re-evaluation runs against.

### Addressed

| motivation | before | after |
|---|---|---|
| ① agent context bleed | 0 instruction files; 16 packages, 908 files, no scope | 4 directory-scoped files stating boundary, dependency limits, cross-subtree routing, and verification commands |
| ② «说不清什么是什么» | product layout undocumented; console optionality only in compose comments | `docs/product-layout.md`, cross-linked with the tooling guide |
| ③ deploy api without the console | already true, undiscoverable | stated, with the command |

### Not addressed, and why

**Instruction files are read, not obeyed.** This change narrows what an agent is
*told*; it cannot bind what an agent *does*. Motivation ① asked for physical
isolation, and this is the soft form of it. Whether soft is enough is the question
Phase 1–4 exist to answer, and only using these files answers it.

**The api subtree is still 454 files.** Scoping to `apps/api` removes `apps/web`,
`packages/*` and the console's 261 files from an agent's world — but the largest
single subtree is unchanged. A sub-repository would not change that either; only
decomposition within the api would.

**43% of CI cost was targeted; 28% was reachable.** `public-surface-parity` is
api-only by subject and unconditionable in practice because it is a required
status check (§3). The split does not fix this: six repositories each with their
own required checks have the same constraint.

### What the epic should weigh

Two of the three motivations are now met without any restructuring — ② and ③ were
documentation gaps, and ① is met in its soft form. What a split still buys is
**hard** isolation: an agent that cannot read `apps/api` because those files are
not on disk, rather than one told not to.

That is a real difference and this change cannot substitute for it. It does mean
the question in front of Phase 1–4 has narrowed from *«three problems»* to one:
**is soft scoping insufficient in practice?** That is answerable by working this
way for a while, and it is cheaper to answer than to assume.
