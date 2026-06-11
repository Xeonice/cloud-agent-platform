<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.
     CORRECTED partition (apply phase, verified against real file coupling):
       - Tracks 1–7 write disjoint file sets (verified by import/usage scan); no shared-file tasks exist.
         Cross-track surfaces are import-only: `shortTaskId`/`isOpenTask` exports survive Track 4's
         in-place queue-panel/task-status evolution; `app.css` is written ONLY by Track 3 (token-source
         convention — component styling stays in component files); `new-task-dialog.tsx` (Track 7) is
         disjoint from Track 4's dashboard files (`dashboard.tsx` only imports it, props unchanged).
       - Track 8 is the INTEGRATION track: it screenshots the merged result of every page track and is
         the change's required verify gate, so it runs SERIALLY after all parallel tracks integrate
         (no Playwright harness exists yet — all of its files are new). -->

## 1. Track: metrics-contract-projection (depends: none)

- [x] 1.1 Extend `packages/contracts/src/metrics.ts` zod contract with the per-task process-scope section keyed by `taskId`: latest frame only (no history), the existing `scope` discriminator (`process`, falling back to `container`), server-computed `cpuPercent`/`memoryPercent`, sample timestamp/age and stale flag — strictly additive (no existing field changes, no new endpoint family, no new capability flag)
- [x] 1.2 Fold the sampler's in-memory `processSamples` latest frames into the `/metrics` response in `apps/api/src/metrics/metrics-projection.ts` (+ `metrics.service.ts` wiring): sourced from the SAME sampler snapshot (no extra sampling pass per request), carry-forward stale semantics on transient tick misses, container-scope fallback when the in-sandbox reading is unavailable, non-running/left-set tasks omitted or explicitly not-sampled — never fabricated zeros
- [x] 1.3 Extend the colocated `.mjs` tests (`metrics-projection.test.mjs` and peers): per-task entries present for running tasks, latest-frame-only shape, container fallback, carry-forward on transient miss, non-running omission, and an additive-contract assertion (every prior field unchanged in name/type)

## 2. Track: web-data-layer (depends: metrics-contract-projection)

- [x] 2.1 Mirror the new per-task process-scope fields in `apps/web/src/lib/api/real.ts` under the one shared zod contract type from `@cap/contracts`
- [x] 2.2 Mirror the same fields in `apps/web/src/lib/api/mock.ts` in lockstep: mock default ceiling stays 5 (matching the backend default), fixtures include honest not-sampled/stale states (never zero-filled); update `mock.test.ts` lockstep assertions
- [x] 2.3 Add the pool-panel `select` projection to the existing `metricsQuery` in `apps/web/src/lib/api/queries.ts` (ceiling, occupancy slots, queue, per-task samples) — keep the 5s `refetchInterval`, no per-task `GET /tasks/:taskId/metrics` fan-out, no SSE

## 3. Track: design-tokens (depends: none)

- [x] 3.1 In `apps/web/src/styles/app.css` `@theme`/`:root`: add `--console` and `--muted-2` as first-class tokens and retune `--shadow-card` to `0 0 0 1px rgba(0,0,0,0.08), 0 2px 2px rgba(0,0,0,0.04), 0 8px 8px -8px rgba(0,0,0,0.04)`
- [x] 3.2 Apply the console background at body level via an `@layer base` rule referencing `var(--console)` in `app.css`, and remove the one-off `bg-[#f8f9fb]` arbitrary class from `apps/web/src/routes/_app.tsx` (verify `@cap/ui` components pick the tokens up with no per-package divergence)

## 4. Track: dashboard-inbox-pool (depends: web-data-layer)

