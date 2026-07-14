## Context

The repository already has the right architectural seed: the
`PUBLIC_V1_OPERATIONS` manifest in `@cap/contracts` is consumed by OpenAPI and
the API Playground, a reflection test compares it with real Nest controllers,
and MCP tests compare mapped tool names. The remaining problem is that the
manifest helper widens every entry except its id, while MCP registration and
REST authorization repeat schemas, scopes, outputs, and errors manually. That
means the system detects some inventory drift, but TypeScript cannot require a
complete adapter for a newly added operation and tests do not systematically
prove semantic parity.

The active `add-task-model-selection` change demonstrates the pressure: one new
field and one catalog capability must move through contracts, task/schedule
creation, Public V1, MCP, OpenAPI, Playground, scheduler, and runtime behavior.
The first parity signal must occur when the contract is edited, not only in a
late integration track.

Constraints:

- `@cap/contracts` remains transport-neutral and cannot depend on Nest, the MCP
  SDK, or application services.
- Public V1 and MCP must delegate to the same application use cases, but their
  envelopes may differ where the protocols genuinely differ.
- The official MCP SDK's deeply nested Zod generics have previously caused
  `TS2589`; the existing narrow `ToolRegistrar` boundary is intentional.
- Complex schedule schemas use Zod refinements/effects and cannot safely expose
  `.shape` to the SDK without a separate field-owning object.
- Existing external routes, tool names, request/success bodies, and human error
  compatibility must remain unchanged. MCP application errors may add the
  declared namespaced safe metadata envelope; SDK pre-validation remains its
  existing text-only transport result.
- The existing `deep-research-proposal` specification forbids modifying the
  OpenSpec CLI, spec-driven schema, or artifact dependency graph.
- Local focused verification must not require Docker, a database, a network,
  credentials, or a listening socket.

## Goals / Non-Goals

**Goals:**

- Make missing Public V1/MCP bindings, scopes, error mappings, and schema
  projections fail at edit/typecheck time whenever TypeScript can prove them.
- Derive shared transport metadata from one exact capability registry while
  keeping behavior in explicit thin adapters over shared use cases.
- Detect the remaining runtime/schema drift with one deterministic focused suite
  reused by editor hooks, commit/push hooks, CI, and OpenSpec apply.
- Force every feature proposal to state whether each public surface changes, is
  derived, is internal-only, or is protocol-excluded, with a reason.
- Keep intentional REST/MCP differences visible, stable, and testable.

**Non-Goals:**

- Automatically exposing every Console or internal runtime feature through
  Public V1 and MCP.
- Generating MCP handlers mechanically from OpenAPI.
- Moving application logic, Nest controllers, or MCP SDK callbacks into
  `@cap/contracts`.
- Requiring REST and MCP wire envelopes or protocol status codes to be identical.
- Adding a public endpoint/tool, changing request/success wire behavior, or
  migrating database data in this change. The declared additive MCP error
  metadata is the only intentional result-envelope extension.
- Modifying OpenSpec CLI code, `spec-driven` schema files, or artifact dependency
  edges.
- Running full end-to-end infrastructure tests on every source edit.

## Decisions

### 1. Preserve the exact operation tuple and export derived operation types

Change the helper to return its const generic unchanged:

```ts
function definePublicV1Operations<
  const Operations extends readonly PublicV1OperationShape[],
>(operations: Operations): Operations {
  return operations;
}

export type PublicV1Operation =
  (typeof PUBLIC_V1_OPERATIONS)[number];
export type PublicV1OperationId = PublicV1Operation['id'];
export type PublicV1OperationById<Id extends PublicV1OperationId> =
  Extract<PublicV1Operation, { readonly id: Id }>;
export type McpMappedOperation = Extract<
  PublicV1Operation,
  { readonly mcp: { readonly tool: string } }
>;
export type McpMappedOperationId = McpMappedOperation['id'];
```

Keep a broad `PublicV1OperationShape` constraint for authoring validation, but do
not use it as the exported entry union. This preserves each id's exact scope,
schemas, MCP tool, and difference metadata. Runtime validation additionally
rejects duplicate ids, REST route keys, and MCP names.

