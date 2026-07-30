## Context

Measured on the working tree at `82b0b66`:

```
CLAUDE.md / AGENTS.md anywhere in the repo        0
workspace packages                               16
source files / lines                            908 / 270,676
`runtime` search hits    api 228 · web 58 · contracts 36 · sandbox 22

ci.yml jobs                                       6
ci.yml `paths` filters                            0
ci.yml job-level conditions                       0   (the three `if:` are
                                                       `always()` on artifact steps)
last run                                       12.2 runner-min
  of which api/database-only                    5.2 runner-min
```

`docs/repo-layout.md` exists and is good at what it does — it documents `.claude/`
and `openspec/`. It contains nothing about `apps/` or `packages/`.

`docker-compose.prod.yml` already puts `web` behind `profiles: ["web"]` and calls
api + Postgres «the CORE run unit». That fact is currently discoverable only by
reading the compose file's comments.

## Goals / Non-Goals

**Goals:**

- An agent working in one subtree can tell, without reading the others, what that
  subtree owns and what it must not touch.
- A self-hoster can tell what to deploy and what is optional without reading
  compose comments.
- CI runs the jobs a change can affect.

**Non-Goals:**

- Any repository restructuring, publishing, or renaming.
- A root `CLAUDE.md` (see D1).
- Reducing coverage for changes that do reach api or database paths.

## Decisions

### D1 — Directory-scoped instructions, and deliberately no root file

Instructions live at `apps/api/`, `apps/web/`, `packages/contracts/`, and
`packages/sandbox/`. There is no root `CLAUDE.md`.

A root file would describe all sixteen packages to every agent regardless of what
it was asked to do, which is exactly the situation being fixed. The value here is
not "write down what the repo is" — it is "make the answer depend on where you
are".

Four locations, not sixteen: `sandbox-core`, `sandbox-provider-aio`,
`sandbox-provider-boxlite`, `sandbox-cloud-http`, `sandbox-environment` and
`sandbox-conformance` are one concern behind one port, and `tsconfig` /
`eslint-config` are 77 and 81 lines. One file at `packages/sandbox/` covers the
cluster; more files would be more surface without more scope.

*Alternative rejected — a root file plus per-directory overrides.* Nested files
are additive, so the root's content reaches every agent anyway.

### D2 — Each file states a boundary, not a summary

The failure mode for this kind of file is a description of the subtree that reads
well and changes no behaviour. What makes an agent's context narrower is knowing
what is **not** its business, so each file states four things:

1. what this subtree is, in one or two sentences
2. what it may depend on — and, explicitly, what it must not reach into
3. where the things it is likely to look for actually live, when they live
   elsewhere
4. how to verify a change to it, as commands

Point 3 is what the `runtime`-search measurement argues for: an agent in `apps/web`
searching for runtime handling should be told the vocabulary is declared in
`@cap-console/contracts` and the implementations live in `apps/api`, rather than
finding 58 local hits and inferring.

*Alternative rejected — document architecture in these files.* That belongs in
specs, which already carry it. These files route; they do not explain.

### D3 — The product layout is a sibling document, not an edit

`docs/repo-layout.md` documents the tooling buckets and does it correctly. The
product layout goes in `docs/product-layout.md`, cross-linked, because the two
answer different questions for different readers: one is «how does this
repository's workflow work», the other is «what is this software made of and what
do I have to run».

Merging them would produce one document that is the first thing a contributor
reads and the first thing a self-hoster reads, serving neither.

### D4 — CI conditions are proven by a skip, not by a parse

Adding `paths` to a job is the kind of edit that can silently reduce coverage: a
filter that never matches makes a job a no-op that still reports success, and the
absence of a failure looks identical to a pass.

So acceptance is not «the workflow parses» or «CI is green». It is, per job
touched: **a case where it runs and a case where it is skipped**, both observed.
Until both are observed the job's condition is unproven.

This repository has a required-check configuration on `main`. A job that is
skipped rather than run must remain compatible with that configuration — a
required check that never reports is a merge that can never happen, which is the
opposite failure and just as silent.

*Alternative rejected — leave CI alone and let the split fix it.* The split does
not fix it; six repositories with unconditioned CI each is the same waste
distributed. And the epic explicitly wants to know whether cheap fixes remove the
pain before the expensive ones are scheduled.

### D5 — What is out of scope for the conditions

`typecheck + lint + test` and `scheduled tasks browser e2e` keep running
unconditionally. The first covers every package, so any change can affect it. The
second drives a browser against a live api, so both a web change and an api change
can break it.

The four conditioned are the ones whose subject is unambiguous:
`public-surface-parity`, `task model N-1 compatibility`, `task admission migration
compatibility`, `boot-smoke` — each reads api sources or a database and cannot be
affected by a docs-only or console-only change.

## Risks / Trade-offs

- **[A condition that never matches turns a job into a silent pass]** → D4. Both
  branches observed per job; nothing accepted on a parse.

- **[A skipped job blocks a required check]** → Checked against the branch
  protection configuration as part of acceptance, not assumed.

- **[The instruction files drift from the code]** → They state boundaries and
  verification commands, not architecture (D2), so the things most likely to drift
  are not in them. Where a file names a path or a command, that path or command is
  verified to exist at acceptance.

- **[Instruction files are read but not followed]** → Real and unfixable here.
  This change narrows what an agent is told; it cannot bind what an agent does.
  The epic's hard isolation is a different instrument for the same goal, and this
  change is deliberately the cheap one that comes first.

## Migration Plan

None. No runtime, deployment, or wire-format change. The CI conditions take effect
on the next pull request; rollback is a revert.

## Open Questions

None blocking. Whether these files sufficiently reduce the context bleed is the
question the epic wants answered, and it is answered by using them, not by
deciding it here.
