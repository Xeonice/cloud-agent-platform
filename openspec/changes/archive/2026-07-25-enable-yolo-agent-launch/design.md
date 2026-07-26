## Context

Task agents execute inside a provider-selected, per-task sandbox and are reached through
the CAP terminal gateway. AIO and BoxLite now share `@cap/sandbox` session machinery;
provider packages own only their transport/executor details. Runtime policy remains in
`CodexRuntime` and `ClaudeCodeRuntime`.

The implemented flags are supported by the installed CLIs (`codex-cli 0.145.0`, Claude
Code 2.1.219) and by their current help surfaces. Anthropic's official CLI reference
defines `--dangerously-skip-permissions` as the flag that skips permission prompts. The
Codex help describes `--dangerously-bypass-approvals-and-sandbox` as intended for an
externally sandboxed environment. The shipped images pin Codex 0.144.1 and Claude Code
2.1.207, so host parsing is supporting evidence, not a substitute for image/provider
canaries.

The earlier approval design left contradictory state: the AIO image baked a Codex hook,
per-task Codex setup deleted that hook before launch, and a fail-closed approval class was
registered in DI without a production `enforceThen` call site. This design treats actual
runtime behavior as authoritative and removes the unsupported security claim.

## Goals / Non-Goals

**Goals:**

- Use explicit no-prompt permission modes for every entry point in scope.
- Preserve provider-neutral selection and one launch policy for AIO and BoxLite.
- Preserve file-backed prompt/model/credential handling and task-scoped tmux lifecycle.
- Make the approval/containment boundary accurate and testable.
- Verify the exact pinned image CLIs and fresh-sandbox behavior before archive.

**Non-Goals:**

- Providing per-command human approval inside a bypass-mode interactive PTY.
- Treating the dormant exec enforcer as production coverage.
- Redesigning live reconnect, scrollback, or alternate-screen handling; that is owned by
  `restore-native-live-terminal` after this change is archived.
- Adding cross-provider retry after a selected provider fails. AIO and BoxLite are
  independently selected by capability and priority.

## Decisions

### D1. The per-task provider sandbox is the autonomous-execution boundary

Interactive Codex uses `--dangerously-bypass-approvals-and-sandbox`; interactive and
headless Claude use `--dangerously-skip-permissions`. These modes are accepted for
owner-directed autonomous work because the process is already inside a task-scoped AIO
or BoxLite sandbox. That boundary isolates the host, other tasks, and their workspaces.
It does not isolate the same-UID agent from the owner-scoped credential required by its
CLI, and the current providers do not impose an LLM-only egress allowlist. Provider
lifecycle, opaque control-plane delivery, workspace scoping, and proven cleanup are
release gates; resistance to a malicious prompt/repo that deliberately reads and
exfiltrates the injected owner credential is out of scope until CAP has a task-bound auth
broker or equivalent short-TTL capability.

Alternative considered: keep the inner CLI approval loop. Rejected because it blocks the
required unattended task flow and behaves differently across entry points.

### D2. Runtime policy selects flags; shared/provider layers do not invent alternatives

The permission matrix is:

| Runtime | Interactive | Headless new | Headless resume |
| --- | --- | --- | --- |
| Codex | `--dangerously-bypass-approvals-and-sandbox` | same bypass on `codex exec` | same explicit bypass on `codex exec resume` |
| Claude Code | `--dangerously-skip-permissions` | same bypass on `claude -p` | same bypass on `claude -p --resume` |

Model material remains an independently validated optional argument. Tests therefore
assert required/forbidden flags without hard-coding away a legitimate `--model` segment.
The provider-neutral engine consumes the resolved runtime; AIO and BoxLite transports do
not branch on agent identity or silently fall back to pre-YOLO argv.

The pinned Codex 0.144.1 can parse the bypass flag on `exec resume`. A real BoxLite
new→resume canary demonstrated that relying on inherited approval state can exit 0 without
performing the requested tool call, so resume repeats the bypass explicitly and validates
the transcript-derived session identifier before it enters the shell command.

Alternative considered: make image `CODEX_LAUNCH_ARGV` the runtime source of truth.
Rejected because the orchestrator builds the command before it enters the sandbox; image
ENV is a compatibility/contract mirror and is checked against runtime policy.

### D3. Claude dangerous-mode acknowledgement is additive to onboarding/trust

Provisioning writes `/home/gem/.claude/settings.json` with
`permissions.skipDangerousModePermissionPrompt=true`. It also preserves the identical
global/project onboarding document at both `$HOME/.claude.json` and
`$CLAUDE_CONFIG_DIR/.claude.json`, because pinned Claude releases have differed on which
path is authoritative. Files remain mode 0600, credentials remain in the separate launch
environment file, and no secret is placed in argv or verification output.

