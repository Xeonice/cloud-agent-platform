import { FRAME_CHANNEL } from './ws-frames.js';

/**
 * Transitional internal shape used only by the legacy finished/static recording
 * utility while the gateway replay implementation is removed in Track 5.
 *
 * This is intentionally a TypeScript type, not a wire schema, and is not part
 * of `ControlFrame`/`WsFrame`: live WebSocket parsing rejects `snapshot`.
 */
export interface SnapshotFrame {
  readonly channel: typeof FRAME_CHANNEL.CONTROL;
  readonly type: 'snapshot';
  readonly data: string;
  readonly cols: number;
  readonly rows: number;
  readonly seq: number;
}

/**
 * Transitional internal shape for the legacy recording reader. There is no
 * exported `TailReplayFrameSchema`, and live WebSocket parsing rejects it.
 */
export interface TailReplayFrame {
  readonly channel: typeof FRAME_CHANNEL.CONTROL;
  readonly type: 'tail_replay';
  readonly data: string;
  readonly seq: number;
  readonly final: boolean;
}
