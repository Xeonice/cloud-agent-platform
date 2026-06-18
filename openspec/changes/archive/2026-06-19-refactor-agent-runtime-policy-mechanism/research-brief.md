# Research Brief — refactor-agent-runtime-policy-mechanism

Architectural audit of the `AgentRuntime` abstraction as shipped in v0.6.0
(`add-claude-code-runtime`). Grounded in the merged code on `main` (f6bf815).

## The abstraction leaks: codex logic lives in 4 places + 2 interfaces + 1 adapter

The intended home for codex logic is `CodexRuntime`. It is NOT the only home:

1. **`CodexRuntime`** (intended) — but `autoSubmit(pty,ctx)=>cleanup` (the rich
   port impl with the real DSR/CPR machinery, `codex-runtime.ts`) is **dead code**:
   no consumer calls the port's `autoSubmit`. `detectExit` (has-session) duplicates
   the pty client's inline `hasSession`.
2. **`aio-pty-client.ts`** (shared transport) — the codex DSR/CPR handshake is
   INLINE: `DSR_CURSOR_POSITION_QUERY` (`\x1b[6n`), `SYNTHETIC_CPR_REPLY`
   (`\x1b[1;1R`), `dsrSeen`, `launchedCodex`, the output-quiescence timer + Enter.
   All codex-specific, in the shared pty client.
3. **`aio-sandbox.provider.ts`** (shared lifecycle) — codex injection/trim INLINE:
   `injectCodexAuth`, `injectTaskPrompt`, `CODEX_HOME_DIR`, `trimCodexHomeBeforeStop`.
   Codex writes go inline; claude writes delegate to the runtime — **asymmetric**.
4. **`agent-runtime.integration.ts`** (the adapter) — branches on identity:
   - `autoSubmit(): boolean { return this.runtime.id === 'codex' }` — an **identity
     check disguised as a port call** (and the gate the pty client reads);
   - `injectAuth`: `if (this.runtime.id !== 'codex' && ctx.prompt)`;
   - `trimBeforeStop`: `if (this.runtime.id === 'codex')`.

Plus **two `AgentRuntime` interfaces**: the rich PORT (`agent-runtime.port.ts`:
`autoSubmit(pty,ctx)=>cleanup`, `detectExit(exec,ctx)=>ExitSignal`) and the narrow
CONSUMER (`agent-runtime.integration.ts`: `autoSubmit():boolean`,
`detectExit(exec,taskId)=>RuntimeExitDecision`), bridged by `RuntimeAdapter` — a
whole translation layer whose main job is the `id === 'codex'` branching above.

## Root cause: the seam assumed the runtime owns MECHANISM

The port handed the runtime mechanism it cannot own: `autoSubmit(pty,ctx)=>cleanup`
is an observer over the PTY event loop, but the pty client OWNS that loop → the
adapter degraded it to a boolean → the inline machinery stayed → dead code +
identity branch. `detectExit`/injection have the same shape: the provider owns the
exec surface + lifecycle, so codex's injection stayed inline. The runtime ended up
owning neither cleanly.

The fix is the **policy/mechanism split**: the runtime is a (mostly) declarative
POLICY object; the shared scaffolding is the MECHANISM (PTY loop, exec, lifecycle,
liveness poller) that reads the policy. `id === 'codex'` exists ONLY inside the two
policy objects — never in the mechanism.

## De-risking: characterization tests, NOT the (unrunnable) compose e2e

The clean refactor must touch codex's terminal handshake + injection, whose
byte-identity the project guards with a compose e2e that does NOT run on
GitHub-hosted Actions (needs a self-hosted amd64 host). That is the WRONG safety
net for a refactor. codex's byte-identity lives in four DETERMINISTIC, locally
testable outputs:

| Output | Pure? | Locally golden-testable? |
|--------|-------|--------------------------|
| `buildDetachedCodexLaunchLine` launch-line string | yes | yes (`codex-launch.test.mjs` already pins 16 cases) |
| DSR→CPR sequence (`\x1b[1;1R` + single Enter on quiesce) | yes (given the DSR input) | yes (feed a synthetic DSR, assert injected bytes) |
| `injectCodexAuth` / config.toml / prompt exec command strings | yes (given material) | yes |
| `trimCodexHome` trim command strings | yes | yes |

**Pin these four as golden/characterization tests on the CURRENT code first**;
refactor behavior-preservingly (the mechanism code is unchanged — only its GATE
flips from `id === 'codex'` to the runtime's declared policy, which evaluates to the
same path for codex); assert the golden outputs are byte-identical. The compose e2e
is then the final integration confirmation, **not the refactor's gate** — which
unblocks the refactor from the x86 dependency.

## Target shape (the north star)

```
runtime = POLICY (mostly data + pure command-emitters + one detectExit)
  launchSpec(ctx): { argv, env }              // runtime contributes argv+env only
  terminalStartup: { replyToStartupDSR, promptSubmit: 'none'|'cr-on-quiesce', quiesceMs? }
  sandboxSetupCommands(ctx, material): string[]   // codex: auth.json+config.toml; claude: launch-env.sh+.claude.json
  preStopTrimCommands(ctx): string[]
  detectExit(exec, ctx): Promise<ExitSignal>
  transcript: { kind, pathFor(ctx) }

mechanism = SHARED scaffolding (runtime-agnostic)
  pty client: ONE DSR/CPR/quiesce loop, reads terminalStartup; tmux + $(cat prompt) wrap
  provider:   runs sandboxSetupCommands / preStopTrimCommands via the shared exec
  liveness:   calls runtime.detectExit only
  → no `id === 'codex'`; one interface; RuntimeAdapter DELETED
```

## Sequence (each step keeps codex byte-identical, golden-gated, independently mergeable)

0. Pin the four golden/characterization snapshots on the current code.
1. Declarative `terminalStartup`; pty gate `id`-check → declared policy; delete dead `CodexRuntime.autoSubmit`.
2. Symmetric injection: move `injectCodexAuth`/prompt/trim into the runtime as command-emitters; provider calls uniformly, drops `id === 'codex'`.
3. Unify `detectExit` (single source); lift tmux + `$(cat)` into shared mechanism; runtime gives `{argv,env}`.
4. Collapse the two interfaces into one; delete `RuntimeAdapter`; consumers use the port directly.
5. Resolve `captureTranscript` (both runtimes own their source) or remove it from the port.
