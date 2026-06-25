# Tasks

## 1. Track: runtime-launch-policy

- [x] 1.1 `CodexRuntime` interactive launch uses Codex's documented bypass/YOLO-style flag.
- [x] 1.2 `ClaudeCodeRuntime` interactive launch uses Claude Code's documented bypass-permissions flag.
- [x] 1.3 Claude Code headless launch/resume uses the same bypass-permissions flag.
- [x] 1.4 Claude Code setup pre-seeds user settings to skip the dangerous-mode confirmation prompt.
- [x] 1.5 Remove the obsolete Codex launch guard that rejected bypass/YOLO flags.

## 2. Track: image-contract-and-tests

- [x] 2.1 Update `CODEX_LAUNCH_ARGV` in the derived AIO sandbox image contract.
- [x] 2.2 Update runtime and terminal golden tests for the new launch flags.
- [x] 2.3 Run targeted API tests for runtime launch and terminal launch helpers.
- [x] 2.4 Run API typecheck/lint.
- [x] 2.5 Validate this OpenSpec change.
