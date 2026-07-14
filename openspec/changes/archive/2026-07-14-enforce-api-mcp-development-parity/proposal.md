## Why

The repository already has a shared public-operation manifest and several drift
tests, but MCP registration, runtime scope enforcement, complex request shapes,
outputs, and error translation still contain handwritten copies. Today a feature
can compile in its owning package while `/v1`, MCP, OpenAPI, or the Playground is
incomplete, with the first broad signal arriving late in implementation or CI.
We need a development-time constraint that makes every public-surface decision
explicit and turns omissions into typecheck or focused-test failures.

## What Changes

- Evolve `PUBLIC_V1_OPERATIONS` into a literal-preserving typed capability
  registry. Common operation ids, scopes, wire schemas, outputs, errors, MCP
  mappings, exclusions, and protocol differences remain contract-owned; REST
  and MCP callbacks remain thin API-layer adapters over the same services.
- Add exhaustive typed REST/MCP bindings. A mapped operation without an adapter,
  an unknown adapter, an undeclared scope/error mapping, or an untested protocol
  difference fails typecheck or the parity suite.
- Derive MCP tool metadata and schemas from the registry, validate actual SDK
  `tools/list` and structured results, and split complex schemas into one
  field-owning wire schema plus a derived parse/refinement schema to prevent
  copied raw shapes from stripping new fields.
- Add a deterministic, database-free `public-surface` gate covering reflected
  Nest routes, MCP inventory/schemas/scopes/results/errors, OpenAPI, Playground,
  and contract tests. Reuse it for watch/edit feedback, conditional pre-commit,
  pre-push, CI, and OpenSpec track integration.
- Require a machine-readable `surface-impact.json` sidecar for feature changes,
  declaring `/v1`, MCP, OpenAPI, Playground, internal-only, exclusions, and
  protocol differences, with operation-scoped difference kinds cross-checked
  against the registry. Add task metadata (`requirements`, `surfaces`,
  `verify`) and prevent `[x]` completion until the declared command passes.
  This operates through repository artifacts and linters; it does not modify the
  OpenSpec CLI, spec-driven schema, or artifact dependency graph.
- Document the contributor workflow and stable local/CI commands. No public API
  route, MCP tool name, request, or success payload changes; MCP application
  errors gain additive safe metadata while retaining compatibility text,
  task-create metadata explicitly describes its REST-only header/throttle, and
  the SDK-limited transcript output advertisement is explicitly declared while
  runtime structured content remains canonical.

## Capabilities

### New Capabilities

- `api-mcp-development-parity`: typed public capability registry, exhaustive
  transport bindings, explicit protocol-difference declarations, focused
  conformance tests, and surface-impact/task-metadata linting.

### Modified Capabilities

- `public-v1-api`: bind each real public controller operation and its runtime
  scope/schema behavior to the canonical operation id.
- `mcp-server`: derive mapped tool contracts from the registry and verify actual
  SDK registration, parsing, scope enforcement, structured output, and errors.
- `monorepo-foundation`: add downstream contract checks and layered execution of
  one stable public-surface gate at edit, commit, push, and CI boundaries.
- `deep-research-proposal`: emit and lint a public-surface impact sidecar without
  changing the OpenSpec artifact graph.
- `parallel-track-apply`: require task-specific verification before completion
  and rerun affected parity after track integration.
- `adversarial-spec-verify`: verify both programmatic transports plus declared
  exclusions/differences for public-surface changes.
- `contributor-docs`: document the parity workflow, metadata, and commands.

## Impact

- **Contracts:** `packages/contracts` public-operation types, schema exports,
  domain-error metadata, and focused contract tests.
- **API:** `apps/api/src/v1`, `apps/api/src/mcp`, OpenAPI projection, shared
  scope/error adapters, and conformance tests. Product services remain the only
  behavior implementation.
- **Web:** Playground projection/conformance checks; no intended UI behavior
  change.
- **Developer workflow:** package/root scripts, Turbo task wiring, edit hook,
  lint-staged/pre-push hooks, CI job, OpenSpec sidecar/task linter, and
  contributor documentation.
- **Compatibility:** no database migration or request/success wire change. MCP
  application-boundary errors add a namespaced stable metadata envelope while
  preserving existing text; SDK pre-validation remains text-only. Intentional
  REST/MCP differences stay explicitly declared and tested.
