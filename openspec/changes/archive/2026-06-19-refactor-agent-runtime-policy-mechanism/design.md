## Context

`add-claude-code-runtime` (v0.6.0) introduced an `AgentRuntime` port but integrated
it with an adapter-bridge rather than a clean refactor, to avoid touching codex's
byte-fragile terminal handshake under time pressure. The result (audited in
`research-brief.md`): codex logic lives in `CodexRuntime` (intended) AND inline in
the shared pty client (`aio-pty-client.ts`: the DSR/CPR/quiesce machinery) AND inline
in the shared provider (`aio-sandbox.provider.ts`: `injectCodexAuth`/prompt/trim) AND
in a `RuntimeAdapter` that branches on `runtime.id === 'codex'` — across two parallel
`AgentRuntime` interfaces. The port's `autoSubmit(pty,ctx)=>cleanup` is dead code.

This change is a **pure refactor** (no behavior change for codex or claude) that
redraws the seam so the runtime owns POLICY and the shared scaffolding owns MECHANISM.

## Goals / Non-Goals

**Goals:**
- One `AgentRuntime` interface; `RuntimeAdapter` deleted (or reduced to DI wiring).
- The runtime is a (mostly) declarative POLICY object owning NO I/O.
- ZERO `runtime.id === 'codex'` (or any agent-identity branch) in shared mechanism.
- Codex behavior byte-identical, proven by golden/characterization tests — NOT
  gated on the self-hosted-only compose e2e.
- A third runtime can be added by writing one policy object, touching no mechanism.

**Non-Goals:**
- No contract / DB / frontend / image changes.
- No new runtime, no new feature, no behavior change.
- Not fixing the unrelated compatible-provider-not-wired-to-execution gap.
- Not running the compose e2e here (it stays the final confirmation, deferred).

## Decisions

### D1 — Policy vs Mechanism is the organizing principle
The runtime is POLICY (data + pure functions); the shared scaffolding is MECHANISM
(the PTY event loop, the `/v1/shell/exec` surface, container lifecycle, the liveness
poller). Mechanism reads policy; mechanism never branches on agent identity. **Why:**
the v0.6.0 leak came from handing the runtime mechanism it cannot own (an observer
over a PTY loop the pty client owns), which forced the adapter + identity branches.
**Alternative rejected:** keep the adapter and just "clean up the branches" — the
branches are a SYMPTOM of the seam being in the wrong place; they reappear for a
third runtime.

### D2 — Declarative `terminalStartup`, single mechanism in the pty client
Replace `autoSubmit(pty,ctx)=>cleanup` with declared data:
```ts
terminalStartup: {
  replyToStartupDSR: boolean              // codex: true, claude: false
  promptSubmit: 'none' | 'cr-on-quiesce'  // codex: cr-on-quiesce, claude: none
  quiesceMs?: number
}
```
The pty client keeps its ONE DSR/CPR/quiesce loop and reads this declaration; the
gate flips from `runtime.autoSubmit() (= id==='codex')` to
`runtime.terminalStartup.replyToStartupDSR`. For codex the SAME code path runs.
`CodexRuntime.autoSubmit` (dead) is deleted. **Why:** the DSR/CPR mechanism belongs
to the transport that owns the byte stream; only its PARAMETERS are agent-specific.

### D3 — Runtime emits commands; provider runs them (symmetric, pure)
Replace the provider's inline `injectCodexAuth`/`injectTaskPrompt`/`trimCodexHome`
and the runtime's `injectAuth(exec,...)` with pure command-emitters:
```ts
sandboxSetupCommands(ctx, material): string[]   // shell commands to write creds/config
preStopTrimCommands(ctx): string[]
```
The provider runs them for BOTH runtimes via the shared exec — no codex-inline, no
`id === 'codex'`. **Why:** returning command STRINGS makes the runtime pure and
directly golden-testable (the commands ARE the byte-identity surface). The provider
owns the only exec. **Alternative considered:** keep `injectAuth(exec)` as a method —
rejected because a method that runs I/O is harder to characterization-test than a
pure string emitter, and it kept the codex/claude asymmetry alive.

### D4 — `detectExit` is the single completion source; launch wrapper is mechanism
The liveness poller calls `runtime.detectExit` only (codex: `tmux has-session`;
claude: tail JSONL for `end_turn` then `kill-session`); the inline `hasSession`
duplicate is removed (codex's detectExit uses a shared has-session helper the pty
exposes as mechanism). The detached-tmux wrapper + `$(cat <prompt-file>)` delivery
move into shared mechanism; the runtime contributes only `{ argv, env }`. **Why:**
the tmux session + prompt-file plumbing is identical for all runtimes — it is
mechanism, not policy.

