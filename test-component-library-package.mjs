/**
 * Minimal test: "Maintained component library package" requirement.
 *
 * Checks:
 *  1. @cap/ui package.json declares the correct package name and entry points.
 *  2. The built dist/index.js exports all required symbols.
 *  3. The built dist/index.d.ts exposes the same public API.
 *  4. Every expected dist file exists (no stale/missing build artifacts).
 *  5. The cn() utility merges class names correctly at runtime.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(__dirname, "packages/ui");

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// ── 1. package.json structure ────────────────────────────────────────────────
console.log("\n[1] package.json metadata");
const pkg = JSON.parse(
  fs.readFileSync(path.join(UI_ROOT, "package.json"), "utf8"),
);
assert('name is "@cap/ui"', pkg.name === "@cap/ui");
assert("main points to dist/index.js", pkg.main === "./dist/index.js");
assert("types points to dist/index.d.ts", pkg.types === "./dist/index.d.ts");
assert(
  'exports["."].import is dist/index.js',
  pkg.exports?.["."]?.import === "./dist/index.js",
);
assert(
  'exports["."].types is dist/index.d.ts',
  pkg.exports?.["."]?.types === "./dist/index.d.ts",
);
assert(
  'exports["./styles.css"] is src/styles.css',
  pkg.exports?.["./styles.css"] === "./src/styles.css",
);

// ── 2. dist artifacts exist ───────────────────────────────────────────────────
console.log("\n[2] built dist artifacts present");
const requiredDist = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/lib/cn.js",
  "dist/lib/cn.d.ts",
  "dist/components/button.js",
  "dist/components/button.d.ts",
  "dist/components/card.js",
  "dist/components/card.d.ts",
  "dist/components/badge.js",
  "dist/components/badge.d.ts",
  "dist/terminal/terminal.js",
  "dist/terminal/terminal.d.ts",
];
for (const rel of requiredDist) {
  assert(
    `${rel} exists`,
    fs.existsSync(path.join(UI_ROOT, rel)),
    `missing: ${path.join(UI_ROOT, rel)}`,
  );
}

// ── 3. dist/index.js exports expected symbols ─────────────────────────────────
console.log("\n[3] dist/index.js exports expected symbols");
const indexJs = fs.readFileSync(path.join(UI_ROOT, "dist/index.js"), "utf8");

const expectedExports = [
  "UI_PACKAGE",
  "cn",
  "Button",
  "buttonVariants",
  "Card",
  "CardHeader",
  "CardTitle",
  "CardDescription",
  "CardContent",
  "CardFooter",
  "Badge",
  "badgeVariants",
  "statusBadgeVariant",
  "Terminal",
];
for (const sym of expectedExports) {
  assert(
    `index.js re-exports "${sym}"`,
    indexJs.includes(sym),
    `"${sym}" not found in dist/index.js`,
  );
}

// ── 4. dist/index.d.ts declares the same public API ──────────────────────────
console.log("\n[4] dist/index.d.ts type declarations");
const indexDts = fs.readFileSync(path.join(UI_ROOT, "dist/index.d.ts"), "utf8");
for (const sym of expectedExports) {
  assert(
    `index.d.ts mentions "${sym}"`,
    indexDts.includes(sym),
    `"${sym}" not in dist/index.d.ts`,
  );
}

// ── 5. cn() runtime behaviour ─────────────────────────────────────────────────
console.log("\n[5] cn() runtime (clsx + tailwind-merge)");
// Import the built JS directly (no React renderer needed for this utility)
const { cn } = await import(
  path.join(UI_ROOT, "dist/lib/cn.js")
);
assert(
  "cn() merges two plain classes",
  cn("foo", "bar") === "foo bar",
  `got: "${cn("foo", "bar")}"`,
);
assert(
  "cn() handles falsy values",
  cn("foo", undefined, false, null, "bar") === "foo bar",
  `got: "${cn("foo", undefined, false, null, "bar")}"`,
);
// tailwind-merge: last conflicting tw class wins
assert(
  "cn() deduplicates conflicting Tailwind utilities",
  cn("p-4", "p-8") === "p-8",
  `got: "${cn("p-4", "p-8")}"`,
);
assert(
  "cn() merges conditional object syntax",
  cn({ "text-red-500": true, "text-blue-500": false }) === "text-red-500",
  `got: "${cn({ "text-red-500": true, "text-blue-500": false })}"`,
);

// ── 6. statusBadgeVariant() correctness ───────────────────────────────────────
console.log("\n[6] statusBadgeVariant() maps TaskStatus → BadgeVariant");
const { statusBadgeVariant } = await import(
  path.join(UI_ROOT, "dist/components/badge.js")
);
const statusMap = [
  ["running",            "default"],
  ["awaiting_input",     "warning"],
  ["pending",            "secondary"],
  ["completed",          "success"],
  ["failed",             "destructive"],
  ["agent_failed_to_start", "destructive"],
];
for (const [status, expected] of statusMap) {
  const got = statusBadgeVariant(status);
  assert(
    `statusBadgeVariant("${status}") === "${expected}"`,
    got === expected,
    `got "${got}"`,
  );
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
