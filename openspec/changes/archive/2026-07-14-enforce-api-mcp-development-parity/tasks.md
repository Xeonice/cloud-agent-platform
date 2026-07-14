<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: openspec-metadata-foundation (depends: none)

- [x] 1.1 Implement the repository-owned verifier allowlist, task-metadata parser, and `shell: false` task runner with bootstrap/unit tests.
  - requirements: ["deep-research-proposal/generated-public-surface-tasks-carry-verification-metadata", "parallel-track-apply/task-completion-requires-its-declared-verifier"]
  - surfaces: ["openspec", "developer-workflow"]
  - verify: "openspec-metadata"
- [x] 1.2 Implement `surface-impact.json` shape, relation, registry-id, and diff-aware migration validation with fixtures for changed, excluded, internal-only, and untouched legacy changes.
  - requirements: ["deep-research-proposal/proposal-records-a-machine-readable-public-surface-decision"]
  - surfaces: ["openspec", "contracts"]
  - verify: "openspec-metadata"
- [x] 1.3 Update both Codex and Claude propose skills to generate/read/validate the sidecar and public-surface task metadata, then assert the mirrored instructions remain byte-identical.
  - requirements: ["deep-research-proposal/proposal-records-a-machine-readable-public-surface-decision", "deep-research-proposal/generated-public-surface-tasks-carry-verification-metadata"]
  - surfaces: ["openspec", "developer-workflow"]
  - verify: "openspec-metadata"
- [x] 1.4 Update both Codex and Claude apply skills to preflight the sidecar, correct semantic surface coupling, invoke only allowlisted task verifiers, and mark `[x]` only after success.
  - requirements: ["parallel-track-apply/apply-correction-respects-semantic-surface-coupling", "parallel-track-apply/task-completion-requires-its-declared-verifier", "parallel-track-apply/integrated-tracks-rerun-affected-surface-parity"]
  - surfaces: ["openspec", "developer-workflow"]
  - verify: "openspec-metadata"
- [x] 1.5 Add regression tests proving propose/apply metadata enforcement changes no OpenSpec CLI, `spec-driven` schema, or artifact dependency edge.
  - requirements: ["deep-research-proposal/proposal-records-a-machine-readable-public-surface-decision"]
  - surfaces: ["openspec"]
  - verify: "openspec-metadata"

## 2. Track: exact-contract-registry (depends: openspec-metadata-foundation)

