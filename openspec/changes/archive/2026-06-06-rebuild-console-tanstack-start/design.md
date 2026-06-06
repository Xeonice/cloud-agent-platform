## Context

The web console (`apps/web`) is a **Next.js 15 app** that consumes four real
REST endpoints (`GET /tasks`, `GET /tasks/:id`, `GET /repos`,
`POST /repos/:id/tasks`) plus the terminal WebSocket, importing shared
components from `@cap/ui` (shadcn/ui + Tailwind **v3**, including the
xterm-wrapping `<Terminal>`) and shared zod types from `@cap/contracts`
(`Repo`, `Task`, `TaskStatus`, WS frames). It is deployed web-only to Vercel and
talks to a cross-origin api via `NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_WS_URL`.

The NestJS api (`apps/api`) authenticates with a **single operator bearer token**
(`AUTH_TOKEN`, constant-time compared; the api refuses to start without it — see
`single-user-auth`). It runs agent tasks via a **host-root `docker.sock`** model:
the orchestrator inside the `api` container mounts the host docker socket and
provisions sibling `cap-aio-<taskId>` containers. **This makes "who can authenticate
to the api" equivalent to "who can run as root on the host."** Today that risk is
contained by there being exactly one shared token and one operator; the moment we
introduce multi-user login, the gate on *who gets a session* becomes a load-bearing
security boundary, not a UX nicety.

We have a **10-page design prototype** (blueprint `w16t13s6u.output`, `.result`) to
faithfully reproduce (direction B). Confronting the prototype against the live
backend exposes a large capability gap: of the 10 pages, **7 are mostly mock** —
there is no OAuth/identity, no GitHub repository import, no resource metrics, no
audit/history, no settings/credential storage, and the `Task`/`Repo` Prisma models
(verified: `Repo{id,name,gitSource,createdAt}`, `Task{id,repoId,prompt,status,createdAt}`)
have no `branch`/`strategy`/import-metadata fields. The prototype itself depicts
"GitHub OAuth identity + allowlist account `tanghehui`", which is the product's
intended posture, not the current single-token reality.

**Why now:** (1) the prototype is the agreed product surface and the console must
match it; (2) Next.js's RSC/route model fights the per-request, WS-heavy,
client-only-terminal shape of this app, and the operator has chosen TanStack Start
(full-stack on Vite, Nitro vercel preset) as the target; (3) the single-token auth
model cannot honestly back a multi-user prototype — and leaving the docker.sock
host-root surface gated by one shared secret while the UI implies named accounts is
a security/clarity liability. This change rebuilds the frontend AND pushes the
backend to supply real data behind a real, allowlist-gated identity.

Stakeholders: the operator (owns the allowlist, the host, and the
single-vs-multi-user trust decision), whoever maintains the api/Prisma schema, and
whoever owns the Vercel deploy.

## Goals / Non-Goals

**Goals:**

- Faithfully reproduce **all 10 prototype pages** on **TanStack Start** (Vite-native,
  Vinxi removed), shadcn/ui + Tailwind **v4**, design tokens ported from the
  prototype CSS, sharing one token contract with `@cap/ui` so shared components do
  not lose color.
- Introduce **GitHub OAuth multi-user identity WITH a hard allowlist gate** as the
  security boundary over the host-root docker.sock model. Retire the single
  operator-token path for *human* operators; keep a distinct machine-token domain
  for runner dial-back.
- Push the backend to **supply real data**: OAuth flow + session + users + allowlist;
  task `branch`/`strategy` persistence with read-back; settings CRUD + encrypted
  Codex credential storage; audit/history event recording + query; resource metrics
  (guardrails-semaphore-derived **and** real CPU/memory via docker-stats/cgroup
  sampling) behind a `/metrics` aggregation endpoint; approvals pending-list read.
- Route **all reads through TanStack Query** with a **single capabilities flag** as
  the real/mock switch point, so all 10 pages render today and flip to real
  endpoints page-by-page as the backend lands — with the mock boundary honestly
  labeled, never overclaiming.
- Close the **"sendable but unreadable" trap**: `branch`/`strategy` accepted by
  create-task must be persisted and readable back on the task/session/history views.

