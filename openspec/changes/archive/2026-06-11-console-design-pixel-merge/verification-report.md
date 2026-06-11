# Verification Report — console-design-pixel-merge

Adjudicated three-way routing. Two passes recorded; the second pass (after the
V1 fix landed) supersedes the tallies of the first.

## Pass 2 (current) — post-V1 re-verification

Raw skeptic output: 1 unmet (the SAME token-merge Scenario-4 grounds as pass 1,
re-raised); gap analysis: 0 requirements without a traceable implementation
(V1 verified implemented); scope analysis: 13 observations (6 new this pass).
After end-to-end re-trace against the working tree:

| Verdict | Count | Items |
| --- | --- | --- |
| Reclassified MET | 1 | Design-revision token merge in one source (re-confirmed) |
| Reopened (verify-reopened task) | 0 | — |
| Spec defect (design.md Open Questions) | 0 | — (workspace-counts defect from pass 1 already recorded; not re-opened) |

All requirements in the two spec deltas (`specs/frontend-console/spec.md`,
`specs/resource-metrics/spec.md`) now stand as MET, including the pass-1
reopened account affordance (task V1, closed — see below). The required visual
gate (`cd apps/web && pnpm test:visual`, 32/32, deterministic across two
consecutive runs) is recorded in tasks 8.1–8.3.

### Pass-2 gap analysis: clean

- frontend-console: dashboard inbox + pool panel (QueuePanel, CapacityAside,
  task-status descriptor, poolPanelQuery select, 5s poll, loader prefetch,
  MetricStrip removed, ≤820px mobile rules), landing family (RunnerCapsule,
  ProcessRail, BoundaryLedger, session-aware CTA + account affordance V1),
  session 3+1 layout (SessionHeader/SessionContextStrip, pty line removed,
  `ssr:false` invariant), token merge (below), guardrail ladders
  (IDLE_TIMEOUT_OPTIONS/DEADLINE_OPTIONS shared by dialog and `/tasks/new`),
  820px convention (`max-[821px]`), required pixel gate (8 pages × 2
  breakpoints) — all traced to implementation.
- resource-metrics: `/metrics` per-task process-scope section
  (metrics-projection.ts `foldTaskSamples` + metrics.service.ts, zod
  contracts), per-task read (`GET /tasks/:taskId/metrics`), degradation /
  carry-forward / container fallback / not-running semantics
  (ResourceSamplerService), mock/real lockstep under the one contract — all
  traced to implementation.

## Reclassified MET

### Design-revision token merge in one source (frontend-console) — re-confirmed in pass 2

Skeptic verdict was FAIL (both passes, identical grounds) because
`packages/ui/src/styles.css` (the `@cap/ui` standalone fallback stylesheet)
omits `--console`/`--muted-2` and retains the pre-revision `--shadow-card`
(line 224), against its own header's "keep in lock-step" note. Pass-2 re-trace
independently reconfirms the requirement is met as written; the fallback
divergence is a minor gap that does not block any scenario:

- Every normative clause is implemented in the single source,
  `apps/web/src/styles/app.css`: `--console: #f8f9fb` / `--muted-2: #808080` in
  `:root` (app.css:94-95), exposed as `--color-console`/`--color-muted-2` in
  `@theme inline` (app.css:257-258); `--shadow-card` retuned to exactly
  `0 0 0 1px rgba(0,0,0,0.08), 0 2px 2px rgba(0,0,0,0.04), 0 8px 8px -8px
  rgba(0,0,0,0.04)` (app.css:293-295); console background applied at body level
  via the `@layer base` `html, body { background-color: var(--console) }` rule
  (app.css:325-330); the one-off `bg-[#f8f9fb]` is gone from `_app.tsx` (the
  `SidebarInset` is `bg-transparent`; the literal survives only in an
  explanatory comment at app.css:323).
