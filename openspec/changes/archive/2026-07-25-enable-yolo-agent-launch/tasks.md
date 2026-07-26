# Tasks

## 1. Track: runtime-launch-policy

- [x] 1.1 `CodexRuntime` interactive launch uses Codex's documented bypass/YOLO-style flag.
- [x] 1.2 `ClaudeCodeRuntime` interactive launch uses Claude Code's documented bypass-permissions flag.
- [x] 1.3 Claude Code headless launch/resume uses the same bypass-permissions flag.
- [x] 1.4 Claude Code setup pre-seeds user settings to skip the dangerous-mode confirmation prompt.
- [x] 1.5 Remove the obsolete Codex launch guard that rejected bypass/YOLO flags.

## 2. Track: image-contract-and-tests

- [x] 2.1 Update `CODEX_LAUNCH_ARGV` in the derived AIO and BoxLite sandbox image contracts.
- [x] 2.2 Update runtime and terminal golden tests for the new launch flags.
- [x] 2.3 Run targeted API tests for runtime launch and terminal launch helpers.
- [x] 2.4 Run API typecheck/lint.
- [x] 2.5 Validate this OpenSpec change.

## 3. Track: post-provider-center-rebase-and-verification

- [x] 3.1 Add the security/ownership design and rebase proposal plus all three deltas to the provider-center architecture, current CLI pins, and the later native-terminal composition boundary.
- [x] 3.2 Remove dead AIO image hook artifacts and correct code/image/spec comments so the dormant approval enforcer and ungated bypass PTY are described truthfully.
- [x] 3.3 Add cross-layer golden coverage for Claude resume, forbidden legacy flags, provider-neutral launch construction, and matching AIO/BoxLite image contracts.
- [x] 3.4 Run host and exact pinned-image parser probes for all interactive/headless/resume flags; verify fresh Claude settings/onboarding paths and 0600 permissions without exposing credentials.
- [x] 3.5 Run explicit real BoxLite and `bwg-jp` AIO fresh-task canaries for Codex/Claude interactive and headless execution (including supported resume), a real shell/write/git action, no blocking prompt, exit/transcript evidence, reconnect without relaunch, control-plane/argv/log/residue secret non-disclosure, and exact cleanup. Record that this does not prove resistance to deliberate same-UID credential exfiltration.
- [x] 3.6 Run affected tests, typecheck, lint, Docker contract checks, strict OpenSpec validation, and `git diff --check`; write `verification-report.md` with versions, commands, task/session ids, outcomes, limitations, and cleanup evidence.
