# Research Brief — rebuild-console-tanstack-start

> Side-car (NOT a tracked OpenSpec artifact). Distilled from the rebuild blueprint
> (`tasks/w16t13s6u.output` `.result`). Single source of truth for the proposal,
> design, specs, and tasks of this change. Direction **B**: faithfully reproduce all
> 10 design pages; fill backend gaps — but push the backend to supply real data wherever
> the operator chose to, rather than leaving them mock forever.

## 1. Route map

App is TanStack Start (Vite-native, no Vinxi). Two layout families: **standalone**
(landing-nav, no app-shell) and **app-shell** (pathless `_app` layout: sidebar + topbar +
mobile-nav + account-menu). `★` = client-only (`ssr:false`), `◆` = wired to a real backend
endpoint.

```
__root.tsx        head/CSS/Scripts · per-request QueryClient · Sonner · theme pre-hydration script
│
├─ standalone (landing-nav, SSR)
│   ├─ /            index.tsx        营销落地 Landing            (static / mock preview)
│   ├─ /login       login.tsx        GitHub 授权登录 (gate)      (OAuth start ◆ + allowlist)
│   ├─ /workspace   workspace.tsx    工作区总览 Launcher hub      ◆ GET /repos, GET /tasks (derived)
│   └─ /resume      resume.tsx       Agent 控制台 · 继续处理      ◆ next-action task (derived)
│
└─ _app.tsx        pathless app-shell layout + auth/allowlist beforeLoad
    ├─ /dashboard          _app/dashboard.tsx       任务控制台 / 运行工作台   ◆ queue + create + ◆ metrics
    ├─ /tasks/new          _app/tasks/new.tsx       创建任务 / 高级派发        ◆ POST create
    ├─ /tasks/$taskId  ★◆  _app/tasks/$taskId.tsx   实时 xterm 会话           ◆ real WS + ◆ task ctx
    ├─ /repositories       _app/repositories.tsx    仓库导入 / 仓库范围        ◆ imported list + ◆ GitHub import
    ├─ /history            _app/history.tsx         历史与日志 · 审计时间线    ◆ task table + ◆ audit events
    └─ /settings           _app/settings.tsx        设置 · 账户与模型凭据      ◆ settings + ◆ Codex credential
```

> Decided in blueprint: prototype had two pages claiming `/`. Resolution — Landing = `/`,
> Launcher = `/workspace`, Resume = `/resume`. (Final home-route ownership is an open question
> pending operator confirmation; see §5.)

## 2. Page → data matrix (real vs. mock → now-real)

The blueprint snapshot was taken against TODAY's backend (only `/tasks`, `/repos`,
`POST /repos/:id/tasks`, `POST /repos`, WS `/terminal` exist). This change's whole point is
to **promote** most of the "mock" column to real by extending the backend. Column 3 marks
what this change makes real.

| Page | Real today | Mock today | Promoted to REAL by this change |
|---|---|---|---|
| `/` Landing | — | full marketing preview (hero/terminal/proof/workflow/security) | stays static (intentional) |
| `/login` | local token gate only | githubConnected / allowlist `tanghehui` / 3-step onboarding | **GitHub OAuth flow + session + allowlist gate** |
| `/workspace` | GET /repos, GET /tasks (derived) | RUNNERS 7/10, QUEUE 11, retention, card copy | **runner/queue/slot counts from /metrics** |
| `/dashboard` | GET /tasks, GET /repos, POST create | metrics tiles, capacity 7/10, slot meter, CPU/mem, branches, strategy, command preview, config | **/metrics (semaphore-derived + docker-stats CPU/mem), branch/strategy persisted** |
| `/tasks/new` | GET /repos, POST create | branches, strategy presets, runner availability, command preview, write-boundary | **branch + strategy persisted (read back on task detail)** |
| `/tasks/$taskId` | WS raw/keystroke/decision, GET /tasks/:id (5 fields) | repo#branch / agent / runner env / safety boundary (TASK_CONTEXTS) | **branch/strategy read-back; pending-approval list read** |
| `/repositories` | GET /repos, POST /repos | importable list (USER_REPOSITORIES), repo metadata, default repo, sync state | **GitHub `/user/repos` import + repo GitHub-import metadata** |
| `/history` | GET /tasks | audit event timeline, HTTP status codes, retention, durations | **audit/history event recording + query endpoint** |
| `/settings` | GET /repos (default-repo options) | account identity, allowlist, retention, writeConfirm, Codex credential mode/test | **settings CRUD + encrypted Codex credential storage** |

