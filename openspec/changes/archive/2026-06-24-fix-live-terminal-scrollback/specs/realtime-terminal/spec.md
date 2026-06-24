## MODIFIED Requirements

### Requirement: The live terminal preserves a scrollable history

The live session terminal SHALL let the operator scroll up to earlier output WHILE THE TASK IS
RUNNING. The agent (codex) SHALL run inline (`--no-alt-screen`, normal buffer) AND, because codex runs
inside a detached tmux session, the tmux attached client SHALL also render the pane in the NORMAL
buffer (NOT the alternate screen) — otherwise tmux's alternate screen overrides codex's inline mode and
the live xterm enters its alternate buffer (no scrollback). The live stream's output SHALL accrue in
the xterm scrollback, and the viewport SHALL be synced to that buffer so the accumulated history is
ACTUALLY scrollable (the `.xterm-viewport` height reflects the buffer, not a single screen), updating
as live output arrives.

#### Scenario: Operator scrolls up through earlier output while running

- **WHEN** a RUNNING task's codex has produced more than one screen of output and the operator scrolls up in the live terminal
- **THEN** earlier output is visible — the live xterm accumulated scrollback (it is not pinned to the current screen), and scrolling reaches the top of the history

#### Scenario: codex launches in inline (non-alt-screen) mode

- **WHEN** a task launches codex
- **THEN** the codex launch argv includes `--no-alt-screen` so codex itself does not switch to the alternate screen

#### Scenario: tmux does not pin the pane to the alternate screen

- **WHEN** codex runs inside the detached tmux session and the pty client attaches
- **THEN** the PTY stream reaching the browser is normal-buffer (tmux is not rendering the pane in the alternate screen), so the live xterm accumulates scrollback rather than entering its non-scrollable alternate buffer

#### Scenario: The live viewport reflects accumulated scrollback

- **WHEN** the live buffer has accumulated more than one screen of scrollback
- **THEN** the `.xterm-viewport` is synced so it is scrollable (its scrollHeight reflects the full buffer), updating as new live output arrives — the operator never sees a buffer that has scrollback but a viewport stuck at one non-scrollable screen