Alternative considered: keep the widened manifest and add snapshots. Rejected
because snapshots are late feedback and cannot make a missing adapter a compiler
error.

### 2. Separate field-owning wire schemas from derived parse schemas

Introduce a schema pair for public inputs:

```ts
interface PublicSchemaPair<
  Wire extends z.AnyZodObject,
  Parse extends z.ZodTypeAny = Wire,
> {
  readonly wire: Wire;
  readonly parse: Parse;
  readonly jsonSchemaOverlay?: Readonly<Record<string, unknown>>;
}
```

- `wire` owns the fields and feeds OpenAPI and MCP `tools/list`.
- `parse` is either the same schema or is derived from `wire` using defaults,
  refinements, and transforms. `definePublicSchemaPair` walks that wrapper
  lineage and rejects an independently authored parse object. REST and MCP
  callbacks both use `parse`.
- Type comparisons use `z.input` for accepted wire values and `z.output` for
  normalized application inputs.
- OpenAPI-only JSON Schema composition that cannot be expressed by the converter
  stays next to the schema pair as an explicit overlay, rather than in an
  operation-id switch in the generator.

Schedule create/update/dispatch are migrated first. Existing exported schema
names remain aliases to the parse schemas so other consumers do not break. MCP
flattened inputs are composed with `merge`/shared projection helpers from params,
query, and body wire objects; their field lists are not restated.

Alternative considered: advertise the refined `ZodEffects` schema directly.
Rejected because the SDK registration boundary needs an object shape. Copying the
shape is also rejected because it recreates the exact drift window being fixed.

### 3. Make protocol mappings and differences first-class registry data

Each entry keeps a REST mapping and an explicit MCP discriminated union:

```ts
mcp:
  | {
      tool: string;
      inputProjection: PublicInputProjection;
      outputProjection: 'canonical' | PublicOutputProjection;
      differences: readonly PublicProtocolDifference[];
    }
  | {
      excluded: string;
    };
```

Each entry also declares its REST success projection. Existing operations use a
shared `legacy-validated-handler-value` decision: the schema is validated, but
the established handler bytes are not silently rewritten by Zod stripping.
This makes the REST-versus-canonical-MCP output asymmetry explicit and prevents a
future operation from inheriting it accidentally.

`PublicInputProjection` declares which canonical params/query/body fields are
flattened and which REST-only headers are omitted. Non-identity result projections
declare their own output schema and reason. The existing differences are
dogfooded immediately:

- `tasks.create`: REST-only `Idempotency-Key`;
- `tasks.events`: reasoned MCP exclusion for SSE;
- `tasks.create`: historical MCP text wrapper while structured output remains
  canonical;
- `tasks.create`: MCP-specific asynchronous/polling description and the
  dedicated REST create throttle versus the MCP transport limiter;
- `runtimeModels.query`: the Public V1 handler keeps its dedicated
  per-principal catalog throttle while MCP stays under the MCP transport
  limiter; shared catalog-service capacity controls still apply to both;
- `tasks.transcript`: the MCP SDK high-level registrar only accepts one root
  object output schema, so `tools/list` advertises a wider object derived from
  every canonical `SessionHistory` union variant while runtime
  `structuredContent` is still validated against the untouched discriminated
  union;
- `schedules.delete`: REST 204 versus MCP deletion acknowledgement.

An optional/absent `mcp` property is not allowed. This prevents silence from
being mistaken for a product decision.

Alternative considered: OpenAPI-to-MCP generation. Rejected because headers,
streaming, status semantics, flattened tool arguments, and application error
translation require deliberate protocol adapters.

### 4. Register MCP tools from an exhaustive adapter map

Define the behavior map by stable operation id:

```ts
type McpAdapterMap = {
  [Id in McpMappedOperationId]: McpAdapter<PublicV1OperationById<Id>>;
};

const MCP_ADAPTERS = {
  'tasks.create': { execute: /* shared use-case call */ },
  // ...
} satisfies McpAdapterMap;
```

`registerMcpTools` iterates the mapped registry entries and wraps each adapter in
one common pipeline:

