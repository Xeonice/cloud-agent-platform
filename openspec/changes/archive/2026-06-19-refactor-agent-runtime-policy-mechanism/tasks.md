<!-- This is a behavior-preserving refactor: the steps are STRICTLY SEQUENTIAL and
     golden-test-gated. Each track depends on the previous so apply runs them in order;
     codex must stay byte-identical (golden) and claude working (unit) at every step. -->

## 1. Track: golden-characterization (depends: none)

- [x] 1.1 Pin the codex detached launch-line string as a golden test (extend `apps/api/src/terminal/codex-launch.test.mjs`): assert `buildDetachedCodexLaunchLine` output for the canonical argv/workspace/session-id, byte-for-byte.
- [x] 1.2 Capture the codex DSR→CPR reference sequence from the PRODUCTION path (`aio-pty-client.ts` `onOutput`/`maybeArmPromptAutoSubmit`): synthetic startup DSR (`\x1b[6n`) → synthetic CPR (`\x1b[1;1R`) → after a `CODEX_AUTOSUBMIT_QUIESCE_MS` (default 800) quiesce, exactly one Enter (`\r`); claude injects neither. NOTE the production mechanism is byte-identical to the to-be-DELETED `CodexRuntime.autoSubmit` (proven) and is coupled inside `AioPtyClient`, so the executable golden lands when step 2 extracts the mechanism to read `terminalStartup` (this task captures the reference values to assert against; do NOT pin the dead code).
- [x] 1.3 Pin the codex sandbox-setup exec command strings (`injectCodexAuth` config.toml/auth.json + prompt-file write) for a fixed auth material, byte-for-byte.
- [x] 1.4 Pin the codex pre-stop trim command strings (`trimCodexHomeBeforeStop`: removes cache/auth, keeps `sessions/`), byte-for-byte. Review all four snapshots against a real codex launch capture before relying on them.

## 2. Track: declarative-terminal-startup (depends: golden-characterization)

- [x] 2.1 Add `terminalStartup: { replyToStartupDSR; promptSubmit: 'none'|'cr-on-quiesce'; quiesceMs? }` to the `AgentRuntime` port and declare it on both runtimes (codex: `{true,'cr-on-quiesce'}`; claude: `{false,'none'}`).
- [x] 2.2 In `aio-pty-client.ts`, flip the DSR/CPR/quiesce gate from `runtime.autoSubmit()`/`launchedCodex`/`id==='codex'` to read `runtime.terminalStartup`; keep the mechanism code path unchanged.
- [x] 2.3 DELETE the dead `CodexRuntime.autoSubmit(pty,ctx)=>cleanup` AND its `agent-runtime.test.mjs` test (it is unreachable — never called; the adapter shortcut it with `id === 'codex'`), and delete the adapter's `autoSubmit():boolean { return id==='codex' }`. The pty-client DSR/CPR mechanism CODE is unchanged — only its gate flips from `launchedCodex`/`id` to `runtime.terminalStartup`. Land the executable 1.2 golden against the (now declared-policy-driven) production mechanism and assert it matches the reference sequence captured in 1.2; claude injects neither.

## 3. Track: symmetric-injection (depends: declarative-terminal-startup)

<!-- HARDENED by the step3-derisk-trace-audit workflow (3 adversarial lenses). Byte-identity
     is ACHIEVABLE but only if these traps are handled EXACTLY. The emitter is a PER-COMMAND
     fail-closed plan, NOT a bare string[]; 3a-3c are ADDITIVE (nothing calls them → zero
     behavior change, golden-verified); 3.3/3.4 are the ONLY behavior-affecting steps (provider
     wiring), gated by a wiring + fail-closed-matrix characterization test (3.5). -->

- [x] 3.0 (avoid the layering cycle WITHOUT a file move) Keep the port's thin-union philosophy: EXTEND `AuthMaterial` with `codexCompatible?: { baseUrl; apiKey; model }` so `CodexRuntime` reads only the port's `AuthMaterial` (never `CodexAuthMaterial`) → no `agent-runtime → sandbox` dependency, `codex-auth-source.port.ts` stays in `sandbox/` with its impls + sole consumer (the provider). The provider maps its resolved `CodexAuthMaterial` (official→`{authJson}`, compatible+SSRF-safe→`{codexCompatible}`, unsafe→`{}`) into `AuthMaterial`. (Superseded the move-the-file approach — verified unnecessary.)
- [x] 3.1 Add to the port: `type SandboxSetupCommand = { command: string; tolerateUnresolvedExit: boolean }` (NaN exit → `!tolerate` fails closed; a real non-zero ALWAYS fails closed), `type SandboxSetupPlan = { ok:false; reason } | { ok:true; commands: SandboxSetupCommand[] }`, `SandboxSetupContext = { taskId; workspaceDir; prompt: string|null }`, and `sandboxSetupCommands(ctx, material): SandboxSetupPlan` + `preStopTrimCommands(ctx): SandboxSetupCommand[]`. Implement on `CodexRuntime` (move `injectCodexAuth`+`injectTaskPrompt`+`compatibleProviderToml`/`esc` logic in as a PURE emitter) and `ClaudeCodeRuntime` (launch-env.sh + `.claude.json` + prompt). DELETE the dead `CodexRuntime.injectAuth`. NOTHING calls the new methods yet (additive).
  - TRAP-1 (config+auth = ONE element): codex element[0] is the FULL `mkdir -p && rm -f hooks.json && <config.toml write> && chmod 600 config.toml` + (official only) ` && <auth.json write> && chmod 600 auth.json` — single string, NOT two elements.
  - TRAP-2 (conditional prompt): when `ctx.prompt` is null/empty the emitter returns the array WITHOUT a prompt element (codex `injectTaskPrompt` early-returns today); non-empty → append the prompt element.
  - TRAP-3 (per-command fail-closed): codex commands `tolerateUnresolvedExit:false`; claude auth-write `true` (today `code!==null&&code!==0`); claude prompt-write `false` (today `NaN||!==0`); claude no-token → `{ok:false, reason:'runtime not configured'}` BEFORE any command.
  - TRAP-4 (SSRF is async I/O): `assertSafeProviderUrl` does NOT move into the pure emitter — it stays in the provider's material-resolution (3.3); the emitter receives ALREADY-validated material (unsafe compatible URL → provider passes degraded/null material → emitter writes config-only).
  - TRAP-5 (idempotency/escaping verbatim): keep `mkdir -p`, `rm -f hooks.json` (codex-config only), `chmod 600`, single-quoted base64, and `compatibleProviderToml` key order + `esc` (backslash/double-quote) byte-for-byte.
