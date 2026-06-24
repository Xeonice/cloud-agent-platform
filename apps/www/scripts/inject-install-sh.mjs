/**
 * Build-time install.sh injection (one-line-installer spec / task 5.3).
 *
 * `public/install.sh` is the inspectable source-of-truth script and ships with
 * TEMPLATE MARKERS (`__CAP_REPO_URL__`, `__CAP_SITE_DOMAIN__`) so the committed
 * file is readable and the repo carries no hard-coded deploy domain. Next copies
 * `public/*` verbatim into the static export's `out/`. This post-build step
 * rewrites `out/install.sh` IN PLACE, replacing the markers with the real
 * build-time values so the PUBLISHED file (served at `https://<domain>/install.sh`)
 * contains literal values — never placeholders — per the spec scenario
 * "Repo URL and domain are resolved at build".
 *
 * Values come from the same build-time public env the site metadata uses
 * (`NEXT_PUBLIC_REPO_URL`, `NEXT_PUBLIC_SITE_URL`). If unset, the script's own
 * in-file fallbacks (the `case … __CAP_*__ )` arms) still apply at runtime, but
 * we additionally warn so a real deploy does not silently ship the source
 * defaults.
 */
import { readFile, writeFile, access, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(appRoot, "..", "..");
const outDir = path.join(appRoot, "out");
const outFile = path.join(outDir, "install.sh");
const rootIndex = path.join(outDir, "index.html");
// The prebuilt one-line installer (surface-quick-deploy-installer-on-www): the repo's
// scripts/quick-deploy.sh is the single source-of-truth — staged into the static export
// and marker-substituted here, NOT a second hand-maintained copy.
const quickDeploySrc = path.join(repoRoot, "scripts", "quick-deploy.sh");
const quickDeployOut = path.join(outDir, "quick-deploy.sh");
// docker-compose.prod.yml is served as a static asset so a site-hosted quick-deploy.sh
// run is self-contained (no GitHub-branch runtime dependency).
const composeSrc = path.join(repoRoot, "docker-compose.prod.yml");
const composeOut = path.join(outDir, "docker-compose.prod.yml");

// The locale-segmented root layout lives under app/[locale]/, so there is no
// top-level app/page.tsx and the export emits no out/index.html for `/`. Write a
// tiny redirect page so a bare `/` (on Vercel AND on any plain static host that
// serves the export directly) lands on the default locale. Vercel additionally
// gets a 308 redirect via vercel.json; this is the host-agnostic fallback.
const DEFAULT_LOCALE = "en";
const rootRedirectHtml = `<!doctype html>
<html lang="${DEFAULT_LOCALE}">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=/${DEFAULT_LOCALE}/" />
    <link rel="canonical" href="/${DEFAULT_LOCALE}/" />
    <title>cloud-agent-platform</title>
  </head>
  <body>
    <p>Redirecting to <a href="/${DEFAULT_LOCALE}/">/${DEFAULT_LOCALE}/</a>…</p>
    <script>
      location.replace("/${DEFAULT_LOCALE}/");
    </script>
  </body>
</html>
`;

/** Normalize a repo URL: ensure a trailing `.git` for the clone form. */
function cloneUrl(raw) {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\.git$/i.test(trimmed) ? trimmed : `${trimmed}.git`;
}

/** Bare host (no scheme, no trailing slash) for the served domain marker. */
function siteDomain(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

async function main() {
  try {
    await access(outDir);
  } catch {
    // No static export present (e.g. a non-export build): nothing to do.
    console.log(`[inject-install-sh] ${outDir} not found — skipping.`);
    return;
  }

  // Root redirect page (`/` → `/${DEFAULT_LOCALE}/`).
  await writeFile(rootIndex, rootRedirectHtml, "utf8");
  console.log(`[inject-install-sh] wrote ${rootIndex} (root → /${DEFAULT_LOCALE}/).`);

  try {
    await access(outFile);
  } catch {
    console.log(`[inject-install-sh] ${outFile} not found — skipping marker injection.`);
    return;
  }

  const repo = cloneUrl(process.env.NEXT_PUBLIC_REPO_URL);
  const domain = siteDomain(process.env.NEXT_PUBLIC_SITE_URL);

  if (!repo) {
    console.warn(
      "[inject-install-sh] NEXT_PUBLIC_REPO_URL is unset — published install.sh keeps its in-file repo fallback.",
    );
  }
  if (!domain) {
    console.warn(
      "[inject-install-sh] NEXT_PUBLIC_SITE_URL is unset — published install.sh keeps its in-file domain fallback.",
    );
  }

  // IMPORTANT: only substitute the two ASSIGNMENT lines
  //   REPO_URL="__CAP_REPO_URL__"   /   SITE_DOMAIN="__CAP_SITE_DOMAIN__"
  // and the `curl … https://__CAP_SITE_DOMAIN__/install.sh` comment. We must NOT
  // touch the marker in the fallback `case "$X" in __CAP_*__)` arms: those arms
  // exist so the in-file public defaults still apply when the markers were NOT
  // substituted (e.g. running the committed source copy). Replacing them too
  // would make the arm match the real injected value and clobber it.
  let script = await readFile(outFile, "utf8");
  if (repo) {
    script = script.replace(
      /^(REPO_URL=")__CAP_REPO_URL__(")$/m,
      `$1${repo}$2`,
    );
  }
  if (domain) {
    script = script.replace(
      /^(SITE_DOMAIN=")__CAP_SITE_DOMAIN__(")$/m,
      `$1${domain}$2`,
    );
    // The header comment's example `curl … https://<domain>/install.sh | sh`.
    script = script.replaceAll(
      "https://__CAP_SITE_DOMAIN__/install.sh",
      `https://${domain}/install.sh`,
    );
  }

  // When BOTH values were injected, the in-file fallback `case` guards are dead
  // code AND the only remaining `__CAP_*__` markers; strip them so the PUBLISHED
  // file carries zero placeholders (spec: "not placeholders"). If a value was
  // NOT injected, leave its guard in place so the runtime fallback still works.
  if (repo) {
    script = script.replace(
      /\ncase "\$REPO_URL" in\n\s*__CAP_REPO_URL__\)[^\n]*\nesac\n/,
      "\n",
    );
  }
  if (domain) {
    script = script.replace(
      /\ncase "\$SITE_DOMAIN" in\n\s*__CAP_SITE_DOMAIN__\)[^\n]*\nesac\n/,
      "\n",
    );
  }

  await writeFile(outFile, script, "utf8");

  console.log(
    `[inject-install-sh] wrote ${outFile} (repo=${repo || "fallback"}, domain=${domain || "fallback"}).`,
  );

  // Stage the prebuilt installer + its compose asset (surface-quick-deploy-installer-on-www).
  await stagePrebuiltInstaller(domain);
}