Net effect: of the prototype's "7/10 pages are mostly mock" starting point, this change wires
**multi-user OAuth, GitHub import, resource metrics, audit history, and account/Codex settings**
to real backend endpoints. Genuinely-static marketing copy on `/` stays static. The data-access
seam (`lib/api/{real,mock,capabilities,queries}.ts`) is preserved so any endpoint not yet shipped
falls back to typed mock by flipping ONE `BACKEND_CAPABILITIES` flag — "ship all 10 pages today,
swap to real backend by flipping a flag" remains the contract.

## 3. Token plan (summary)

- Single source: `apps/web/src/styles/app.css`, Tailwind **v4** (no `tailwind.config.js`).
  `@import "tailwindcss"; @import "tw-animate-css"; @custom-variant dark (&:is(.dark *));`
- `:root` maps the prototype's **`admin-*` terminal values** (the real product theme, NOT the
  marketing OKLCH theme) onto shadcn semantic tokens: `--primary:#171717` (dark buttons!),
  `--accent:#ebf5ff/#0a72ef`, `--background/--card:#fff`, `--muted-foreground:#666`,
  `--border/--input:#ebebeb`, `--ring:#0a72ef`, `--radius:0.5rem`, full sidebar token set,
  `--chart-1..5`.
- Extra brand/semantic tokens shadcn lacks but the design needs: `--success #1a7f37 / -soft #ecfdf3`,
  `--warning #9a6700 / -soft #fff8c5`, `--info #0a72ef / -soft #ebf5ff`, `--danger-soft #fff1f0`,
  `--dark-pill #171717`; brand `--blue/--pink/--red`; terminal scope `--terminal-bg #050505 /
  -fg #e8e8e8 / -muted / -line` + OKLCH log ok/warn/err.
- `@theme inline` exposes every `--xxx` as a `--color-*` utility (`bg-success-soft`, `text-info`,
  `bg-terminal-bg`…); fonts sans/mono (JetBrains Mono + `tabular-nums` for numerics/eyebrows);
  radius ladder sm6/md8/lg10/xl12/full; **box-shadow ring tokens** (`shadow-ring/card/modal/menu/
  toast/terminal`) — KEY: prototype "borders" are mostly 1px box-shadow rings, prefer
  `shadow-ring` over `border` to look right.
- `.dark` is synthesized (chrome inverted near-black, status/accent hues kept and lifted) since
  the prototype chrome has no dark mode — only the terminal is dark. SSR pages use a `__root.tsx`
  inline pre-hydration script to set `.dark` and avoid FOUC.
- `components.json`: `tailwind.config:""`, `css:src/styles/app.css`, `cssVariables:true`,
  `baseColor:neutral`, `rsc:false`, `tsx:true`. xterm gets `--terminal-*` resolved to hex and fed
  into its `theme` option (it does not consume Tailwind classes).
- `@cap/ui` migrates its `styles.css` from v3 (3-directive + HSL) to consume the SAME v4 token
  contract, so shared Button/Card/Badge/Terminal stay color-matched with the new pages.

## 4. Track DAG

```
T0 Scaffold/Build (Next → TanStack Start, Vite, lib migration)
   │
   ├───────────────┬───────────────────────────────┐
   ▼               ▼                                ▼
T1 Tokens/shadcn  T3 Mock层/Query 工厂            (T3 only depends on T0)
   │               │
   ▼               │
T2 App-Shell/导航  │
   │               │
   ├───────────────┴────────┬──────────┬──────────┬──────────┐
   ▼          ▼          ▼          ▼          ▼          ▼
 T4 着陆类   T5 仓库/设置  T6 历史    T7 Dashboard           T9 Session ★
 (/,/login,  (/repos,    (/history) (◆队列+创建)            (◆真WS, ssr:false)
  /workspace, /settings)                  │
  /resume)                                ▼
                                     T8 高级派发整页 (/tasks/new, reuse T7 form)
   └───────────────┴──────────┴──────────┴──────────┴──────────┘
                              ▼
                       T10 集成 / 回归 / Nitro(Vercel) 部署 / 视觉比对
```

- Parallel windows: T1 ∥ T3 (both depend only on T0). After T2 + T3 land, T4/T5/T6/T7/T9 run
  five-wide. T8 depends on T7's shared form/command-preview components.
- Backend extension tracks (OAuth + session + allowlist; GitHub import + repo metadata; metrics
  aggregation incl. docker-stats sampling; audit/history recording + query; settings CRUD +
  encrypted Codex credential; branch/strategy persistence + read-back; approvals pending-list)
  ride alongside the frontend tracks that consume them — each frontend page is wired to its real
  endpoint as that endpoint lands, otherwise it falls back through the capability flag.
