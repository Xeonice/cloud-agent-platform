/**
 * Compile ONE `.ts` source (plus whatever it imports) for a `.mjs` test harness.
 *
 * Ten harnesses used to hand-write the same `tsc` invocation. That duplication
 * had two costs:
 *
 *   1. **Drift.** Only two of the ten passed `--strict`, while the project
 *      baseline is `strict: true` — so eight harnesses compiled real production
 *      source under weaker rules than the project does, and could pass on code
 *      the project build would reject. Decorator and type-root flags varied too.
 *   2. **No path alias.** A bare `tsc <file> --flags` invocation never reads the
 *      project `tsconfig`, so `compilerOptions.paths` does not apply — and `tsc`
 *      has no `--paths` CLI flag. An `@/…` import anywhere in the compile graph
 *      failed the harness outright.
 *
 * Both are fixed by telling the compiler through a generated tsconfig that
 * EXTENDS the application's own, instead of through a flag list: the baseline
 * comes from one place, and `paths` comes with it. Single-file compilation is
 * preserved via `files` — the helper changes how the compiler is told what to
 * do, not what it compiles.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/api` — the package whose tsconfig defines the baseline. */
const API_ROOT = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(API_ROOT, '..', '..');
const TSC = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');

/**
 * Compile `sources` into `outDir`.
 *
 * @param {object} args
 * @param {string[]} args.sources  absolute paths to the `.ts` entry sources
 * @param {string} args.outDir     where to emit
 * @param {Record<string, unknown>} [args.compilerOptions]
 *   overrides layered on top of the project baseline. Use sparingly: an override
 *   here is a deliberate departure from how the application itself compiles, and
 *   the reason belongs in the caller.
 */
export function compileSingleSource({ sources, outDir, compilerOptions = {} }) {
  const configDir = mkdtempSync(join(API_ROOT, '.tsc-harness-'));
  try {
    const config = {
      extends: join(API_ROOT, 'tsconfig.json'),
      compilerOptions: {
        outDir,
        noEmitOnError: true,
        // The harnesses import the emitted JS with `await import(...)`, so the
        // application's own build layout (rootDir, incremental state, etc.) must
        // not follow us into a temp directory.
        rootDir: join(API_ROOT, 'src'),
        composite: false,
        incremental: false,
        tsBuildInfoFile: undefined,
        ...compilerOptions,
      },
      files: sources,
    };
    const configPath = join(configDir, 'tsconfig.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    execFileSync(TSC, ['-p', configPath], { cwd: API_ROOT, stdio: 'pipe' });
    rewriteAliasRequires(outDir);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

/** Find `name` anywhere under `dir` — the emitted layout mirrors `src/`. */
export function findEmitted(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findEmitted(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

/**
 * Rewrite `require("@/x")` in emitted JS to a relative path.
 *
 * `tsc` resolves path aliases for TYPE checking but emits the specifier
 * unchanged — so aliased output compiles and then fails to load. (`nest build`
 * does this rewrite itself, which is why the application's own `dist` carries
 * relative paths and needs no runtime resolver; a bare `tsc` invocation does
 * not.) The emitted tree mirrors `src/` because `rootDir` is `src`, so the
 * alias target is just a path relative to `outDir`.
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
      const after = before.replace(
        /require\("@\/([^"]+)"\)/g,
        (_match, target) => {
          let rel = relative(dirname(abs), join(outDir, target)).replace(/\\/g, '/');
          if (!rel.startsWith('.')) rel = `./${rel}`;
          return `require("${rel}")`;
        },
      );
      if (after !== before) writeFileSync(abs, after);
    }
  };
  walk(outDir);
}
