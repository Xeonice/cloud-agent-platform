# Design — console-design-pixel-merge

## Context

The shipped console was rebuilt 1:1 against the previous design revision
(archive `2026-06-06-rebuild-console-tanstack-start`), while the Open Design prototype
(`openspec/changes/console-design-pixel-merge/design-baseline/`) kept iterating: attention-first dashboard inbox,
`capacity-modern` pool panel with per-runner resource rows, landing `runner-capsule`
demo + `process-rail`/`boundary-ledger`, and token/shadow/preset drift. Every page
therefore carries a known, bounded delta. The per-runner data the pool panel needs
already exists in the backend sampler (`resource-sampler.service.ts` `processSamples`)
— it is collected but not exposed in the `/metrics` aggregate.

Constraints inherited and NOT relitigated here:

- The four proposal decisions (MetricStrip deleted; queued rows navigable; `/metrics`
  extension instead of a new endpoint; full-page merge scope).
- The four archived slot decisions (shrink = no-kick, one global pool, DB overrides
  env, restart re-offer) — the slot grid is ceiling-many (1–20, runtime-mutable),
  never hardcoded.
- Honesty rule for metrics: not-running/not-sampled is stated, zeros are never
  fabricated. The hardcoded `pty: /dev/pts/4` falls to this rule.

## Goals / Non-Goals

**Goals:**

- Bring every page to the new design revision with a required, per-page,
  per-breakpoint Playwright screenshot gate against the design HTML as living baselines.
- Expose per-task process samples through the existing `/metrics` payload so the pool
  panel renders per-runner CPU/MEM from one poll.
- Keep all changes additive on API/contract surfaces; loosen (never tighten) navigation.

**Non-Goals:**

- SSE or any push transport — the existing 5s `metricsQuery` polling stays.
- New endpoint families, capability flags, or guardrail/account-settings spec changes.
- Any input/connection semantics change on the terminal (`realtime-terminal` untouched);
  session work is markup reorganization only.
- Historical metrics — the per-task section is latest-frame-only.

## Decisions

### D1. `/metrics` grows a per-task process-scope section (thin projection)

The sampler already holds in-memory `processSamples` per task. The projection
(`metrics-projection.ts`) folds the latest frame per running task into the single
`/metrics` response, keyed by taskId, with server-computed percentages and the
established scope discriminator + degradation language.

- Why over a new `runner-pool` endpoint: `/metrics` already returns capacity,
  occupancy, queue, and container resources — the panel's join keys live there.
  A second endpoint would duplicate freshness semantics and add a capability flag.
- Why over client fan-out to `GET /tasks/:taskId/metrics`: N+1 requests per 5s poll
  scales with the ceiling (up to 20) for data the server already has in one map.
- Payload bound: latest-frame-only × ceiling ≤ 20 tasks keeps growth trivial; no
  history arrays.

### D2. Per-runner rows are a client-side join over existing queries

The capacity-modern panel joins `occupancy.slots[].taskId` × the new per-task metrics
block × `tasksQuery` (repo/title/status) in a `select` projection — no new query, no
server-side join.

- Why: both queries already poll; pushing repo/title into `/metrics` would couple the
  metrics contract to task presentation fields. Missing join legs degrade honestly
  (row renders with explicit not-sampled state, never zeros).
- Pool-hero numbers ("7/10 在线" in the design is sample data) are computed client-side
  from live ceiling + occupancy; the slot grid sizes to `occupancy.slots.length`.

### D3. `task-status.ts` mapping evolves from `connectable` to an action descriptor

The single exhaustive status mapping becomes the one source for row actions:
awaiting input → primary 处理输入, running → 接管会话, done/failed → ghost
查看记录/查看错误, queued → non-primary but **navigable** 等待 runner (never
`disabled`/`aria-disabled` — overturns the current `connectable:false`).

- Why one mapping: prevents per-component drift; the inbox, tab counts (existing
  SegmentedControl ReactNode label + CountChip, no component API change), and detail
  links all read the same table. Exhaustiveness is compiler-checked.

### D4. runner-capsule is ported to native React, not wrapped

The 737-line vanilla Web Component is re-implemented as a React component with the
same loop state machine, replacing the static HeroPreview.