**Non-Goals:**

- **Open multi-tenant SaaS.** This stays an **allowlisted self-host** for a few
  trusted operators. The allowlist is a hard gate, not a sign-up funnel; there is no
  org/team/billing model.
- **Per-user data isolation as a security control.** Given the host-root trust model,
  every allowlisted user is already root-equivalent on the host; data is **shared**
  across allowlisted users (tasks/repos are platform-global), with identity used for
  attribution/audit and the allowlist used for admission — not for tenant isolation.
- **Dark mode for app chrome.** The prototype's app chrome is light-only; only the
  terminal is dark. We synthesize a `.dark` token set for completeness but do **not**
  ship a chrome theme toggle this round.
- **Gating codex's in-sandbox execution.** Per the established product positioning
  (`codex-execution-not-gated`), codex's autonomous execution inside its container is
  not command-gated; the trust boundary is the container. This change does not
  revisit that.
- **Task mutation beyond create** (cancel/retry) and **RSC** (not in TanStack Start
  1.0) are out of scope.

## Decisions

### D1 ★ — GitHub OAuth multi-user identity + HARD allowlist gate over host-root docker.sock

**Threat model (stated plainly):** the orchestrator mounts the **host
`docker.sock`** and provisions sibling containers as root. Any principal who can
obtain an authenticated api session can create tasks, which run with host-root
docker control. Therefore **login == host root.** The single security decision that
matters is *who is allowed to hold a session.* The GitHub OAuth identity layer is
**not** the gate; the **allowlist is the gate.** OAuth only proves "this is GitHub
user X"; the allowlist decides "X may have a session." The prototype's
`allowedAccount: tanghehui` is exactly this gate.

**Decision:**

1. **OAuth flow (backend, new `multi-user-oauth` capability).** Add the standard
   GitHub OAuth Authorization-Code flow: `GET /auth/github/login` (redirect to
   GitHub with `state`), `GET /auth/github/callback` (exchange code → GitHub user),
   `GET /auth/session` (current user or 401), `POST /auth/logout`. The callback
   resolves the GitHub login/id and **checks it against the allowlist BEFORE
   creating any session.** A non-allowlisted GitHub user gets a clean "not on the
   allowlist" rejection and **no session is created** — the gate is checked at the
   one place a session is minted.
2. **Allowlist as configuration, not self-service.** The allowlist is operator-owned
   config (env `AUTH_ALLOWLIST=tanghehui,...` and/or a seeded `User.allowed` flag),
   evaluated server-side. It is **never** mutable from a logged-in session in this
   change (no "invite" UI) — adding a user is an operator action, consistent with
   the self-host posture. If the allowlist is empty/unset the api **refuses to mint
   sessions** (fail-closed, mirroring the existing `AUTH_TOKEN`-refuses-to-start
   stance).
3. **Sessions & users storage (Prisma).** New `User` model (`id`, `githubId`,
   `login`, `name`, `avatarUrl`, `allowed`, `createdAt`) and `Session` model
   (`id`, `userId`, `expiresAt`, `createdAt`) keyed by an opaque, high-entropy,
   httpOnly, `Secure`, `SameSite=Lax` cookie. Server-side session records (not
   stateless JWTs) so logout/expiry/allowlist-removal can **revoke** immediately —
   critical given login == root. Constant-time session-id lookup; sessions expire and
   are sweepable.
4. **Retiring the single operator token (migration, not rename).** The human-facing
   REST/WS guard moves from `AUTH_TOKEN` bearer to **session-cookie**. The
   `single-user-auth` capability is migrated → `multi-user-oauth`: the
   "operator token gates REST/WS" requirements are **replaced** by
   "an allowlisted OAuth session gates REST/WS." Critically, the **runner
   `TASK_TOKEN` domain is untouched** — that authenticates sandbox dial-back, was
   always a separate trust domain (per `single-user-auth`), and remains a
   machine-to-machine bearer. During migration the api MAY accept *both* a valid
   session cookie AND the legacy `AUTH_TOKEN` (behind a `LEGACY_OPERATOR_TOKEN`
   feature flag) for one release so existing scripts/CI keep working, then the legacy
   path is removed. The `/health` endpoint stays unauthenticated.
