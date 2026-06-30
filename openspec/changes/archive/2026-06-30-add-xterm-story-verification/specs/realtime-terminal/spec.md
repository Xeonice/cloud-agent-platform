## ADDED Requirements

### Requirement: Local xterm story verifies terminal rendering behavior

The realtime terminal SHALL provide a local-only xterm story or harness that mounts the same shared terminal wrapper used by the console and verifies rendering behavior that is not covered by masked page screenshots. The story SHALL NOT be exposed as a production console route and SHALL be runnable by local verification tooling.

#### Scenario: Story mounts the shared terminal wrapper

- **WHEN** the xterm story is opened in local verification
- **THEN** it mounts the same shared `@cap/ui` terminal wrapper used by the live session terminal
- **AND** it imports the same app terminal styles needed for production-equivalent rendering

#### Scenario: Story reproduces the session height chain

- **WHEN** the session-shell terminal story is rendered at desktop and mobile viewport sizes
- **THEN** the terminal article fills the remaining viewport-height slot below the story header
- **AND** the xterm surface fills the terminal article body rather than rendering as a smaller partial region

#### Scenario: Story verifies scrollback remains readable

- **WHEN** the story writes more terminal output than fits in the visible rows and then continues writing new output
- **THEN** the xterm viewport remains scrollable to earlier output
- **AND** earlier history remains visible when the operator scrolls upward

#### Scenario: Story verifies UTF-8 rendering

- **WHEN** the story writes Chinese text and multibyte UTF-8 characters, including writes split across chunk boundaries
- **THEN** the rendered terminal output contains the original characters
- **AND** the output does not replace them with underscores or replacement characters

#### Scenario: Story verifies resize reporting

- **WHEN** the story container is resized
- **THEN** xterm is refit to the new container
- **AND** the story records the latest terminal cols and rows reported through the shared terminal resize callback

#### Scenario: Terminal story checks run outside the masked visual baseline

- **WHEN** the terminal story verification command runs
- **THEN** it uses terminal-specific Playwright checks for geometry, scrollability, UTF-8 text, and resize events
- **AND** it does not rely on the existing design-baseline suite, which masks the live terminal region
