# Proposal: fix-clone-retry-and-tui-classifier

## Why

Two production defects diagnosed live on vibe-zlyan (v0.43.1, 2026-07-21; full
evidence chain in `research-brief.md`):

1. **Half of claude-code tasks die at clone.** The box→forge long-flow transfer
   (818 MB pack from `code.iflytek.com`) is intermittently unstable at the network
   level (3/6 platform tasks failed; reproduced 1/2 through the raw serve exec path;
   every infrastructure theory — disk, OOM, timeouts, proxy, release regression — was
   eliminated with hard evidence). The platform turns this routine flake into a fatal
   task failure because the repository-transfer stage is single-shot, and the git
   error is redacted to `cause=unknown`, costing hours of diagnosis.
2. **The v0.43.1 claude auth classifier never fires in production.** Claude's TUI
   paints via cursor positioning (no newlines on the wire); `normalizeRuntimeOutput`
   strips those sequences to nothing, fusing screen rows so every line-anchored
   claude pattern is unreachable. Proven by feeding the real `session.log` of task
   `a8b7648a` to the deployed classifier (returns null on the exact 401 screen it was
   built for). The v0.43.1 golden fixture used rendered capture-pane text, not wire
   bytes.

## What Changes

- **Repository-transfer retry**: the workspace transfer stage retries automatically
  on failure (bounded attempts, within the existing materialization deadline), with
  per-attempt diagnostics so retries are observable, never silent.
- **TUI-faithful output normalization**: `normalizeRuntimeOutput` converts absolute
  cursor positioning and vertical cursor moves into line breaks and horizontal moves
  into spaces BEFORE stripping remaining ANSI, so line-anchored classifier patterns
  work on interactive TUI byte streams. Golden fixture switches to the real captured
  session bytes.
- **Typed git failure causes**: the transfer failure normalizer maps stable git
  stderr signatures (connection reset / early EOF / RPC failed → network; no space
  left → capacity; authentication → auth) into the existing typed cause vocabulary
  instead of the `unknown` fallback — mapping only, no raw text persisted.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sandbox-provider-port`: the "Workspace materialization reports bounded stages and
  typed failures" requirement gains transfer-retry semantics and pins the git stderr
  signature → typed cause mapping with scenarios.
- `agent-runtime`: the "Claude auth-failure classification covers current CLI
  phrasings" requirement is strengthened — classification SHALL work on the raw
  interactive TUI byte stream (cursor-positioned, newline-free), pinned by a
  real-bytes fixture scenario.

## Impact

- **Code**: `packages/sandbox/src/workspace/git.ts` (transfer retry + stderr cause
  mapping), `apps/api/src/agent-runtime/runtime-output-failure-classifier.ts`
  (normalization), test fixtures (real session bytes), related unit tests.
- **Behavior**: no schema/API changes. Tasks on flaky links now survive transient
  clone failures; auth-broken claude tasks fail fast instead of idling; provisioning
  failures carry actionable causes.