5. **Per-user scoping vs shared.** Given few trusted users and the host-root model,
   tasks/repos remain **platform-global (shared)**. Identity is recorded for
   **attribution** (`Task.createdByUserId`, audit `actor`) and admission, **not** for
   isolation. This is an explicit Non-Goal-backed choice: per-user data partitioning
   would imply a tenant-isolation security claim we cannot honor when every user is
   root-equivalent.

**Alternatives considered.** (a) *Keep the single shared token, dress the UI as
multi-user* — rejected: the prototype implies named accountability and audit
attribution that a shared secret cannot provide, and it hides the real gate. (b)
*Stateless JWT sessions* — rejected: cannot revoke on allowlist removal/logout
without a denylist, and immediate revocation matters when login == root. (c)
*Real per-user tenant isolation* — rejected as a Non-Goal: false security comfort
under host-root. (d) *OAuth without an allowlist* — rejected outright: that would let
any GitHub user become host root.

### D2 — Resource metrics: semaphore-derived + real CPU/memory, behind one `/metrics` endpoint

The prototype shows two metric families that must be honestly sourced: **slot/queue
metrics** (RUNNERS 7/10, QUEUE 11, free slots, the 10-segment slot table) and
**host resource metrics** (CPU 42% / memory 64% gauges).

**Decision (new `resource-metrics` capability):**

1. **Slot/queue metrics are DERIVED, not measured.** They come directly from the
   existing **guardrails concurrency semaphore** — active task count, configured
   capacity, free slots, queue depth, and a per-slot occupancy table — which the
   orchestrator already maintains as the source of truth for admission control.
   These are cheap, exact, and synchronous; no sampling needed.
2. **CPU/memory are REAL, sampled.** Per-container CPU% and memory come from
   **`docker stats` (one-shot, `--no-stream`) and/or direct cgroup v2 reads**
   (`/sys/fs/cgroup/.../cpu.stat`, `memory.current`) for the running
   `cap-aio-<taskId>` containers plus a host roll-up. Because the orchestrator
   already has the host docker socket, `docker stats` is in-reach without new
   privileges.
3. **One aggregation endpoint.** `GET /metrics` (session-gated like the rest) returns
   a single typed payload merging the derived slot/queue block and the sampled
   CPU/memory block, plus a `sampledAt` timestamp. The frontend's `metricsQuery` /
   `capacityQuery` read this one endpoint; today they read `mock.ts`, and flipping
   `capabilities.metrics = true` points them at `/metrics`.
4. **Sampling cadence & overhead.** Real CPU/memory is the expensive part:
   `docker stats --no-stream` per container is non-trivial. We sample on a **bounded
   cadence (~5s)** in a background sampler that caches the last snapshot; `/metrics`
   serves the cache (never blocks a request on a live sample), and the frontend
   polls `/metrics` on its own ~5s `refetchInterval`. Cgroup reads (cheap file reads)
   are preferred where available; `docker stats` is the portable fallback. Sampling is
   skipped when there are zero running containers.

**Alternatives considered.** (a) *Live-sample on every request* — rejected: couples
request latency to docker-stats cost and can stampede under polling. (b) *Full
Prometheus/cAdvisor stack* — rejected as over-scoped for a few-user self-host; a
cached single endpoint is sufficient. (c) *Skip real CPU/memory, keep gauges mock* —
rejected: the operator explicitly wants real resource data; only slot/queue stays
derived because it genuinely is exact.

### D3 — TanStack Start architecture (full-stack on Vite, Nitro vercel preset)

**Decision:** rebuild `apps/web` as TanStack Start **1.x (RC)**, Vite-native (Vinxi
removed). Key, load-bearing specifics:

1. **Vite plugin order is load-bearing:** `tailwindcss()` → `tanstackStart({srcDirectory:'src'})`
   → `viteReact()` → `nitro()`. Wrong order breaks the build; abundant stale
   Vinxi/`app.config.ts` tutorials online will mislead — the spec/tasks pin the
   correct order.
