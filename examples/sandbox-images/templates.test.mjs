import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('sandbox image templates derive from official CAP release images', () => {
  const aio = readFile('examples/sandbox-images/aio/Dockerfile');
  const boxlite = readFile('examples/sandbox-images/boxlite/Dockerfile');

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

function readFile(path) {
  return readFileSync(resolve(root, path), 'utf8');
}