1. obtain scope/owner policy from the registry and fail closed;
2. build the advertised input from its declared projection;
3. parse callback input through the canonical parse schema;
4. invoke the adapter/shared application use case;
5. validate the normalized output;
6. produce canonical structured content and any declared compatibility text;
7. translate a stable public error through the MCP error map and return its safe
   envelope in namespaced result metadata while preserving compatibility text.

The narrow `ToolRegistrar` remains. If TypeScript loses correlation while
iterating a discriminated union, one localized cast is allowed inside
`registerOne`; the exhaustive map and public exports may not degrade to string
records. Tests use both the narrow capture port and an SDK in-process request path
so `tools/list` and structured results are verified as clients observe them.

Alternative considered: keep independent per-tool `registerTool` calls. Rejected
because shared metadata remains handwritten even if more assertions are added.

### 5. Bind Nest handlers by typed operation id and centralize policy

Add `@PublicV1Operation(id)` metadata plus a fail-closed public operation guard and
contract interceptor. The decorator only accepts `PublicV1OperationId`.

- The guard resolves the entry and enforces its scope and owner policy. It first
  requires a resolved principal; it must not accidentally treat a missing
  principal as the existing session-style allow-all scope case.
- The interceptor parses request params/query/body/declared headers through the
  entry's canonical parser/projection before invoking the handler. It validates
  ordinary canonical responses; SSE framing and REST 204 follow their declared
  projections.
- Operation-scoped transport infrastructure, including the runtime-model catalog
  throttle, selects handlers through their typed `@PublicV1Operation` id rather
  than copying an HTTP method/path pair that can drift from the registry.
- Controllers retain routing and application orchestration, but remove repeated
  scope literals and schema copies.
- The reflection test proves a bijection among handler metadata ids, Nest
  method/path decorators, and REST registry entries. It derives the expected set
  and never asserts a fixed `17` or future `18` count.
- A recursive production-source audit scans all API source directories, resolves
  direct and namespace-qualified decorators, and proves its discovered operation
  ids exactly equal the registry. Bound handlers may receive data only through
  `@PublicV1Input`; raw `@Req` is limited to the registry authorization helpers,
  and raw `@Res` is limited to operations whose registry entry declares
  `streaming: true`.

Alternative considered: create a second manually maintained REST adapter map.
Rejected because Nest controllers already are the REST adapters; typed metadata
and reflection can bind them without another inventory.

### 6. Introduce stable public errors with exhaustive REST/MCP maps

`@cap/contracts` exports the stable code union and safe error envelope schema.
`apps/api` owns a transport-neutral `PublicSurfaceError` and two exhaustive maps:

```ts
const REST_PUBLIC_ERROR_MAP = { /* code -> HTTP representation */ }
  satisfies Record<PublicErrorCode, RestErrorMapping>;
const MCP_PUBLIC_ERROR_MAP = { /* code -> JSON-RPC/retryable */ }
  satisfies Record<PublicErrorCode, McpErrorMapping>;
```

Start with boundary errors (`validation_failed`, `insufficient_scope`,
`owner_required`) and existing public status families (`not_found`, `conflict`,
`rate_limited`, `temporarily_unavailable`). The operation registry lists the
codes each operation may return. Existing services that throw Nest exceptions
are normalized at the adapter boundary first; domain services can migrate to
`PublicSurfaceError` incrementally. Existing HTTP status/message compatibility is
captured before the migration and preserved. Because this change is a behavior-
preserving refactor, the stable code is the transport-neutral selection key; it
is not injected into a legacy REST JSON body that did not already expose it.
That omission is represented as a registry-wide, tested REST compatibility
projection. MCP application-boundary failures expose the same stable envelope
through the declared `com.cloud-agent-platform/public-error` result metadata
key, without replacing their existing text. Invalid tool arguments rejected by
the SDK before the adapter callback cannot use that projection and remain an
explicit text-only SDK pre-validation difference.

Alternative considered: expose HTTP status semantics directly through MCP.
Rejected because it couples application failures to one transport and produces
unstable MCP errors.

### 7. Use a validated sidecar without changing the OpenSpec graph

`surface-impact.json` is a change-local sidecar, analogous to
`research-brief.md`, not a registered OpenSpec artifact. It declares:

