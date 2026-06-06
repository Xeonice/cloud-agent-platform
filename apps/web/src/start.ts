/**
 * TanStack Start instance (rebuild-console-tanstack-start D3).
 *
 * `defaultSsr: true` — every route SSRs by default; the only opt-out is the
 * terminal session route `/_app/tasks/$taskId`, which sets `ssr: false` because
 * xterm.js + the WebSocket cannot run on the server (D3.3).
 */
import { createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => {
  return {
    defaultSsr: true,
  };
});
