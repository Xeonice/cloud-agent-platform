/**
 * `TerminalSkeleton` — the `ssr: false` route's `pendingComponent` (task 18.1).
 *
 * THIS IS SERVER-RENDERED. `ssr: false` skips the page component on the server
 * but STILL renders the `pendingComponent`, so this MUST be pure, window-free
 * markup: no `window`, no `document`, no xterm, no WebSocket, no clock/random.
 * It reproduces the terminal-card chrome (head + dark body + input row) with a
 * muted「正在连接会话…」placeholder so there is no layout flash before the
 * client-only live terminal mounts.
 */
import * as React from "react";

export function TerminalSkeleton(): React.ReactElement {
  return (
    <section className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-[minmax(0,1fr)]">
      <article className="flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-terminal-bg text-terminal-fg shadow-terminal">
        {/* terminal-head */}
        <div className="flex min-h-[40px] flex-none items-center justify-between border-b border-terminal-line bg-[#0d0d0d] px-3.5 font-mono text-xs text-terminal-muted">
          <span>正在连接会话…</span>
          <span className="font-mono">pty: —</span>
        </div>
        {/* xterm-host placeholder (dark body) — fills the space below the head */}
        <div className="min-h-0 flex-1 bg-[#050505] p-4 font-mono text-[13px] leading-[1.6]">
          <span className="block text-terminal-muted">正在连接会话…</span>
        </div>
        {/* terminal-input row */}
        <div className="grid flex-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-terminal-line bg-[#080808] px-4 pb-4 pt-3 font-mono">
          <span className="text-terminal-ok">$</span>
          <span className="text-terminal-muted">连接后可输入命令…</span>
          <span aria-hidden className="h-7" />
        </div>
      </article>
    </section>
  );
}
