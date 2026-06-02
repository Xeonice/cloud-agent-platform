import { z } from 'zod';
import { FRAME_CHANNEL } from './ws-frames.js';

/**
 * Runner dial-back handshake (runner-dialback-and-creds spec, D8).
 *
 * The runner dials OUT to the orchestrator; its FIRST frame is this handshake,
 * carrying a short-lived, per-task, single-task-scoped `TASK_TOKEN`. The
 * orchestrator rejects missing/malformed/expired/mismatched tokens (including a
 * token issued for task A claiming task B).
 */
export const DialbackHandshakeFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('dialback_handshake'),
  /** The task the runner claims to be. */
  taskId: z.string().uuid(),
  /** Short-lived per-task bearer token authenticating the dial-back. */
  TASK_TOKEN: z.string().min(1),
});
export type DialbackHandshakeFrame = z.infer<typeof DialbackHandshakeFrameSchema>;
