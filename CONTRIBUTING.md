# Contributing

This repository is developed spec-first using a project-local OpenSpec flow
enhanced with multi-agent Workflow orchestration. Contributions move through a
documented lifecycle rather than ad-hoc pull requests: you propose a change,
generate its artifacts, implement it track-by-track, verify it against its
specs, and archive it.

This guide orients you to that flow and routes you to the real tooling. It
deliberately does **not** restate canonical detail — it links to the source of
truth (`.claude/workflows/README.md`, the slash commands, their backing skills,
and the schema) so the docs cannot drift out of sync.

## Table of Contents

- [The OpenSpec lifecycle](#the-openspec-lifecycle)
- [How to propose a change](#how-to-propose-a-change)
- [Public V1/MCP surface parity](#public-v1mcp-surface-parity)
- [Tooling](#tooling)
- [Conventions](#conventions)
- [Track convention](#track-convention)
- [How things run](#how-things-run)
- [Scheduled-task E2E](#scheduled-task-e2e)

## The OpenSpec lifecycle

Every contribution flows through these five ordered steps:

1. **Propose** — Describe the change you want to make. A new change directory is
   created under `openspec/changes/<change-name>/` with a `proposal.md`.
2. **Create Artifacts** — Generate the supporting artifacts for the change:
   `design.md`, the delta `specs/`, and a track-annotated `tasks.md`.
3. **Implement** — Work through the tasks in `tasks.md`, checking each one off as
   it is completed.
4. **Verify** — Prove every spec requirement is satisfied before the change can
   be archived. Unmet requirements route back to tasks; defects route back to
   design.
5. **Archive** — Once verification passes, finalize the change and move it into
   `openspec/changes/archive/`.

These steps map directly onto the tooling described below.

## How to propose a change

Start a new change with the propose tooling rather than hand-creating files.
This scaffolds the change directory and its initial artifacts in one step. See
[Tooling](#tooling) for the exact entry points, and [Track
convention](#track-convention) for how to author the resulting `tasks.md`.

If you are still figuring out *what* to build, explore first (see
`/opsx:explore` below) before committing to a proposal.

## Public V1/MCP surface parity

Every feature change must explicitly decide whether it affects Public V1, MCP,
OpenAPI, API Playground, or internal-only behavior. This is a decision rule, not
a requirement to expose every feature publicly: an internal-only feature is
valid, but an omitted public-surface decision is not.

Record the decision in `openspec/changes/<change-name>/surface-impact.json` while
proposing the change. The sidecar is change-local and does not add an artifact
to the OpenSpec dependency graph. Classify every surface with one of these
statuses:

| Status | Use it when |
| --- | --- |
| `changed` | The surface's contract or implementation changes. Include affected stable operation/tool ids or a declared registry-wide scope. |
| `unchanged` | The surface was considered and remains unchanged. Explain why the feature does not alter it. |
| `derived` | The surface is regenerated or projected from a changed canonical contract. Include affected ids or scope; do not maintain a second handwritten contract. |
| `excluded` | The capability is intentionally absent from that protocol. Set a non-empty `protocolReason` and identify the stable operation in the difference declaration. |
| `not-applicable` | The surface does not apply to the feature. Give a concrete reason rather than a generic placeholder. |

Every status requires a non-empty `reason`. A Public V1 change must either
declare the corresponding MCP mapping/change or an explicit MCP exclusion; an
MCP-only change must make the inverse decision. Put REST-only headers, streaming
exclusions, flattened inputs, compatibility envelopes, and non-identity outputs
in `protocolDifferences`, keyed by stable operation id. A projection means the
protocol representation deliberately differs while the normalized capability
stays equivalent; it must not become an undocumented schema copy.

Use this sequence during development:

1. Name the semantic capability and its stable operation/tool ids.
2. Complete all five surface decisions in `surface-impact.json`, including
   reasons, affected ids/scope, and any exclusions or projections.
3. Keep the canonical registry/schema and its Public V1, MCP, OpenAPI, and
   Playground consumers in the same Track or connect them with explicit Track
   dependencies.
4. Run the focused parity command while iterating, then run the full verifier
   before push or integration.

The following examples show the decision, not a replacement for the validated
sidecar schema:

| Feature | Surface decision |
| --- | --- |
| Mapped public field on `tasks.create` | Mark Public V1 and MCP `changed`; mark OpenAPI and API Playground `derived`; name `tasks.create` and its tool mapping. Update the canonical wire/parse schema and both transport bindings together. |
| Worker-local cache tuning | Mark internal-only behavior `changed`; mark Public V1, MCP, OpenAPI, and API Playground `not-applicable`, each with a concrete reason. Do not invent an endpoint or tool. |
| Lifecycle SSE on `tasks.events` | Mark Public V1 `changed`, OpenAPI `derived`, and MCP `excluded`; add a `tasks.events` MCP-exclusion difference explaining why a request-response tool does not represent the stream. Classify API Playground according to its real projection and give the reason. |

### Task verification metadata

Each task checkbox must be followed by machine-readable requirement, surface,
and verifier metadata. For example:

```md
- [ ] 2.3 Generate MCP registration from the capability registry.
  - requirements: ["api-mcp-development-parity/transport-bindings-are-exhaustive"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "public-surface-fast"
```

`requirements` uses `<capability>/<normalized-requirement-name>`, `surfaces`
names every area the task can affect, and `verify` is an id from the
repository-owned verifier allowlist. It is not shell text: apply resolves the id
to fixed arguments and must not execute a command copied from Markdown. Change a
task to `[x]` only after its declared verifier succeeds.

The sidecar/task validator and verifier allowlist are canonical in
[`scripts/openspec-metadata.mjs`](scripts/openspec-metadata.mjs). Use the
repository-owned ids defined there; do not duplicate its command mapping in
`tasks.md` or this guide.

### Local parity commands

Use the infrastructure-free focused suite while editing public contracts,
registry entries, transport bindings, OpenAPI, or Playground projections:

```bash
pnpm test:public-surface
```

It checks the contracts, real Public V1 handler metadata, MCP SDK registration
and results, OpenAPI, Playground, and declared protocol differences without a
database, container, credential, network call, or listening port.

Before push or final integration, run the full gate:

```bash
pnpm verify:public-surface
```

The full command adds declared build/code-generation prerequisites, downstream
typechecks, and OpenSpec metadata validation before reusing the focused suite.
Local hooks and CI call these same root commands rather than maintaining their
own test inventories.

For the canonical orchestration and enforcement behavior, read the [workflow
overview](.claude/workflows/README.md), the propose skill for
[Claude](.claude/skills/openspec-propose/SKILL.md) or
[Codex](.codex/skills/openspec-propose/SKILL.md), and the apply skill for
[Claude](.claude/skills/openspec-apply-change/SKILL.md) or
[Codex](.codex/skills/openspec-apply-change/SKILL.md). This guide intentionally
does not duplicate their implementation detail.

## Tooling

All contribution work goes through four OpenSpec slash commands. Use these
instead of a generic PR flow:

| Slash command   | Phase                       | Backing command file              |
| --------------- | --------------------------- | --------------------------------- |
| `/opsx:explore` | think through ideas first   | `.claude/commands/opsx/explore.md` |
| `/opsx:propose` | Propose + Create Artifacts  | `.claude/commands/opsx/propose.md` |
| `/opsx:apply`   | Implement (+ Verify gate)   | `.claude/commands/opsx/apply.md`   |
| `/opsx:archive` | Archive                     | `.claude/commands/opsx/archive.md` |

The command definitions live under `.claude/commands/opsx/`. Each command is a
thin entry point that invokes a backing skill under `.claude/skills/` — for
example `.claude/skills/openspec-propose/`, `.claude/skills/openspec-apply-change/`,
`.claude/skills/openspec-archive-change/`, and `.claude/skills/openspec-explore/`.
Read the skill's `SKILL.md` for the authoritative behavior of each command.

## Conventions

- **Spec-first** — changes are described in `openspec/changes/` before code is
  written; the specs are the contract that verification checks against.
- **Single-source canonical detail** — these docs link to the source of truth
  rather than copying it, so update the source, not a restatement.
- **Lowercase-hyphenated file names** for net-new files, matching existing repo
  convention.
- **Track-annotated tasks** — `tasks.md` groups work into parallelizable Tracks;
  see the [Track convention](#track-convention) for the exact format.

## Track convention

Tasks in a change's `tasks.md` are grouped into **Tracks**. Independent tracks
run in parallel at apply time; tasks within a track run serially and resume off
the `[x]` checkbox ledger.

A track header takes the form:

```
## N. Track: <name> (depends: <track>|none)
```

where `N` is the track number and `(depends: ...)` declares its dependency on
another track (or `none`). Each task under the header uses the checkbox form:

```
- [ ] N.Y <task description>
```

where `N` is the track number and `Y` is the task's position within the track.
A finished task flips `- [ ]` to `- [x]`.

Do not restate the full rules here — they are canonical in
[`.claude/workflows/README.md`](.claude/workflows/README.md) and enforced by the
schema under [`openspec/schemas/spec-driven/`](openspec/schemas/spec-driven/).
Refer to those when authoring tasks.

## How things run

The slash commands are thin executors; the real orchestration lives in
`.claude/workflows/`. Project-local Claude/Codex skill mirrors add metadata
preflight, while the schema override points the skills at the workflow engines;
neither layer changes the OpenSpec CLI or artifact dependency graph.

For the full workflow table, the apply-time parallelism threshold, and the
wiring between the schema override and the orchestration engines, see
[`.claude/workflows/README.md`](.claude/workflows/README.md). It is the source of
truth for how propose, apply, and verify actually execute.

## Scheduled-task E2E

Use the isolated browser verifier when changing schedule dispatch, task
admission, authentication, audit, or the schedules console:

```bash
pnpm test:e2e:schedules:local
```

The command requires Docker and an installed Playwright Chromium. Docker assigns
the disposable Postgres port, the API and control servers bind ephemeral ports,
and a short-lived socket reservation protects the web port until Vite binds it.
The runner applies every migration and boots the real API and web console. API
workspace builds, Prisma generation, and migrations run with an explicit empty
environment; Prisma uses a copied schema and `package.json` under the run's
artifact directory. The runner therefore does not use the normal CAP ports,
`apps/api/.env`, `apps/web/.env`, operator credentials, or an existing database.
The sandbox boundary is a test-only recording provider; TasksService,
Guardrails, the poller, controllers, authentication, Prisma, and audit recording
remain real.

For the slower real-minute check, run:

```bash
SCHEDULE_E2E_WALL_CLOCK=1 pnpm test:e2e:schedules:local
```

On failure the command prints the artifact directory containing sanitized API,
web, Postgres, database-state, screenshot, video, and trace evidence.
`SCHEDULE_E2E_ARTIFACT_DIR` is an artifact root: relative values are resolved
against the invocation directory, and every invocation always creates a unique
`<root>/<run-id>` child with an ownership marker before it can delete that child.
If artifact sanitization fails, the runner discards browser traces and runtime
logs instead of retaining raw evidence. Set `KEEP_E2E_STACK=1` to retain only
this invocation's resources for inspection; the runner prints the real Node
process IDs, owned container name, and an exact cleanup command without
placeholder PIDs. The fast real-Postgres scheduler gate remains available as
`pnpm test:integration:schedules` and requires an explicitly supplied disposable
`DATABASE_URL`.
