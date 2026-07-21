# Design: fix-clone-retry-and-tui-classifier

## Context

See `research-brief.md` for the full evidence chain. Two independent fixes, one
release train. Constraints: the transfer command is already idempotent (starts with
`rm -rf <workspace>`); the materialization deadline (`gitCloneTimeoutMs`, 900 s on the
affected deployment) is the outer budget; diagnostics are secret-free by spec (no raw
stderr may be persisted); codex classifier behavior must remain byte-identical.

## Goals / Non-Goals

**Goals**
- A transient clone failure no longer kills the task when a retry within the deadline
  would succeed (today's incident rate: 3/6 tasks).
- Every line-anchored claude classifier pattern works on the real interactive TUI
  byte stream; the shipped-but-inert v0.43.1 patterns become effective.
- Transfer failures carry typed causes (network / capacity / auth) instead of
  `unknown` whenever git's stderr matches a stable signature.

**Non-Goals**
- No shallow/partial clone semantics change (follow-up option).
- No detached-transfer (dual-gate) path changes — the affected deployment runs the
  inline legacy path; the detached path already has its own liveness model.
- No new failure-code enum values; mapping targets the existing cause vocabulary.

## Decisions

### D1 — Retry inside the transfer stage, not around the whole materialization

`runMaterializationStage` for `workspace_transfer` wraps the exec in an attempt loop:
up to 3 attempts total, 5 s backoff between attempts, each attempt gated on
`deadline.remainingTimeoutMs()` (no attempt starts with < 60 s of budget). The stage
command's leading `rm -rf` makes each attempt a clean slate — no partial-state
handling needed. Retrying the whole materialization instead would repeat
credential-setup/ls-remote (already-succeeded stages) and violate the one-start/
one-terminal diagnostic invariant for those stages.

- Per-attempt observability: attempts 2..n emit the SAME stage with a distinguishable
  diagnostic (`retryable: true` on the non-final failed attempts) so the event stream
  shows `started → failed(retryable) → started → succeeded` rather than a silent
  in-place retry. The one-start/one-terminal invariant is scoped per attempt.
- Retry only on failure classes where repetition can help: the typed network causes
  and the `unknown` fallback. Auth, missing-ref, and capacity failures do NOT retry
  (deterministic outcomes; retrying wastes the deadline).

### D2 — Normalize cursor motion into whitespace, then strip ANSI

In `normalizeRuntimeOutput`, BEFORE the generic CSI strip:

1. CUP/HVP (`ESC[r;cH`, `ESC[r;cf`) and vertical moves/line addressing
   (`ESC[nA`, `ESC[nB`, `ESC[nE`, `ESC[nF`, `ESC[nd`) → `\n`
2. Horizontal moves (`ESC[nC`, `ESC[nG`) → single space

Rationale: a TUI "line" is delimited by cursor jumps, not newlines; converting jumps
to `\n` reconstructs the visual line structure the patterns were written against.
Codex output (plain print-style) contains none of these in its failure envelopes, so
existing codex tests pin unchanged behavior; extra newlines from stray sequences are
harmless to substring/envelope patterns. The golden claude fixture switches to the
REAL 6 797-byte session.log captured from task `a8b7648a` — the exact bytes the
deployed v0.43.1 classifier returned `null` for.

### D3 — Map git stderr signatures to typed causes at classification time only

The transfer failure normalizer (which today collapses everything unmatched into
`unknown`) gains substring → cause rules evaluated against the exec's captured
output: `no space left on device` → capacity; `could not resolve host`, `connection
reset`, `connection refused`, `connection timed out`, `rpc failed`, `unexpected
disconnect`, `early eof`, `transfer closed` → TLS/network; `authentication failed`,
`http 401`/`403` → authentication. The raw text is inspected in memory and discarded;
only the enum cause crosses into diagnostics (existing secret discipline unchanged).
This is an implementation completion of what the spec already mandates ("SHALL
normalize at least … TLS/network …"), pinned with new scenarios.

## Risks / Trade-offs

- [Retries extend time-to-failure for genuinely dead links] → attempts bounded (3)
  and budget-gated (≥60 s remaining), worst case adds ~10 s of backoff inside the
  unchanged 900 s deadline.
- [Cursor-motion conversion changes normalization for all consumers] → the only
  consumers are the two classifiers; codex suite pins byte-identical classification;
  claude patterns get strictly more matchable structure.
- [stderr signatures drift across git versions] → signatures chosen from git's
  long-stable curl/transport error strings; unmatched text still falls back to
  `unknown` (never a wrong cause).
- [Retry masks a systemic outage] → per-attempt `failed(retryable)` diagnostics keep
  each attempt visible in the event stream and metrics.

## Migration Plan

Application-only; ships as v0.43.2 via the normal release train; no schema changes;
rollback = revert release.

## Open Questions

None blocking.
