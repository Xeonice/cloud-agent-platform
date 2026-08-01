/**
 * The test-runtime construction bridge behind the harness-maker seam.
 *
 * The two shipped runtime implementations (and the transcript parser registry)
 * live in `apps/api` today, so the suite constructs them the way the repo's own
 * `.test.mjs` harnesses do: compile the REAL leaf sources with `tsc` against
 * the api's own tsconfig baseline, then import the emitted modules. This keeps
 * the extraction direction honest — the PACKAGE owns every assertion and its
 * compile graph carries no `apps/api` import (`pnpm typecheck` proves it);
 * only this test-time bridge, injected through the typed `RuntimeSeedBridge`
 * seam, reaches the api's runtime constructors. When the runtimes move into a
 * workspace package, only this file changes.
 *
 * The emit lands in a throwaway dot-dir INSIDE `apps/api` (the seed harnesses'
 * own convention) so Node resolves `@cap-console/*` through the api's
 * node_modules and the emitted CommonJS loads under the api's `type` setting.
 * It is removed in `dispose()`.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/runtime-conformance` */
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const API_ROOT = join(REPO_ROOT, 'apps', 'api');

/** Resolve the repo `tsc`, walking up for a worktree without its own install. */
function resolveTsc() {
  let dir = REPO_ROOT;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
}

/**
 * Rewrite `require("@/x")` in emitted JS to a relative path — `tsc` resolves
 * the api's path alias for type checking but emits the specifier unchanged.
 * (Same rewrite as `apps/api/src/testing/compile-single-source.mjs`.)
 */
function rewriteAliasRequires(outDir) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const before = readFileSync(abs, 'utf8');
      const after = before.replace(/require\("@\/([^"]+)"\)/g, (_match, target) => {
        let rel = relative(dirname(abs), join(outDir, target)).replace(/\\/g, '/');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        return `require("${rel}")`;
      });
      if (after !== before) writeFileSync(abs, after);
    }
  };
  walk(outDir);
}

function findEmitted(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findEmitted(abs, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return abs;
    }
  }
  return null;
}

/**
 * Compile the runtime + parser leaf sources once and return the typed
 * `RuntimeSeedBridge` the harness makers consume, plus a `dispose()` that
 * removes the throwaway emit.
 */
export async function loadApiRuntimeSeedBridge() {
  const outDir = mkdtempSync(join(API_ROOT, '.runtime-conformance-seed-'));
  const configDir = mkdtempSync(join(API_ROOT, '.runtime-conformance-tsconfig-'));
  try {
    const config = {
      extends: join(API_ROOT, 'tsconfig.json'),
      compilerOptions: {
        outDir,
        noEmitOnError: true,
        rootDir: join(API_ROOT, 'src'),
        composite: false,
        incremental: false,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
      },
      // Neutralize the api tsconfig's `include: src/**` (a derived `files`
      // list UNIONS with an inherited `include`, which would drag the whole
      // api — Nest, Prisma client and all — into this leaf compile).
      include: [],
      files: [
        join(API_ROOT, 'src', 'agent-runtime', 'codex-runtime.ts'),
        join(API_ROOT, 'src', 'agent-runtime', 'claude-code-runtime.ts'),
        join(API_ROOT, 'src', 'sandbox', 'parse-transcript.ts'),
      ],
    };
    const configPath = join(configDir, 'tsconfig.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    execFileSync(resolveTsc(), ['-p', configPath], {
      cwd: API_ROOT,
      stdio: 'pipe',
    });
    rewriteAliasRequires(outDir);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }

  const codexJs = findEmitted(outDir, 'codex-runtime.js');
  const claudeJs = findEmitted(outDir, 'claude-code-runtime.js');
  const parseJs = findEmitted(outDir, 'parse-transcript.js');
  if (!codexJs || !claudeJs || !parseJs) {
    rmSync(outDir, { recursive: true, force: true });
    throw new Error(`compiled runtime seed modules not found under ${outDir}`);
  }

  const { CodexRuntime } = await import(pathToFileURL(codexJs).href);
  const { ClaudeCodeRuntime } = await import(pathToFileURL(claudeJs).href);
  const { parseTranscript } = await import(pathToFileURL(parseJs).href);

  /** @type {import('../../dist/index.js').RuntimeSeedBridge} */
  const bridge = {
    async constructRuntime(id) {
      if (id === 'codex') return new CodexRuntime();
      if (id === 'claude-code') return new ClaudeCodeRuntime();
      throw new Error(`no seed constructor for runtime "${id}"`);
    },
    parseTranscript(jsonl, format) {
      return parseTranscript(jsonl, format);
    },
  };

  return {
    bridge,
    dispose() {
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}