- Scenario 4 ("a `@cap/ui` component and an `apps/web` surface render on the
  same page ... from the same `app.css` definitions") is satisfied by the
  actual mechanism: `@cap/ui` is a tsc-only library that does not run Tailwind
  — `apps/web` compiles `@cap/ui` component classes against its own `app.css`,
  so any in-app render resolves the retuned shadow and the new tokens from the
  one source. The body-level rule is precisely what lets `@cap/ui` components
  inherit the console canvas with no per-package class (design.md D5).
- The skeptic's failing artifact, `packages/ui/src/styles.css`, is imported
  nowhere in the repository (pass-2 grep across apps/ and packages/ for
  `@cap/ui/styles` hits only the package.json `exports` entry and the file's
  own header comment; no Storybook/styleguide/isolated-test consumer exists),
  and no `@cap/ui` component uses the `shadow-card`/`console`/`muted-2`
  utilities at all (grep over `packages/ui/src/components/` is empty; Card uses
  `shadow-sm`). The divergence therefore cannot manifest visually on any
  rendered page. Moreover the requirement's operative sentence — values "SHALL
  live only in the single `app.css` source" — cuts against duplicating the
  retuned values into the fallback; the "keep in lock-step" note in that file's
  header is the prior change's (rebuild-console-tanstack-start) convention, not
  a scenario of this requirement.
- Non-blocking residual (housekeeping, optional): refresh or re-scope the
  unconsumed `packages/ui/src/styles.css` fallback (old `--shadow-card`,
  missing `--console`/`--muted-2`) the next time a standalone consumer of
  `@cap/ui/styles.css` actually appears.

## Reopened as verify-reopened task — CLOSED in pass 2

### Landing is session-aware — account affordance (frontend-console)

Pass 1 confirmed a real gap and routed it to tasks.md "Track: verify-reopened"
(task V1): the requirement mandates, for the authenticated landing, a primary
进入控制台 CTA "(and an account affordance)", and no element reflected the
operator's identity. Pass 2 verifies the fix end-to-end: `landing-nav.tsx` now
exposes an `account` prop (`LandingNavAccount`: GitHub `login` +
avatar-or-initials chip, `data-slot="landing-nav-account"`, labelled 当前账户),
and `routes/index.tsx` wires it from the session (`session.login` /
`session.avatarUrl`) behind the mount-gated `authed` flag — preserving the
SSR-safe swap invariant (unauthenticated server/first paint, reconcile after
hydration). Pixel gate unaffected (the harness captures the unauthenticated
first paint). Task V1 is checked off in tasks.md.

## Spec defect (routed to design.md Open Questions) — pass 1, unchanged

### Workspace counts reflect live queries — "each screen-card footer shows an open-tasks count"

Not reopened as a code task. The scenario's "each screen-card footer shows an
open-tasks count" contradicts the same requirement's own prose (the screen-cards
come "with a footer 'open tasks' count **and latest run id** derived from the
tasks query") and the prototype design's static footers (OAuth scoped / 30
天保留 / 单用户模式 / 安全优先). `workspace.tsx` implements the only
self-consistent reading: 任务控制台 footer ← live open-task count
(`openTasksMeta`), 实时会话 footer ← most-relevant task's `shortTaskId`, other
footers static per the design. The wording pre-exists verbatim in the base spec
(`openspec/specs/frontend-console/spec.md`) and was carried into this delta.
Recorded as an Open Question in design.md for a wording fix at the next spec
sync.

## Scope observations (implemented beyond spec; recorded, no action)

Union of both passes; none is a requirement failure. Items 11–16 surfaced in
pass 2. Line refs refreshed against the current tree where files shifted.

1. Dashboard 观察窗口 SegmentedControl (24h/7d/30d, decorative, unwired) —
   `apps/web/src/routes/_app/dashboard.tsx:62-68`. Pure visual fidelity to the
   design baseline; not query-wired by intent.
2. Dashboard topbar hidden ≤820px (`max-[821px]:hidden` on `/dashboard`) —
   `apps/web/src/routes/_app.tsx:92-95`. Design-driven: the baseline has
   `.page-dashboard .topbar{display:none}` and the blocking pixel gate surfaced
   it (task 8.2 note); fidelity, not creep.
