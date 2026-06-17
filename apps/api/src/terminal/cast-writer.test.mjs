/**
 * Focused unit test for the pure asciicast v2 line builders
 * (session-terminal-replay, Track 2). Compiles `cast-writer.ts` standalone with
 * tsc (the only import is a type-only `@cap/contracts` symbol, which elides) and
 * asserts the header/event/resize lines are well-formed asciicast and that a
 * multibyte UTF-8 `data` round-trips byte-for-byte through JSON.
 *
 * Run: `node cast-writer.test.mjs` (no prior build needed — it self-compiles).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const src = join(__dirname, 'cast-writer.ts');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}
function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

const outDir = mkdtempSync(join(apiRoot, '.cast-writer-test-'));
try {
  execFileSync(
    tscBin,
    [
      src,
      '--outDir', outDir,
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--target', 'ES2021',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const compiled = findFile(outDir, 'cast-writer.js');
  if (!compiled) throw new Error('compiled cast-writer.js not found');
  const { buildCastHeaderLine, buildCastEventLine, castResizeData } = await import(
    pathToFileURL(compiled).href
  );

  // header
  const headerLine = buildCastHeaderLine(120, 40, 1718600000);
  assert(headerLine.endsWith('\n'), 'header line is newline-terminated');
  const header = JSON.parse(headerLine);
  assert(header.version === 2, 'header version is 2');
  assert(header.width === 120 && header.height === 40, 'header carries geometry');
  assert(header.timestamp === 1718600000, 'header carries timestamp');

  // output event
  const evLine = buildCastEventLine(0.213, 'o', '[32mhi[0m');
  assert(evLine.endsWith('\n'), 'event line is newline-terminated');
  const ev = JSON.parse(evLine);
  assert(ev[0] === 0.213 && ev[1] === 'o', 'event time + code');
  assert(ev[2] === '[32mhi[0m', 'event data preserves ANSI');

  // multibyte round-trip (the UTF-8 correctness guarantee)
  const mb = '你好世界🎉 résumé';
  const mbLine = buildCastEventLine(1.0, 'o', mb);
  assert(JSON.parse(mbLine)[2] === mb, 'multibyte UTF-8 data round-trips byte-for-byte');

  // resize
  const rLine = buildCastEventLine(1.5, 'r', castResizeData(100, 30));
  assert(JSON.parse(rLine)[2] === '100x30', 'resize data is "COLSxROWS"');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
