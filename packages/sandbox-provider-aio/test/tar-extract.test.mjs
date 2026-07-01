import assert from 'node:assert/strict';
const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const { tar, longNameTar, base256SizeTar } = await import('./test-tar-helpers.mjs');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

await test('extracts matching regular files and preserves archive paths', () => {
  const files = mod.extractFilesFromTar(
    tar([
      { name: 'rollout-a.jsonl', content: 'a' },
      { name: 'skip.txt', content: 'skip' },
      { name: 'rollout-b.jsonl', content: 'b', prefix: 'home/gem/.codex/sessions' },
      { name: 'dir', type: '5', content: '' },
    ]),
    (name) => name.endsWith('.jsonl'),
  );
  assert.deepEqual(
    files.map((file) => [file.name, file.content.toString('utf8')]),
    [
      ['rollout-a.jsonl', 'a'],
      ['home/gem/.codex/sessions/rollout-b.jsonl', 'b'],
    ],
  );
});

await test('supports GNU long names and base-256 size fields', () => {
  const longName = 'home/gem/.codex/sessions/' + 'x'.repeat(120) + '.jsonl';
  assert.deepEqual(
    mod.extractFilesFromTar(longNameTar(longName, 'long'), () => true).map((file) => [
      file.name,
      file.content.toString('utf8'),
    ]),
    [[longName, 'long']],
  );
  assert.deepEqual(
    mod.extractFilesFromTar(base256SizeTar('large.jsonl', 'large'), () => true).map(
      (file) => file.content.toString('utf8'),
    ),
    ['large'],
  );
});

await test('malformed and empty archives degrade to the readable subset', () => {
  assert.deepEqual(mod.extractFilesFromTar(Buffer.alloc(1024), () => true), []);
  const truncated = tar([{ name: 'ok.jsonl', content: 'ok' }]).subarray(0, 513);
  assert.deepEqual(mod.extractFilesFromTar(truncated, () => true), []);
  const badSize = Buffer.from(tar([{ name: 'bad.jsonl', content: '' }]));
  badSize.write('not-octal', 124, 'utf8');
  assert.deepEqual(
    mod.extractFilesFromTar(badSize, () => true).map((file) => file.name),
    ['bad.jsonl'],
  );

  const emptySize = Buffer.from(tar([{ name: 'empty-size.jsonl', content: '' }]));
  emptySize.fill(0, 124, 136);
  assert.deepEqual(
    mod.extractFilesFromTar(emptySize, () => true).map((file) => [
      file.name,
      file.content.toString('utf8'),
    ]),
    [['empty-size.jsonl', '']],
  );

  const nulTypeflag = Buffer.from(tar([{ name: 'nul-type.jsonl', content: 'nul' }]));
  nulTypeflag[156] = 0;
  assert.deepEqual(
    mod.extractFilesFromTar(nulTypeflag, () => true).map((file) => [
      file.name,
      file.content.toString('utf8'),
    ]),
    [['nul-type.jsonl', 'nul']],
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