2. **Per-request QueryClient.** `getRouter()` constructs a **new `QueryClient` per
   request** and wires `setupRouterSsrQueryIntegration`. A module-singleton
   QueryClient would **leak cache across users during SSR** — unacceptable once we
   have multiple identities. This is asserted as a requirement.
3. **`ssr:false` for the terminal route.** `/tasks/$taskId` is the only client-only
   route: xterm.js + WebSocket cannot run on the server. The route sets `ssr:false`
   and the server emits a real `pendingComponent` (TerminalSkeleton) — note `ssr:false`
   still SSRs the pending fallback, so the skeleton must be real to avoid a flash and
   must not touch `window`.
4. **Nitro vercel preset.** Deploy target is **Vercel via the Nitro `vercel`
   preset** (operator-decided), replacing the old Next-shaped `vercel.json`. The
   cross-origin `VITE_API_BASE_URL`/`VITE_WS_URL` contract is preserved so web (Vercel)
   still targets the api (Fly/compose) origin.
5. **Version pinning.** TanStack Start is RC (RSC not in 1.0; minors may break);
   versions are **exactly pinned** and upgrades gated behind a route/SSR/Query
   regression pass.

**Alternatives considered.** (a) *Stay on Next.js* — rejected by the operator;
RSC/route model fights per-request QueryClient + WS + client-only terminal. (b)
*Vinxi-based TanStack Start* — rejected: Vinxi is removed in current Start; Vite-native
is the supported path. (c) *node-server self-host preset* — viable, but operator chose
Vercel; the Nitro preset is a config swap if that changes.

### D4 — Tailwind v3 → v4 token migration (`@theme inline` + shadcn CSS variables, shared with `@cap/ui`)

**Decision:** collapse the prototype's dual themes into a single source of truth at
`src/styles/app.css` (Tailwind v4, **no `tailwind.config.js`**):

1. Header: `@import "tailwindcss"; @import "tw-animate-css"; @custom-variant dark (&:is(.dark *))`.
2. `:root` uses the **`admin-*` light theme** (the real product theme, NOT the
   marketing oklch theme) mapped onto shadcn's required semantic tokens. Notably
   **buttons are dark**: `--primary:#171717` (ink) / `--primary-foreground:#fff`;
   `--background:#fff`/`--foreground:#171717`; accent blue `#0a72ef`; the full
   `--sidebar-*` set (active = dark pill); `--chart-1..5`.
3. **Extra brand/semantic tokens** shadcn lacks but the design needs, written into
   `:root`: status **soft** colors — `--success:#1a7f37`/`--success-soft:#ecfdf3`,
   `--warning`/`--warning-soft`, `--info`/`--info-soft`, `--danger-soft`,
   `--dark-pill:#171717`; and a **terminal scope** `--terminal-bg:#050505` /
   `--terminal-fg:#e8e8e8` / `--terminal-muted` / `--terminal-line` plus oklch ok/warn/err
   log colors.
4. `@theme inline` maps every `--xxx` to a Tailwind utility (`bg-background`,
   `bg-success-soft text-success`, `bg-terminal-bg`, …); sans/mono font stacks
   (mono + `tabular-nums` for numerals/eyebrows/meta); radius ladder (sm 6 / 8 / lg 10 /
   xl 12 / full); and **box-shadow tokens** (`shadow-ring/card/modal/menu/toast/terminal`)
   — load-bearing because the prototype's "borders" are almost all 1px box-shadow
   rings, so we prefer `shadow-ring` over `border` to look right.
5. **Shared with `@cap/ui`.** The token contract lives once in `app.css`; `@cap/ui`'s
   `styles.css` migrates from v3 (three-directive + HSL) to **consume the same v4
   token contract** (or `@cap/ui` exports components only and tokens centralize in the
   app). Either way `Button`/`Card`/`Badge`/`Terminal` must not lose color.
6. **xterm doesn't read Tailwind classes.** At mount, the terminal resolves
   `--terminal-*` into hex and feeds xterm's `theme` option (background/foreground/cursor/ANSI16).