- Why over `customElements` wrapping: the Web Component manipulates its own DOM,
  fighting hydration under TanStack Start SSR; a React port keeps one rendering model
  and makes the reduced-motion gate a plain prop/state.
- SSR safety: server/first paint renders the reduced-motion (static) state; the
  animation upgrades via `matchMedia('(prefers-reduced-motion)')` after mount,
  mirroring the landing's existing mounted-flag pattern. This introduces the app's
  first `prefers-reduced-motion` handling.

### D5. Tokens merge into one source; console background moves to body level

`app.css` `@theme` gains `--console`/`--muted-2`, `--shadow-card` is retuned, and the
one-off `bg-[#f8f9fb]` in `_app.tsx` becomes a body-level `@layer base` rule.

- Why body-level: @cap/ui components and standalone pages inherit automatically;
  arbitrary-value utilities cannot propagate to the shared package.

### D6. In-place evolution where structure survives, replacement where it doesn't

`QueuePanel`/`QueueRow` and the session markup evolve in place (smaller diff,
invariants preserved: `ssr:false`, pendingComponent, raw-bytes-bypass-Query);
`capacity-aside.tsx` and `hero-preview.tsx` are replaced outright because the new
designs share no structure with them. Any session change that could touch
input/connection paths is gated on live verification.

### D7. Pixel gate uses the design HTML as living baselines

Playwright `toHaveScreenshot()` compares each app page, per breakpoint (the recorded
≤820px convention + desktop), against screenshots of the local design files —
promoted from the rebuild's optional gate to a required verify step.

- Why design-HTML baselines over checked-in PNGs: the prototype is the source of
  truth and still local; rendering both sides in the same browser/viewport removes
  platform font/antialiasing variance from the comparison.
- Determinism: fixed viewport, animations disabled, mock data mode, explicit
  per-page thresholds.

## Risks / Trade-offs

- [Screenshot flakiness — CJK font fallback, animation timing] → same-browser
  baseline rendering, `reducedMotion`/animation-disable flags, mock data, explicit
  `maxDiffPixelRatio` per page; runner-capsule region masked or frozen at a known state.
- [Join-leg races — metrics and tasks polls land out of phase] → rows degrade
  honestly per leg (slot shown, resources "未采样", title placeholder); no zeros.
- [Session reorg silently breaking terminal semantics] → markup-only diff discipline
  plus the live-verify gate on anything near input/connection paths.
- [Mock/real drift on the new metrics fields] → one zod type in
  `packages/contracts/src/metrics.ts`; mock.ts and real.ts land in lockstep, mock
  ceiling stays aligned with the backend default (5).
- [Design prototype lives in /tmp] → baselines are regenerable from the design files
  referenced in the change; the verify step documents the source path. If the copy is
  lost, re-export precedes verification.

## Migration Plan

Additive and order-safe:

1. Contracts + backend projection (new `/metrics` fields) — old clients ignore them.
2. Web data layer (`queries.ts` select projections, mock/real lockstep).
3. Page merges (tokens first — global propagation — then dashboard, landing,
   session, remaining pages).
4. Screenshot harness + baselines as the closing verify gate.

Rollback: revert web commits independently; the `/metrics` extension can stay
deployed (purely additive, no flag).

## Open Questions

- Exact `maxDiffPixelRatio`/threshold per page — set empirically when the harness
  lands; the spec only requires that thresholds be explicit and blocking.
- Whether the runner-capsule loop is masked or deterministically frozen (seeded
  state) in screenshots — decide when the React port's state machine is in hand.
- Spec defect (verify pass, no code change): the carried-over scenario
  "Workspace counts reflect live queries" says "**each** screen-card footer shows
  an open-tasks count derived from the tasks query", which contradicts the same
  requirement's own prose — the 6 screen-cards come "with a footer 'open tasks'
  count **and latest run id**" (the 实时会话 footer carries the latest task id,
  not a count) — and contradicts design fidelity (the prototype's other footers
  are static descriptors: OAuth scoped / 30 天保留 / 单用户模式 / 安全优先).
  `workspace.tsx` implements the only self-consistent reading: 任务控制台 footer
  ← open-task count from the tasks query, 实时会话 footer ← most-relevant task's
  short id from the tasks query, remaining footers static per the design. Fix is
  a wording change in `specs/frontend-console/spec.md` ("each" → the data-bound
  cards), to be made when the spec next syncs; not an implementation task.