- [x] 3.2 GOLDEN the emitters (additive, on the new pure functions): `CodexRuntime.sandboxSetupCommands` for the matrix {official, compatible, null} × {prompt, no-prompt} — assert the exact ordered `command` strings + `tolerateUnresolvedExit` flags byte-for-byte; `ClaudeCodeRuntime.sandboxSetupCommands` for {token, no-token} × {prompt, no-prompt} incl the fail-closed `{ok:false}`. Add `preStopTrimCommands` golden: codex trim string EXACT (`rm -rf cache/logs_*.sqlite* 2>/dev/null; : > auth.json 2>/dev/null; true` — `: >` truncate NOT rm; keeps `sessions/`); claude trim keeps `projects/`.
- [x] 3.3 (BEHAVIOR-AFFECTING) Rewire `injectRuntimeSetup` to use the emitters: resolve the runtime (undefined → CONCRETE codex instance, never the dead adapter null path), resolve ONLY that runtime's material once (codex via `CODEX_AUTH_SOURCE` + `assertSafeProviderUrl`; claude via `CLAUDE_AUTH_SOURCE`) + the prompt once, call `sandboxSetupCommands`, then a uniform fail-closed loop: `for ({command, tolerateUnresolvedExit} of plan.commands) { exit = parseExecResult(exec(command)); failed = isNaN(exit) ? !tolerateUnresolvedExit : exit!==0; if (failed) throw <scrubbed> }`. Delete inline `injectCodexAuth`/`injectTaskPrompt`/`compatibleProviderToml` + the adapter's `injectAuth`/`resolveAuthMaterial`/`injectClaudePrompt`. No `id === 'codex'` (dispatch material resolution via a credential-source registry keyed by runtime id, NOT a hardcoded branch). `clone`/`preinstallSkills` stay SEPARATE post-setup steps.
- [x] 3.4 (BEHAVIOR-AFFECTING) Rewire `trimRuntimeHomeBeforeStop` to run `runtime.preStopTrimCommands` via a SEPARATE fail-OPEN dispatcher (try/catch warn-only + 10s `AbortSignal.timeout`, exactly as today) — NEVER the fail-closed setup loop. Delete inline `trimCodexHomeBeforeStop` + the `id === 'codex'` trim branch.
- [x] 3.5 (THE WIRING SAFETY NET) Add a provider characterization test: a FAKE `SandboxExec` that RECORDS every `(command, order)` + a stubbed runtime/auth-source, asserting (a) the FULL ordered exec transcript for codex {official+prompt, compatible+no-prompt, null} matches the v0.6.0 inline sequence byte-for-byte, and (b) a FAIL-CLOSED MATRIX: inject exit_code {0, 1, NaN, absent} per command and assert exactly which throw (codex strict; claude auth tolerant of NaN; claude prompt strict) + that the trim path NEVER throws. Re-run golden 1.3/1.4 + the full api suite.

## 4. Track: unify-exit-and-launch (depends: symmetric-injection)

- [x] 4.1 Make the launch wrapper shared mechanism: the runtime contributes only `{ argv, env }` (move the detached-tmux + `$(cat <prompt-file>)` build into the pty-client/launch helper, built identically for all runtimes).
- [x] 4.2 Make `runtime.detectExit` the single completion source; remove the pty client's inline `hasSession` duplicate (codex's `detectExit` uses a shared has-session helper). The liveness poller calls only `runtime.detectExit`.
- [x] 4.3 Re-run golden 1.1 (launch line byte-identical for codex) + the codex/claude exit unit tests.

## 5. Track: collapse-interfaces (depends: unify-exit-and-launch)

- [x] 5.1 Collapse the two `AgentRuntime` interfaces into one (the port); delete the `RuntimeAdapter` translation layer; reduce `agent-runtime.integration.ts` to DI/registry wiring (or fold it in). Consumers (provider, pty client, liveness, tasks dispatch) depend on the single port directly.
- [x] 5.2 Grep the shared-scaffolding sources for `id === 'codex'` / `id !== 'codex'` and assert ZERO matches. Full `turbo typecheck`/`lint`/unit + all golden tests green.

## 6. Track: resolve-transcript (depends: collapse-interfaces)

- [x] 6.1 Resolve `captureTranscript`: either both runtimes own their transcript source (codex rollout JSONL, claude session JSONL) and the port keeps it, or remove it from the port if the rollout/JSONL capture lives in the retention path. Whichever — no half-method returning `[]`. Do not regress session replay.

## 7. Track: final-verification (depends: resolve-transcript)

- [x] 7.1 (VERIFIED on douglas-wsl x86 WSL2, 2026-06-18/19) Run the compose e2e (`.github/workflows/e2e.yml`) on a self-hosted amd64 runner (or real x86 host) as the FINAL integration confirmation that codex + claude both still launch/run/exit/replay end-to-end. Not a precondition for landing steps 1–6.
