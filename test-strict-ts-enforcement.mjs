/**
 * Minimal test: "Strict-TypeScript enforced in three places"
 *
 * Point 1 – packages/tsconfig/base.json has compilerOptions.strict === true
 * Point 2 – .claude/settings.json defines a PostToolUse hook that runs
 *            typecheck AND lint on edited .ts/.tsx files
 * Point 3 – .husky/pre-commit invokes lint-staged
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

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

// ─── Point 1: base tsconfig strict: true ─────────────────────────────────────
console.log("\nPoint 1: packages/tsconfig/base.json has strict: true");
{
  const path = resolve(ROOT, "packages/tsconfig/base.json");
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    assert("base.json is readable and valid JSON", false, String(e));
    cfg = null;
  }
  if (cfg !== null) {
    assert(
      'compilerOptions.strict === true',
      cfg?.compilerOptions?.strict === true
    );
  }
}

// ─── Point 2: .claude/settings.json defines TS/ESLint hook ───────────────────
console.log("\nPoint 2: .claude/settings.json has PostToolUse hook for .ts/.tsx files");
{
  const path = resolve(ROOT, ".claude/settings.json");
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    assert(".claude/settings.json is readable and valid JSON", false, String(e));
    cfg = null;
  }

  if (cfg !== null) {
    const postToolUse = cfg?.hooks?.PostToolUse;
    assert(
      "hooks.PostToolUse array exists",
      Array.isArray(postToolUse) && postToolUse.length > 0
    );

    // Find a hook entry that targets Edit|Write (or MultiEdit)
    const editHookEntry = Array.isArray(postToolUse)
      ? postToolUse.find(
          (h) =>
            typeof h.matcher === "string" &&
            (h.matcher.includes("Edit") || h.matcher.includes("Write"))
        )
      : null;

    assert(
      "A hook with matcher covering Edit/Write exists",
      editHookEntry !== null && editHookEntry !== undefined
    );

    // Check that the hook command references a script handling typecheck/lint
    if (editHookEntry) {
      const commands = (editHookEntry.hooks ?? [])
        .flatMap((h) => (h.command ? [h.command] : []));
      const hasTypecheckOrLint = commands.some(
        (cmd) => cmd.includes("typecheck") || cmd.includes("lint")
      );
      assert(
        "Hook command references typecheck/lint script",
        hasTypecheckOrLint,
        `commands found: ${commands.join(", ")}`
      );

      // Also verify the referenced shell script exists and mentions both eslint and typecheck
      const scriptMatch = commands
        .join(" ")
        .match(/["']?([^\s"']*typecheck-lint[^\s"']*)["']?/);
      if (scriptMatch) {
        const scriptPath = scriptMatch[1].replace(
          "$CLAUDE_PROJECT_DIR",
          ROOT
        );
        try {
          const scriptContent = readFileSync(scriptPath, "utf8");
          assert(
            "Hook script mentions 'eslint'",
            scriptContent.includes("eslint")
          );
          assert(
            "Hook script mentions 'typecheck'",
            scriptContent.includes("typecheck")
          );
          assert(
            "Hook script filters on .ts/.tsx files",
            scriptContent.includes(".ts") || scriptContent.includes(".tsx")
          );
        } catch (e) {
          assert("Hook script file is readable", false, String(e));
        }
      } else {
        // The command itself might directly run typecheck+lint without a separate script
        assert("Hook command or script is identifiable", false,
          "Could not locate a typecheck-lint script reference in the hook command");
      }
    }
  }
}

// ─── Point 3: .husky/pre-commit invokes lint-staged ──────────────────────────
console.log("\nPoint 3: .husky/pre-commit invokes lint-staged");
{
  const path = resolve(ROOT, ".husky/pre-commit");
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    assert(".husky/pre-commit is readable", false, String(e));
    content = null;
  }

  if (content !== null) {
    assert(
      ".husky/pre-commit invokes lint-staged",
      content.includes("lint-staged"),
      `file content: ${content.trim()}`
    );
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("ALL TESTS PASSED — 'Strict-TypeScript enforced in three places' requirement is satisfied.");
  process.exit(0);
} else {
  console.error("SOME TESTS FAILED — requirement is NOT fully satisfied.");
  process.exit(1);
}
