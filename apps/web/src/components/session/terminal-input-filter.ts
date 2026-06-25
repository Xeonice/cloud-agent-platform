/**
 * xterm.js emits terminal-generated replies through `onData` when replayed
 * output contains terminal queries (DA/CPR/DSR). During reconnect replay those
 * replies are historical side effects, not operator keystrokes, so the session
 * bridge must not send them back to the live PTY.
 */

const TERMINAL_GENERATED_RESPONSE_RE =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b\[(?:(?:\?\d+(?:;\d+)*)c|(?:>\d+(?:;\d+)*)c|(?:\d+(?:;\d+)*)R|(?:\d+)n))*$/;

export function isTerminalGeneratedResponse(data: string): boolean {
  return data.length > 0 && TERMINAL_GENERATED_RESPONSE_RE.test(data);
}
