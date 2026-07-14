# Research Brief: API/MCP Development Parity

## Research question

How can future feature work be constrained during development so the public
`/v1` API, MCP tools, OpenAPI, and API Playground evolve from the same product
contract, while still allowing explicit protocol-specific differences?

## Route 1: External practices and protocol constraints

### Findings

- The MCP tool contract is not only a tool name. The official specification
  exposes `inputSchema`, optional `outputSchema`, and structured results; when an
  output schema is advertised, the server result must conform to it. Inventory
  parity alone therefore cannot prove API/MCP parity.
  Source: <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- MCP input and output schemas are JSON Schema contracts. This favors deriving
  both transports from the same field-owning schema instead of copying Zod raw
  shapes into tool registration. Complex validation may still need a separate
  parse/refinement layer derived from that wire shape.
  Source: <https://modelcontextprotocol.io/seps/2106-json-schema-2020-12>
- TypeScript's `satisfies` operator validates that a mapping is complete while
  preserving literal inference. A literal-preserving operation tuple plus a
  `satisfies Record<MappedOperationId, Adapter>` map can make a newly declared
  MCP operation fail typecheck until its adapter exists.
  Source: <https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html>
- CI only becomes an effective merge constraint when the parity job is a
  required status check. The repository command and CI job should therefore
  have a stable name that branch protection can require.
  Source: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>

### Implication for this repository

Use generation where transport metadata is truly shared, use exhaustive typed
adapters where behavior remains transport-specific, and verify the actual SDK
tool list/result schemas rather than comparing handwritten snapshots.

## Route 2: Current codebase

### Existing strengths

- `packages/contracts/src/public-v1-operations.ts` already declares
  `PUBLIC_V1_OPERATIONS`, including REST method/path, scope, schemas, and an
  explicit MCP tool or exclusion.
- `apps/api/src/v1/v1-operation-manifest.spec.ts` reflects the real Nest
  controllers and proves their method/path inventory matches the manifest.
- `apps/api/src/openapi/openapi.registry.ts` and
  `apps/web/src/components/api/catalog.ts` project OpenAPI and Playground data
  from that manifest.
- `apps/api/src/mcp/mcp.spec.ts` compares the actual registered SDK tool names
  against manifest mappings and records SSE and `Idempotency-Key` as explicit
  transport differences.
- API and Web tests are already exercised by `.github/workflows/ci.yml`. The
  current in-progress `add-task-model-selection` worktree also adds a contracts
  package test script and invokes it from that required CI lane; this proposal
  must preserve and generalize that improvement rather than duplicate it.

### Drift windows that remain

1. `definePublicV1Operations` returns a widened `readonly PublicV1Operation[]`.
   Operation-specific scope/schema/MCP literals are therefore not available to
   build an exact adapter type for each operation.
2. `apps/api/src/mcp/mcp-tools.ts` manually repeats tool name, description,
   scope, input shape, output schema, parsing, and callback behavior. The
   manifest currently proves inventory, but not every schema, policy, domain
   error, or returned structured result.
3. Schedule create/update tool shapes are reconstructed manually because the
   canonical schemas add refinements and do not expose a raw `.shape`. A future
   field can be added to the canonical request yet be stripped or omitted at
   the MCP SDK boundary.
4. Transcript and delete outputs have handwritten MCP projections. These are
   valid protocol differences, but they are not centrally declared or checked
   exhaustively.
5. REST controllers repeat `requireScope` and validation wiring. The manifest
   carries a scope, but the runtime gate can still be changed independently.
6. Domain failures are mapped separately by REST and MCP without an exhaustive
   shared domain-code inventory.
7. The clean baseline did not run package-local contracts fixtures. The active
   model-selection worktree is adding a contracts test script and CI step, but
   root `pnpm verify` still does not run tests, the edit-time hook typechecks only
   the owning package, and pre-commit runs lint-staged only. A contracts edit can
   therefore still break API or MCP projections without immediate feedback.
8. The broad parity verification in the active `add-task-model-selection`
   change appears late in its task plan. By that point, drift may have already
   crossed several implementation tracks.

### Architectural boundary

`packages/contracts` should own transport-neutral schemas and capability
metadata, but not Nest services or MCP callbacks. `apps/api` should own thin
REST/MCP adapters and domain-to-protocol error translation. Product services
remain the one behavior path both transports call.

## Route 3: Prior changes and repository decisions

### Relevant history

