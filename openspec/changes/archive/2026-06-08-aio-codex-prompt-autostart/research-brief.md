# Research brief — aio-codex-prompt-autostart

Side-car provenance for the proposal/design. Combines live verification on the pinned image with adversarially-verified web research.

## Live verification (bwg-jp VPS, `cap-aio-sandbox:pinned`, codex 0.131.0)

- `codex --help`: `Usage: codex [OPTIONS] [PROMPT]`; `[PROMPT] = Optional user prompt to start the session`. `codex exec [PROMPT]` is the non-interactive sibling. `--no-alt-screen` exists.
- Launching `codex -C /home/gem/workspace --ask-for-approval never --sandbox danger-full-access --dangerously-bypass-hook-trust "<prompt>"` with the workspace dir present enters the interactive TUI and renders the prompt text; without `auth.json` it stops at a Sign-in screen.
- `codex -C <dir>` requires `<dir>` to EXIST (errors `os error 2` otherwise) — in production the repo clone creates `/home/gem/workspace` before launch, so the ordering is correct, but it is a real dependency.
- codex 0.131 TUI render: synchronized-output `ESC[?2026h/l`, cursor-hide `ESC[?25l`, focus-reporting `ESC[?1004h`, full-grid cursor-addressed repaints; NO alternate-screen (`ESC[?1049h`). The crossterm startup DSR is `\x1b[6n` (already intercepted by `AioPtyClient.onOutput` → synthetic CPR `\x1b[1;1R`).
- `/v1/shell/ws` is served by a python `gem-server` (libtmux); output frames carry RAW text (not base64). Idle first-screen is a plain bash prompt with bash-readline bracketed-paste toggles (`ESC[?2004h/l`); no visible tmux status bar.

## Web research (adversarially verified, sourced)

- **CONFIRMED (high):** a positional prompt to interactive `codex` PRE-FILLS the composer but does NOT auto-submit — the operator must press Enter. Sources: developers.openai.com/codex/cli/reference + features; community guides. The `--ask-for-approval`/`--sandbox` flags control execution permission, NOT submission.
- **CONFIRMED:** no documented stdin/env/config path feeds an initial prompt to the interactive TUI — positional arg is the only launch mechanism (`codex inject` for running sessions is an unimplemented feature request, #11415).
- **Rejected — `codex exec`:** non-interactive (exits; no operator intervention) and can hang forever on inherited non-TTY stdin (codex#20919).
- **Idiom reuse:** `AioSandboxProvider.injectCodexAuth` already writes `config.toml`/`auth.json` via `printf %s '<base64>' | base64 -d > file`; the base64 alphabet has no shell metacharacters, so single-quoting is provably safe — the basis for D2 (prompt file) over inline escaping.

## Why the cap-side auto-Enter is robust (D4)

The DSR `\x1b[6n` is emitted only by codex's crossterm, never by the shell — gating the auto-`\r` on "DSR observed AND output quiesced" guarantees it cannot land in the bash shell (the dangerous silent-no-run failure) and that the composer is rendered + idle. Worst-case misfire degrades to a manually-submittable composer (made reliable by the sibling `console-terminal-1to1` change), so the risk is bounded.

## Still open (needs live auth)

Multi-line pre-filled prompt submitting as one message (codex newline regressions #8673/#20580); byte-exact base64 round-trip for CJK/emoji; the exact output-quiescence window.