- change name and intent;
- whether external wire behavior changes;
- status/reason/scope for Public V1, MCP, OpenAPI, Playground, and internal-only
  behavior;
- affected operation/tool ids, or the `all-existing` scope for a registry-wide
  refactor;
- each protocol exclusion or projection by stable operation id;
- the allowlisted final verifier id.

A repository-owned validator parses the sidecar with Node's native JSON parser,
validates shape and cross-field rules, and cross-checks declared ids against the
registry when available. Public V1 `changed` requires MCP `changed`
or an explicit exclusion; MCP-only changes require a concrete inverse reason.
An MCP exclusion uses the same operation selector as Public V1 and has a matching
`mcp-exclusion` entry. For selected operations, every registry-owned MCP
difference kind is present under the same operation target; final verification
also rejects operation-scoped sidecar kinds that the registry does not declare.

The propose skills generate and validate it; apply skills require it during
preflight; staged-file validation and CI check changed change directories. The
`.codex` and `.claude` copies of propose/apply instructions remain byte-identical
and have a parity assertion. Existing active changes are not bulk-edited; a
sidecar becomes required when a change is newly created, modified, or selected
for apply.

Alternative considered: add `surface-impact` to the spec-driven dependency
graph. Rejected because it violates the existing Backbone requirement and would
make all active legacy changes unexpectedly incomplete.

### 8. Give every task allowlisted verification metadata

Each checkbox has adjacent child metadata:

```md
- [ ] 2.3 Generate MCP registration from the registry.
  - requirements: ["api-mcp-development-parity/transport-bindings-are-exhaustive"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "public-surface-fast"
```

Verifier ids map to argv arrays in a repository-owned module. The task verifier
spawns them with `shell: false`; it never executes Markdown as shell. Apply runs
the verifier after implementation and only then marks the task complete.
Metadata validation rejects duplicate task ids, unknown requirement references,
unknown verifier ids, and missing fields.

The exact requirement reference uses `<capability>/<normalized-requirement-name>`.
The initial allowlist includes narrow contract/API/Web/docs checks plus
`public-surface-fast` and `public-surface-full`.

Alternative considered: store arbitrary commands in `tasks.md`. Rejected because
it is unsafe and lets commands drift independently of repository scripts.

### 9. Reuse one classifier and two root verification commands at every layer

Add a shared file classifier used by the edit hook and lint-staged:

- contract/registry edits trigger contracts and downstream API/Web typechecks,
  metadata validation, and the focused suite;
- V1/MCP/OpenAPI/Playground edits trigger the relevant typecheck and focused
  suite;
- OpenSpec proposal/spec/design/tasks/sidecar edits trigger sidecar/task metadata
  validation;
- unrelated files keep existing checks without paying for the public suite.

Root commands:

- `pnpm test:public-surface`: incremental/codegen-aware focused tests for
  contracts, Public V1 reflection, MCP registration/conformance, OpenAPI, and
  Playground; no database, network, ports, or credentials. A watch command uses
  the same test inventory.
- `pnpm verify:public-surface`: fresh declared build/codegen prerequisites,
  downstream typechecks, metadata validation, and the focused test command.

Pre-commit conditionally invokes the focused command once. Pre-push always runs
the full command because a single-commit diff is not a reliable description of
everything being pushed. CI job id `public-surface-parity` invokes that same full
command and is configured as a required merge check. The broader API/Web suite
and boot smoke remain separate; they do not substitute for this contract gate.

Tests that open a listening port or need a database remain outside the focused
suite. This avoids hiding sandbox failures with test-specific hardcoding and
keeps the gate reproducible locally.

Alternative considered: duplicate commands in hooks and workflow YAML. Rejected
because the enforcement layers would eventually test different inventories.

### 10. Verify both structure and normalized behavior

The suite has four layers:

1. compile-time fixtures prove exact tuple, adapter, and error-map exhaustiveness;
2. structure tests compare real Nest metadata, OpenAPI, Playground, and actual
   MCP SDK tool metadata with the registry;
3. shared fixtures drive REST and MCP adapters, comparing normalized use-case
   arguments, outputs, rejection semantics, and whether a write occurred;
