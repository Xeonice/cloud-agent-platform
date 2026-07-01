import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

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

const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function makeDocker(containers) {
  const removed = [];
  const removeForce = [];
  let lastFilter;
  let listCalls = 0;
  return {
    removed,
    removeForce,
    get lastFilter() {
      return lastFilter;
    },
    get listCalls() {
      return listCalls;
    },
    async listContainers(opts) {
      listCalls += 1;
      lastFilter = opts?.filters;
      return containers.map((c) => ({
        Id: c.Id,
        ...(c.Names === null ? {} : { Names: c.Names ?? ['/' + c.Id] }),
        State: c.state,
      }));
    },
    getContainer(id) {
      const c = containers.find((x) => x.Id === id);
      return {
        async inspect() {
          if (!c) throw new Error('no such container');
          return { State: { FinishedAt: c.finishedAt }, Created: c.created };
        },
        async remove(opts) {
          removeForce.push(opts?.force);
          if (c && c.state === 'running' && !opts?.force) {
            throw new Error('cannot remove a running container');
          }
          removed.push(id);
        },
      };
    },
  };
}

await test('docker retention store lists stopped AIO sandboxes oldest-first', async () => {
  const docker = makeDocker([
    { Id: 'running-old', state: 'running', finishedAt: iso(99 * DAY) },
    { Id: 'stopped-new', state: 'exited', finishedAt: iso(1 * DAY) },
    { Id: 'stopped-old', state: 'exited', finishedAt: iso(3 * DAY) },
  ]);
  const store = new mod.AioDockerSandboxRetentionStore(docker, 'cap-aio-');
  const listed = await store.listStoppedSandboxes();

  assert.deepEqual(
    listed.map((c) => c.id),
    ['stopped-old', 'stopped-new'],
  );
  assert.equal(listed.some((c) => c.id === 'running-old'), false);
  assert.equal(docker.lastFilter.status.includes('exited'), true);
  assert.equal(docker.lastFilter.name.some((n) => n.includes('cap-aio-')), true);
});

await test('docker retention store falls back when inspect metadata is missing', async () => {
  const docker = makeDocker([
    { Id: 'no-name', state: 'created', Names: null },
    { Id: 'created-only', state: 'exited', created: iso(2 * DAY) },
    { Id: 'missing', state: 'dead' },
  ]);
  const originalGetContainer = docker.getContainer.bind(docker);
  docker.getContainer = (id) => {
    if (id === 'missing') {
      return {
        async inspect() {
          throw new Error('missing');
        },
        async remove() {},
      };
    }
    return originalGetContainer(id);
  };
  const store = new mod.AioDockerSandboxRetentionStore(docker, 'cap-aio-');

  const listed = await store.listStoppedSandboxes();

  assert.deepEqual(
    listed.map((c) => c.id),
    ['no-name', 'missing', 'created-only'],
  );
  assert.deepEqual(
    listed.map((c) => c.name),
    ['no-name', 'missing', 'created-only'],
  );
  assert.equal(listed[0].finishedAtMs, 0);
  assert.equal(listed[1].finishedAtMs, 0);
  assert.ok(listed[2].finishedAtMs > 0);
});

await test('docker retention store removes stopped sandboxes without force', async () => {
  const docker = makeDocker([
    { Id: 'stopped-old', state: 'exited', finishedAt: iso(3 * DAY) },
  ]);
  const store = new mod.AioDockerSandboxRetentionStore(docker, 'cap-aio-');

  await store.removeStopped({
    id: 'stopped-old',
    name: 'stopped-old',
    finishedAtMs: Date.now(),
  });

  assert.deepEqual(docker.removeForce, [false]);
  assert.deepEqual(docker.removed, ['stopped-old']);
});

await test('docker retention store ignores remove failures', async () => {
  const docker = makeDocker([{ Id: 'gone', state: 'exited', finishedAt: iso(DAY) }]);
  docker.getContainer = () => ({
    async inspect() {
      return { State: { FinishedAt: iso(DAY) } };
    },
    async remove() {
      throw new Error('already removed');
    },
  });
  const store = new mod.AioDockerSandboxRetentionStore(docker, 'cap-aio-');

  await assert.doesNotReject(() =>
    store.removeStopped({ id: 'gone', name: 'gone', finishedAtMs: Date.now() }),
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