- [x] 4.1 Evolve `apps/web/src/components/dashboard/task-status.ts` from the `connectable` flag to an exhaustive status→action descriptor covering every `TaskStatus` union member (compiler-checked): awaiting input → primary 处理输入, running → 接管会话, done → ghost 查看记录, failed → ghost 查看错误, queued/pending → non-primary but NAVIGABLE 等待 runner (real link, never `disabled`/`aria-disabled`); update `task-status.test.ts`
- [x] 4.2 Evolve `apps/web/src/components/dashboard/queue-panel.tsx` (`QueuePanel`/`QueueRow`) in place into the attention-first inbox: row actions derived solely from the task-status mapping, awaiting-input rows sorted to top with the alert-gradient needs-input treatment, queued rows linking to `/tasks/$taskId` (pre-running placeholder)
- [x] 4.3 Add the inbox toolbar: client-side search plus status SegmentedControl tabs 全部/待处理/运行/排队 with live `CountChip` counts embedded via the existing ReactNode label (no SegmentedControl API change); filtering stays client-side (`useMemo`-derived, not written to the query cache)
- [x] 4.4 Delete the 4-tile MetricStrip from `apps/web/src/routes/_app/dashboard.tsx` (drop the `metric-tile.tsx` usage on the dashboard) — intentional removal, the inbox tab counts and pool panel carry its information
- [x] 4.5 Replace `apps/web/src/components/dashboard/capacity-aside.tsx` outright with the `capacity-modern` pool panel: pool-hero N/M 在线 computed client-side from live ceiling + occupancy (never the 7/10 sample), zero-padded numbered slot grid sized to `occupancy.slots.length` for any ceiling 1–20 (never hardcoded ten), pool-lane (空闲→已分配→可接管), per-runner resource rows via the client-side join of `occupancy.slots[].taskId` × per-task metrics samples × tasksQuery (repo/title/status) with honest 未运行/未采样 degradation per missing leg, and a pool-policy block — all from the one metricsQuery poll
- [x] 4.6 Implement the `mobile-inbox` responsive rules on the established ≤820px convention (`max-[820px]`/`min-[821px]` utilities only, no new JS breakpoint)

## 5. Track: landing-runner-capsule (depends: none)

- [x] 5.1 Port the design's 737-line vanilla `runner-capsule.js` Web Component to a native React component preserving the same ordered loop state machine, replacing the static `apps/web/src/components/landing/hero-preview.tsx`
- [x] 5.2 Make the runner-capsule SSR-safe: server render and first client paint use the reduced-motion (static) branch with no `window`/`matchMedia` access during render; upgrade to the animation loop only after mount via `matchMedia('(prefers-reduced-motion: no-preference)')` (mounted-flag pattern); `reduce` visitors keep the static branch
- [x] 5.3 Replace the 3-step WorkflowRow (`workflow-step.tsx`) with the `process-rail` section at `#workflow` and the 3-card FeatureGrid (`feature-card.tsx`) with the `boundary-ledger` section at `#security`, keeping the existing `#security` anchor (including the footer link) resolving to the boundary-ledger
- [x] 5.4 Integrate in `apps/web/src/routes/index.tsx` carrying forward intact: session-aware CTA swap (unauthenticated first paint, reconcile after hydration), smooth anchor scrolling with fixed-nav scroll-margin, CJK line-break handling, no nondeterministic values rendered (hydration-warning-free)

## 6. Track: session-markup (depends: none)

- [x] 6.1 Reorganize the session page to the design revision's session-toolbar placement and 3+1 context-strip grouping (three task-context items together, guardrail readout separated) in `apps/web/src/components/session/session-header.tsx`/`session-context-strip.tsx` — markup/layout only, toolbar action/input/connection behavior unchanged
- [x] 6.2 Remove the hardcoded `pty: /dev/pts/4` line (and any pty path) from the terminal-head in `apps/web/src/components/session/session-terminal.tsx`, keeping the `{agent} · {repo}#{branch}` label — no backend field backs it, fabricated values are prohibited
- [x] 6.3 Verify the route invariants survive: `/tasks/$taskId` remains the only `ssr: false` route, the server still emits the `pendingComponent` terminal skeleton, raw terminal bytes still bypass the TanStack Query cache; if any diff touches the WebSocket input/connection path, gate completion on live-backend verification (typing, Enter submit, reconnect)

## 7. Track: presets-and-remaining-pages (depends: none)

