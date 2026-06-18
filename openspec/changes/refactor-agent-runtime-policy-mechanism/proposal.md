## Why

The `AgentRuntime` abstraction shipped in v0.6.0 (`add-claude-code-runtime`) was
integrated under time pressure with an adapter-bridge rather than a clean refactor,
so codex logic LEAKS across the shared scaffolding instead of living only in
`CodexRuntime`. An audit (see `research-brief.md`) found it in **four** places plus
**two** parallel `AgentRuntime` interfaces and a `RuntimeAdapter` translation layer:
the port's `autoSubmit(pty,ctx)=>cleanup` is dead code; the real codex DSR/CPR
handshake is inline in the shared pty client; codex auth/prompt/trim injection is
inline in the shared provider (while claude's delegates to the runtime —
asymmetric); and the adapter branches on `runtime.id === 'codex'` in three methods —
an identity check disguised as a port call. The abstraction "leaks" because the seam
was drawn assuming the runtime owns MECHANISM (the PTY event loop, the exec surface)
that the shared scaffolding actually owns. This makes a third runtime painful and
makes "codex vs claude" reasoning live in the wrong layer.

## What Changes

- **Redraw the seam as POLICY vs MECHANISM.** The runtime becomes a (mostly)
  declarative POLICY object — it contributes data and pure command-emitters, owns NO
  I/O. The shared scaffolding (pty client, provider, liveness poller) is the
  MECHANISM that reads the policy. `runtime.id === 'codex'` (or any agent-identity
  branch) is FORBIDDEN in the mechanism; it exists only inside the two policy objects.
- **Declarative terminal-startup.** Replace `autoSubmit(pty,ctx)=>cleanup` with a
  declared `terminalStartup` policy (`replyToStartupDSR` / `promptSubmit` /
  `quiesceMs`). The pty client keeps its SINGLE DSR/CPR/quiesce mechanism, driven by
  the declaration. Delete the dead `CodexRuntime.autoSubmit`.
- **Symmetric injection.** Move codex's `injectCodexAuth` / `injectTaskPrompt` /
  `~/.codex` trim into `CodexRuntime` as command-emitters; the provider runs
  `sandboxSetupCommands` / `preStopTrimCommands` via the shared exec for BOTH
  runtimes. Drop the provider's codex-inline code and `id === 'codex'` branch.
- **Unify exit detection + lift the launch wrapper.** `runtime.detectExit` is the
  single completion source (the liveness poller calls only it). The detached-tmux
  wrapper + `$(cat <prompt-file>)` delivery become shared MECHANISM; the runtime
  contributes only `{ argv, env }`.
- **Collapse to one interface; delete `RuntimeAdapter`.** With the identity branches
  gone, the narrow consumer interface + the translation layer have no reason to
  exist — consumers use the port directly.
- **Resolve `captureTranscript`.** Either both runtimes own their transcript source
  (codex rollout JSONL, claude session JSONL) or it leaves the port (today it returns
  `[]` for codex — a half-method).
- **Behavior-preserving by construction + golden-tested.** codex's four
  deterministic observable outputs (launch-line string, DSR→CPR injection sequence,
  injection exec commands, trim commands) are pinned as characterization/golden
  tests on the current code FIRST, then asserted byte-identical after each refactor
  step. The compose e2e is the final integration confirmation, NOT the refactor's
  gate — so this is not blocked on the (self-hosted-only) amd64 e2e.

This is a **pure refactor**: no runtime behavior changes for codex or claude — only
where the code lives and how the seam is shaped.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `agent-runtime`: the `AgentRuntime` port is reshaped from a mechanism-owning
  interface (with a dead `autoSubmit` + a parallel consumer interface + adapter) into
  a single POLICY interface — declarative `terminalStartup`, pure
  `sandboxSetupCommands`/`preStopTrimCommands` command-emitters, `{argv,env}`
  launch-spec, one `detectExit` source, resolved transcript — with the architectural
  invariant that no agent-identity branch exists in shared scaffolding.
- `aio-sandbox-execution`: the provider + pty client become pure MECHANISM that
  reads runtime policy. Codex's inline auth/prompt/trim injection and the pty
  client's `id === 'codex'`-gated DSR/CPR handshake are driven by declared policy
  instead, with codex's observable outputs byte-identical (golden-tested).

## Impact

- **Backend**: `apps/api/src/agent-runtime/*` (port reshape, both runtime impls,
  delete `agent-runtime.integration.ts`'s adapter/consumer-interface or reduce it to
  DI wiring); `apps/api/src/sandbox/aio-sandbox.provider.ts` (drop codex-inline
  injection/trim + `id` branch); `apps/api/src/terminal/aio-pty-client.ts` (DSR/CPR
  gate reads `terminalStartup`; drop `launchedCodex`/`id` coupling; lift the
  tmux/`$(cat)` wrapper to shared mechanism).
- **Tests**: new characterization/golden tests pinning codex's four outputs; extend
  `agent-runtime.test.mjs` / `codex-launch.test.mjs`.
- **No** contract, DB, frontend, or image changes. No behavior change — pure refactor.
- **Gating**: the compose e2e (`.github/workflows/e2e.yml`) remains the final
  confirmation on a self-hosted amd64 runner; it is not a precondition for landing
  the golden-test-gated steps.
