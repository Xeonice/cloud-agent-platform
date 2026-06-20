# Tasks — add-headless-execution-track

## 1. Port contracts (AgentRuntime)
- [x] 1.1 Add `ExecutionMode = 'interactive-pty' | 'headless-exec'` and `readonly executionModes: ReadonlySet<ExecutionMode>` to the `AgentRuntime` port (`agent-runtime.port.ts`).
- [x] 1.2 Add `buildHeadlessLine(ctx: LaunchContext): string` and `buildResumeLine(ctx: LaunchContext, prevSessionId: string): string` to the port (optional for runtimes that omit `headless-exec`).
- [x] 1.3 Add the transcript contract to the port (Option A — keep the port a dependency-light leaf): `transcriptArtifact(ctx): { dir, filenameGlob }` + a `transcriptFormat: 'codex-rollout' | 'claude-jsonl'` tag. The parser is NOT a port method; the sandbox layer dispatches by the tag (4.2). Plus a registry-free `transcriptFormatForRuntime` helper for the durable-read path.
- [x] 1.4 Update the port doc-comment to state execution-mode is consumer-selected and transcript is per-runtime-declared (no codex hardcoding downstream).

## 2. CodexRuntime headless + transcript
- [x] 2.1 Implement `executionModes = {interactive-pty, headless-exec}` and `buildHeadlessLine` = `codex exec --json -C <ws> --ask-for-approval never --sandbox danger-full-access --dangerously-bypass-hook-trust --skip-git-repo-check < /dev/null` (stdin redirect MANDATORY).
- [x] 2.2 Implement `buildResumeLine` = `codex exec resume <sid> "<prompt>" --json --skip-git-repo-check < /dev/null` (NO `-s`).
- [x] 2.3 Implement `transcriptArtifact` → `{ dir: ~/.codex/sessions, filenameGlob: /rollout-.*\.jsonl$/ }` + `transcriptFormat = 'codex-rollout'` (the sandbox dispatch maps it to the existing `parseRollout`).

## 3. ClaudeCodeRuntime headless + transcript + parser
- [x] 3.1 Implement `executionModes = {interactive-pty, headless-exec}` and `buildHeadlessLine` = `claude -p "<prompt>" --output-format stream-json --session-id <uuid>` (+ existing sandbox/onboarding flags).
- [x] 3.2 Implement `buildResumeLine` = `claude -p "<prompt>" --resume <sid> --output-format stream-json`.
- [x] 3.3 Implement `transcriptArtifact` → `{ dir: ~/.claude/projects/<claudeProjectSlug(ws)>, filenameGlob: /<session-id>\.jsonl$/ }` reusing `claudeProjectSlug` (`replace(/[^a-zA-Z0-9]/g,'-')`).
- [x] 3.4 Write a NEW claude JSONL parser (`claude-transcript-parser.ts`): map chained `{type:'user'|'assistant', message, uuid, parentUuid}` records to `SessionTurn[]`; SKIP non-conversational types (`queue-operation`/`attachment`/`last-prompt`/`rate_limit_event`/`system`); defensive on unknown types/missing fields. Declare `transcriptFormat = 'claude-jsonl'`; the sandbox `parse-transcript` module dispatches to this parser by that tag (NOT a port method).

## 4. Runtime-aware transcript read/parse mechanism
- [x] 4.1 `aio-sandbox.provider.ts` `readRolloutFromContainer`: resolve `{dir, filenameGlob}` from the task's runtime `transcriptArtifact` (drop hardcoded `~/.codex/sessions` + `rollout-*.jsonl`); pull only that dir; newest match; null on miss.
- [x] 4.2 `parseRollout` call sites (mcp.server / v1-transcript / session-history / session-transcript.service): dispatch to the task runtime's `parseTranscript` instead of the codex parser.
- [x] 4.3 `session-transcript.service` durable capture: read+archive the per-runtime artifact (raw JSONL), per the runtime's declaration.

## 5. Execution-mode routing (TasksService)
- [x] 5.1 Add an `executionMode` column to `Task` (Prisma) + migration; default `interactive-pty`.
- [x] 5.2 `TasksService.create` (+ the `createTaskRow`/`admitCreatedTask` split): derive `executionMode` from consumer — programmatic (MCP `create_task` / `POST /v1/tasks`) → `headless-exec`, console → `interactive-pty`; persist on the row.
- [x] 5.3 Provisioning reads `executionMode`: `headless-exec` launches `buildHeadlessLine` (no `terminalStartup` DSR/CR handshake); `interactive-pty` unchanged.
- [x] 5.4 Fail closed: a programmatic task whose runtime lacks `headless-exec` is rejected with a distinct reason (no interactive fallback).

## 6. Headless exit detection → terminal
- [x] 6.1 For `headless-exec`, resolve completion on natural process exit (session-gone path), mapping exit code: 0 → `succeeded`, non-zero → `failed`; no resident idle, no `resolveExitStatus` PTY heuristic, no write-lease.
- [x] 6.2 Confirm boot re-adoption + liveness poller treat a detached headless process the same as a detached tmux session (survive-api-redeploy guarantees preserved).

## 7. Tests
- [x] 7.1 Golden test pinning codex headless argv (asserts `< /dev/null`, `--skip-git-repo-check`, `--sandbox danger-full-access`; resume argv asserts NO `-s`).
- [x] 7.2 Claude JSONL parser unit test over a real fixture: extracts user/assistant turns, skips `queue-operation`/`attachment`/`last-prompt`.
- [x] 7.3 Regression: a finished `claude-code` task's transcript read returns turns (NOT `no-rollout`).
- [x] 7.4 Routing test: MCP/`/v1`-created task → `executionMode=headless-exec` + reaches terminal on exit-0; console-created task → `interactive-pty` unchanged.
- [x] 7.5 Characterization: console interactive-pty path (codex + claude) byte-identical to today (no regression in the existing live-terminal behavior).

## 8. Docs / wrap
- [x] 8.1 Note in deploy/runtime docs: programmatic tasks are fire-and-forget headless; no continue/approval for them (multi-turn resume capability exists in the port but is unwired this change).
- [x] 8.2 Delta-spec sync to `openspec/specs/` is performed at archive time (not in this change's working edits).
