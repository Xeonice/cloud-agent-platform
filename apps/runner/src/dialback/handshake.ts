import {
  DialbackHandshakeFrameSchema,
  FRAME_CHANNEL,
  type DialbackHandshakeFrame,
} from '@cap/contracts';

/**
 * Runner dial-back handshake construction (track runner-dialback-and-creds, 8.1).
 *
 * The dial-back handshake is a *first-class frame type* whose wire shape is owned
 * by `@cap/contracts` (contracts task 2.7). This module does not redefine that
 * shape — it only constructs and validates an instance of it for the runner to
 * send as the very first frame on its outbound socket.
 *
 * The frame carries:
 * - the claimed `taskId` (the task this runner believes it is), and
 * - the short-lived per-task `TASK_TOKEN` minted by the orchestrator at task
 *   creation (contracts/orchestrator track 8.3).
 *
 * Carrying both lets the orchestrator handshake verifier (track 14, task 8.2)
 * reject a token issued for task A that is presented while claiming task B: the
 * token is bound to exactly one task and is never reusable across tasks.
 */

/** Inputs needed to mint the runner's first (handshake) frame. */
export interface HandshakeInput {
  /** The task this runner is the sandbox for. */
  readonly taskId: string;
  /**
   * The short-lived, single-task-scoped credential proving this runner is the
   * sandbox for `taskId`. Sourced from the environment (e.g. `TASK_TOKEN`) that
   * the orchestrator injected when it provisioned the sandbox; never persisted.
   */
  readonly taskToken: string;
}

/**
 * Builds and validates the dial-back handshake frame.
 *
 * Validation goes through the contracts schema so a malformed frame is caught
 * on the runner before it is ever sent, rather than only being rejected by the
 * orchestrator. Throws if `taskId` or `taskToken` are empty/whitespace.
 */
export function buildHandshakeFrame(input: HandshakeInput): DialbackHandshakeFrame {
  const taskId = input.taskId?.trim();
  const taskToken = input.taskToken?.trim();

  if (!taskId) {
    throw new Error('Dial-back handshake requires a non-empty taskId');
  }
  if (!taskToken) {
    throw new Error('Dial-back handshake requires a non-empty TASK_TOKEN');
  }

  // contracts is the single source of truth for the frame shape and its
  // discriminator; `.parse` both validates the channel/type discriminators and
  // guarantees the result is wire-valid. The token field is named `TASK_TOKEN`
  // to match the contracts handshake frame exactly.
  return DialbackHandshakeFrameSchema.parse({
    channel: FRAME_CHANNEL.CONTROL,
    type: 'dialback_handshake',
    taskId,
    TASK_TOKEN: taskToken,
  });
}

/**
 * Reads the handshake inputs from the runner process environment. The
 * orchestrator injects `TASK_ID` and `TASK_TOKEN` when it provisions the
 * sandbox; the token is treated as an ephemeral secret and is never written to
 * disk or logged.
 */
export function handshakeInputFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HandshakeInput {
  return {
    taskId: env.TASK_ID ?? '',
    taskToken: env.TASK_TOKEN ?? '',
  };
}
