# Visual baselines: pinned rendering environment & regeneration procedure

(close-gate-blindspots-and-ci-hygiene task 7.1 — spec `test-suite-discovery` /
"Visual lanes pin their rendering environment and review their baselines".)

## The pin

Both web Playwright lanes run in CI inside ONE pinned Playwright Docker image:

    mcr.microsoft.com/playwright:v1.60.0-noble

- `pnpm test:visual` — the pixel gate (`playwright.config.ts`)
- `pnpm test:terminal-stories` — its own deliberately separate lane
  (`playwright.terminal-stories.config.ts`; it must NOT mask live terminal
  content the way the visual lane does)

**Invariant:** the image tag version MUST equal the resolved `@playwright/test`
version in `pnpm-lock.yaml` (currently `1.60.0`). Playwright requires the npm
package and the image's preinstalled browser builds to match. Bump the
dependency and the image tag in the SAME commit (both configs' header
annotations + the CI workflow + this doc), then re-run the validation below.

Why a pin: screenshot comparison is only meaningful inside one reproducible
rendering environment — baselines generated on a different OS (Mac-rendered
baselines against Linux runners) guarantee font-rendering flake. This harness
already re-renders BOTH sides (design prototype and app) in the same browser on
every run, which removes most OS variance from each individual comparison — but
the manifest THRESHOLDS are recorded numbers, only valid against the
environment they were measured in. The pin makes that environment reproducible.
(The one network input that remains is the design prototype's Google-Fonts
`@import` in `design-baseline/css/platform.css`; it cannot be vendored in-repo
because `design-baseline/` must stay byte-identical to the OD project for
`sync-design-baseline.mjs --check`. The app side self-hosts the same Geist
family from `public/fonts/`.)

## What a "baseline" is here (and what a reviewed diff means)

Baselines are NOT checked-in PNGs:

- The committed, reviewed baseline SOURCE is `e2e/design-baseline/` (the frozen
  OD prototype snapshot) plus the recorded per-page thresholds in
  `e2e/visual/manifest.ts`.
- The PNGs under `e2e/visual/__screenshots__/` are LIVING artifacts: gitignored
  and re-captured from the committed source at the start of every run, inside
  the same environment the app capture uses.

A baseline change is therefore, by construction, a reviewed diff: it can only
be a change to `e2e/design-baseline/**` (via `sync-design-baseline.mjs`, run by
a developer against the local OD project — never in CI) or to the recorded
thresholds in `e2e/visual/manifest.ts`. A gating run on a runner never
overwrites baselines — it only reads them; even `--update-snapshots` could only
write into the gitignored `__screenshots__/`, which the capture project
regenerates on every run anyway.

## Regeneration / recalibration procedure (against the pin)

Run after any design change (OD → baseline re-sync), when the suite covers a
new page, or on a pin bump. Step 1 runs on the developer host (OD lives outside
the repo); steps 2–4 run INSIDE the pinned image.

1. Host, from `apps/web`: `node e2e/sync-design-baseline.mjs --check` to report
   drift, then without `--check` to re-sync OD → `e2e/design-baseline/`.
2. Measure inside the pin, from the repo root:

   ```bash
   docker run --rm --ipc=host -e CI=1 -e HUSKY=0 \
     -v "$PWD":/work -w /work \
     mcr.microsoft.com/playwright:v1.60.0-noble \
     bash -c 'corepack enable && corepack prepare pnpm --activate && \
       pnpm install --frozen-lockfile --filter "@cap-console/web..." && \
       pnpm --filter @cap-console/contracts build && \
       pnpm --filter @cap-console/ui build && \
       cd apps/web && VV_MEASURE=1 pnpm test:visual'
   ```

   `VV_MEASURE=1` pins every threshold to 0 so every comparison reports its
   actual diff ratio; the measure run is EXPECTED to exit non-zero. Compute the
   precise ratio as reported differing pixels ÷ viewport pixels (desktop
   1440×900 = 1 296 000, mobile 820×1180 = 967 600).

   NOTE: the mounted checkout's `node_modules` must have been installed inside
   a Linux container (or start from a clean checkout) — a macOS-installed
   `node_modules` carries mac-native binaries and will not run in the image.
