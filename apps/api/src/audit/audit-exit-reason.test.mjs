/**
 * Pins the failure-diagnostic helpers added by record-task-failure-reason:
 *   - `reasonForExit(code, abnormal)` — the exit-code -> human-reason mapping
 *     (audit-mapping.ts)
 *   - `stripAnsi(input)` + tail line-selection — the transcript-tail sampling
 *     (snapshot.ts)
 *
 * Like its sibling `.test.mjs` scripts (task-lifecycle / guardrails-exit-roundtrip),
 * this is a no-transpile node:test that FAITHFULLY MIRRORS the source logic to pin
 * the documented contract without a build step. If the source mapping changes,
 * this test must change with it — that is the intended drift guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- faithful mirror of audit-mapping.ts `reasonForExit` --------------------
function reasonForExit(code, abnormal) {
  if (abnormal || code === null) {
    return '沙箱异常断开（会话建立前 WS 关闭 / 退出码未解析，疑似容器被杀或网络中断）';
  }
  switch (code) {
    case 124:
      return '超时（timeout 终止）';
    case 130:
      return 'SIGINT（中断 / Ctrl-C）';
    case 137:
      return 'SIGKILL（被强杀，疑似 OOM 或容器被杀）';
    case 143:
      return 'SIGTERM（被终止，常见于部署 / 重启）';
    default:
      return `codex 自身错误或任务提交失败（退出码 ${code}，见输出末尾）`;
  }
}

// ---- faithful mirror of snapshot.ts `stripAnsi` ----------------------------
function stripAnsi(input) {
  return input
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// ---- faithful mirror of the tail line-selection (snapshot.ts) ---------------
const TAIL_LINES = 20;
function tailLines(text) {
  return stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-TAIL_LINES)
    .join('\n');
}

test('abnormal / unresolved code always reports an abnormal disconnect', () => {
  assert.match(reasonForExit(null, false), /沙箱异常断开/);
  assert.match(reasonForExit(0, true), /沙箱异常断开/);
  assert.match(reasonForExit(137, true), /沙箱异常断开/); // abnormal wins over code
});

test('signal codes map via the 128+signal convention', () => {
  assert.match(reasonForExit(124, false), /超时/);
  assert.match(reasonForExit(130, false), /SIGINT/);
  assert.match(reasonForExit(137, false), /SIGKILL/);
  assert.match(reasonForExit(143, false), /SIGTERM/);
});

test('other non-zero codes attribute to codex + point at the tail', () => {
  const r = reasonForExit(1, false);
  assert.match(r, /codex 自身错误/);
  assert.match(r, /退出码 1/);
  assert.match(r, /见输出末尾/);
});

test('stripAnsi removes CSI/SGR, OSC, and bare control chars but keeps text+newlines', () => {
  const raw = '\x1b[31mERROR\x1b[0m: rate limit\r\n\x1b]0;title\x07next\x08line\n';
  const out = stripAnsi(raw);
  assert.ok(!out.includes('\x1b'), 'no ESC remains');
  assert.match(out, /ERROR: rate limit/);
  assert.match(out, /nextline/); // \x08 (backspace) stripped, no color codes
  assert.ok(out.includes('\n'), 'newlines preserved');
});

test('tail keeps only the last N non-empty lines', () => {
  const many = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const out = tailLines(`${many}\n\n   \n`); // trailing blank lines dropped
  const lines = out.split('\n');
  assert.equal(lines.length, TAIL_LINES);
  assert.equal(lines[lines.length - 1], 'line 30');
  assert.equal(lines[0], 'line 11');
});

test('empty / whitespace-only transcript yields empty tail', () => {
  assert.equal(tailLines('   \n\n\t\n'), '');
});
