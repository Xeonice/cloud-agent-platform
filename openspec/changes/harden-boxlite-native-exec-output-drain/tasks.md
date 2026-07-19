<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: command-output-contract (depends: none)

- [x] 1.1 Clarify the sandbox-core command executor success boundary without widening `SandboxCommandExecutionResult`: add or adapt a typed internal output-settlement rejection that maps incomplete output to the existing safe transport/protocol/timeout classifications while retaining no command, output, provider id, or raw error, and document that every successful result carries fully settled output.
  - requirements: ["sandbox-provider-port/provider-command-results-require-complete-output-settlement", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 1.2 Add sandbox-core unit coverage for proven zero-byte output, typed output transport/protocol/timeout/cancellation rejection, known process settlement remaining diagnostic-only, rejection validation, and unique unsafe-material canaries; prove no new public diagnostic cause or successful partial-result shape is introduced.
  - requirements: ["sandbox-provider-port/provider-command-results-require-complete-output-settlement", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 2. Track: boxlite-native-drain (depends: command-output-contract)

- [x] 2.1 Replace `finishAfterPoll()` and its one-event-loop drain assumption with an idempotent BoxLite native execution coordinator that starts poll and attach concurrently, computes one monotonic absolute deadline at execution start, waits for both authoritative terminal facts using remaining budget, and never starts a second full timeout.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "sandbox-provider-port/provider-command-results-require-complete-output-settlement"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.2 Make attach settlement explicit: retain separate stdout/stderr UTF-8 decoders, accept valid empty output only after the attach `exit` frame, retain and compare the attach exit code with poll settlement, permit only fully drained attach output to reach `mergeExecOutput`, and fail mismatched or malformed terminal control data through typed protocol handling without rerunning exec.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "sandbox-provider-port/provider-command-results-require-complete-output-settlement"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.3 Complete every poll-first, attach-first, attach-error, early-close, deadline, poll-failure, and cancellation path with one cleanup owner for sockets, timers, decoders, and AbortSignal listeners; preserve the proven process outcome separately from attach degradation and classify the consuming operation with the existing safe cause vocabulary without adding per-poll/per-frame events or unsafe fields.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "boxlite-sandbox-provider/boxlite-native-operations-emit-bounded-correlated-diagnostics", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.4 Rewrite the BoxLite tests that currently treat attach failure/hang/timeout as successful empty output, remove the native-exec attach-disabling seam, then add deterministic delayed-handshake replay, attach-first, zero-byte, fragmented stdout/stderr, split UTF-8, non-zero exit, terminal mismatch, shared-deadline, cancellation-at-each-phase, disposal, and 50-100 fast-command stress cases with controlled WebSocket terminal events and secret/raw-material scans retained.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "boxlite-sandbox-provider/boxlite-native-operations-emit-bounded-correlated-diagnostics", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 3. Track: provider-conformance (depends: command-output-contract, boxlite-native-drain)

- [x] 3.1 Extend the shared provider conformance harness with deterministic process-versus-output settlement controls and assertions for poll/process-first, output-first, late replay, valid empty output, fragmented streams, early close/error, hang, one shared deadline, cancellation, and inconsistent channel settlement; correctness MUST be driven by protocol terminal events rather than fixed sleeps.
  - requirements: ["sandbox-provider-port/provider-command-results-require-complete-output-settlement", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 3.2 Apply complete-output conformance to AIO, cloud-http, and BoxLite command capabilities, proving single-channel providers retain their normalized behavior, BoxLite cannot advertise a successful incomplete-output executor, diagnostics remain bounded and secret-free, and no metadata/runtime/workspace consumer adds a provider-specific fallback.
  - requirements: ["sandbox-provider-port/provider-command-results-require-complete-output-settlement", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 4. Track: integration-and-rollout-validation (depends: boxlite-native-drain, provider-conformance)

- [x] 4.1 Extend the gated native BoxLite E2E with repeated fast `printf`, valid empty output, non-zero stderr/output, and `/etc/cap/sandbox-metadata.json` reads against a real supported BoxLite service; prove late replay completes through the attach `exit` frame and every probe sandbox is removed in `finally`.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 4.2 Run the focused BoxLite build/client/diagnostics suites, `pnpm --filter @cap/sandbox-provider-boxlite test`, `pnpm test:sandbox`, package and full sandbox coverage, and gated `pnpm --filter @cap/sandbox-provider-boxlite test:e2e`; repair every regression and retain evidence that total wait time never becomes two full command timeouts.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "sandbox-provider-port/provider-command-results-require-complete-output-settlement", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts"]
  - surfaces: ["contracts", "ci", "developer-workflow"]
  - verify: "api-mcp"
- [ ] 4.3 Validate the released candidate on `vibe-zlyan` by creating a task with the failed task's repository, owner, branch, runtime/model, sandbox environment, and prompt configuration; confirm diagnostics no longer show degraded attach followed by fabricated empty metadata, runtime preflight reaches workspace/Git provisioning, the task reaches a truthful later lifecycle state, and all probe/task sandboxes are cleaned or retained only by the configured policy.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "boxlite-sandbox-provider/boxlite-native-operations-emit-bounded-correlated-diagnostics", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope"]
  - surfaces: ["contracts", "developer-workflow"]
  - verify: "api-mcp"
- [ ] 4.4 Run strict OpenSpec validation, `validate-change` in propose/apply phases, the allowlisted API verifier, a Public V1/MCP operation-and-tool inventory check proving no public surface drift, and `git diff --check`; keep `surface-impact.json` internal-only with unchanged runtime wire behavior.
  - requirements: ["boxlite-sandbox-provider/boxlite-command-and-archive-operations-normalize-to-cap-contracts", "sandbox-provider-port/provider-command-results-require-complete-output-settlement", "sandbox-provider-port/provider-conformance-covers-terminal-executor-workspace-and-ownership-contracts", "observability/provisioning-diagnostic-logs-carry-a-bounded-safe-causal-envelope"]
  - surfaces: ["openspec", "developer-workflow", "contracts", "public-v1", "mcp"]
  - verify: "openspec-metadata"