3. Record (measured + headroom) per page in the `ratio(...)` calls of
   `e2e/visual/manifest.ts`, and append a dated calibration record to the
   manifest header.
4. Confirm green inside the pin: the same `docker run`, with plain
   `pnpm test:visual` — and `pnpm test:terminal-stories` for the stories lane.
5. Commit the whole diff: `design-baseline/**` + manifest thresholds + any
   annotation updates. That commit IS the reviewed baseline change.

### Pulling the pin behind a throttled network

Direct `docker pull mcr.microsoft.com/...` can stall (observed ~28 KB/s on the
797 MB browser layer). Pull **by digest** through any registry mirror instead,
then retag — the digest makes the bytes identical regardless of mirror:

```bash
# 1. Read the manifest-list digest from BOTH hosts; they MUST match:
curl -sI https://mcr.microsoft.com/v2/playwright/manifests/v1.60.0-noble \
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' | grep -i digest
# 2. Pull by that digest via the mirror (docker verifies every layer against it):
docker pull mcr.dockerproxy.net/playwright@sha256:<digest>
docker tag  mcr.dockerproxy.net/playwright@sha256:<digest> \
            mcr.microsoft.com/playwright:v1.60.0-noble
```

## Validation record

**2026-07-31 (task 7.1, first in-pin run).** Image
`mcr.microsoft.com/playwright:v1.60.0-noble`, manifest-list digest
`sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948`
(digest-verified identical between MCR and the mirror used to fetch it);
executed as the **linux/arm64** variant of the multi-arch pin (local Docker on
Apple silicon). CI runners are amd64 — the same-image amd64 proof lands with the
lane wiring (change task 7.4); if any cell trips there, re-measure inside the
pin on the runner per the procedure above.

- Step 1: `sync-design-baseline.mjs --check` → **0 drift** (committed baseline
  is byte-identical to the OD project). No `design-baseline/**` change to land.
- Step 2 (`VV_MEASURE=1`, in-pin): all 22 captures green; all 22 comparisons
  reported. Full measured table recorded in the `manifest.ts` header
  ("In-pin recalibration, 2026-07-31").
- Step 3: ONE pin-attributable recalibration — `api@mobile` Linux-measured
  0.0480 vs Mac-recorded 0.045 → raised to 0.065. Every other in-threshold cell
  keeps its Mac-recorded value (Linux shift ≤ a few 1e-3). That manifest edit is
  this validation's reviewed baseline diff.
- Step 4 (plain `pnpm test:visual`, in-pin): **40 passed, 4 failed** — the 4
  are the two pre-existing, pin-independent pages below, and nothing else.
  `pnpm test:terminal-stories` (in-pin): **15/15 passed**, exit 0.

**Pre-existing failures (recorded, NOT absorbed into thresholds — triage per
the change's three-way convention):**

1. `tasks-new` (both breakpoints) — **product defect (backend-less mode)**:
   `/tasks/new` renders the route error boundary (出错了 / fetch failed).
   `schedulesQuery()` in `src/lib/api/queries.ts` has no mock seam — its
   `real.listSchedules()` runs unconditionally in the route loader, so any
   backend-less render (the `VITE_FORCE_MOCK` harness, and equally a dev
   machine without an api) fails the route. Fix belongs in app code (a mock
   seam like `reposQuery`'s), outside this task's scope.
2. `session` (both breakpoints, ratios 0.53/0.67) — **stale design baseline**:
   the app grew the view tabs (任务视图/准备诊断, 实时终端/对话记录), the
   per-task resource strip, and the 定时任务/镜像管理 nav after the 2026-06-23
   OD snapshot, and the OD design was never updated (hence 0 drift in step 1 —
   re-sync cannot fix this). Clearing it = update the OD session/nav design,
   re-sync, re-measure in-pin. Inflating the threshold to >0.53 would gut the
   tripwire and was deliberately not done.

Until those two are cleared, a wired visual lane is red on exactly those pages;
the terminal-stories lane is provably green inside the pin today.
