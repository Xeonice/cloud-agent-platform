/**
 * Visual-verification manifest (console-design-pixel-merge tasks 8.1/8.2).
 *
 * THE single catalog the suite is generated from: every merged console page ×
 * both breakpoints, each mapped to its design-baseline HTML file and carrying
 * its RECORDED, BLOCKING diff threshold (`maxDiffPixelRatio` — the fraction of
 * differing pixels Playwright tolerates before the comparison FAILS).
 *
 * ── Baseline source path ───────────────────────────────────────────────────
 * Baselines are NOT checked-in PNGs. They are re-captured on every suite run
 * from the FROZEN finalized baseline (the 2026-06-19 snapshot — a static in-repo
 * oracle, design.md D2), kept at the STABLE location below — NOT in an
 * `openspec/changes/<name>/` directory, which is moved on archive and would
 * break the gate (stabilize-visual-baseline-path):
 *
 *   apps/web/e2e/design-baseline/
 *
 * served locally by `e2e/serve-design-baseline.mjs` and screenshotted by the
 * `design-baseline` Playwright project (baseline.capture.ts) into
 * `e2e/visual/__screenshots__/` (gitignored) — in the SAME browser, viewport,
 * scale factor, and reduced-motion setting the app is captured under, which
 * removes platform font/antialiasing variance from the comparison.
 *
 * ── Regeneration procedure ─────────────────────────────────────────────────
 * Nothing to do: `pnpm test:visual` always regenerates baselines first (the
 * comparison project declares the capture project as a Playwright dependency).
 * If the design prototype changes, the next run compares against it
 * automatically. To RE-CALIBRATE the recorded thresholds after an intentional
 * design change, run the measure mode — `VV_MEASURE=1 pnpm test:visual` — which
 * pins every threshold to 0 so each comparison fails and prints its ACTUAL
 * diff ratio, then record (measured + headroom) below.
 *
 * ── Threshold semantics (task 8.2) ─────────────────────────────────────────
 * The app intentionally renders DIFFERENT DATA than the prototype's sample
 * copy (typed mock fixtures vs hand-written sample text), so thresholds are
 * calibrated empirically per page/breakpoint (design.md "Open Questions"):
 * measured ratio at merge time + headroom. They are a REGRESSION TRIPWIRE
 * against layout/structure drift, not a pixel-identity claim. A page exceeding
 * its recorded threshold FAILS the suite — blocking gate, not a warning.
 *
 * Calibration record (VV_MEASURE=1 run at merge time, 2026-06-11, chromium
 * 1.60, deviceScaleFactor 1; ratio = differing pixels / viewport pixels):
 *
 *   page          desktop(1440×900)   mobile(820×1180)   recorded threshold
 *   landing       0.0120              0.0123             0.025 / 0.025
 *   login         0.0327              0.0384             0.050 / 0.055
 *   dashboard     0.0267              0.0281             0.045 / 0.045
 *   tasks-new     0.0568              0.0271             0.075 / 0.045
 *   session       0.0377              0.0500             0.055 / 0.065
 *   repositories  0.0126              0.0169             0.030 / 0.035
 *   history       0.0263              0.0303             0.045 / 0.050
 *   settings      0.0232              0.0219             0.040 / 0.040
 *
 * Re-validation (session-cockpit-redesign, VV_MEASURE=1, 2026-06-14): the design
 * baseline was rebuilt = the pixel-merge archive + the 228px sidebar accent
 * delta + the cockpit `session.html` (running-state, mock-fixture content) +
 * `session-cockpit.css` (the session/terminal cockpit styles overlaid on the
 * archive platform.css, with the terminal pinned to the app's `min-h` model so
 * the masked terminal aligns). All UNTOUCHED pages re-measured at their original
 * actuals (≤ a few 1e-4 drift), so their thresholds are unchanged. The session
 * page re-measured 0.0388 / 0.0491 against the fresh cockpit baseline — within
 * the unchanged 0.055 / 0.065 — and its mask moved to the whole terminal window
 * (the old header connection pill is gone). All 16 comparisons pass.
 */

export interface Breakpoint {
  id: "desktop" | "mobile";
  width: number;
  height: number;
}

/**
 * Desktop + the recorded ≤820px mobile convention (spec "Mobile breakpoint
 * convention is recorded at 820px": mobile rules engage AT 820px).
 */
export const BREAKPOINTS: readonly Breakpoint[] = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 820, height: 1180 },
] as const;

