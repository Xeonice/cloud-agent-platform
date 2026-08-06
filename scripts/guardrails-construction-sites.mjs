// 统计 `new GuardrailsService(` 的构造点：总数/文件数、目录外文件数、以及填了第 8 参(transcripts)及以后的站点。
// 注释行不计。输出一行 "sites files outsideFiles heavy heavyOutside heavyOutsideFiles"。
//
// 计数口径（写在这里，因为口径错过一次）：一个站点的实参数 = 深度 1 的逗号数 + 1，
// 但 **Prettier 在多行调用的最后一个实参后留的尾逗号不代表一个实参**，必须扣掉；
// 空参表 `new GuardrailsService()` 记 0 而不是 1。原实现两者都没做，于是本仓每一个
// 多行构造点都被多算一个实参，heavy 阈值(>=8)因此把六个只传 7 参（末参是 prisma、
// transcripts 取构造函数默认值 NOOP_SESSION_TRANSCRIPT_CAPTURE）的站点误判成填了
// transcripts 位。站点数/文件数不读实参数，所以前三个数没被这个 bug 波及，后三个被。
// 校验方式：与 TypeScript AST（ts.isNewExpression → node.arguments.length）逐位对齐。
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
    let d = 0, commas = 0, lastComma = -1, j = i + 21;
    const open = i + 22;                                  // '(' 在 i+21，实参区从 i+22 起
    for (; j < t.length; j++) {
      const c = t[j];
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) { d--; if (d === 0) break; }
      else if (c === ',' && d === 1) { commas++; lastComma = j; }
    }
    // j 停在配对的 ')'。空参表记 0；末逗号与 ')' 之间只有空白 => 那是 Prettier 的尾逗号，不是实参。
    const trailing = lastComma !== -1 && t.slice(lastComma + 1, j).trim() === '';
    const args = t.slice(open, j).trim() === '' ? 0 : commas + 1 - (trailing ? 1 : 0);
    rows.push({ f, args }); i = j;
  }
}
const outside = (r) => !r.f.includes('/guardrails/');
const figures = (rs) => {
  const heavy = rs.filter((r) => r.args >= 8);          // transcripts 是第 8 参
  const ho = heavy.filter(outside);
  return [
    rs.length, new Set(rs.map((r) => r.f)).size, new Set(rs.filter(outside).map((r) => r.f)).size,
    heavy.length, ho.length, new Set(ho.map((r) => r.f)).size,
  ].join(' ');
};

// --cross-check：用 TypeScript 自己的 parser 重数一遍。上面那个扫逗号的实现是手写的，
// 手写的东西错过一次（尾逗号），而钉这些数的 spec 场景又是拿它自己来验的 —— 自证。
// 这里的第二个计数器与它算法无关（走真 AST），两边一致才说明数的是这棵树而不是这个工具。
if (process.argv.includes('--cross-check')) {
  const ts = (await import('typescript')).default;
  const astRows = [];
  for (const f of files) {
    const src = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
    const walk = (n) => {
      if (ts.isNewExpression(n) && n.expression.getText(src) === 'GuardrailsService') {
        astRows.push({ f, args: n.arguments ? n.arguments.length : 0 });
      }
      n.forEachChild(walk);
    };
    walk(src);
  }
  const scan = figures(rows), ast = figures(astRows);
  console.log(scan === ast ? 'AGREE' : `DISAGREE scan=[${scan}] ast=[${ast}]`);
} else {
  console.log(figures(rows));
}
