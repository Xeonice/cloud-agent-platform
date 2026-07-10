import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dockerfiles = [
  readFileSync(new URL('../docker/aio-sandbox.Dockerfile', import.meta.url), 'utf8'),
  readFileSync(new URL('../docker/boxlite-sandbox.Dockerfile', import.meta.url), 'utf8'),
];

test('official sandbox Dockerfiles write the same required metadata contract', () => {
  for (const dockerfile of dockerfiles) {
    assert.match(dockerfile, /write-sandbox-metadata\.mjs/);
    assert.match(
      dockerfile,
      /COPY scripts\/write-sandbox-metadata\.mjs scripts\/sandbox-version-selector\.mjs \/usr\/local\/bin\//,
    );
    assert.match(dockerfile, /--sandbox-version "\$\{CAP_VERSION\}"/);
    assert.match(dockerfile, /--dependency "codex=\$\{CODEX_VERSION\}"/);
    assert.match(dockerfile, /--dependency "claude-code=\$\{CLAUDE_CODE_VERSION\}"/);
    assert.match(dockerfile, /--dependency "openspec=\$\{OPENSPEC_VERSION\}"/);
    assert.match(dockerfile, /--output \/etc\/cap\/sandbox-metadata\.json/);
  }
});