export interface VisualPage {
  /** Stable id — also the snapshot filename stem (`<id>-<breakpoint>.png`). */
  id: string;
  /** App route under test. */
  appPath: string;
  /** Design-baseline HTML file (path on the baseline static server). */
  designPath: string;
  /** Whether the page sits behind the `_app` auth gate (mock gate seeded). */
  authed: boolean;
  /**
   * RECORDED blocking thresholds, per breakpoint (`maxDiffPixelRatio`).
   * Calibrated empirically via `VV_MEASURE=1` (see header).
   */
  maxDiffPixelRatio: { desktop: number; mobile: number };
  /** Regions masked in the APP capture (dynamic/equivalence-excluded). */
  appMask?: string[];
  /** The SAME regions masked in the DESIGN capture. */
  designMask?: string[];
  /** Selector that must be visible before the app capture (data rendered). */
  readySelector?: string;
}

/**
 * Mock fixture task `a` (running) — the session page under test. A FIXED mock
 * id so the session screenshot is deterministic.
 */
export const SESSION_TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/**
 * The transcript timeline fixture (wire-transcript-real-data): the COMPLETED mock
 * task whose `mockSessionHistory` resolves to the `available` transcript (system
 * milestones + commentary + tool diffstat + final answer). `SESSION_TASK_ID`
 * (task `a`, running) buckets to an EMPTY history, so the dedicated transcript
 * route must point at this completed id to render the timeline under test.
 */
export const TRANSCRIPT_TASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** Measure mode: pin thresholds to 0 so every test reports its actual ratio. */
const MEASURE = process.env.VV_MEASURE === "1";

function ratio(desktop: number, mobile: number): VisualPage["maxDiffPixelRatio"] {
  return MEASURE ? { desktop: 0, mobile: 0 } : { desktop, mobile };
}

/**
 * Every merged console page (spec: "Required per-page pixel comparison") —
 * no page or breakpoint skipped.
 *
 * Masked regions (spec allows masking to stabilize dynamic regions):
 *  - landing runner-capsule: the looping demo on BOTH sides (also frozen by
 *    `reducedMotion: "reduce"` — masked as belt-and-braces, task 8.1).
 *  - session terminal: the live xterm surface — raw terminal bytes are not a
 *    design-comparable region (mock mode has no socket; the design shows
 *    hand-written sample output).
 */
