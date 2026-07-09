import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('sandbox image templates derive from official CAP release images', () => {
  const aio = readFile('examples/sandbox-images/aio/Dockerfile');
  const boxlite = readFile('examples/sandbox-images/boxlite/Dockerfile');

  assert.match(aio, /ARG CAP_VERSION=v0\.0\.0/);
  assert.match(boxlite, /ARG CAP_VERSION=v0\.0\.0/);
  assert.match(aio, /FROM ghcr\.io\/xeonice\/cap-aio-sandbox:\$\{CAP_VERSION\}/);
  assert.match(
    boxlite,
    /FROM ghcr\.io\/xeonice\/cap-boxlite-sandbox:\$\{CAP_VERSION\}/,
  );
  assert.match(aio, /WORKDIR \/home\/gem\/workspace/);
  assert.match(boxlite, /WORKDIR \/home\/gem\/workspace/);
});

test('sandbox image docs link the template directories', () => {
  const docs = readFile('docs/sandbox-images.md');
  const readme = readFile('examples/sandbox-images/README.md');

  assert.match(docs, /examples\/sandbox-images\/aio/);
  assert.match(docs, /examples\/sandbox-images\/boxlite/);
  assert.match(readme, /examples\/sandbox-images\/aio/);
  assert.match(readme, /examples\/sandbox-images\/boxlite/);
});

test('sandbox image docs cover registry operations and avoid local source types', () => {
  const docs = [
    readFile('docs/sandbox-images.md'),
    readFile('docs/sandbox-images.zh.md'),
    readFile('apps/web/src/content/sandbox-images.md'),
  ];

  for (const doc of docs) {
    assert.match(doc, /write:packages/);
    assert.match(doc, /HTTPS/);
    assert.match(doc, /insecure registry/);
    assert.match(doc, /Image Management|镜像管理/);
    assert.match(doc, /registry token/);
    assert.match(doc, /CAP_VERSION=v0\.0\.0/);
    assert.doesNotMatch(doc, /loaded image/i);
    assert.doesNotMatch(doc, /rootfs/i);
  }
});

function readFile(path) {
  return readFileSync(resolve(root, path), 'utf8');
}