- [x] 7.1 Update the single shared guardrail option catalog in `apps/web/src/components/dashboard/new-task-dialog.tsx` to the design ladders: idle 关闭/15 分钟/30 分钟 (`idleTimeoutMs` 900000/1800000), deadline 无/1 小时/4 小时 (`deadlineMs` 3600000/14400000); 关闭/无 submit no field; confirm `apps/web/src/routes/_app/tasks/new.tsx` consumes the same module (no drift); update `new-task-dialog.test.ts`
- [x] 7.2 Audit-and-adjust pixel passes against the design revision for `apps/web/src/routes/login.tsx`, `routes/_app/history.tsx`, `routes/_app/repositories.tsx`, and `routes/_app/settings.tsx` (scoped adjustments only, no structural rebuild)

## 8. Track: integration-visual-verification (depends: ALL — integration track, runs serially after all parallel tracks merge)

- [x] 8.1 Build the Playwright `toHaveScreenshot()` harness: serve the local design HTML files from `openspec/changes/console-design-pixel-merge/design-baseline/` as living baselines rendered in the same browser/viewport as the app, with mock data mode, animations disabled, and the runner-capsule region masked or deterministically frozen; document the baseline source path and regeneration procedure in the suite
      <!-- apps/web/playwright.config.ts + e2e/serve-design-baseline.mjs + e2e/visual/{manifest.ts,baseline.capture.ts,pixel.spec.ts}.
           Mock data mode = new VITE_FORCE_MOCK=1 seam in lib/api/capabilities.ts isCapable() (mock-session isAuthCapable() now routes
           through it); runner-capsule frozen via reducedMotion:"reduce" on BOTH sides AND masked; baseline source path + regeneration
           (always re-captured per run; VV_MEASURE=1 re-calibration) documented in e2e/visual/manifest.ts header. -->
- [x] 8.2 Add per-page, per-breakpoint comparisons (desktop + ≤820px mobile) for `/`, `/login`, `/dashboard`, `/tasks/new`, `/tasks/$taskId`, `/repositories`, `/history`, `/settings` with explicit recorded `maxDiffPixels`/`maxDiffPixelRatio` thresholds per page — a page exceeding its threshold FAILS the suite (blocking gate, not a warning)
      <!-- 8 pages × {1440×900, 820×1180} = 16 comparisons; per-page/per-breakpoint maxDiffPixelRatio recorded in
           e2e/visual/manifest.ts with the calibration table (measured 0.012–0.057 + headroom). Blocking proven: VV_MEASURE=1
           (thresholds pinned 0) → 16/16 fail, exit 1. Integration fixes the gate surfaced: (a) max-[820px] compiled to Tailwind v4
           STRICT width<820px leaving exactly 820px in a desktop/mobile dead zone — replaced with max-[821px] (≡ inclusive ≤820px,
           the design's max-width:820px) across apps/web/src + spec delta parenthetical updated; (b) dashboard ≤820px now hides the
           topbar per design `.page-dashboard .topbar{display:none}` (Topbar className prop + _app.tsx). -->
- [x] 8.3 Prove determinism and wire the gate: two consecutive runs against the same build produce identical per-page pass/fail results, and the suite is recorded as the change's required verify step
      <!-- Two consecutive full runs: 32/32 passed each, per-test result lists byte-identical (diff clean). RECORDED VERIFY STEP:
           `cd apps/web && pnpm test:visual` — the change's required visual gate (proposal "Tests/verify"; promoted from the
           rebuild's optional gate). -->

## Track: verify-reopened (depends: none)

- [x] V1. Landing authenticated account affordance: when the operator is authenticated, `/` must render an account affordance — a UI element reflecting the operator's identity/account (e.g. the session's GitHub login rendered in the landing-nav alongside the 进入控制台 CTA) — in addition to the existing CTA swap. Today `apps/web/src/routes/index.tsx` + `landing-nav.tsx` render NO identity element in the authed state (no `session.*` field is consumed). Keep the SSR-safe swap invariant: unauthenticated state on server/first paint, reconcile after hydration; stay within the existing design language (the design baseline mocks only the anonymous state). Spec: frontend-console "Landing-family standalone pages" / Scenario "Landing is session-aware" — "...presents a primary '进入控制台' CTA to `/dashboard` (and an account affordance)". Pixel gate is unaffected (the harness captures the unauthenticated first paint).
