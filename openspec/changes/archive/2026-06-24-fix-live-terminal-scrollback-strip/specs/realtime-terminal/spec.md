## MODIFIED Requirements

### Requirement: The live terminal preserves a scrollable history

The live session terminal SHALL let the operator scroll up to earlier output WHILE THE TASK IS
RUNNING. The agent (codex) SHALL run inline (`--no-alt-screen`). Because codex runs inside a detached
tmux session whose ATTACHED CLIENT renders in the alternate screen — which tmux's `alternate-screen`
window option canNOT disable (that option governs only the pane program, not the client's attach
alt-screen) — the front-end SHALL STRIP the alt-screen switch from the live stream so the output lands
in the NORMAL buffer instead of the live xterm's non-scrollable alternate buffer. The live output SHALL
accrue in the xterm scrollback, and the viewport SHALL be synced to that buffer so the accumulated
history is ACTUALLY scrollable (the `.xterm-viewport` height reflects the buffer, not a single screen),
updating as live output arrives.

#### Scenario: Operator scrolls up through earlier output while running

- **WHEN** a RUNNING task's codex has produced more than one screen of output and the operator scrolls up in the live terminal
- **THEN** earlier output is visible — the live xterm accumulated scrollback (it is not pinned to the current screen), and scrolling reaches the top of the history

#### Scenario: codex launches in inline (non-alt-screen) mode

- **WHEN** a task launches codex
- **THEN** the codex launch argv includes `--no-alt-screen` so codex itself does not switch to the alternate screen

#### Scenario: The front-end strips the alt-screen switch from the live stream

- **WHEN** the live `onRaw` stream contains the tmux attach client's alt-screen switch (`?1049h/l`, `?1047h/l`, `?47h/l`) — which tmux options cannot suppress
- **THEN** the front-end strips that switch from the bytes (UTF-8-safe, before writing to xterm), so the live output lands in the normal buffer and accumulates scrollback rather than entering the non-scrollable alternate buffer

#### Scenario: The live viewport reflects accumulated scrollback

- **WHEN** the live buffer has accumulated more than one screen of scrollback
- **THEN** the `.xterm-viewport` is synced so it is scrollable (its scrollHeight reflects the full buffer), updating as new live output arrives — the operator never sees a buffer that has scrollback but a viewport stuck at one non-scrollable screen