export const PAGES: readonly VisualPage[] = [
  {
    id: "landing",
    appPath: "/",
    designPath: "/index.html",
    authed: false,
    maxDiffPixelRatio: ratio(0.025, 0.025),
    appMask: ['[data-slot="runner-capsule"]'],
    designMask: ["runner-capsule-demo"],
    readySelector: '[data-slot="runner-capsule"]',
  },
  {
    id: "login",
    appPath: "/login",
    designPath: "/login.html",
    authed: false,
    maxDiffPixelRatio: ratio(0.05, 0.055),
  },
  {
    id: "dashboard",
    appPath: "/dashboard",
    designPath: "/screens/dashboard.html",
    authed: true,
    // Re-calibrated vs the finalized baseline (VV_MEASURE 0.06/0.05 + headroom):
    // residual is the pool sample-data delta (app 4/5 mock runners vs baseline
    // 7/10) + capacity-meter style; structure matches dashboard.html.
    maxDiffPixelRatio: ratio(0.075, 0.065),
    readySelector: 'a[href^="/tasks/"]',
  },
  {
    id: "tasks-new",
    appPath: "/tasks/new",
    designPath: "/screens/queue.html",
    authed: true,
    // Re-calibrated vs the finalized baseline (VV_MEASURE 0.11/0.05 + headroom).
    // Content is faithful (guardrail/执行边界 copy now sandbox-trust; same fields
    // + 命令预览 + 执行边界). The desktop residual is the highest in the suite:
    // an accumulating vertical-density delta down the long form (per-field spacing
    // vs queue.html) + sample-data text. FUTURE: tighten by matching field gaps to
    // queue.html `.field` rhythm, then re-lower the desktop threshold.
    maxDiffPixelRatio: ratio(0.13, 0.065),
    readySelector: "form",
  },
  {
    id: "session",
    appPath: `/tasks/${SESSION_TASK_ID}`,
    designPath: "/screens/session.html",
    authed: true,
    // Re-calibrated vs the finalized baseline (VV_MEASURE 0.07/0.04 + headroom):
    // header is faithful (crumb/title/state/2-line prompt clamp/tags/停止);
    // residual is the masked-terminal edge + prompt sample-text delta.
    maxDiffPixelRatio: ratio(0.085, 0.06),
    // The whole dark terminal window (head + PTY + statusline) is dynamic/masked
    // in both captures; the cockpit dropped the header connection pill, so the
    // old `[data-connection]` / `.session-actions .status-pill` masks are gone.
    appMask: ["article.bg-terminal-bg"],
    designMask: ["section.terminal-shell"],
    readySelector: "article.bg-terminal-bg",
  },
  {
    id: "repositories",
    appPath: "/repositories",
    designPath: "/screens/agents.html",
    authed: true,
    // Re-calibrated vs the finalized baseline (VV_MEASURE 0.03/0.04 + headroom).
    maxDiffPixelRatio: ratio(0.05, 0.055),
  },
  {
    id: "history",
    appPath: "/history",
    designPath: "/screens/history.html",
    authed: true,
    // Re-calibrated for the finalized baseline (pixel-restore-console-to-od Track
    // 9): history is now a task-row list matching history.html; the residual diff
    // is the legitimate sample-data delta (the app's 5 mock tasks vs the
    // baseline's 7 hand-written rows, repo-name vs raw-id, clock format) —
    // VV_MEASURE desktop 0.05 / mobile 0.07 + headroom; a structural regression
    // still trips it.
    maxDiffPixelRatio: ratio(0.065, 0.085),
  },
  {
    id: "settings",
    appPath: "/settings",
    designPath: "/screens/settings.html",
    authed: true,
    // Re-calibrated vs the finalized baseline (VV_MEASURE 0.04/0.04 + headroom).
    // NOTE: the Claude Code credential group (Track 10.2) is not yet in the app
    // settings; the residual stays low because the codex section dominates. When
    // 10.2 lands, re-measure.
    maxDiffPixelRatio: ratio(0.055, 0.055),
  },
  // ── Transcript timeline (wire-transcript-real-data): the dedicated
  // `/tasks/:id/transcript` route now renders REAL `mockSessionHistory` data
  // (was a hardcoded sample). Pointed at the COMPLETED fixture so the `available`
  // timeline renders; FIXED mock timestamps keep the time gutter deterministic. ──
  {
    id: "transcript",
    appPath: `/tasks/${TRANSCRIPT_TASK_ID}/transcript`,
    designPath: "/screens/transcript.html",
    authed: true,
    // MEASURED (VV_MEASURE, wire-transcript-real-data) desktop 0.03 / mobile 0.06
    // + headroom: the timeline is faithful (typed event rows + green answer card);
    // residual is the mock-transcript text/content delta vs the hand-written
    // transcript.html. A structural regression still trips these thresholds.
    maxDiffPixelRatio: ratio(0.06, 0.08),
    // Wait for the final-answer card so capture fires after the timeline renders.
    readySelector: ".bg-success-soft",
  },
  // ── /api Playground (add-api-playground, Track 5 pixel-baseline). The app
  // DEFAULT-selects `POST /v1/tasks` with its sample body and an EMPTY response
  // (mock mode has no backend — design D6), while the prototype `api.html` shows
  // a FILLED response (a `201 Created` pill + a `142 ms · 312 B` timing/size meta
  // + a sample JSON body). The timing/size meta is genuinely DYNAMIC, so it is
  // masked on the design side (`.api-res-meta`); the empty-vs-filled response
  // card is a recorded design-vs-app delta absorbed by the threshold (the same
  // sample-copy-vs-fixture pattern as login / tasks-new), not a structural
  // drift. The rail + request editor (the stable structure this gate protects)
  // are compared unmasked. The `readySelector` waits for the rail's first
  // endpoint row so the capture happens after the page has rendered. ──
  {
    id: "api",
    appPath: "/api",
    designPath: "/screens/api.html",
    authed: true,
    // Recorded threshold (the landing-pixel pattern). MEASURED on a clean
    // full-sweep run (add-api-playground Track 5): `api @ desktop` diffs at
    // ratio 0.03 (the documented empty-vs-filled response-card delta), well
    // under 0.06; both breakpoints pass green at 0.06 (measured + ~2× headroom).
    maxDiffPixelRatio: ratio(0.06, 0.06),
    // Timing/size meta is dynamic (the app's empty render has no meta at all);
    // mask it on the design baseline so it never drives the diff.
    designMask: [".api-res-meta"],
    // Wait for the rail's first endpoint row before capturing. `aria-label`
    // "接口集合" is the rail's stable, semantic handle on BOTH sides (the app
    // `<aside aria-label="接口集合">` and the prototype `.api-rail`), so the app
    // capture only fires once the catalog has rendered.
    readySelector: 'aside[aria-label="接口集合"] button',
  },
] as const;

/** Snapshot name for a page × breakpoint cell — shared by capture + compare. */
export function snapshotName(pageId: string, breakpointId: string): string {
  return `${pageId}-${breakpointId}.png`;
}
