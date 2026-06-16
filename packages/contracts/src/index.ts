/**
 * @cap/contracts — single source of truth.
 *
 * Exports zod schemas alongside their `z.infer` types. All apps
 * (`apps/api`, `apps/web`) consume shared shapes from here via
 * `workspace:*` and never re-declare them locally (D11).
 */

// Repo / Task domain + REST bodies + task-status enum
export * from './task.js';

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

// Operator-auth shapes: WS connect-auth frame + shared AUTH_TOKEN config contract
export * from './auth.js';

// Multi-user GitHub OAuth session identity + GET /auth/session response shape
export * from './session.js';

// Composed discriminated control-frame union + full WS frame union
export * from './control-frame.js';

// GitHub repository import: available-GitHub-repo + import request shapes
export * from './github-import.js';

// Account settings preferences + Codex execution credential (read/write shapes)
export * from './settings.js';

// Audit/history: append-only audit event record + history-timeline query
export * from './audit.js';

// Runtime metrics: derived semaphore capacity + sampled CPU/memory aggregation
export * from './metrics.js';

// Read-only session-history replay model (finished-task transcript read-model)
export * from './session-history.js';

// Build-version metadata: unauthenticated GET /version response shape + fallback
export * from './version.js';