7. `.dark` is synthesized (chrome inverted, status hues preserved & lightened) for the
   terminal scope and future use; a `__root.tsx` inline pre-hydration `ThemeScript`
   prevents FOUC.

**Alternatives considered.** (a) *Keep `@cap/ui` on v3, app on v4* — rejected: two
token systems guarantee shared components desaturate/mismatch. (b) *Keep
`tailwind.config.js`* — rejected: v4 prefers CSS-first `@theme inline`; mixing invites
drift.

### D5 — Data layer: all reads through TanStack Query; capabilities flag is the single real/mock switch

**Decision:** every page reads data **exclusively through TanStack Query** (real or
mock alike), and the queryFn is the **only** place real/mock is chosen:

1. `lib/api/` is the sole data-access layer: `real.ts` (the four real endpoints +,
   as the backend lands, the new ones), `mock.ts` (typed mocks: auth/metrics/history/
   settings/githubImport/taskContexts, each with a `delay()` matching prototype
   timing), `capabilities.ts` (`BACKEND_CAPABILITIES` per-domain flags — today
   `{tasks,repos,createTask: true; auth,metrics,history,settings,githubImport,branches: false}`),
   and `queries.ts` (`queryOptions` factories shared by loaders and components; each
   queryFn does `if (capable) return real() else return mock()`).
2. **Flipping a flag is the entire integration step** for a domain: implement the
   real endpoint in `real.ts`, set its capability `true`, done. This is the disciplined
   answer to the "7/10 pages are mock" risk — the seam is one file, and the mock is
   honestly labeled in the UI where it matters.
3. Local writable UI state (githubConnected, importedRepos, selectedRepo, settings,
   codex credential **draft**) lives in a small persisted store
   (key `agent-control-plane-state`); mutations write the store then
   `invalidateQueries` to re-render. As real endpoints land, mutations become real
   POST/PUTs.
4. **Terminal bytes never enter Query.** Raw WS frames go straight to `term.write`;
   only discrete control frames (task done / lease change / approval) bridge back via
   `queryClient.setQueryData(['tasks',id])`. High-frequency bytes through React state
   would thrash.
5. **`branch`/`strategy` persistence closes the "sendable but unreadable" trap.** The
   create-task form already lets the operator pick a branch/strategy and the body is
   accepted — but the `Task` model has no such fields, so the backend **silently
   drops them** and the session/history views can't show them (forcing mock
   `TASK_CONTEXTS`). This change adds `Task.branch` / `Task.strategy` (and any
   runner-metadata needed) to Prisma + contracts + read-back, so what was sent is
   what's shown. Until that lands, `capabilities.branches=false` and the context is
   mock — but the fix is in scope, not perpetual mock.

**Alternatives considered.** (a) *Scatter `fetch` per page with ad-hoc mocks* —
rejected: no single seam; integration becomes a hunt. (b) *MSW network-level mocking* —
considered; the capabilities flag is lighter and keeps the seam in app code where the
honest-labeling lives.

### D6 — Auth transport into WS/REST (session/token via query param + bearer subprotocol)

**Decision:** REST requests carry the session via the **httpOnly session cookie**
(automatic, cross-origin requires `credentials:'include'` + api CORS allowlisting the
web origin). The **browser WebSocket API cannot set an `Authorization` header**, so
WS auth continues to ride the existing transport: the credential is passed as a
**connect query param and/or a `bearer.<token>` subprotocol** (already correctly
implemented in `ws-client.ts` / `TerminalSocket`). Under multi-user the server-side WS
handshake validates the **session** (resolving cookie OR the subprotocol-carried
session token) and rejects+closes any unauthenticated/non-allowlisted connection
before joining a task stream, mirroring the current "close before subscribe" guard.
We do **not** attempt to add a WS `Authorization` header.

**Alternatives considered.** (a) *Custom WS header* — impossible in browsers. (b)
*Cookie-only WS auth* — fragile cross-origin (third-party-cookie / `SameSite`
constraints between Vercel web and Fly api); the subprotocol path is origin-robust and
already built.

## Risks / Trade-offs