4. OpenSpec validation compares sidecar/task claims with specs, registry, and
   implementation evidence.

An all-fields fixture is generated from canonical known fields but includes
semantic values for optional fields; it is not a second schema. Mutation tests
or compile-fail fixtures add a temporary operation/field/error and prove the gate
fails until every required projection is present. This directly tests the future
iteration path instead of asserting a fixed current inventory.

Alternative considered: compare only tool and route counts. Rejected because
equal counts can still hide schema, scope, output, and error drift.

## Risks / Trade-offs

- **[MCP SDK generics trigger TS2589]** -> Retain `ToolRegistrar`, concentrate any
  cast in one registration boundary, and keep the exhaustive adapter record fully
  typed.
- **[MCP SDK output registration cannot express a root object union]** -> Declare
  the transcript-only `mcp-output-schema-relaxation`, derive its wider object
  from the canonical union options without copied fields, validate runtime
  structured output against the canonical union, and mutation-test the exact
  advertised projection in both directions.
- **[Wire/parse separation changes accepted inputs]** -> Preserve existing schema
  aliases, record before/after acceptance fixtures, and migrate one schema family
  at a time.
- **[Runtime response validation exposes old inconsistencies]** -> Baseline every
  existing operation first, preserve external behavior, and treat a discovered
  mismatch as a defect to fix rather than weakening the canonical schema.
- **[Public error normalization becomes a large refactor]** -> Land exhaustive
  maps and boundary-generated errors first; normalize legacy exceptions at the
  adapter and migrate domain services incrementally.
- **[Hooks become disruptive]** -> Use one tested file classifier for edit/commit
  paths, keep the focused suite service-independent, and reserve fresh full
  prerequisites for pre-push/CI.
- **[Sidecar becomes unchecked paperwork]** -> Cross-check it against registry,
  specs, changed files, actual tools/routes, and adversarial verification rather
  than accepting self-declaration.
- **[Task verifier executes untrusted text]** -> Resolve only allowlisted ids to
  fixed argv and use `shell: false`.
- **[The active model-selection change conflicts in shared files]** -> Implement
  and land the parity foundation first, then rebase/reconcile model-selection so
  its new operation and `model` field become the first conformance fixture. If
  work must proceed concurrently, place shared registry/MCP files in one serial
  integration track.
- **[A new CI job is configured but not merge-required]** -> Keep a stable job id,
  verify repository branch/ruleset configuration during rollout, and document the
  required check.

## Migration Plan

1. Capture current Public V1, MCP, OpenAPI, and Playground inventories and
   canonical behavior as compatibility fixtures. Add the root scripts in a
   non-blocking mode so the baseline can run before refactoring.
2. Preserve exact manifest literals and add compile/runtime uniqueness tests.
   Remove fixed operation/tool count assertions.
3. Split schedule and other complex inputs into wire/parse pairs while keeping
   legacy export aliases and byte-compatible acceptance fixtures.
4. Add explicit projections/differences, build the exhaustive MCP adapter map,
   and switch registration to the generated wrapper pipeline.
5. Bind Public V1 handlers by typed id, introduce the central guard/interceptor,
   and remove duplicated scope/schema wiring after parity tests pass.
6. Add stable public error codes/maps and migrate boundary errors first, then
   normalize existing service exceptions without changing public responses.
7. Add sidecar/task validators, synchronize Codex/Claude skill instructions, and
   dogfood the metadata on this change.
8. Enable the shared classifier, edit/pre-commit/pre-push gates, contributor docs,
   and the `public-surface-parity` CI job. Confirm it is a required merge check.
9. Reconcile `add-task-model-selection` onto the new registry/adapter model and
   run its all-fields REST/MCP fixture as the first real feature proof.

Rollback is code-only: disable hook/CI invocation first if it prevents unrelated
work, then revert the registry/adapter refactor as one unit while retaining
compatibility fixtures. No data rollback is required. Existing routes/tools and
legacy schema exports remain available throughout migration.

## Open Questions

No architectural question blocks implementation. During apply, measure the
focused and full command durations on CI and a normal developer checkout; test
selection may be optimized without dropping any required invariant or making the
full merge gate conditional.