- Every track has a verifiable exit (dev boots, `turbo verify` green, key interactions hand-tested,
  optional Playwright per-page visual comparison against the prototype).

## 5. Key risks

1. **TanStack Start is v1 RC** (2025-09), not LTS 1.0; RSC not in 1.0; minors may break — pin
   exact versions; upgrades require re-regressing routing/SSR/Query.
2. **Vinxi removed → Vite-native** — most online `app.config.ts`/Vinxi tutorials mislead; the
   `vite.config` plugin order `tailwindcss() → tanstackStart() → viteReact() → nitro()` is
   load-bearing — wrong order breaks the build.
3. **Tailwind v3 → v4 migration** — existing `apps/web` and `@cap/ui` styles are v3 (3-directive +
   HSL); large token port to `@theme inline` + OKLCH + `tw-animate-css`; `@cap/ui` and app MUST
   share one token source or shared components decolor.
4. **`docker stats` / cgroup sampling for metrics** — must be cheap, sampled (not per-request
   exec), and degrade gracefully when the host daemon is unreachable; the `/metrics` aggregation
   blends guardrails-semaphore counters (active / free slots / queue / slot table) with real
   CPU/memory. Mismatched sources can mislead operators if not reconciled.
5. **branch/strategy persistence** — today `CreateTaskBody` accepts them but the `Task` model
   drops them silently (no read-back). This change adds Prisma fields + read-back so session/
   history can show the real branch/strategy instead of mock `TASK_CONTEXTS`. Migration + contract
   bump required.
6. **GitHub OAuth = host-root admission gate** — backend runs tasks via host-root `docker.sock`,
   so "who can log in" == "who can run as root on the host". The allowlist gate is a load-bearing
   security boundary, NOT UI decoration. OAuth callback, session, and allowlist enforcement MUST
   fail closed; a non-allowlisted authenticated GitHub user MUST be denied console access.
7. **xterm + SSR** — `ssr:false` + construct in `useEffect` + import `xterm.css` or hydration
   crashes; `ssr:false` still SSRs the `pendingComponent`, needs a real skeleton. WS bytes MUST
   NOT enter the Query cache (high-frequency bytes thrash React).
8. **QueryClient must be created per request** in `getRouter()` — a module singleton leaks state
   across users in SSR (now multi-user, so a real cross-tenant leak risk).
9. **Encrypted Codex credential storage** — API keys must be encrypted at rest, never returned in
   plaintext, and masked in responses; key material handling is a security surface.
10. **WS handshake cannot set `Authorization` header** — keep the existing token-query +
    `bearer.<token>` subprotocol; with multi-user sessions, the WS auth must map to the
    session/user, not a single shared operator token.
11. **Nitro deploy target = Vercel preset** — old Next-shaped `vercel.json` is incompatible; the
    cross-origin `API_BASE_URL`/`WS_URL` strategy must be preserved on Vercel.
12. **Mock persistence reuses prototype localStorage key** `agent-control-plane-state` — stale/
    incompatible old structures need migration/cleanup.

## 6. Open questions (for operator sign-off)

1. Home-route ownership — Landing vs. Launcher vs. Resume as `/` (prototype had two `/`s); confirm
   the real product entry order and inter-page navigation.
2. OAuth scope — confirm the GitHub OAuth app scopes (identity-only vs. repo read for import), the
   exact allowlist storage (env list vs. DB `User.allowed` flag), and whether the session cookie is
   the single source of truth for both REST and WS auth (replacing the single `AUTH_TOKEN`).
3. Session task-context fields — now that branch/strategy persist, confirm which runner/env fields
   (runner id, vCPU, worktree path, pty path) the backend should also persist vs. keep derived/mock.
4. Metrics depth — confirm the `/metrics` payload shape: semaphore counters only, or also
   per-task CPU/mem from docker-stats; sampling interval; behavior when the daemon is unreachable.
5. Dark mode — deliver a theme toggle, or ship synthesized `.dark` unused (chrome default light)?
6. Audit/history scope — which events are recorded (task create / status transition / approval
   decision / settings change / login), retention window, and query filters (level / time-range /
   search) the `/history` endpoint must support.
7. Playwright high-fidelity screenshot comparison as an acceptance gate — if required, supply the
   10 baseline prototype screenshots.
8. Codex credential — confirm encryption scheme (KMS vs. app-key envelope), and whether
   compatible-provider model probing calls out to the provider at save/test time.
