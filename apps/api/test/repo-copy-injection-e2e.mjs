/**
 * add-repo-content-store Track 4.7 — REAL docker end-to-end for the aio
 * `volume` injection chain.
 *
 * Proves the physical link the unit tests can only describe:
 *
 *   named volume holding a bare mirror
 *     -> REAL provision spec (`buildAioLocalSandboxProvisionSpec`) turns the
 *        workspace source into a read-only `VolumeOptions.Subpath` mount
 *     -> REAL container created from that spec (docker >= 26 semantics)
 *     -> REAL materialization engine (`materializeSandboxGitWorkspaceStaged`)
 *        drives its commands through `docker exec` as the image's NON-ROOT user
 *     -> workspace exists, `origin` points at the recorded git source, content
 *        matches the mirror, and the mount is not writable.
 *
 * NOT part of the default unit gate: it needs a docker daemon and a local
 * sandbox image. Everything it creates (volume + containers) is torn down.
 *
 * Run:
 *   node --test --test-force-exit apps/api/test/repo-copy-injection-e2e.mjs
 *   CAP_REPO_INJECTION_E2E_IMAGE=<image> node --test ...   # explicit image
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';

import {
  buildAioLocalSandboxProvisionSpec,
  materializeSandboxGitWorkspaceStaged,
} from '@cap/sandbox';

const docker = new Docker();
const GIT_SOURCE = 'https://example.invalid/acme/widgets.git';
const REPO_ID = `e2e-${randomUUID()}`;
const VOLUME = `cap-repo-store-e2e-${randomUUID().slice(0, 8)}`;
const MIRROR_SUBPATH = `${REPO_ID}.git`;
const WORKSPACE_DIR = '/home/gem/workspace';

async function resolveImage() {
  if (process.env.CAP_REPO_INJECTION_E2E_IMAGE) {
    return process.env.CAP_REPO_INJECTION_E2E_IMAGE;
  }
  const images = await docker.listImages();
  const tags = images.flatMap((image) => image.RepoTags ?? []);
  // Prefer a real AIO sandbox image: it carries git AND the non-root `gem`
  // user, which is exactly what makes `safe.directory` load-bearing.
  return (
    tags.find((tag) => tag.includes('cap-aio-sandbox') && !tag.endsWith(':<none>')) ??
    tags.find((tag) => tag.startsWith('alpine/git')) ??
    null
  );
}

const IMAGE = await (async () => {
  try {
    await docker.ping();
  } catch {
    return null;
  }
  return resolveImage();
})();

const SKIP = IMAGE === null;
if (SKIP) {
  console.log(
    'repo-copy-injection-e2e: SKIPPED (no docker daemon or no local sandbox image)',
  );
}

/** Run a command in a container and return {exitCode, output}. */
async function execInContainer(container, command, user) {
  const exec = await container.exec({
    Cmd: ['sh', '-lc', command],
    AttachStdout: true,
    AttachStderr: true,
    ...(user === undefined ? {} : { User: user }),
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const inspected = await exec.inspect();
  // Demultiplex the docker stream framing (8-byte headers).
  let output = '';
  let buffer = Buffer.concat(chunks);
  while (buffer.length >= 8) {
    const size = buffer.readUInt32BE(4);
    output += buffer.subarray(8, 8 + size).toString('utf8');
    buffer = buffer.subarray(8 + size);
  }
  return { exitCode: inspected.ExitCode ?? -1, output };
}

async function runDisposableContainer(config, run) {
  const container = await docker.createContainer(config);
  try {
    await container.start();
    return await run(container);
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

test('repo-store copy is injected into a real container as a read-only subpath mount', {
  skip: SKIP,
}, async () => {
  await docker.createVolume({ Name: VOLUME });
  try {
    // 1. Seed a REAL bare mirror inside the named volume (stands in for the
    //    import-time acquisition the repo-store service performs).
    const seedScript = [
      'set -e',
      'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null',
      'export GIT_AUTHOR_NAME=cap GIT_AUTHOR_EMAIL=cap@example.com',
      'export GIT_COMMITTER_NAME=cap GIT_COMMITTER_EMAIL=cap@example.com',
      'rm -rf /tmp/origin && mkdir -p /tmp/origin && cd /tmp/origin',
      'git init --initial-branch=main -q .',
      'printf "injected\\n" > README.md',
      'git add . && git commit -q -m seed',
      `git clone --mirror -q /tmp/origin /repo-store/${MIRROR_SUBPATH}`,
      `git -C /repo-store/${MIRROR_SUBPATH} rev-parse HEAD`,
    ].join(' && ');
    const seeded = await runDisposableContainer(
      {
        Image: IMAGE,
        name: `cap-repo-store-seed-${randomUUID().slice(0, 8)}`,
        Entrypoint: ['sleep'],
        Cmd: ['120'],
        User: 'root',
        HostConfig: {
          AutoRemove: false,
          Mounts: [
            { Type: 'volume', Source: VOLUME, Target: '/repo-store', ReadOnly: false },
          ],
        },
      },
      (container) => execInContainer(container, seedScript),
    );
    assert.equal(seeded.exitCode, 0, `seeding the mirror failed: ${seeded.output}`);
    const mirrorHead = seeded.output.trim().split(/\s+/u).at(-1);
    assert.match(mirrorHead, /^[0-9a-f]{40}$/u);

    // 2. Build the sandbox container from the REAL provision spec, with the
    //    repo mount the provider derives from a `volume` workspace source.
    const taskId = randomUUID();
    const spec = buildAioLocalSandboxProvisionSpec({
      taskId,
      config: {
        image: IMAGE,
        network: 'bridge',
        readinessTimeoutMs: 1_000,
        approvalsBase: 'http://api:8080',
      },
      repoMount: {
        volumeName: VOLUME,
        subpath: MIRROR_SUBPATH,
        mountPath: '/cap-repo-source',
      },
    });
    assert.deepEqual(
      spec.containerConfig.HostConfig.Mounts,
      [
        {
          Type: 'volume',
          Source: VOLUME,
          Target: '/cap-repo-source',
          ReadOnly: true,
          VolumeOptions: { Subpath: MIRROR_SUBPATH },
        },
      ],
      'the provision spec carries the read-only per-repo subpath mount',
    );

    await runDisposableContainer(
      {
        ...spec.containerConfig,
        name: `cap-repo-inject-e2e-${randomUUID().slice(0, 8)}`,
        // The AIO entrypoint would start the sandbox server; this e2e only
        // needs a live container to exec the materialization commands in.
        Entrypoint: ['sleep'],
        Cmd: ['300'],
        HostConfig: {
          ...spec.containerConfig.HostConfig,
          NetworkMode: 'bridge',
        },
      },
      async (container) => {
        // The materialization must run as a NON-ROOT user: the stored copy is
        // owned by root, which is exactly what triggers git's ownership check
        // and makes `safe.directory` load-bearing (research-brief §2, item 4).
        const sandboxUser = process.env.CAP_REPO_INJECTION_E2E_USER ?? '1000:1000';
        const prepared = await execInContainer(
          container,
          // Mirrors the sandbox image's own layout: the workspace parent is
          // owned by the sandbox user, everything else stays root-owned.
          'mkdir -p /home/gem && chown -R 1000:1000 /home/gem',
          'root',
        );
        assert.equal(prepared.exitCode, 0, prepared.output);
        const identity = await execInContainer(container, 'id -u', sandboxUser);
        console.log(
          `  e2e: image=${IMAGE} sandbox user=${sandboxUser} uid=${identity.output.trim()}`,
        );
        assert.notEqual(
          identity.output.trim(),
          '0',
          'the injection must be proven under a non-root sandbox user',
        );

        // 3. Drive the REAL materialization engine; every command it emits is
        //    executed inside the real container as that user.
        const executed = [];
        const result = await materializeSandboxGitWorkspaceStaged({
          taskId,
          plan: {
            repositoryUrl: GIT_SOURCE,
            callerBranch: null,
            resolvedBranch: 'main',
            deadlineMs: 120_000,
          },
          workspaceDir: WORKSPACE_DIR,
          source: {
            kind: 'volume',
            repoId: REPO_ID,
            volumeName: VOLUME,
            subpath: MIRROR_SUBPATH,
            mountPath: '/cap-repo-source',
            gitSource: GIT_SOURCE,
          },
          stageExecutor: {
            async execute(execution) {
              const command = execution.request.command;
              executed.push({ stage: execution.stage, command });
              const run = await execInContainer(
                container,
                command,
                sandboxUser,
              );
              return {
                exitCode: run.exitCode,
                output: run.output,
                stdout: run.output,
                stderr: '',
                timedOut: false,
              };
            },
          },
        });
        assert.deepEqual(
          result,
          { status: 'succeeded', stage: 'complete' },
          `materialization failed: ${JSON.stringify(executed, null, 2)}`,
        );
        assert.deepEqual(
          executed.map((entry) => entry.stage),
          ['remote_ref_resolution', 'workspace_transfer', 'checkout'],
        );

        // 4. The workspace is a normal git tree pointing at the real source.
        const origin = await execInContainer(
          container,
          `git -C ${WORKSPACE_DIR} remote get-url origin`,
          sandboxUser,
        );
        assert.equal(origin.exitCode, 0);
        assert.equal(origin.output.trim(), GIT_SOURCE);

        const head = await execInContainer(
          container,
          `git -C ${WORKSPACE_DIR} rev-parse HEAD; cat ${WORKSPACE_DIR}/README.md; git -C ${WORKSPACE_DIR} rev-parse --abbrev-ref HEAD`,
          sandboxUser,
        );
        assert.equal(head.exitCode, 0);
        assert.match(head.output, new RegExp(mirrorHead, 'u'));
        assert.match(head.output, /injected/u);
        assert.match(head.output, /main/u);

        // 5. The stored copy is not writable from inside the sandbox.
        const write = await execInContainer(
          container,
          'touch /cap-repo-source/cap-write-probe',
          sandboxUser,
        );
        assert.notEqual(write.exitCode, 0, 'the repo-store mount must be read-only');

        // 6. Only this repo's copy is visible (subpath scoping).
        const listing = await execInContainer(
          container,
          'ls /cap-repo-source',
          sandboxUser,
        );
        assert.match(listing.output, /HEAD/u, 'the mount IS the bare mirror');
        assert.doesNotMatch(
          listing.output,
          new RegExp(MIRROR_SUBPATH, 'u'),
          'no sibling repo directories are exposed',
        );
      },
    );
  } finally {
    await docker.getVolume(VOLUME).remove({ force: true }).catch(() => undefined);
  }
});