- **[TanStack Start v1 RC instability — minors may break route/SSR/Query.]** →
  **Mitigation:** pin exact versions; gate any upgrade behind a route + SSR + Query
  regression pass; document the correct Vite plugin order (T0 risk: stale Vinxi
  tutorials misdirect).
- **[Host-root docker.sock + multi-user — the allowlist is load-bearing.]** Login ==
  host root, so an allowlist bug or an OAuth-without-gate slip is a full host
  compromise. → **Mitigation:** check the allowlist at the single session-mint point
  (callback), fail-closed when the allowlist is empty, use revocable server-side
  sessions (not stateless JWT), keep tasks/repos shared (no false isolation claim),
  and keep the runner `TASK_TOKEN` domain separate.
- **[Tailwind v4 migration scope — `@cap/ui` could desaturate.]** Two token systems
  would mismatch shared `Button`/`Badge`/`Card`/`Terminal`. → **Mitigation:** one
  token contract in `app.css`; migrate `@cap/ui` styles to consume it; a temporary
  `/styleguide` page validates all components + StatusPill variants against the token
  table before pages are built.
- **[xterm + SSR hydration crash.]** xterm touches `window`. → **Mitigation:**
  `/tasks/$taskId` is `ssr:false`, terminal constructed in `useEffect`,
  `@xterm/xterm/css/xterm.css` imported, a real (window-free) skeleton serves the SSR
  pending pass; WS bytes stay out of Query.
- **[docker stats overhead under polling.]** Live-sampling per request could stampede
  and add latency. → **Mitigation:** background sampler on a bounded ~5s cadence
  caches the snapshot; `/metrics` serves the cache; prefer cheap cgroup reads; skip
  when zero containers run.
- **[Mock-now / real-later drift — "looks usable but is fake."]** 7/10 pages are
  mock today; users could mistake mock data for real. → **Mitigation:** the
  capabilities flag is the single, auditable real/mock seam; mocks are typed against
  `@cap/contracts` (+ view extensions) so they can't drift off-shape; the UI honestly
  labels mock regions; each backend capability has its own spec delta so "flip the
  flag" is a tracked deliverable, not an open-ended placeholder.
- **[Per-request QueryClient discipline.]** A module-singleton QueryClient leaks
  cache across users in SSR. → **Mitigation:** asserted requirement — construct inside
  `getRouter()`.
- **[`branch`/`strategy` silent-drop trap.]** Until the Prisma fields land, sent
  branch/strategy vanish and session context is mock. → **Mitigation:** in-scope
  Prisma + contracts + read-back; `capabilities.branches` flips only when read-back is
  real, so the UI never claims a persisted branch it can't show.

## Migration Plan

**Principle: backend API contracts first, then the frontend consumes them; flip one
capability flag per landed endpoint.**

1. **Frontend scaffold (no backend dependency).** Migrate `apps/web` Next → TanStack
   Start (T0): remove `next.config.mjs`/`next-env.d.ts`/Next `vercel.json`; add the
   Start/Router/Query/Vite/Tailwind-v4 deps; `vite.config.ts` with the load-bearing
   plugin order; carry over `ws-client.ts` / `api-client.ts`(→`real.ts`) / `config.ts`
   with env `NEXT_PUBLIC_*` → `VITE_*`. Build the token layer (T1), app-shell (T2), and
   mock/Query layer (T3). All 10 pages render on mock + the four real endpoints.
2. **Backend contracts, in dependency order.** Land Prisma migrations + REST/WS
   contracts per new capability — sequenced so each is independently shippable:
   - **`multi-user-oauth`**: `User`/`Session` models; `/auth/github/{login,callback}`,
     `/auth/session`, `/auth/logout`; session-cookie REST/WS guard; allowlist gate at
     callback. Dual-accept legacy `AUTH_TOKEN` behind `LEGACY_OPERATOR_TOKEN` for one
     release, then remove. **Runner `TASK_TOKEN` untouched.**
   - **`repo-and-task-management` (modified)**: add `Task.branch`/`Task.strategy`
     (+ runner metadata) and `Repo` GitHub-import metadata; persist on create, expose
     on read — closing the unreadable trap.
   - **`github-repository-import`**: list importable repos via the GitHub token,
     import → create `Repo` with metadata, set-default.
   - **`resource-metrics`**: guardrails-derived block + cached docker-stats/cgroup
     sampler + `GET /metrics`.
   - **`audit-history`**: event recording on lifecycle/auth/approval actions +
     query endpoint(s); approvals pending-list read.
   - **`account-settings`**: settings CRUD + **encrypted-at-rest** Codex credential
     storage.
