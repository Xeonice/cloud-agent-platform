# Verification Report — fix-live-terminal-scrollback-strip

Adjudication of the verify pass. Raw-unmet input was empty (`[]`); the
three-way routing below reflects an independent end-to-end re-trace of every
spec requirement against the actual code, not a rubber-stamp of the skeptic.

## Requirements re-traced as MET

Spec: `specs/realtime-terminal/spec.md` — MODIFIED requirement
"The live terminal preserves a scrollable history".

- **Parent requirement — live terminal preserves a scrollable history.** MET.
  Live `onRaw` strips the alt-screen switch (so output lands in the normal
  buffer and accrues scrollback) and the shipped viewport sync makes it
  scrollable. See the scenario traces below.

- **Scenario: codex launches in inline (non-alt-screen) mode.** MET.
  `apps/api/src/agent-runtime/codex-runtime.ts:61` — the codex launch line is
  `codex --no-alt-screen -C /home/gem/workspace …`, so codex itself does not
  switch to the alternate screen.
  - Met-as-written, minor gap (does not block primary scenario): the skeptic's
    gap note also cited `aio-pty-client.ts:127` as carrying `--no-alt-screen`;
    that is inaccurate (no such occurrence exists), but the requirement is
    satisfied by the single authoritative source in `codex-runtime.ts`.

- **Scenario: The front-end strips the alt-screen switch from the live stream.**
  MET. `apps/web/src/components/session/cast-log.ts:67` `stripAltScreenBytes`
  is byte-level and UTF-8-safe (1:1 `String.fromCharCode`, deliberately not
  `TextDecoder("latin1")`/windows-1252), reusing `stripAltScreen`'s regex
  `ALT_SCREEN_RE = /\x1b\[\?(?:1049|1047|47)[hl]/g` (cast-log.ts:26) which
  covers `?1049h/l`, `?1047h/l`, `?47h/l` exactly as the scenario requires. It
  is called in `session-terminal.tsx:377` —
  `handle.write(stripAltScreenBytes(bytes), …)` — i.e. before writing to xterm.

- **Scenario: The live viewport reflects accumulated scrollback.** MET.
  `apps/web/src/components/session/session-terminal.tsx` defines
  `syncViewportSoon` (debounced, ref-held at line 246/261) and the `onRaw`
  flush callback invokes `syncViewportSoonRef.current()` (line 381) so the
  `.xterm-viewport` is re-synced as live output arrives.

- **Scenario: Operator scrolls up through earlier output while running.** MET
  (composite of the strip + viewport-sync traces above). The two mechanisms
  together let the running live terminal accumulate scrollback in the normal
  buffer and expose it as scrollable.

## Gap finding (recorded)

All four scenarios have traceable, end-to-end implementation. The only
non-code item is task 2.2 — a POST-DEPLOY live verify in Chrome (live buffer
`normal`, baseY accumulates, scroll-to-top without manual interaction, no
mojibake on Chinese). That is an acceptance gate to run after deploy, not a
requirement lacking implementation, so it does not open a code task.

## Scope finding (recorded — authorized cleanup, NOT scope-creep)

The change removes the inert tmux `alternate-screen off` appendage from
`codex-launch.ts` (`wrapInDetachedSession` + `wrapHeadlessDetachedSession`)
and the matching test assertions (codex-launch golden + headless-execution
`$`-anchor). Confirmed removed: zero `alternate-screen` matches remain in
`apps/api/src/terminal/codex-launch.ts`,
`apps/api/src/terminal/codex-launch.test.mjs`, or
`apps/api/src/agent-runtime/headless-execution.spec.ts`.

This removal has no backing SHALL statement in `specs/realtime-terminal/spec.md`
(the spec only mandates the front-end strip), but it is NOT unauthorized
scope-creep: `proposal.md` §"What Changes" and `design.md` D5 explicitly scope
it as removing the ineffective option from the superseded v0.20.5 approach A "to
avoid future confusion". Reverting inert code from a failed prior approach is
within the declared change scope and is consistent with the MODIFIED-requirement
narrative. No code task and no spec-defect is opened for it.

## Three-way tally

- reopenedTasks: (none)
- specDefects: (none)
- reclassifiedMet: parent requirement + all four scenarios re-trace as MET.
