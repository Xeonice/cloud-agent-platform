/**
 * Runner dial-back module (track runner-dialback-and-creds, task 8.1).
 *
 * Public surface for the runner's outbound dial-back to the orchestrator:
 * - {@link DialBackClient} opens an outbound WebSocket and never listens inbound,
 *   sending the handshake frame as its first frame.
 * - {@link buildHandshakeFrame} constructs the contracts-defined dial-back
 *   handshake frame carrying the per-task `TASK_TOKEN`.
 */
export {
  DialBackClient,
  type DialBackClientOptions,
  type DialBackState,
  type OutboundSocket,
  type OutboundSocketFactory,
} from './dialback-client.js';
export {
  buildHandshakeFrame,
  handshakeInputFromEnv,
  type HandshakeInput,
} from './handshake.js';