- [x] 2.1 Make `definePublicV1Operations` preserve its exact const tuple, export per-id/mapped-operation helper types, and add compile/runtime uniqueness fixtures without fixed inventory counts.
  - requirements: ["api-mcp-development-parity/canonical-public-capability-registry", "api-mcp-development-parity/transport-bindings-are-exhaustive"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground"]
  - verify: "contracts-registry"
- [x] 2.2 Split complex schedule create/update/dispatch inputs into field-owning wire schemas and derived parse schemas while preserving existing export aliases and acceptance behavior.
  - requirements: ["api-mcp-development-parity/wire-schemas-and-parse-schemas-cannot-drift"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi"]
  - verify: "contracts-registry"
- [x] 2.3 Add typed input/output projection and protocol-difference metadata, shared schema composition helpers, and explicit declarations for idempotency, SSE, task text compatibility, schedule delete output, and the registry-wide legacy REST error envelope.
  - requirements: ["api-mcp-development-parity/canonical-public-capability-registry", "api-mcp-development-parity/wire-schemas-and-parse-schemas-cannot-drift"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "contracts-registry"
- [x] 2.4 Add the stable public error-code vocabulary and safe envelope schemas, then annotate each registry operation with its declared public errors.
  - requirements: ["api-mcp-development-parity/public-errors-have-exhaustive-transport-mappings"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi"]
  - verify: "contracts-registry"
- [x] 2.5 Preserve and extend the in-progress contracts package test lane so registry, wire/parse, projection, and compile fixtures run from the package test command and CI rather than remaining undiscovered files.
  - requirements: ["monorepo-foundation/contracts-tests-participate-in-normal-verification"]
  - surfaces: ["contracts", "ci"]
  - verify: "contracts-registry"

## 3. Track: public-error-boundary (depends: exact-contract-registry)

- [x] 3.1 Implement `PublicSurfaceError` plus exhaustive REST and MCP mapping records using `satisfies Record<PublicErrorCode, ...>`.
  - requirements: ["api-mcp-development-parity/public-errors-have-exhaustive-transport-mappings"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-public-errors"
- [x] 3.2 Normalize validation, scope, owner, not-found, conflict, rate-limit, and unavailable failures at the public adapter boundary while preserving existing HTTP status/message bodies through the declared legacy REST compatibility projection.
  - requirements: ["api-mcp-development-parity/public-errors-have-exhaustive-transport-mappings"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-public-errors"
- [x] 3.3 Add safe-detail and exhaustive-map tests that fail on an unmapped code and reject stack traces, secrets, and non-allowlisted provider diagnostics.
  - requirements: ["api-mcp-development-parity/public-errors-have-exhaustive-transport-mappings"]
  - surfaces: ["public-v1", "mcp"]
  - verify: "api-public-errors"

## 4. Track: generated-mcp-adapters (depends: exact-contract-registry, public-error-boundary)

- [x] 4.1 Define the per-operation MCP adapter types and exact `MCP_ADAPTERS satisfies McpAdapterMap` record while retaining the narrow SDK registrar boundary.
  - requirements: ["api-mcp-development-parity/transport-bindings-are-exhaustive", "mcp-server/mcp-tool-registration-is-exhaustively-registry-bound"]
  - surfaces: ["mcp", "contracts"]
  - verify: "api-mcp"
- [x] 4.2 Implement registry-driven tool registration for names, descriptions, schemas, annotations, scope/owner gates, canonical parsing, structured output validation, compatibility text, and public errors.
  - requirements: ["mcp-server/mcp-tool-registration-is-exhaustively-registry-bound", "api-mcp-development-parity/wire-schemas-and-parse-schemas-cannot-drift"]
  - surfaces: ["mcp", "contracts"]
  - verify: "api-mcp"
- [x] 4.3 Migrate every currently mapped MCP callback into a thin operation-id adapter over the same existing application services and remove copied schedule/transcript field lists and scope literals.
  - requirements: ["api-mcp-development-parity/transport-bindings-are-exhaustive", "mcp-server/mcp-tool-registration-is-exhaustively-registry-bound"]
  - surfaces: ["mcp"]
  - verify: "api-mcp"
- [x] 4.4 Exercise an in-process official SDK `tools/list`/tool-call path and assert registry-derived input/output schemas, structured results, and all explicit differences without hard-coded tool counts.
  - requirements: ["api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally", "mcp-server/mcp-tool-registration-is-exhaustively-registry-bound"]
  - surfaces: ["mcp", "contracts"]
  - verify: "api-mcp"
- [x] 4.5 Add MCP failure fixtures proving canonical parsing, fail-closed scope/owner behavior, stable error codes, safe details, and no service invocation on rejected writes.
  - requirements: ["api-mcp-development-parity/public-errors-have-exhaustive-transport-mappings", "api-mcp-development-parity/rest-and-mcp-adapters-pass-shared-behavioral-conformance"]
  - surfaces: ["mcp"]
  - verify: "api-mcp"

## 5. Track: typed-rest-bindings (depends: exact-contract-registry, public-error-boundary)

- [x] 5.1 Add the typed `@PublicV1Operation` decorator and fail-closed scope/owner guard driven by exact registry ids.
  - requirements: ["public-v1-api/public-v1-handlers-are-exhaustively-registry-bound", "api-mcp-development-parity/transport-bindings-are-exhaustive"]
  - surfaces: ["public-v1", "contracts"]
  - verify: "api-v1"
- [x] 5.2 Add the registry-driven request/response contract boundary for params, query, body, declared headers, ordinary outputs, SSE, and 204 projections.
  - requirements: ["public-v1-api/public-v1-handlers-are-exhaustively-registry-bound", "api-mcp-development-parity/wire-schemas-and-parse-schemas-cannot-drift"]
  - surfaces: ["public-v1", "contracts"]
  - verify: "api-v1"
- [x] 5.3 Bind every Public V1 data handler by operation id and remove duplicated scope/schema policy literals after compatibility fixtures pass.
  - requirements: ["public-v1-api/public-v1-handlers-are-exhaustively-registry-bound"]
  - surfaces: ["public-v1"]
  - verify: "api-v1"
- [x] 5.4 Extend reflection tests to compare handler id, method/path, schema, policy, and exact derived sets in both directions while preserving explicit metadata/internal route exclusions.
  - requirements: ["public-v1-api/public-v1-handlers-are-exhaustively-registry-bound", "api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally"]
  - surfaces: ["public-v1", "contracts"]
  - verify: "api-v1"
- [x] 5.5 Add REST rejection/output fixtures that prove canonical parsing, public error mapping, fail-closed authorization, and byte-compatible existing wire behavior.
  - requirements: ["api-mcp-development-parity/public-errors-have-exhaustive-transport-mappings", "api-mcp-development-parity/rest-and-mcp-adapters-pass-shared-behavioral-conformance"]
  - surfaces: ["public-v1"]
  - verify: "api-v1"

## 6. Track: derived-documentation-surfaces (depends: exact-contract-registry, public-error-boundary)

- [x] 6.1 Generate OpenAPI request, output, error, and complex-schema overlay metadata from registry wire pairs and remove operation-id-specific field copies.
  - requirements: ["api-mcp-development-parity/wire-schemas-and-parse-schemas-cannot-drift", "api-mcp-development-parity/public-errors-have-exhaustive-transport-mappings"]
  - surfaces: ["openapi", "contracts", "public-v1"]
  - verify: "openapi-playground"
- [x] 6.2 Keep the API Playground catalog derived from exact registry entries and add projection checks for any new policy/difference metadata it consumes without changing rendered behavior.
  - requirements: ["api-mcp-development-parity/canonical-public-capability-registry", "api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally"]
  - surfaces: ["playground", "contracts"]
  - verify: "openapi-playground"
- [x] 6.3 Add exact-set conformance tests across registry, OpenAPI operation ids, and Playground data operations, including explicit exclusions and no fixed operation totals.
  - requirements: ["api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally"]
  - surfaces: ["openapi", "playground", "contracts"]
  - verify: "openapi-playground"

## 7. Track: public-surface-test-gate (depends: generated-mcp-adapters, typed-rest-bindings, derived-documentation-surfaces)

- [x] 7.1 Add package-level focused test scripts for contracts, API parity, OpenAPI, and Playground plus one infrastructure-free runner and watch inventory.
  - requirements: ["api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally", "monorepo-foundation/contracts-tests-participate-in-normal-verification"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground"]
  - verify: "public-surface-fast"
- [x] 7.2 Add shared all-fields success and validation/scope/owner/domain-error fixtures that compare normalized REST/MCP use-case arguments, outputs, and write invocation.
  - requirements: ["api-mcp-development-parity/rest-and-mcp-adapters-pass-shared-behavioral-conformance"]
  - surfaces: ["public-v1", "mcp", "contracts"]
  - verify: "public-surface-fast"
- [x] 7.3 Add compile-fail or mutation fixtures proving a missing operation adapter, schema field projection, error mapping, and protocol decision each break the gate until completed.
  - requirements: ["api-mcp-development-parity/canonical-public-capability-registry", "api-mcp-development-parity/transport-bindings-are-exhaustive", "api-mcp-development-parity/public-errors-have-exhaustive-transport-mappings"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "public-surface-fast"
- [x] 7.4 Wire root `test:public-surface`, watch, and `verify:public-surface` scripts with explicit build/codegen and downstream typecheck prerequisites shared by local and CI callers.
  - requirements: ["monorepo-foundation/local-hooks-and-ci-reuse-stable-public-surface-commands", "monorepo-foundation/public-contract-edits-validate-downstream-consumers"]
  - surfaces: ["developer-workflow", "contracts", "public-v1", "mcp", "openapi", "playground"]
  - verify: "public-surface-full"
- [x] 7.5 Prove both root commands avoid databases, containers, network, credentials, and listening sockets, and exclude port-reaching integration tests from the focused inventory.
  - requirements: ["api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally", "monorepo-foundation/local-hooks-and-ci-reuse-stable-public-surface-commands"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "public-surface-full"

## 8. Track: local-and-ci-enforcement (depends: openspec-metadata-foundation, public-surface-test-gate)

- [x] 8.1 Implement and unit-test one public-surface/OpenSpec file classifier shared by edit-time and staged-file hooks.
  - requirements: ["monorepo-foundation/public-contract-edits-validate-downstream-consumers"]
  - surfaces: ["developer-workflow", "openspec"]
  - verify: "workflow-gates"
- [x] 8.2 Extend the edit hook and lint-staged flow to run downstream typechecks, metadata validation, and the focused gate once for relevant files while preserving existing lint behavior.
  - requirements: ["monorepo-foundation/public-contract-edits-validate-downstream-consumers", "monorepo-foundation/local-hooks-and-ci-reuse-stable-public-surface-commands"]
  - surfaces: ["developer-workflow", "contracts", "public-v1", "mcp", "openspec"]
  - verify: "workflow-gates"
- [x] 8.3 Add a Husky pre-push hook that always invokes `pnpm verify:public-surface` and fails closed without attempting unreliable single-commit diff inference.
  - requirements: ["monorepo-foundation/local-hooks-and-ci-reuse-stable-public-surface-commands"]
  - surfaces: ["developer-workflow"]
  - verify: "workflow-gates"
- [x] 8.4 Add the stable `public-surface-parity` CI job using the same full root command, preserve the in-progress contracts test lane, and verify the job is configured as a required merge check.
  - requirements: ["monorepo-foundation/local-hooks-and-ci-reuse-stable-public-surface-commands"]
  - surfaces: ["ci", "contracts", "public-v1", "mcp", "openapi", "playground"]
  - verify: "workflow-gates"
- [x] 8.5 Run sidecar/task metadata validation in relevant pre-commit and CI diffs and prove untouched legacy active changes are not bulk-failed while applied/modified changes are checked.
  - requirements: ["deep-research-proposal/proposal-records-a-machine-readable-public-surface-decision", "deep-research-proposal/generated-public-surface-tasks-carry-verification-metadata"]
  - surfaces: ["openspec", "developer-workflow", "ci"]
  - verify: "workflow-gates"

## 9. Track: contributor-parity-guide (depends: openspec-metadata-foundation, public-surface-test-gate)

- [x] 9.1 Extend `CONTRIBUTING.md` with the Public V1/MCP decision workflow, sidecar statuses, explicit exclusions/projections, task metadata, and focused/full commands.
  - requirements: ["contributor-docs/guide-documents-the-public-surface-parity-workflow"]
  - surfaces: ["docs", "openspec", "developer-workflow"]
  - verify: "docs"
- [x] 9.2 Document examples for a mapped public feature, an internal-only feature, and a protocol-excluded feature while linking to canonical workflow/skill sources instead of duplicating them.
  - requirements: ["contributor-docs/guide-documents-the-public-surface-parity-workflow"]
  - surfaces: ["docs"]
  - verify: "docs"

## 10. Track: adversarial-integration (depends: local-and-ci-enforcement, contributor-parity-guide)

- [x] 10.1 Extend adversarial verify routing so every touched public registry/schema/adapter requirement is dynamically checked against sidecar, real REST metadata, real MCP SDK metadata, and behavior.
  - requirements: ["adversarial-spec-verify/public-surface-changes-require-dynamic-conformance-verification"]
  - surfaces: ["openspec", "public-v1", "mcp", "openapi", "playground"]
  - verify: "public-surface-full"
- [x] 10.2 Run an undeclared-impact, false-exclusion, and MCP-field-stripping mutation through verify and prove each becomes an unmet/spec-defect finding that keeps archive gated.
  - requirements: ["adversarial-spec-verify/public-surface-changes-require-dynamic-conformance-verification"]
  - surfaces: ["openspec", "public-v1", "mcp"]
  - verify: "public-surface-full"
- [x] 10.3 Run `pnpm verify:public-surface`, the existing required CI-equivalent typecheck/lint/test suites, strict OpenSpec validation, metadata validation, and compatibility fixtures; repair every failure before completing the change.
  - requirements: ["api-mcp-development-parity/focused-public-surface-verification-is-runnable-locally", "api-mcp-development-parity/rest-and-mcp-adapters-pass-shared-behavioral-conformance", "parallel-track-apply/integrated-tracks-rerun-affected-surface-parity"]
  - surfaces: ["contracts", "public-v1", "mcp", "openapi", "playground", "openspec", "ci"]
  - verify: "public-surface-full"
- [x] 10.4 Audit the final diff for fixed operation/tool totals, copied canonical field lists, debugger statements, undeclared protocol differences, and accidental edits to OpenSpec CLI/schema/dependency files.
  - requirements: ["api-mcp-development-parity/canonical-public-capability-registry", "deep-research-proposal/proposal-records-a-machine-readable-public-surface-decision"]
  - surfaces: ["contracts", "public-v1", "mcp", "openspec", "developer-workflow"]
  - verify: "public-surface-full"
