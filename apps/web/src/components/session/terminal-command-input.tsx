/**
 * `TerminalCommandInput` — the `$`-prompted command row for the FALLBACK
 * line-view ONLY (prototype `.terminal-input`). The live xterm path is a true
 * 1:1 surface (direct `onData` keystrokes); this row is rendered only when xterm
 * fails to mount (the xterm-unavailable degraded path), where there is no
 * terminal to type into.
 *
 * Pure/controlled: the parent owns the input value + submit. Enter or the
 * 发送命令 button submits; the parent clears the value after a successful send
 * (lease-constrained server-side — a no-op without a lease/socket).
 *
 * SSR-safe: no window/clock/random; deterministic render off props.
 */
import * as React from "react";

import { Input } from "@/components/ui/input";

export interface TerminalCommandInputProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  /** Disabled until the terminal/socket is usable (e.g. no session id yet). */
  disabled?: boolean;
}

export function TerminalCommandInput({
  value,
  onValueChange,
  onSubmit,
  disabled = false,
}: TerminalCommandInputProps): React.ReactElement {
  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-terminal-line bg-[#080808] px-4 pb-4 pt-3 font-mono">
      <span className="text-terminal-ok">$</span>
      <Input
        data-terminal-input
        aria-label="远端命令"
        placeholder="输入：status、diff、pause、pnpm test scheduler"
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className="h-auto rounded-none border-0 bg-transparent px-0 py-0 text-[13px] text-terminal-fg shadow-none placeholder:text-terminal-muted focus-visible:border-0 focus-visible:ring-0"
      />
      <button
        type="button"
        data-terminal-send
        disabled={disabled}
        onClick={onSubmit}
        className="inline-flex h-7 items-center justify-center rounded-md bg-terminal-line px-3 text-xs font-medium text-terminal-fg transition-colors hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-50"
      >
        发送命令
      </button>
    </div>
  );
}
