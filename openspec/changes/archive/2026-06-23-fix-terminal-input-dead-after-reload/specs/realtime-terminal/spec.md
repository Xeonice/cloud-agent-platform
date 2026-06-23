## ADDED Requirements

### Requirement: A ready xterm always replaces the read-only fallback

The live session terminal SHALL render the real xterm whenever xterm successfully initializes —
including on WIDE viewports where initialization is slower. The readiness watchdog SHALL NOT
permanently strand the terminal on the read-only fallback when xterm is merely slow: a late `onReady`
(arriving AFTER the watchdog fired) SHALL recover the live terminal (clear the failed state) so the
ready xterm replaces the fallback. The fallback SHALL be shown ONLY for a GENUINE xterm failure (e.g.
the dynamic import threw / the canvas never mounts within a tolerant budget), not for slow
initialization.

#### Scenario: Slow (wide-viewport) xterm init still renders the real terminal

- **WHEN** the terminal page loads on a wide viewport and xterm takes longer than the readiness budget to initialize, then finishes
- **THEN** the real xterm replaces the fallback (the terminal is NOT permanently stuck on the read-only text view) and typing works

#### Scenario: A late onReady recovers from a fired watchdog

- **WHEN** the readiness watchdog has already flipped the failed state and xterm then becomes ready (a late `onReady`)
- **THEN** the failed state is cleared and the real xterm replaces the fallback

#### Scenario: Fallback only for a genuine failure

- **WHEN** xterm genuinely fails to initialize (the dynamic import throws / the canvas never mounts within the tolerant budget)
- **THEN** the read-only fallback is shown (the honest degraded state)

#### Scenario: Wide viewport renders the real terminal across reloads

- **WHEN** the operator reloads the terminal page repeatedly on a wide (≈1728px) viewport
- **THEN** each reload renders the real xterm (not 「降级为文本视图」) and accepts keyboard input

### Requirement: The live terminal preserves a scrollable history

The live session terminal SHALL let the operator scroll up to earlier output. The agent (codex) SHALL
run its TUI in inline mode (normal buffer), NOT the alternate screen, so its output accrues in the
xterm scrollback rather than being pinned to the current screen. The single codex launch argv SHALL
carry `--no-alt-screen` (codex 0.131), kept byte-consistent across the runtime source, the pty-client
default, and the baked image env.

#### Scenario: Operator scrolls up through earlier output

- **WHEN** codex has produced more than one screen of output and the operator scrolls up in the live terminal
- **THEN** earlier output is visible (the live xterm has scrollback; it is not pinned to the current screen)

#### Scenario: codex launches in inline (non-alt-screen) mode

- **WHEN** a task launches codex
- **THEN** the codex launch argv includes `--no-alt-screen` so its output stays in the normal buffer and the live terminal keeps a scrollable history
