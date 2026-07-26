import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { serializeActiveBuffer } from '../packages/ui/dist/index.js';

const requireFromWeb = createRequire(
  new URL('../apps/web/package.json', import.meta.url),
);
const requireFromUi = createRequire(
  new URL('../packages/ui/package.json', import.meta.url),
);
const { Terminal } = requireFromWeb('@xterm/headless');
const { SerializeAddon } = requireFromUi('@xterm/addon-serialize');

function write(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function terminalState({
  normal = 'normal-shell',
  alternate = 'CURRENT FRAME',
  cols = 20,
  rows = 4,
  suffix = '',
} = {}) {
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 0,
  });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  await write(terminal, normal);
  await write(
    terminal,
    `\x1b[?1049h\x1b[2J\x1b[H${alternate}${suffix}`,
  );
  return {
    terminal,
    full: serializer.serialize(),
    active: serializeActiveBuffer(terminal),
  };
}

test('active snapshot excludes a different hidden attach shell', async (t) => {
  const first = await terminalState({ normal: 'first-shell$ tmux attach A' });
  const second = await terminalState({ normal: 'second-shell$ tmux attach B' });
  t.after(() => {
    first.terminal.dispose();
    second.terminal.dispose();
  });

  assert.notEqual(first.full, second.full);
  assert.equal(first.active, second.active);
  assert.equal(JSON.parse(first.active).atBottom, true);
});

test('active snapshot distinguishes every public visible state dimension', async (t) => {
  const baseline = await terminalState({
    alternate: '\x1b[1;31m中文 FRAME\x1b[0m',
    suffix: '\x1b[3;4H',
  });
  const variants = [
    await terminalState({
      alternate: '\x1b[1;32m中文 FRAME\x1b[0m',
      suffix: '\x1b[3;4H',
    }),
    await terminalState({
      alternate: '\x1b[1;31m中X FRAME\x1b[0m',
      suffix: '\x1b[3;4H',
    }),
    await terminalState({
      alternate: '\x1b[1;31m中文 FRAME\x1b[0m',
      suffix: '\x1b[2;2H',
    }),
    await terminalState({
      alternate: '\x1b[1;31m中文 FRAME\x1b[0m',
      cols: 21,
      suffix: '\x1b[3;4H',
    }),
    await terminalState({
      alternate: '\x1b[1;31m中文 FRAME\x1b[0m',
      suffix: '\x1b[?1h\x1b[3;4H',
    }),
  ];
  t.after(() => {
    baseline.terminal.dispose();
    for (const variant of variants) variant.terminal.dispose();
  });

  for (const variant of variants) {
    assert.notEqual(variant.active, baseline.active);
  }
});

test('active snapshot preserves line-wrap state independently of cell text', async (t) => {
  const wrapped = await terminalState({
    alternate: 'ABCDEFGH',
    cols: 4,
    rows: 2,
  });
  const addressed = await terminalState({
    alternate: 'ABCD\x1b[2;1HEFGH',
    cols: 4,
    rows: 2,
  });
  t.after(() => {
    wrapped.terminal.dispose();
    addressed.terminal.dispose();
  });

  const wrappedState = JSON.parse(wrapped.active);
  const addressedState = JSON.parse(addressed.active);
  assert.deepEqual(
    wrappedState.viewport.map((line) =>
      line.cells.map((cell) => cell?.[0] ?? '').join(''),
    ),
    addressedState.viewport.map((line) =>
      line.cells.map((cell) => cell?.[0] ?? '').join(''),
    ),
  );
  assert.notDeepEqual(
    wrappedState.viewport.map((line) => line.wrapped),
    addressedState.viewport.map((line) => line.wrapped),
  );
  assert.notEqual(wrapped.active, addressed.active);
});
