# Research Brief — pixel-restore-console-to-od

Side-car research notes grounding the proposal. Not a tracked artifact.

## Situation

- **Design source of truth**: Open Design project `680d21c4` ("OpenSpec Agent System", Vercel/Geist design system). Heavily revised through 2026-06-19 (this design session). Frozen snapshot copied into `design-baseline/` (10 screens + `css/platform.css` + `js/platform.js`).
- **Real frontend**: `apps/web` — TanStack Start + shadcn/ui, shared primitives in `packages/ui` (`@cap/ui`). Console pages live under `src/routes/_app/*`.
- **Divergence**: `apps/web` screens were last visually touched on **2026-06-11** (commit `eef0e9b` "pixel-merge design revision across all pages"). The OD baseline has since gone through many revisions. The frontend is ~8 days / many design iterations behind.

## Key insight: tokens already match, components don't

`apps/web/src/styles/app.css` is explicitly **"the SINGLE design-token contract"** mirroring the OD `platform.css` admin-light theme — same hexes (`#171717` ink, `#ebebeb` border, `#0a72ef` blue, `#f5f5f5` secondary), dark buttons, 1px `shadow-ring` philosophy, dark terminal scope. `@cap/ui` re-imports it.

⇒ Pixel restoration is **component/layout re-sync + 2 new views**, NOT a token rebuild. Token-level exceptions to carry over: **Geist Sans/Mono** (OD switched; frontend still `system-ui` / JetBrains Mono) and **flatter card shadows** (`shadow-card` → ring).

## Per-screen delta (OD baseline → apps/web)

| OD screen | Frontend target | Delta |
|---|---|---|
| `index.html` | `routes/index.tsx`, `components/landing/*` | Simplify: drop ACCESS/CONTROL/SAFETY proof-grid, the "操作者模型" 4-step + boundary-ledger, and header nav links (流程/权限/控制台/GitHub登录). `simplify-landing-homepage` is marked complete but did **not** touch `index.tsx`. |
| `screens/dashboard.html` | `routes/_app/dashboard.tsx`, `components/dashboard/*` | Compact task rows; simplify runner pool (slot grid + flow lane → single capacity bar); no multi-select. |
| `screens/agents.html` | `routes/_app/repositories.tsx`, `components/repositories/*` | RUNTIME summary card (Codex · Claude Code), "已连接 GitHub" dialog copy, empty state. |
| `screens/history.html` | `routes/_app/history.tsx`, `components/history/*` | **Rewrite**: current `audit-timeline` + `recent-tasks-table` + summary tiles → single Vercel-style **task-row list** (status pill + title + repo·branch + Agent/耗时 + black 「查看会话」), status filter, empty state. Remove ACTIVE WINDOW/ATTENTION/RETENTION/event-stream. |
| `screens/queue.html` | `routes/_app/tasks/new.tsx` | "沙箱即信任边界" guardrail copy, execution-strategy options; no write-gate language. |
| `screens/session.html` | `routes/_app/tasks/$taskId.tsx`, `components/session/*` | **Remove `approval-surface.tsx`** (write-gate banner); add stop-confirmation dialog; 2-line prompt clamp; header alignment; terminal-record framing. |
| `screens/transcript.html` | **NEW route** (e.g. `_app/tasks/$taskId/transcript`) | Build session-transcript timeline (user / reasoning / tool call+output / final answer / system events; type filter + search + empty state). Reads persisted transcripts. |
| `screens/settings.html` | `routes/_app/settings.tsx`, `components/settings/*` | Credentials reorganized **by runtime** (Codex tab: 官方账号 / 兼容提供方; **Claude Code tab: setup-token + Anthropic API Key** — currently only `codex-*` components exist); drop write-confirm toggle; single-column. |
| `screens/api.html` | **NEW route** `_app/api` | Build API debug console (endpoint collection rail by resource + read-only request bar + Request/Response sections with tabs). Consumes the public v1 API. |

**Cross-cutting**: Geist font; flatter shadows; status dot+text in history; empty states everywhere; `prefers-reduced-motion`; remove all approval/write-gate concepts; sidebar adds "API 调试 ⌘4" (desktop + mobile nav).

## In-flight changes absorbed (decision: one change, absorb)

| Change | Status | Handling |
|---|---|---|
| `redesign-settings-single-column` | in-progress 7/15 | Absorb remaining **frontend** settings work into this change (single-column + by-runtime credentials). Coordinate so we don't double-build. |
| `static-terminal-log` | in-progress 12/13 | Terminal "记录" already implemented in `components/session/*` (cast-log / session-replay). Keep; only restyle to match OD session/transcript framing. Do not re-do the log mechanism. |
| `public-v1-api` | in-progress 22/23 | **Dependency** for the API debug page. The page targets `/v1/*`. Sequence the api view after this lands (or build view against the contract, stub data). |
| `simplify-landing-homepage` | complete | Did not update `apps/web/index.tsx`; landing simplification still owed here. |
| `session-approval-flow` | no-tasks (stale) | Approval flow is removed product-wide; this change removes its **UI** (`approval-surface.tsx`). |

## Dependencies

- API debug view ← `public-v1-api` contract (`@cap/contracts`).
- Transcript view ← `session-transcript-persistence` (shipped) data shape.
- Shared primitives `@cap/ui` (StatusPill / Segmented / Card / Terminal) — extend here for any new shared bits (e.g. transcript event rows, api request/response shells) rather than per-page CSS.

## Verification approach

Faithful frame-by-frame ⇒ per-screen visual diff loop: render OD baseline screen (the frozen `design-baseline/*.html` via a static server) and the `apps/web` route, screenshot both with Playwright at matched viewport, compare. CLAUDE.md mandates Playwright for high-fidelity restoration.

## Locked decisions (from user)

1. **One change** (not split into layers).
2. **Absorb** overlapping in-flight UI work and handle together.
3. **Faithful frame-by-frame** restoration (baseline frozen in `design-baseline/`).
4. (Explore) Landing in scope = console `apps/web/routes/index.tsx`; marketing `apps/www` is out of scope.
