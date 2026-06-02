import { z } from 'zod';
import { PauseFrameSchema, ResumeFrameSchema, AckFrameSchema, RawFrameSchema } from './ws-frames.js';
import {
  SnapshotFrameSchema,
  TailReplayFrameSchema,
  ReconnectFrameSchema,
  ResizeFrameSchema,
} from './snapshot-frames.js';
import {
  PermissionRequestFrameSchema,
  DecisionFrameSchema,
  PostToolUseReportFrameSchema,
} from './approvals.js';
import {
  KeystrokeFrameSchema,
  HeartbeatFrameSchema,
  TakeoverRequestFrameSchema,
  LeaseStateFrameSchema,
} from './write-lock-frames.js';
import { DialbackHandshakeFrameSchema } from './dialback.js';
import { ConnectAuthFrameSchema } from './auth.js';

/**
 * The discriminated control-frame union (realtime-terminal spec, D4).
 *
 * Every control frame shares `channel: "control"` and is further discriminated
 * by its `type` literal. Because raw frames live under the disjoint
 * `channel: "raw"` tag, a raw frame can never be parsed as a control frame.
 */
export const ControlFrameSchema = z.discriminatedUnion('type', [
  // flow control
  PauseFrameSchema,
  ResumeFrameSchema,
  AckFrameSchema,
  // reconnect / snapshot / resize
  SnapshotFrameSchema,
  TailReplayFrameSchema,
  ReconnectFrameSchema,
  ResizeFrameSchema,
  // approvals
  PermissionRequestFrameSchema,
  DecisionFrameSchema,
  PostToolUseReportFrameSchema,
  // write lock
  KeystrokeFrameSchema,
  HeartbeatFrameSchema,
  TakeoverRequestFrameSchema,
  LeaseStateFrameSchema,
  // runner dial-back
  DialbackHandshakeFrameSchema,
  // operator connect-auth (browser/non-browser WS connect credential)
  ConnectAuthFrameSchema,
]);
export type ControlFrame = z.infer<typeof ControlFrameSchema>;

/**
 * The full WebSocket frame union: either an opaque raw byte frame
 * (`channel: "raw"`) or a structured control frame (`channel: "control"`).
 * Discrimination on the top-level `channel` tag guarantees a raw frame is
 * never misread as a control frame.
 */
export const WsFrameSchema = z.union([RawFrameSchema, ControlFrameSchema]);
export type WsFrame = z.infer<typeof WsFrameSchema>;
