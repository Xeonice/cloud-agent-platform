<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: tui-normalization (depends: none)

- [x] 1.1 In `normalizeRuntimeOutput`, convert CUP/HVP (`ESC[r;cH`/`ESC[r;cf`) and vertical cursor moves (`ESC[nA/B/E/F/d`) to `\n` and horizontal moves (`ESC[nC/G`) to a space BEFORE the generic CSI strip; keep all other normalization steps unchanged
  - requirements: ["agent-runtime/claude-auth-failure-classification-covers-current-cli-phrasings"]
  - surfaces: ["developer-workflow"]
  - verify: "api-mcp"
- [x] 1.2 Add the real captured session bytes (task `a8b7648a` session.log, 6 797 bytes, in scratchpad `real-session.log`) as a checked-in fixture; test that `classifyClaudeOutputFailure` classifies it `runtime_auth_rejected` both as full input and as an 8 KB rolling tail, and add the `OAuth access token is invalid` inline variant
  - requirements: ["agent-runtime/claude-auth-failure-classification-covers-current-cli-phrasings"]
  - surfaces: ["developer-workflow"]
  - verify: "api-mcp"
- [x] 1.3 Verify all existing codex + claude classifier tests pass unchanged (codex behavior byte-identical)
  - requirements: ["agent-runtime/claude-auth-failure-classification-covers-current-cli-phrasings"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "api-mcp"

## 2. Track: transfer-retry (depends: none)

- [x] 2.1 Add stderr-signature → typed cause mapping to the transfer failure normalizer in `packages/sandbox/src/workspace/git.ts` (connection reset/refused/timed-out, could not resolve host, RPC failed, unexpected disconnect, early EOF, transfer closed → tls_network; no space left on device → capacity_exhausted; authentication failed / HTTP 401/403 → authentication); raw output inspected in memory only
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures"]
  - surfaces: ["developer-workflow"]
  - verify: "api-mcp"
- [x] 2.2 Wrap the `workspace_transfer` stage in a bounded attempt loop: max 3 attempts, 5 s backoff, no new attempt when `deadline.remainingTimeoutMs()` < 60 s; retry only tls_network and unknown causes; per-attempt diagnostics (non-final failure settles `retryable: true`, next attempt emits its own start)
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures"]
  - surfaces: ["developer-workflow"]
  - verify: "api-mcp"
- [x] 2.3 Unit tests: transient network failure → retried → success with observable per-attempt events; auth/ref/capacity failures do not retry; budget floor stops retries; signature mapping cases incl. unmatched → unknown
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "api-mcp"
- [x] 2.4 Run the workspace-git conformance suite and full api test suite green
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "api-mcp"

## 3. Track: verify-live (depends: tui-normalization, transfer-retry)

- [x] 3.1 Full build + typecheck + lint + api + web suites green
  - requirements: ["agent-runtime/claude-auth-failure-classification-covers-current-cli-phrasings", "sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "api-mcp"
