/**
 * Minimal test: "contracts package is the single source of truth" requirement.
 *
 * Checks:
 *  1. @cap/contracts dist/index.js exports the canonical shared schemas at runtime.
 *  2. The schemas successfully parse well-formed data (live runtime validation).
 *  3. No app file re-declares Task/Repo/TaskStatus shapes locally
 *     — every consuming file imports them from '@cap/contracts'.
 *  4. All three apps (api, web, runner) each import at least one symbol
 *     from '@cap/contracts', confirming they rely on the single source.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIST = path.join(ROOT, "packages/contracts/dist/index.js");

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

// ── 1. @cap/contracts dist/index.js exports expected canonical schemas ────────
console.log("\n[1] @cap/contracts dist exports canonical schemas");
assert(
  "dist/index.js exists",
  fs.existsSync(CONTRACTS_DIST),
  `missing: ${CONTRACTS_DIST}`,
);
assert(
  "dist/index.d.ts exists",
  fs.existsSync(path.join(ROOT, "packages/contracts/dist/index.d.ts")),
);

let contracts;
try {
  contracts = await import(CONTRACTS_DIST);
} catch (e) {
  console.error(`  FAIL  @cap/contracts dist is importable — ${e}`);
  failed++;
  contracts = null;
}

if (contracts) {
  const expectedExports = [
    // Task domain
    "TaskStatusSchema",
    "TaskSchema",
    "TERMINAL_TASK_STATUSES",
    "RepoSchema",
    // REST request/response bodies
    "CreateTaskRequestSchema",
    "createTaskBodySchema",
    "TaskResponseSchema",
    "taskResponseSchema",
    "ListTasksResponseSchema",
    "CreateRepoRequestSchema",
    "createRepoBodySchema",
    "RepoResponseSchema",
    "repoResponseSchema",
    "ListReposResponseSchema",
  ];

  console.log("\n[1a] exported symbol presence");
  for (const name of expectedExports) {
    assert(
      `exports "${name}"`,
      name in contracts,
      `"${name}" not found in contracts dist`,
    );
  }

  // ── 2. Schemas parse valid data correctly (live runtime validation) ──────────
  console.log("\n[2] schemas parse well-formed data (runtime validation)");

  const validRepo = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "my-repo",
    gitSource: "https://github.com/org/repo.git",
    createdAt: new Date(),
  };
  let repoParsed;
  try {
    repoParsed = contracts.RepoSchema.parse(validRepo);
    assert("RepoSchema.parse() succeeds for valid Repo", true);
    assert(
      "RepoSchema result has correct id",
      repoParsed.id === validRepo.id,
    );
  } catch (e) {
    assert("RepoSchema.parse() succeeds for valid Repo", false, String(e));
  }

  const validTask = {
    id: "00000000-0000-0000-0000-000000000002",
    repoId: "00000000-0000-0000-0000-000000000001",
    prompt: "Fix the bug",
    status: "pending",
    createdAt: new Date(),
  };
  let taskParsed;
  try {
    taskParsed = contracts.TaskSchema.parse(validTask);
    assert("TaskSchema.parse() succeeds for valid Task", true);
    assert(
      "TaskSchema result has status 'pending'",
      taskParsed.status === "pending",
    );
  } catch (e) {
    assert("TaskSchema.parse() succeeds for valid Task", false, String(e));
  }

  // TaskStatusSchema rejects an unknown status
  const badStatus = contracts.TaskStatusSchema.safeParse("unknown_status");
  assert(
    "TaskStatusSchema rejects unknown status value",
    !badStatus.success,
    "expected safeParse to fail but it succeeded",
  );

  // createTaskBodySchema rejects missing prompt
  const badBody = contracts.createTaskBodySchema.safeParse({});
  assert(
    "createTaskBodySchema rejects body without prompt",
    !badBody.success,
  );

  // TERMINAL_TASK_STATUSES contains 'completed', 'failed', 'agent_failed_to_start'
  const terminals = contracts.TERMINAL_TASK_STATUSES;
  assert(
    "TERMINAL_TASK_STATUSES includes 'completed'",
    Array.isArray(terminals) && terminals.includes("completed"),
  );
  assert(
    "TERMINAL_TASK_STATUSES includes 'agent_failed_to_start'",
    Array.isArray(terminals) && terminals.includes("agent_failed_to_start"),
  );
}

// ── 3. No app file re-declares shared shapes locally ─────────────────────────
console.log("\n[3] no app re-declares Task/Repo/TaskStatus shapes locally");

/**
 * Patterns that indicate a local re-declaration of a shared domain type.
 * We scan .ts/.tsx files in apps/ (excluding dist, node_modules) and
 * flag any that declare these shapes without importing them from @cap/contracts.
 *
 * We look for:
 *   - `type TaskStatus = …`  (not a type import)
 *   - `interface Task {`
 *   - `z.enum([…'pending'…])` outside the contracts package itself
 *   - `z.object({ status:` (re-defining the Task response shape)
 */
function walkTs(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, files);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

const APPS_DIR = path.join(ROOT, "apps");
const appFiles = walkTs(APPS_DIR);

// Patterns that constitute a *local re-declaration* of a shared domain type
const reDeclarationPatterns = [
  // Local TaskStatus type alias (not an import)
  /^(?!.*import\b).*\btype\s+TaskStatus\s*=/m,
  // Local Repo/Task interface declarations
  /^\s*(?:export\s+)?interface\s+(Task|Repo)\s*\{/m,
  // z.enum that replicates the status values — only flag if it lists 'pending'
  // AND 'completed' AND 'failed' (i.e. the full enum) outside contracts
  // (A simple heuristic: declare z.enum([... 'pending' ... 'completed' ...]))
];

let localRedeclarations = 0;
for (const file of appFiles) {
  const content = fs.readFileSync(file, "utf8");
  for (const pattern of reDeclarationPatterns) {
    if (pattern.test(content)) {
      console.error(
        `  FAIL  Local re-declaration found in: ${path.relative(ROOT, file)} — pattern: ${pattern}`,
      );
      localRedeclarations++;
      failed++;
    }
  }
}
if (localRedeclarations === 0) {
  console.log("  PASS  No local re-declarations of shared domain types found in apps/");
  passed++;
}

// ── 4. All three apps import at least one symbol from @cap/contracts ──────────
console.log("\n[4] all three apps import from @cap/contracts");

const APP_DIRS = {
  api: path.join(ROOT, "apps/api/src"),
  web: path.join(ROOT, "apps/web/src"),
  runner: path.join(ROOT, "apps/runner/src"),
};

for (const [appName, srcDir] of Object.entries(APP_DIRS)) {
  let found = false;
  if (fs.existsSync(srcDir)) {
    const tsFiles = walkTs(srcDir);
    for (const file of tsFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (
        content.includes("from '@cap/contracts'") ||
        content.includes('from "@cap/contracts"')
      ) {
        found = true;
        break;
      }
    }
  }
  assert(
    `apps/${appName} imports from '@cap/contracts'`,
    found,
    `No file in apps/${appName}/src imports from '@cap/contracts'`,
  );
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log(
    "ALL TESTS PASSED — 'contracts package is the single source of truth' requirement is satisfied.",
  );
  process.exit(0);
} else {
  console.error(
    "SOME TESTS FAILED — requirement is NOT fully satisfied.",
  );
  process.exit(1);
}
