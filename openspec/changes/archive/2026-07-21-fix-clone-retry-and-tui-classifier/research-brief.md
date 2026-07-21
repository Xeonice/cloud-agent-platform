# Research Brief — fix-clone-retry-and-tui-classifier

Live evidence gathered 2026-07-21 on vibe-zlyan (v0.43.1, BoxLite provider), driving
tasks via the platform API and reproducing through three distinct execution paths.

## Incident A — intermittent workspace clone failures (3 of 6 platform tasks)

Tasks `c04b2fbf`, `fe8d0832`, `a8b071c1` all failed at
`workspace_transfer / repository_transfer` with `cause=unknown` (~65 s in); tasks
`2bdfafb3` (morning), `a8b7648a`, and my API-driven `927c670d` cloned the SAME repo
successfully (4m37s–5m). Nine controlled clones of the repo
(`code.iflytek.com/.../zhiwen.git`, 818 MB pack / 822 MB `.git`, verified per-path):

| Path | Outcome |
|---|---|
| Platform (serve exec + WS attach + poll) | 3/6 failed |
| serve exec API direct (no attach) | 1/2 failed (exit −1, no workspace, after 5 min) |
| boxlite CLI → local runtime | 4/4 succeeded |

Systematically ELIMINATED before the verdict (each with hard evidence):
- **ENOSPC**: platform boxes are 5 GiB (`virtual_size_mb=5120` in serve log; capacity
  probe active); repro clone leaves 2.2 G free.
- **v0.43.1 regression**: tag diff v0.43.0→v0.43.1 touches only the claude
  onboarding/token change; clone path byte-identical; morning success ran the same code.
- **git low-speed abort** (`GIT_HTTP_LOW_SPEED_LIMIT=1024`/`TIME=60`, added by
  detach-workspace-clone): faithful repro WITH those env vars succeeded in 4m55s at a
  steady 2–3.5 MiB/s.
- **Guest OOM**: boxes actually run ~3.9 GiB RAM / 4 CPUs (serve's `memory_mib: 512`
  create-response/inspect metadata is cosmetic and does not reflect the VM).
- **api-container proxy interception**: `HTTP_PROXY` is set in the api container but
  Node 20 fetch/ws ignore proxy env (no ProxyAgent wiring in code) — control-plane
  traffic is direct.

**Verdict**: the box→`code.iflytek.com` long-flow transfer (VM NAT → macOS host → CN
internet) is intermittently unstable; failures land at varying offsets (65 s, ~5 min).
The platform amplifies a routine network flake into a task-fatal event because the
transfer stage is single-shot (no retry) and the git stderr is redacted into
`cause=unknown`.

## Incident B — the new TUI classifier never fires on real PTY bytes

Task `a8b7648a` displayed `● Please run /login · API Error: 401 OAuth access token is
invalid.` and idled ~4.5 min until manually cancelled — the
fix-claude-onboarding-and-token-verify classifier (shipped hours earlier in v0.43.1)
did not classify it. Root cause proven by feeding the task's REAL `session.log` bytes
to the deployed classifier (`classifyClaudeOutputFailure` → `null`):

```
[11;1H[38;5;220m●[CPlease run /login · API Error: 401 OAuth access token is invalid.[13;1H...
```

Claude's TUI paints via absolute cursor positioning (CUP `ESC[row;colH`) and cursor
moves (`ESC[C` instead of a space) — the byte stream contains NO newlines around the
message. `normalizeRuntimeOutput` strips ALL CSI sequences to the empty string, so
distinct screen rows fuse into one long pseudo-line and `hasStandaloneTerminalLine`'s
start-of-line anchors can never match. The v0.43.1 golden fixture used capture-pane
RENDERED text (with newlines) — unfaithful to the wire format. The pre-existing
codex patterns are unaffected (codex prints plain lines), but every line-anchored
claude pattern (old and new) is dead on the interactive TUI path.

The real session.log is saved as a fixture-quality artifact
(6 797 bytes, task `a8b7648a-8f75-40a5-9a97-35cbebf1cc31`).

## Constraints for design

- Clone runs inline (legacy admission; detached dual-gate path not active on this
  deployment — no detached-job events in any failed task). The stage command list is
  `materializationCommands` in `packages/sandbox/src/workspace/git.ts`; per-stage
  execution goes through `runMaterializationStage` with a shared `OperationDeadline`
  (`gitCloneTimeoutMs`, 900 s here).
- A transfer retry must re-run `rm -rf workspace && mkdir && clone` (the command is
  already idempotent — it starts with `rm -rf`), stay within the SAME deadline, and
  emit distinguishable diagnostics per attempt (no silent retries).
- Normalization fix: convert CUP/HVP (`ESC[r;cH`, `ESC[r;cf`) and vertical moves
  (`ESC[nA/B/E/F/d`) to `\n`, and horizontal moves (`ESC[nC`, `ESC[nG`) to a space,
  BEFORE the generic CSI strip. Codex plain-line output is unaffected (extra newlines
  are harmless); all existing classifier tests must stay green.
- Cause surfacing: the workspace runner sees git stderr; classify stable substrings
  (`No space left on device`→disk, `Could not resolve host|Connection
  (reset|refused|timed out)|RPC failed|unexpected disconnect|early EOF`→network,
  `Authentication failed|401`→auth) into the existing diagnostic `cause` vocabulary
  without carrying raw output (secret discipline: stderr may embed URLs with
  credentials — only map to enum causes, never persist text).