3. **Frontend consumes, flag by flag.** For each landed endpoint: add it to `real.ts`,
   flip its `capabilities.*` to `true`, verify the page's real path, keep the rest on
   mock. No frontend page is rewritten to integrate — only `real.ts` + the flag change.
4. **Retire the human operator token.** Once OAuth sessions are verified, remove the
   `LEGACY_OPERATOR_TOKEN` dual-accept; migrate the `single-user-auth` spec →
   `multi-user-oauth`. `/health` stays unauthenticated; `TASK_TOKEN` stays.
5. **Deploy.** Configure the Nitro `vercel` preset, drop the old Next `vercel.json`,
   verify `VITE_*` env injection and cross-origin CORS (`credentials:'include'`).

**Rollback (per track):** frontend scaffold is a `apps/web` replacement — revertable by
restoring the Next app. Each Prisma migration is additive and independently
revertible; capability flags default to `false`, so reverting a backend track simply
leaves its page on mock (no broken page). The legacy-token dual-accept window is the
auth rollback safety net. Token migration is the last, most security-sensitive step and
is reverted by re-enabling `LEGACY_OPERATOR_TOKEN`.

## Open Questions

Pulled from the blueprint (`.result.openQuestions`) plus this change's cross-cutting
concerns:

- **Homepage identity.** The prototype has two pages claiming `/` (Landing vs
  Launcher). Blueprint ruling: Landing=`/`, Launcher=`/workspace`, Resume=`/resume` —
  **needs operator confirmation** of the real entry point and inter-page navigation.
- **Login gate form.** Blueprint flagged "GitHub visual mock vs real token input." This
  change **resolves it toward real GitHub OAuth + allowlist** (D1). Confirm the
  callback-rejection UX copy for non-allowlisted users (Chinese: e.g. "该 GitHub 账号
  不在白名单内，无法进入控制台").
- **Session context completeness.** `/tasks/$taskId` shows repo#branch/agent/runner
  metadata the backend doesn't yet store. D5 puts `branch`/`strategy` persistence in
  scope; confirm whether runner metadata (region/pty path/worktree changes) should be
  persisted too or stay mock for now.
- **Metrics/history/approvals scope this round.** D2 + the `audit-history` capability
  commit to real `/metrics`, audit events, and approvals pending-list. Confirm the
  audit event taxonomy (which lifecycle/auth/approval actions are recorded) and
  retention (prototype shows 30 days).
- **Per-user data scoping.** This design chooses **shared (global) tasks/repos** with
  identity used only for attribution/audit (Non-Goal: tenant isolation under
  host-root). Confirm the operator accepts shared visibility across allowlisted users.
- **Codex credential encryption-at-rest.** `account-settings` stores the Codex API key
  encrypted; **which mechanism** (KMS / libsodium-sealed with an env master key /
  OS keyring) and key rotation policy is an open decision for the self-host
  environment.
- **Dark mode.** Non-Goal this round (chrome is light-only; `.dark` synthesized but no
  toggle). Confirm no chrome theme switch is required for delivery.
- **GitHub import / Codex wiring depth.** Whether `github-repository-import` and the
  Codex credential test/model-probe are wired to the real GitHub/Codex APIs this round
  or remain mock behind their flags pending the OAuth token plumbing.
- **Visual-fidelity acceptance.** Whether Playwright per-page screenshot comparison
  against the prototype is a delivery gate (per the high-fidelity preference); if so,
  baseline screenshots for the 10 pages are needed.
- **Deploy target.** Confirmed **Vercel via Nitro `vercel` preset**; reconfirm vs
  node-server self-host, since it changes the deploy config and env injection.