/**
 * Stage scripts/quick-deploy.sh + docker-compose.prod.yml into the static export and
 * substitute the compose-base marker. The published quick-deploy.sh defaults its fetch
 * base to the site so it pulls the site's own docker-compose.prod.yml; the committed
 * source keeps its raw-GitHub fallback (the `case … __CAP_COMPOSE_BASE__)` arm), which
 * we strip here only when the marker is actually substituted — exactly mirroring the
 * install.sh handling above.
 */
async function stagePrebuiltInstaller(domain) {
  // Copy the prod compose verbatim so a site-hosted `curl | sh` is self-contained.
  try {
    await copyFile(composeSrc, composeOut);
    console.log(`[inject-install-sh] wrote ${composeOut} (static compose asset).`);
  } catch (err) {
    console.warn(
      `[inject-install-sh] could not stage ${composeSrc} → ${composeOut}: ${err.message}`,
    );
  }

  let qd;
  try {
    qd = await readFile(quickDeploySrc, "utf8");
  } catch (err) {
    console.warn(
      `[inject-install-sh] ${quickDeploySrc} not found — skipping quick-deploy staging: ${err.message}`,
    );
    return;
  }

  // The compose fetch base for the SITE-served copy is the site origin itself.
  const composeBase = domain ? `https://${domain}` : "";
  if (composeBase) {
    // Substitute ONLY the assignment default `${CAP_RAW_BASE:-__CAP_COMPOSE_BASE__}`,
    // never the marker inside the fallback `case` arm (stripped below).
    qd = qd.replace(
      /(\$\{CAP_RAW_BASE:-)__CAP_COMPOSE_BASE__(\})/,
      `$1${composeBase}$2`,
    );
    // The fallback guard is now dead code and the only remaining marker — strip it so
    // the published file carries zero placeholders.
    qd = qd.replace(
      /\ncase "\$RAW_BASE" in\n\s*__CAP_COMPOSE_BASE__\)[^\n]*\nesac\n/,
      "\n",
    );
  } else {
    console.warn(
      "[inject-install-sh] NEXT_PUBLIC_SITE_URL is unset — published quick-deploy.sh keeps its in-file compose-base fallback.",
    );
  }

  // Assertion: when the site domain is provided, the published script must carry no
  // remaining placeholder (spec: "not placeholders").
  if (composeBase && qd.includes("__CAP_COMPOSE_BASE__")) {
    throw new Error(
      "quick-deploy.sh still contains __CAP_COMPOSE_BASE__ after substitution — marker injection failed",
    );
  }

  await writeFile(quickDeployOut, qd, "utf8");
  // Keep the executable bit so the served file is runnable when downloaded.
  console.log(
    `[inject-install-sh] wrote ${quickDeployOut} (compose-base=${composeBase || "fallback"}).`,
  );
}

main().catch((err) => {
  console.error("[inject-install-sh] failed:", err);
  process.exitCode = 1;
});