- `2026-06-19-public-v1-api` established an additive `/v1` surface built from
  shared Zod contracts and delegated to the same product services.
- `2026-06-19-remote-mcp-server` established MCP as a thin scoped adapter over
  those services, not a second provisioning/admission path.
- `2026-06-19-add-api-playground` initially used a curated list; the current
  implementation now derives its data-operation catalog from the shared
  manifest and tests it for drift.
- `2026-06-18-add-ci-typecheck-gate` showed that ordering and code generation
  matter: a named CI gate must execute the real prerequisites, not merely add a
  nominal command.
- `2026-05-31-enhance-openspec-with-workflows` deliberately forbids changing
  the OpenSpec CLI, spec-driven schema, or artifact dependency graph. Any new
  surface-impact declaration must therefore be an artifact sidecar plus a repo
  linter, not a custom OpenSpec schema edge.
- The active `add-task-model-selection` change requires Console, `/v1`, MCP,
  OpenAPI, Playground, scheduler, and runtime behavior to move together. It is
  the concrete near-term consumer of the proposed constraint.

### Lessons

- Reusing the same service is necessary but insufficient: names, fields,
  scopes, output shapes, errors, and intentional exclusions are all contract.
- A final integration test is too late as the first parity signal. The same
  focused gate must be runnable after each relevant edit and each apply track.
- Protocol differences should be first-class data with a reason and an
  assertion. They should not be hidden in callback code or an ignored test.

## Options considered

### A. PR checklist only

Rejected as the primary control. It helps reviewers but cannot detect a missing
field, scope, adapter, or output schema and is easy to skip during multi-track
work.

### B. Generate MCP directly from OpenAPI

Rejected. REST headers, streaming, status codes, and path/query/body placement
do not map mechanically to good MCP tools. It would also hide domain-service
delegation and MCP-specific error/result behavior behind a lossy conversion.

### C. Keep the current manifest and add more snapshot tests

Partially useful, but insufficient alone. Snapshots detect drift after code is
written and tend to duplicate the expected contract. They do not make missing
adapters or scopes a compile-time error.

### D. Exact typed capability registry plus explicit adapters and layered gates

Recommended. Preserve operation literals; derive common metadata and schemas;
require exhaustive REST/MCP bindings; declare exclusions/differences; then run
one deterministic parity suite at edit, commit, push, CI, and OpenSpec apply
boundaries.

### E. Add a new required artifact to the spec-driven dependency graph

Rejected for this change. It would violate the existing "Backbone is not
modified" requirement. A `surface-impact.json` sidecar and deterministic
repository linter provide the constraint without changing OpenSpec internals.

## Recommended capability boundary

1. Add `api-mcp-development-parity` for the exact registry, exhaustive
   transport adapters, explicit difference records, parity suite, and
   surface-impact lint.
2. Extend `public-v1-api` and `mcp-server` with runtime binding/conformance
   requirements so the constraint protects real transport behavior.
3. Extend `monorepo-foundation` with edit/pre-commit/pre-push/CI execution of
   the same named gate and downstream typechecking for contract edits.
4. Extend `deep-research-proposal` with a sidecar declaration generated during
   proposal research, while preserving the existing artifact graph.
5. Extend `parallel-track-apply` so a task is checked only after its declared
   verification command passes and affected parity is rerun after track merge.
6. Extend `adversarial-spec-verify` so public-surface changes are verified
   against both transports and every declared exclusion/difference.
7. Extend `contributor-docs` with the developer workflow and local commands.

## Verification model

The parity gate should fail on an injected fixture operation until all required
bindings are present, and should exercise:

- registry uniqueness and literal/type preservation;
- reflected REST operation id, method/path, scope, and canonical schemas;
- actual MCP `tools/list` inventory, input/output schemas, scope gate, callback
  parsing, structured result validation, and domain-error mapping;
- OpenAPI and Playground projections from the same registry;
- every explicit exclusion/difference with a non-empty reason and targeted test;
- a feature-change fixture proving a newly added request field reaches both
  adapters without being stripped;
- surface-impact/task metadata linting and the same command under local hooks
  and CI.

## Scope guardrails

- This change does not add or break a public endpoint or MCP tool.
- It does not require API and MCP to be identical where protocols differ.
- It does not move application behavior into the contracts package.
- It does not modify the OpenSpec CLI, schema, or artifact dependency graph.
- It does not make Docker, a database, or network access part of the fast local
  parity gate.