Alternative considered: replace the two onboarding files with `settings.json`. Rejected
because the files address different first-run gates.

### D4. Prompt delivery and terminal lifecycle do not change with permission policy

Prompt text is delivered through the provider's opaque private-file transport into a
sandbox file and passed as one positional shell argument through `$(cat ...)`; arbitrary
quotes, substitutions, newlines, and flag-like text never become launch syntax or an
ordinary exec request. The shared detached tmux wrapper, DSR/CPR startup policy,
headless exit sentinel, runtime model policy, transcript declarations, and task ownership
remain unchanged.

The current Codex `--no-alt-screen` and Claude
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` behavior is only the composed baseline at this
archive point. The immediately following native-terminal change removes those two
interactive overrides while preserving all YOLO decisions.

### D5. Bypass-mode production tasks do not register the legacy Codex hook

The AIO image no longer bakes `~/.codex/hooks.json` or `/opt/cap/dist/hooks`; task setup
continues to ensure a stale `hooks.json` is absent. The hook adapter may remain as isolated
repository code/tests, but it is not a property of the bypass-mode runtime image and is
not an approval or reporting guarantee.

`SandboxApprovalEnforcer` retains a fail-closed class contract for a future CAP-brokered
exec call site. Today it is only registered under `SANDBOX_APPROVAL_ENFORCER`; since no
production caller invokes `enforce`/`enforceThen`, neither PTY activity nor ordinary setup
execs are claimed to be gated by it.

Alternative considered: keep baking the hook and claim it as a fallback. Rejected because
provisioning deletes it, bypass semantics do not provide a verified pre-tool gate, and a
DI registration without a caller is not enforcement.

### D6. Verification is versioned and provider-explicit

Static golden tests cover interactive/headless/resume flags, forbidden legacy flags,
shared launch construction, and both Docker ENV mirrors. Parser probes run inside the
actual pinned AIO and BoxLite images. Fresh provider canaries explicitly select each
provider and verify first launch, a real write/shell/git tool action, headless completion,
resume where supported, no blocking permission screen, transcript/exit evidence,
control-plane/argv/log/residue secret non-disclosure, and exact cleanup. These canaries do
not claim to defeat deliberate same-UID credential exfiltration.

Host CLI help is an early diagnostic only. A skipped provider test is not a passing real
gate, and selection failure is not allowed to fall through to a different provider.

## Risks / Trade-offs

- [Bypass expands the process blast radius inside its sandbox] -> require per-task host
  and workspace isolation, opaque credential delivery, exact cleanup evidence, and an
  explicit trusted-owner workload boundary. Do not claim prompt-injection-resistant
  credential containment without a task-bound broker and egress policy.
- [Pinned CLI flags or first-run keys drift] -> probe the exact image versions and block
  archive/release on any prompt or parser mismatch.
- [Image ENV, runtime default, and compatibility launch seams drift] -> cross-layer
  golden tests reject mismatched or legacy flags; the native-terminal follow-up removes
  or characterizes remaining duplicates.
- [Codex resume inherits an unexpected sandbox/approval mode] -> exercise a real pinned
  new-session/resume pair rather than inferring behavior from help text.
- [Removing the baked hook loses post-tool reporting once assumed by operators] -> state
  that no such production guarantee exists; structured transcript/activity is the
  observability source until a separately designed reporting channel is verified.
- [A stale browser/terminal implementation confuses this policy change with replay] ->
  archive YOLO first, then rebase and apply `restore-native-live-terminal`; never archive
  them in the opposite order.

## Migration Plan

1. Rebase the artifacts and tests to provider-center paths and current CLI pins.
2. Remove dead hook artifacts/claims and correct dormant-enforcer documentation.
3. Run focused unit/golden/type/lint/OpenSpec gates.
4. Run explicit BoxLite and AIO pinned-image/fresh-task canaries and record cleanup.
5. Archive this change into canonical specs only after every gate passes.
6. Rebase `restore-native-live-terminal`, which preserves the permission decisions while
   changing only the interactive terminal/reconnect behavior.

Rollback restores the prior runtime/image flags as one coordinated build. It does not
promise that the unreliable hook becomes an approval gate; detached tasks already running
under YOLO are not killed merely by rolling back the API/Web build.

## Open Questions

- None for the permission policy. Real provider evidence is a release gate, not an open
  design choice.