3. SKILL_CATALOG + skill-selection checkbox group in NewTaskDialog —
   `apps/web/src/components/dashboard/new-task-dialog.tsx:66-69`. No spec
   requirement under this change; pre-existing/unrelated surface.
4. `VITE_FORCE_MOCK=1` / `forceMock()` seam in `capabilities.ts:93-96` — the
   chosen mechanism for the harness's required "mock data mode" (task 8.1);
   mechanism unspecified by the spec, purpose in-scope.
5. `isAuthCapable()` delegating through `isCapable('auth')` —
   `mock-session.ts:31-36`; consequence of (4).
6. Landing scroll cue (↓ 向下了解操作者流程 → `#workflow`) —
   `routes/index.tsx:163-169`; design-language polish, unspecified.
7. Hero secondary CTA 查看演示 → `#preview` anchor — `routes/index.tsx:150-179`;
   one concrete realization of the spec's allowed "scroll to the in-page
   preview" for anonymous entries.
8. `task-status.ts` entries for `cancelled`/`agent_failed_to_start`
   (`task-status.ts:117-130`) — forced by the spec's own compiler-checked
   exhaustiveness over the full `TaskStatus` union; the named statuses are
   examples, exhaustiveness is the requirement.
9. Session guardrail cell rendering formatted `idleTimeoutMs`/`deadlineMs` via
   `formatDuration()` — `routes/_app/tasks/$taskId.tsx:143-151`; the spec fixes
   the 3+1 grouping but not the guardrail cell's content.
10. `poolPanelQuery()` / `PoolPanelMetrics` named exports in
    `queries.ts:151-204` — structural naming of the required `metricsQuery`
    select projection; no behavioral delta.
11. Landing smooth-scroll mechanism: post-mount
    `document.documentElement.style.scrollBehavior = 'smooth'` set and restored
    on unmount — `routes/index.tsx:79-87`. The spec requires "smooth anchor
    scrolling" as a carried-forward behavior but does not fix the mechanism; a
    JS document-root mutation is one valid realization (SSR-safe: effect-only).
12. Two-step stop confirm in SessionHeader (`confirmingStop` arm/confirm state)
    — `session-header.tsx:78-149`. The spec requires the 停止任务 action exist
    with behavior unchanged in semantics; the confirm UX is an unspecified
    safety affordance, not a behavior change to the stop call itself.
13. Hot-slot coloring in the slot grid (`memoryPercent >= 60` → brighter cell)
    — `capacity-aside.tsx:213`. Reads the server-computed per-task
    `memoryPercent` as-is (comparison only, no arithmetic); presentation
    threshold unspecified by the spec.
14. Aggregate CPU/MEM stat tiles (two `pool-stat` cards) in CapacityAside —
    `capacity-aside.tsx:138-152`. The spec's pool-panel composition lists
    pool-hero/slot-grid/pool-lane/per-runner-rows/pool-policy; the tiles are a
    design-baseline element rendered off the SAME `/metrics` cache entry (no
    extra poll). Fidelity-driven extra surface.
15. `deriveMemoryPercent` client-side aggregate derivation (cgroup-limit sum →
    per-container-mean fallback → honest `null`/"—") —
    `capacity-aside.tsx:56-73`. Noted tension, not a violation: the
    resource-metrics "computed SERVER-SIDE so the console performs no metric
    arithmetic" SHALL is scoped to the per-task process-scope percentages, and
    the per-runner rows do consume `sample.cpuPercent`/`sample.memoryPercent`
    verbatim (`capacity-aside.tsx:321,329-330`, display rounding only). The
    arithmetic exists solely for the extra-spec aggregate tiles of (14), whose
    aggregate MEM% has no server-computed field to consume; honesty semantics
    (null → "—", never zeros) are preserved. If the tiles are ever specced,
    prefer a server-computed aggregate percent.
16. Auto-navigate into the created task session on dialog submit success —
    `new-task-dialog.tsx:228,322-325`. Pre-decided UX improvement
    (创建即进详情) from the prior console findings, orthogonal to this change's
    guardrail-preset requirement on the same file; no spec clause forbids or
    requires it.
