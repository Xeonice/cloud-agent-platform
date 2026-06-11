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
 * from the design prototype ("living baselines", design.md D7):
 *
 *   openspec/changes/console-design-pixel-merge/design-baseline/
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
    maxDiffPixelRatio: ratio(0.045, 0.045),
    readySelector: 'a[href^="/tasks/"]',
  },
  {
    id: "tasks-new",
    appPath: "/tasks/new",
    designPath: "/screens/queue.html",
    authed: true,
    maxDiffPixelRatio: ratio(0.075, 0.045),
    readySelector: "form",
  },
  {
    id: "session",
    appPath: `/tasks/${SESSION_TASK_ID}`,
    designPath: "/screens/session.html",
    authed: true,
    maxDiffPixelRatio: ratio(0.055, 0.065),
    appMask: ["article.bg-terminal-bg", "[data-connection]"],
    designMask: ["section.terminal-shell", ".session-actions .status-pill"],
    readySelector: "article.bg-terminal-bg",
  },
  {
    id: "repositories",
    appPath: "/repositories",
    designPath: "/screens/agents.html",
    authed: true,
    maxDiffPixelRatio: ratio(0.03, 0.035),
  },
  {
    id: "history",
    appPath: "/history",
    designPath: "/screens/history.html",
    authed: true,
    maxDiffPixelRatio: ratio(0.045, 0.05),
  },
  {
    id: "settings",
    appPath: "/settings",
    designPath: "/screens/settings.html",
    authed: true,
    maxDiffPixelRatio: ratio(0.04, 0.04),
  },
] as const;

/** Snapshot name for a page × breakpoint cell — shared by capture + compare. */
export function snapshotName(pageId: string, breakpointId: string): string {
  return `${pageId}-${breakpointId}.png`;
}