### D5 — Characterization tests are the refactor's safety net (not the e2e)
codex's four DETERMINISTIC observable outputs are pinned as golden snapshots on the
CURRENT code in step 0, then asserted byte-identical after every step: (1) the
`buildDetachedCodexLaunchLine` string, (2) the DSR→CPR injection sequence
(`\x1b[1;1R` + one Enter on quiesce), (3) the `injectCodexAuth`/config/prompt exec
command strings, (4) the trim command strings. **Why:** byte-identity lives in these
unit-level outputs, which are locally testable; the compose e2e (self-hosted amd64
only) is integration confirmation, not a refactor gate. This unblocks the refactor
from the x86 dependency. **Practical interleaving:** only (1) the launch line is a pure
function goldenable standalone in step 0; (2) the DSR/CPR mechanism and (3)(4) the
provider commands are coupled inside `AioPtyClient`/the provider (not isolation-testable
today), so step 0 CAPTURES their reference values from the current code (the DSR/CPR
sequence proven byte-identical to the dead `CodexRuntime.autoSubmit`) and the EXECUTABLE
golden lands when the seam is extracted to a testable shape (step 2 for DSR/CPR, step 3
for the commands). The dead `CodexRuntime.autoSubmit` (+ its test) is DELETED, not
pinned — the production pty-client mechanism is the reference, and its CODE is unchanged
by the refactor (only its gate flips from an identity check to the declared `terminalStartup`).

### D6 — Sequence as small, independently-mergeable, behavior-preserving steps
0 golden → 1 declarative terminal-startup → 2 symmetric injection → 3 unify
detectExit + lift launch wrapper → 4 collapse interfaces + delete adapter → 5 resolve
transcript. Each step keeps codex byte-identical (golden-gated) and claude working
(unit tests), and can be reviewed/merged on its own. **Why:** a one-shot rewrite of
the production execution path is high-risk; small golden-gated steps make each diff
provably behavior-preserving.

## Risks / Trade-offs

- [A refactor step subtly changes a codex byte (escape sequence / command string)] →
  Golden/characterization tests in step 0 fail the step before merge; the mechanism
  code is moved, not rewritten, so codex runs the same path by construction.
- [Claude path regresses while reshaping the port] → Keep/extend the claude unit
  tests (injectAuth fail-closed, end_turn detection, `.claude.json` pre-seed) at each step.
- [The golden tests pin the WRONG outputs (miss a byte-identity surface)] → Derive the
  four surfaces from the actual consumers (pty client input writes, provider exec
  calls); review the snapshots against a live codex launch capture before relying on them.
- [`captureTranscript` resolution (D??) changes replay] → Treat step 5 as optional/last;
  if it risks the rollout replay, leave the port method and document, rather than force it.
- [Integration-level breakage golden tests cannot see] → The compose e2e on a
  self-hosted amd64 runner remains the final confirmation before the refactor is
  declared fully verified (tracked, not blocking the unit-gated steps).
- [Two active changes both touch `agent-runtime`] → `add-claude-code-runtime` should
  be archived first (it shipped in v0.6.0) so its delta merges into the live spec and
  this refactor modifies a single source of truth (see Open Questions).

## Migration Plan

1. (Pre) Archive the shipped `add-claude-code-runtime` so `agent-runtime` is a live
   capability this refactor modifies cleanly.
2. Land steps 0→5 as separate PRs, each golden-test-gated and green on
   `turbo typecheck`/`lint`/unit tests. codex byte-identity asserted at every step.
3. Rollback: each step is an independent revert; no data/contract migration, so any
   step can be reverted without coordination.
4. (Post) Run the compose e2e on a self-hosted amd64 runner as the final integration
   confirmation, then archive this change.

## Open Questions

- Archive `add-claude-code-runtime` first (recommended) vs author this refactor's
  agent-runtime delta against the unarchived change's delta — affects where the
  "current" agent-runtime spec lives.
- `captureTranscript`: keep in the port (both runtimes own a source) vs remove (the
  rollout/JSONL capture lives in the retention path) — decide in step 5 against the
  replay requirement.
- Does `sandboxSetupCommands` returning secret-bearing command strings (base64 token /
  auth.json) raise any handling concern vs the current `injectAuth(exec)` that runs
  them directly? (Both end up as ephemeral exec commands; confirm no new exposure.)
