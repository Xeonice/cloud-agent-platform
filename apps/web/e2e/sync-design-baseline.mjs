/**
 * One-command re-sync of the in-repo design baseline from the Open Design (OD)
 * project (add-private-account-identity, visual-harness maintenance).
 *
 * WHY THIS EXISTS
 * ───────────────
 * The visual gate (`pnpm test:visual`) compares the app against a FROZEN in-repo
 * snapshot at `apps/web/e2e/design-baseline/`. That snapshot is a hand-curated
 * copy of the OD prototype project — so every change that edits a design page has
 * to remember to copy the updated HTML/CSS back into the baseline, or the gate
 * silently drifts (it has: e.g. the forge-credentials card shipped in the app but
 * was never mirrored into `design-baseline/screens/settings.html`). This script
 * makes that re-sync ONE command instead of N manual copies, so "I changed a
 * design page" → "re-run sync" → "re-measure thresholds" is a repeatable loop.
 *
 * USAGE
 * ─────
 *   node e2e/sync-design-baseline.mjs            # copy OD → design-baseline
 *   node e2e/sync-design-baseline.mjs --check    # report drift, copy nothing (CI-friendly)
 *   OD_PROJECT_DIR=/abs/path node e2e/sync-design-baseline.mjs   # override OD location
 *
 * After a real sync, RE-MEASURE the thresholds for any changed/added page:
 *   VV_MEASURE=1 pnpm test:visual   # prints each page's actual diff ratio
 * then record (measured + headroom) in e2e/visual/manifest.ts and run the suite
 * green.
 *
 * NOTE: the OD project lives OUTSIDE the repo (a local OD workspace), so this is a
 * developer convenience, not a CI step — the committed `design-baseline/` remains
 * the portable oracle CI screenshots. `--check` only compares; it never needs OD
 * to be writable.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = path.resolve(here, "design-baseline");

/** The OD project that authors these designs ("OpenSpec Agent System", 680d21c4). */
const DEFAULT_OD_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Open Design/namespaces/release-stable/data/projects/680d21c4-3ec0-4528-b645-c84a95fdfff8",
);
const OD_DIR = process.env.OD_PROJECT_DIR ?? DEFAULT_OD_DIR;

/**
 * The curated file set the baseline mirrors (OD-relative === baseline-relative).
 * Pages NOT screenshotted by the suite are intentionally excluded; add a page
 * here AND to e2e/visual/manifest.ts when the suite starts covering it.
 */
const FILES = [
  "index.html",
  "login.html",
  "css/platform.css",
  "css/responsive.css",
  "js/platform.js",
  "screens/dashboard.html",
  "screens/agents.html",
  "screens/history.html",
  "screens/api.html",
  "screens/queue.html",
  "screens/session.html",
  "screens/settings.html",
  "screens/transcript.html",
  "screens/accounts.html",
];

const checkOnly = process.argv.includes("--check");

async function readOrNull(file) {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

const run = async () => {
  let copied = 0;
  let drifted = 0;
  let missing = 0;

  for (const rel of FILES) {
    const src = path.join(OD_DIR, rel);
    const dst = path.join(BASELINE_DIR, rel);
    const srcBuf = await readOrNull(src);
    if (srcBuf === null) {
      console.warn(`  MISSING in OD   ${rel}`);
      missing += 1;
      continue;
    }
    const dstBuf = await readOrNull(dst);
    const same = dstBuf !== null && dstBuf.equals(srcBuf);
    if (same) continue;
    drifted += 1;
    if (checkOnly) {
      console.log(`  DRIFT           ${rel}`);
      continue;
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, srcBuf);
    console.log(`  synced          ${rel}`);
    copied += 1;
  }

  console.log(`\n${"─".repeat(48)}`);
  console.log(`OD: ${OD_DIR}`);
  if (checkOnly) {
    console.log(`drift: ${drifted} file(s) differ, ${missing} missing in OD`);
    if (drifted > 0) {
      console.log("Run without --check to re-sync, then re-measure thresholds.");
      process.exit(1);
    }
    console.log("baseline is in sync with OD.");
  } else {
    console.log(`synced ${copied} file(s); ${missing} missing in OD`);
    if (copied > 0) {
      console.log(
        "Next: VV_MEASURE=1 pnpm test:visual → record thresholds in manifest.ts → pnpm test:visual (green).",
      );
    }
  }
};

void run();
