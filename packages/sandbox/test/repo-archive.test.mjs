import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

async function collect(archive) {
  const chunks = [];
  for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function withPath(value, fn) {
  const previous = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

const scratch = await mkdtemp(path.join(os.tmpdir(), 'cap-repo-archive-'));
try {
  const storePath = path.join(scratch, 'repo.git');
  const nested = path.join(storePath, 'objects');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(storePath, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(nested, 'pack'), 'pack-bytes');
  await symlink(path.join(storePath, 'HEAD'), path.join(storePath, 'HEAD.link'));

  assert.deepEqual(mod.splitRepoStorePath('/repo.git///'), {
    directory: '/',
    name: 'repo.git',
  });
  for (const invalid of ['repo.git', '/', '/.', '/..']) {
    assert.throws(
      () => mod.splitRepoStorePath(invalid),
      (error) =>
        error?.name === 'RepoStoreArchiveStreamError' &&
        error?.reason === 'tar_failed',
    );
  }

  assert.equal(
    await mod.estimateRepoStoreCopyBytes(storePath),
    Buffer.byteLength('ref: refs/heads/main\n') + Buffer.byteLength('pack-bytes'),
  );
  assert.equal(await mod.estimateRepoStoreCopyBytes(path.join(scratch, 'missing')), null);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    collect(mod.createRepoStoreArchiveStream({ storePath, signal: alreadyAborted.signal })),
    (error) => error?.reason === 'aborted' && !error.message.includes(':'),
  );

  const emptyBin = path.join(scratch, 'empty-bin');
  await mkdir(emptyBin);
  await withPath(emptyBin, async () => {
    await assert.rejects(
      collect(mod.createRepoStoreArchiveStream({ storePath })),
      (error) => error?.reason === 'spawn_failed',
    );
  });

  const failingBin = path.join(scratch, 'failing-bin');
  await mkdir(failingBin);
  const failingTar = path.join(failingBin, 'tar');
  await writeFile(failingTar, '#!/bin/sh\nexit 7\n');
  await chmod(failingTar, 0o755);
  await withPath(failingBin, async () => {
    await assert.rejects(
      collect(mod.createRepoStoreArchiveStream({ storePath })),
      (error) =>
        error?.reason === 'tar_failed' &&
        /exit_code 7$/u.test(error.message),
    );
  });
  await writeFile(
    failingTar,
    "#!/bin/sh\nprintf '%0600s' x >&2\nexit 8\n",
  );
  await withPath(failingBin, async () => {
    await assert.rejects(
      collect(mod.createRepoStoreArchiveStream({ storePath })),
      (error) =>
        error?.reason === 'tar_failed' &&
        /exit_code 8 - /u.test(error.message) &&
        error.message.length < 600,
    );
  });

  const streamingBin = path.join(scratch, 'streaming-bin');
  await mkdir(streamingBin);
  const streamingTar = path.join(streamingBin, 'tar');
  await writeFile(
    streamingTar,
    '#!/bin/sh\nprintf first\nwhile :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\n',
  );
  await chmod(streamingTar, 0o755);
  await withPath(streamingBin, async () => {
    const controller = new AbortController();
    const archive = mod.createRepoStoreArchiveStream({
      storePath,
      signal: controller.signal,
    });
    const iterator = archive[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    controller.abort();
    await assert.rejects(
      async () => {
        while (!(await iterator.next()).done) {}
      },
      (error) => error?.reason === 'aborted',
    );
  });

  const earlyReturnBin = path.join(scratch, 'early-return-bin');
  await mkdir(earlyReturnBin);
  const earlyReturnTar = path.join(earlyReturnBin, 'tar');
  await writeFile(
    earlyReturnTar,
    '#!/bin/sh\nprintf first\nwhile :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\n',
  );
  await chmod(earlyReturnTar, 0o755);
  await withPath(earlyReturnBin, async () => {
    const iterator = mod
      .createRepoStoreArchiveStream({ storePath })
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).done, false);
    await iterator.return();
  });
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log('repo-archive.test.mjs passed');
