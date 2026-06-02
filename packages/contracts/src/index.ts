/**
 * @cap/contracts — single source of truth.
 *
 * Exports zod schemas alongside their `z.infer` types. All apps
 * (`apps/api`, `apps/web`, `apps/runner`) consume shared shapes from here via
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

// Runner dial-back handshake frame
export * from './dialback.js';

// Notification adapter payloads (notify / request-decision)
export * from './notifications.js';

// SandboxProvider sandbox-mode enum
export * from './sandbox.js';

// Operator-auth shapes: WS connect-auth frame + shared AUTH_TOKEN config contract
export * from './auth.js';

// Composed discriminated control-frame union + full WS frame union
export * from './control-frame.js';
