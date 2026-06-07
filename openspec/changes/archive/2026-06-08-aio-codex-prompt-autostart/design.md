## Context

Under the connect-in AIO model, `GuardrailsService.startRunning` → `AioSandboxProvider.provision({taskId})` → `TerminalGateway.openSession` → `new AioPtyClient(…, autoLaunchCodex=true)`. When the sandbox terminal reports `ready`, `AioPtyClient.launchCodex()` types `DEFAULT_CODEX_LAUNCH_ARGV` (`codex -C /home/gem/workspace --ask-for-approval never --sandbox danger-full-access --dangerously-bypass-hook-trust`) into the `/v1/shell/ws` shell via `sendInput(\`${argv}\n\`)`. `ProvisionContext` carries ONLY `taskId`; the prompt never reaches this path, so codex opens blank.

Live verification on the pinned image (`cap-aio-sandbox:pinned`, codex `0.131.0`):
- `codex [OPTIONS] [PROMPT]` — the top-level interactive TUI accepts a positional prompt ("Optional user prompt to start the session").
- Launching with the prompt + an existing `/home/gem/workspace` DOES enter the TUI and render the prompt text; without `auth.json` it stops at a Sign-in screen.
- codex emits the crossterm startup DSR `\x1b[6n` (already intercepted by `AioPtyClient.onOutput` to inject the synthetic CPR `\x1b[1;1R`), then renders via synchronized-output / cursor-addressed repaints.

Web + adversarial research (sourced, two independent verifiers):
- CONFIRMED: a positional prompt PRE-FILLS the composer but does NOT auto-submit; `--ask-for-approval`/`--sandbox` control execution permission, not submission. So a cap-side Enter is required for zero-touch.
- `codex exec` auto-runs but is non-interactive and can hang on inherited non-TTY stdin (codex#20919) — rejected.

## Goals / Non-Goals

**Goals:**
- The operator's stored `task.prompt` reaches codex and pre-fills the composer with zero re-typing.
- Zero-touch: the goal auto-runs without an operator keystroke, while codex stays a fully interactive TUI afterward.
- Shell-injection-safe for arbitrary prompt text; no false-positive on the existing hook-disabling launch guard.

**Non-Goals:**
- The frontend command box / 1:1 typing surface (sibling change `console-terminal-1to1`).
- Changing the approval/threat model (codex in-sandbox execution remains un-gated per the accepted threat model; trust boundary is the container).
- `codex exec` / non-interactive mode.

## Decisions

- **D1 — Positional `[PROMPT]` in the interactive TUI, not `codex exec`.** Keeps the operator able to watch/intervene; avoids the exec inherited-stdin hang (codex#20919). Alternative (exec) rejected for losing interactivity.
- **D2 — Inject the prompt as a base64-decoded FILE + `"$(cat file)"`, not inline-escaped argv.** The prompt is arbitrary operator free-text. Inlining would need bullet-proof shell escaping AND would false-positive the `-s`/`--yolo`/`bypass-approvals` guard regex when a prompt merely mentions those tokens. The base64-file idiom is already proven in `injectCodexAuth` (config.toml/auth.json) and makes single-quoting provably safe; `"$(cat file)"` passes the file content as exactly one argument with no re-expansion. Alternative (inline escaping) rejected as fragile + guard-colliding.
- **D3 — Source the prompt via `ProvisionLookup`, not a provider DB call.** `PrismaProvisionLookup` already loads the task row (it computes the clone spec); returning `task.prompt` alongside keeps the provider a pure port consumer and adds no query. Alternative (extend `ProvisionContext` with the prompt fetched by the caller, or a provider-side DB read) is acceptable but spreads DB knowledge; prefer the existing lookup seam.
- **D4 — Auto-submit = a single `\r`, gated on (DSR observed) AND (output quiesced).** The DSR (`\x1b[6n`) is emitted only by codex's crossterm, never by the shell, so gating on it guarantees the `\r` cannot land in the bash shell (the dangerous silent-no-run failure). Waiting for output quiescence (no `output` frame for a tuned window) after the DSR is a robust proxy for "initial render done, composer pre-filled, idle waiting for input." Fire exactly once. Alternatives: blind fixed delay (rejected — races the shell→TUI transition); output-pattern matching the composer (rejected — brittle against styling/wrapping).
- **D5 — Safe degradation.** If the auto-Enter fires early/late, the worst case is a still-pre-filled composer that the operator submits manually (which the sibling `console-terminal-1to1` change makes reliable). The auto-Enter is best-effort and never throws into the launch path.
- **D6 — Empty prompt → no positional arg.** Write the file unconditionally (empty → empty file) and, on empty, either omit the `"$(cat …)"` suffix or let it expand empty so codex opens a blank composer. Never fail the launch on an empty prompt.

## Risks / Trade-offs

- **Positional prompt pre-fills but does not auto-submit** → relies on the cap-side auto-Enter. Mitigation: D4's DSR-gated quiescence trigger + D5 safe degradation; live-tune the window with auth.
- **Auto-Enter timing fragility** → if it fires before the composer is ready, codex newline handling (#8673/#20580) could mangle/split. Mitigation: gate on DSR + quiescence (composer is idle by then); fire one bare `\r`; degrade safely.
- **Multi-line prompt submission semantics** → a pre-filled multi-line prompt may submit as one message or be split by codex's Enter/newline handling. Mitigation: live verify with auth; if split, fall back to a single-line normalization or a paste-bracketed inject (documented follow-up).
- **Prompt-file injection failure** → must fail the provision CLOSED (mirror `injectCodexAuth`'s non-zero-exit assertion) rather than silently launching goal-less. Mitigation: assert the `/v1/shell/exec` exit code.
- **Large prompt** → base64+file avoids argv length pressure; confirm `/v1/shell/exec` accepts the larger command body (chunking unlikely needed for typical prompts).

## Migration Plan

- Additive; no flag needed. Deploy via dokploy (backend auto-deploy). The behavior change is "codex starts with the goal pre-filled and auto-run" — verify live with real `auth.json` on a fresh task, tuning the quiescence window.
- **Rollback:** revert the `launchCodex` positional suffix and skip the prompt-file write → codex reverts to the prior blank-composer launch (no schema/data migration involved).

## Open Questions

- Exact output-quiescence window (ms) for the auto-Enter — tune live with auth.
- Does codex `0.131` submit a multi-line pre-filled prompt as ONE message on a single `\r`, or split on embedded newlines (#8673/#20580)?
- Does the gem-server `/v1/shell/ws` input path coalesce frames? (Irrelevant for a single `\r`, but confirm for completeness.)
