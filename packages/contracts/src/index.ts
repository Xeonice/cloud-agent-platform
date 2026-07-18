/**
 * @cap/contracts — single source of truth.
 *
 * Exports zod schemas alongside their `z.infer` types. All apps
 * (`apps/api`, `apps/web`) consume shared shapes from here via
 * `workspace:*` and never re-declare them locally (D11).
 */

// Repo / Task domain + REST bodies + task-status enum + agent-runtime selector
export * from './task.js';

// Strict, task-owned provisioning diagnostic event/attempt/query contracts.
export * from './task-provisioning-diagnostics.js';

// Shared git branch/ref validation used by verified repository import metadata.
export * from './git-ref.js';

// Agent-runtime readiness: per-runtime { id, ready } booleans (no secrets)
export * from './runtime.js';

// Contextual per-owner runtime model catalog, immutable environment snapshot,
// and transport-neutral model-domain failures.
export * from './runtime-model.js';

// Strict packaged artifact identity shared by environment validation/release.
export * from './artifact-checksum.js';

// Secret-free shared primitives for deployment capability attestations.
export * from './deployment-capability.js';

// Deployment-wide default-closed capability and N-worker readiness attestation
// for safe task model selection rollout.
export * from './task-model-capability.js';

// Deployment-wide default-closed capability attestation for durable admission.
export * from './task-admission-capability.js';

// Deployment-wide API/MCP/Web compatibility gate for provisioning diagnostics.
export * from './task-provisioning-diagnostics-capability.js';

// Dual-channel WebSocket frame protocol (raw + flow-control frames)
export * from './ws-frames.js';

// SerializeAddon snapshot + reconnect/tail-replay frames
export * from './snapshot-frames.js';

// Approval contract: decision shape + forward-event + PostToolUse report
export * from './approvals.js';

// Write-lock lease state + keystroke/heartbeat/takeover frames
export * from './write-lock-frames.js';

// Notification adapter payloads (notify / request-decision)
export * from './notifications.js';

// SandboxProvider sandbox-mode enum
export * from './sandbox.js';

// Admin-managed sandbox runtime environments and task environment summaries
export * from './sandbox-environment.js';

// Required metadata baked into every supported sandbox image.
export * from './sandbox-metadata.js';

// Operator-auth shapes: WS connect-auth frame + shared AUTH_TOKEN config contract
export * from './auth.js';

// Private-account identity DTOs (add-private-account-identity): password login,
// email-OTP request/verify, change-password, admin account lifecycle (create/
// enable/disable/reset/role + list), one-time admin reveal, auth capability flags
export * from './auth-account.js';

// Authorization scope vocabulary shared by API-key + machine principals
export * from './scope.js';

// Reserved credential prefixes (single source for dispatch/minting/boot assertion)
export * from './credential-prefix.js';

// API-key management DTOs: mint request, show-once mint response, list item, revoke
export * from './api-key.js';

// MCP-token management DTOs: mint request, show-once mint response, list item, revoke
// (settings-minted `mcp_` credential; mirrors the api-key CRUD shapes, reusing the
// shared ScopeSchema + the reserved `mcp_` credential prefix)
export * from './mcp-token.js';

// Session identity + GET /auth/session response shape
export * from './session.js';

// Composed discriminated control-frame union + full WS frame union
export * from './control-frame.js';

// GitHub repository import: available-GitHub-repo + import request shapes
export * from './github-import.js';

// Account settings preferences + Codex execution credential (read/write shapes)
// + admin-managed SMTP config DTOs (add-smtp-config-ui): masked read, save
// (write-only password), and the test-send request/{ ok, message } response
export * from './settings.js';

// Audit/history: append-only audit event record + history-timeline query
export * from './audit.js';

// Runtime metrics: derived semaphore capacity + sampled CPU/memory aggregation
export * from './metrics.js';

// Read-only session-history replay model (finished-task transcript read-model)
export * from './session-history.js';

// Build-version metadata: unauthenticated GET /version response shape + fallback
export * from './version.js';

// Update availability: operator-guarded GET /update-status shape + version compare
export * from './update-status.js';

// asciicast v2 terminal-replay recording shapes (header + event + parse helpers)
export * from './asciicast.js';

// Public /v1 API DTOs: create-with-repoId body + keyset-paginated list envelopes
// + list query + SSE lifecycle-event shape (additive; never mutate console schemas)
export * from './v1.js';

// Scheduled task DTOs + cron/timezone next-fire helper.
export * from './schedule.js';

// Canonical public /v1 operation inventory projected by OpenAPI, API Playground,
// and MCP capability parity tests.
export * from './public-v1-operations.js';

// The exact zod instance every contracts schema is built on. Re-exported so a
// CJS consumer (the api) can run `extendZodWithOpenApi` on the SAME class realm
// the schemas inherit from — see ./zod-instance.ts for the ESM/CJS realm split.
export * from './zod-instance.js';
