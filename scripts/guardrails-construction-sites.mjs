// 统计 `new GuardrailsService(` 的构造点：总数/文件数、目录外文件数、以及填了第 8 参(transcripts)及以后的站点。
// 注释行不计。输出一行 "sites files outsideFiles heavy heavyOutside heavyOutsideFiles"。
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const files = execSync("grep -rl 'new GuardrailsService(' apps/api/src", { encoding: 'utf8' }).trim().split('\n');
const rows = [];
for (const f of files) {
  const t = readFileSync(f, 'utf8');
  let i = 0;
  while ((i = t.indexOf('new GuardrailsService(', i)) !== -1) {
    const ls = t.lastIndexOf('\n', i) + 1;
    if (/^\s*(\*|\/\/)/.test(t.slice(ls, i))) { i += 20; continue; }
    let d = 0, args = 1, j = i + 21;
    for (; j < t.length; j++) {
      const c = t[j];
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) { d--; if (d === 0) break; }
      else if (c === ',' && d === 1) args++;
    }
    rows.push({ f, args }); i = j;
  }
}
const outside = (r) => !r.f.includes('/guardrails/');
const heavy = rows.filter((r) => r.args >= 8);          // transcripts 是第 8 参
const ho = heavy.filter(outside);
console.log([
  rows.length, new Set(rows.map((r) => r.f)).size, new Set(rows.filter(outside).map((r) => r.f)).size,
  heavy.length, ho.length, new Set(ho.map((r) => r.f)).size,
].join(' '));
