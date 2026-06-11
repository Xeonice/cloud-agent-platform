# Proposal: console-design-pixel-merge

## Why

The Open Design prototype (`openspec/changes/console-design-pixel-merge/design-baseline/`) has iterated past the shipped
console: the dashboard moved to an attention-first inbox with status-differentiated row
actions, the capacity aside became a `capacity-modern` pool panel with per-runner resource
rows, the landing gained a live `runner-capsule` demo plus `process-rail`/`boundary-ledger`
sections, and tokens/shadows/guardrail presets drifted. The shipped app was rebuilt 1:1
against the previous design revision (archive `2026-06-06-rebuild-console-tanstack-start`),
so every page now carries a known, bounded delta — and the per-runner data the new panel
needs is already collected by the backend, just not exposed in one payload.

## What Changes

Four operator decisions are pre-made and RESOLVED (do not relitigate):

1. **MetricStrip removal is intentional.** The dashboard 4-up MetricStrip is deleted; the
   inbox + pool panel carry its information. (Rejected: keeping both — duplicates the
   pool-hero numbers and fights the design's attention-first hierarchy.)
2. **Queued tasks stay navigable.** Queued/pending rows keep a real link into the task
   detail (PreRunningPlaceholder precedent); the design's disabled "等待 runner" button is
   rendered as a non-primary, still-clickable affordance, never `disabled`/`aria-disabled`.
   This explicitly overturns the current `connectable:false` mapping in `task-status.ts`.
   (Rejected: literal disabled buttons — Cursor Cloud and Codex cloud both keep queued work
   enterable.)
3. **Pool backend API is in scope — as a small increment.** The single existing `/metrics`
   payload is extended; no new endpoint family, no new capability flag. (Rejected: a new
   "runner-pool" endpoint/capability — `/metrics` already returns capacity, occupancy,
   queue, and container resources.)
4. **Full-page merge.** All pages are brought to the new design revision and pixel-checked,
   not just the dashboard. (Rejected: dashboard-only scope — token and shadow changes
   propagate globally anyway.)

These build on, and must not relitigate, the four archived slot decisions
(shrink = no-kick, one global pool, DB overrides env, restart re-offer): the pool panel
renders a ceiling-many slot grid (1–20, runtime-mutable), never a hardcoded 10.

Concrete changes:

- **Dashboard inbox (gap 1).** In-place evolution of `QueuePanel`/`QueueRow`: delete
  MetricStrip; status-differentiated actions encoded in the single exhaustive
  `task-status.ts` mapping (awaiting input → primary 处理输入, running → 接管会话,
  done/failed → ghost 查看记录/查看错误, queued → navigable 等待 runner); alert-gradient
  needs-input rows; tab counts (全部/待处理/运行/排队) via the existing SegmentedControl
  ReactNode label + CountChip — no component API change; `mobile-inbox` rules on the
  established ≤820px CSS breakpoint convention.
- **capacity-modern pool panel (gap 2, frontend).** Replace `capacity-aside.tsx` with
  pool-hero (e.g. "7/10 在线" — sample data, computed client-side from live ceiling +
  occupancy), numbered slot grid 01–NN sized to `occupancy.slots.length`, pool-lane
  (空闲→已分配→可接管), per-runner resource rows (client join of `occupancy.slots[].taskId`
  × resources × tasksQuery for repo/title/status), and pool-policy. Consumed through the
  existing `metricsQuery` (5s `refetchInterval`, select projection); SSE is a non-goal.
- **`/metrics` process-scope extension (gap 2, backend).** Fold the sampler's in-memory
  per-task `processSamples` into the single `/metrics` payload (thin projection change),
  so the panel renders per-runner CPU/MEM from one poll instead of fanning out N
  `GET /tasks/:taskId/metrics` calls. Server-computed percentages, latest-frame-only
  (no history), reusing the established scope discriminator and the honest
  "not-running/not-sampled, never fabricate zeros" degradation language. Every new field
  lands in lockstep in mock.ts and real.ts under one zod type; mock ceiling stays aligned
  with the backend default (5).
- **Landing demo + sections (gap 3).** Port the 737-line vanilla `runner-capsule.js` Web
  Component to a native React component with the same loop state machine, replacing the
  static HeroPreview; replace the 3-step WorkflowRow and 3-card FeatureGrid with
  process-rail and boundary-ledger. SSR-safe animation: default reduced-motion on
  server/first paint, upgrade via `matchMedia` after mount (mirrors the landing's existing
  mounted-flag pattern; the app currently has zero `prefers-reduced-motion` handling).
  Carry forward intact: session-aware CTA, `#security` anchor (boundary-ledger takes it
  over), CJK line-break handling.
- **Session page markup reorg (gap 4).** Toolbar, context strip, terminal-head, and empty
  states already exist; the gap reduces to session-toolbar placement and 3+1 context
  grouping — no new behavior. Preserve the `ssr:false` + pendingComponent +
  raw-bytes-bypass-Query invariants; any change touching input/connection semantics is
  gated on live verification. The hardcoded `pty: /dev/pts/4` has no backing backend field
  and is removed under the honesty rule (no fabricated values).
- **Token merge (gap 5).** One file: `app.css` `@theme` gains `--console`/`--muted-2`,
  `--shadow-card` is retuned to the design values, and the console background is promoted
  from the one-off `bg-[#f8f9fb]` in `_app.tsx` to a body-level `@layer base` rule —
  propagating automatically to @cap/ui.
- **Remaining pages (gap 6).** Guardrail preset ladders updated in the one shared catalog
  (idle 关闭/15/30 分钟; deadline 无/1h/4h — contract-safe, values are free milliseconds);
  login/history/repositories/settings scoped as audit-and-adjust pixel passes only.
- **Verification.** Playwright `toHaveScreenshot()` page-vs-design-HTML comparison
  (per page, per breakpoint, against the local design files as living baselines) is
  promoted from the rebuild's optional gate to a required verify step.

No breaking changes: API shapes only gain fields, the queued-row link direction loosens
(never tightens) navigation, and env/contract surfaces are untouched.

## Capabilities

### New Capabilities

None — all changes land as requirement deltas to existing capabilities. The new design
vocabulary (capacity-modern, pool-hero, mobile-inbox, boundary-ledger, runner-capsule) has
no archive precedent and enters the specs as added/modified requirements, not new specs.

### Modified Capabilities

- `frontend-console`: MODIFY the dashboard requirements — rewrite "Dashboard lists tasks
  as a fleet" removing the 4-MetricTile ops-status-bar clause; ADD inbox rows with
  exhaustive status-differentiated actions and navigable queued rows; MODIFY the capacity
  panel into capacity-modern while preserving the dynamic ceiling-many slot-grid and
  mock/real ceiling-parity requirements from configurable-task-slots; ADD landing
  runner-capsule/process-rail/boundary-ledger with SSR-safe reduced-motion; MODIFY session
  page layout (toolbar/context regrouping, pty line removed); MODIFY tokens (console
  background at body level, shadow-card values) and guardrail preset ladders; record the
  ≤820px mobile breakpoint convention; ADD required per-page Playwright screenshot
  comparison against the design baselines.
- `resource-metrics`: MODIFY the `/metrics` aggregate — include per-task process-scope
  samples (latest frame only, server-computed percentages) alongside the existing
  container aggregates, with the existing freshness/degradation semantics; no new
  capability flag.

Explicitly NOT modified: `guardrails` and `account-settings` (the four slot decisions are
consumed as-is), `realtime-terminal` (no input/connection semantics change).

## Impact

- **Backend (apps/api):** `src/metrics/metrics-projection.ts` (+`metrics.service.ts`) —
  fold `resource-sampler.service.ts` `processSamples` into the `/metrics` response; no new
  controller routes.
- **Contracts (packages/contracts):** `src/metrics.ts` — extend the metrics response type
  with the per-task process-scope block (zod, mirrored in mock/real).
- **Web (apps/web):**
  - tokens: `src/styles/app.css`, `routes/_app.tsx` (drop `bg-[#f8f9fb]`);
  - dashboard: `routes/_app/dashboard.tsx` (MetricStrip removal),
    `components/dashboard/queue-panel.tsx`, `task-status.ts` (connectable→action mapping),
    `capacity-aside.tsx` (replaced by the capacity-modern panel);
  - landing: `routes/index.tsx`, `components/landing/hero-preview.tsx` (replaced by the
    React runner-capsule), new process-rail/boundary-ledger sections;
  - session: `components/session/session-header.tsx`, `session-terminal.tsx` (markup only);
  - presets: `components/dashboard/new-task-dialog.tsx` / `routes/_app/tasks/new.tsx`
    shared option catalog;
  - data layer: `lib/api/queries.ts` (select projections), `mock.ts`/`real.ts` lockstep.
- **Design source:** `openspec/changes/console-design-pixel-merge/design-baseline/` HTML/CSS/JS files serve as pixel
  baselines for the required Playwright comparisons.
- **Tests/verify:** Playwright `toHaveScreenshot()` harness per page/breakpoint; colocated
  `.mjs` tests for the projection change; live-verify gate on any session-page change that
  could touch terminal semantics.
- **Dependencies/systems:** none new — existing polling data layer, no SSE, no new
  endpoints, no capability flags.
