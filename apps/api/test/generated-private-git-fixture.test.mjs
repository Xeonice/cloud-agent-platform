import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifySandboxGitFailure,
  createExactHostGitCredential,
  createSandboxSecretFilePort,
  materializeSandboxGitWorkspaceStaged,
} from '@cap/sandbox';
import { createGeneratedPrivateGitFixture } from '@cap/sandbox-conformance';
import { basicAuthHeader } from '../dist/forge/forge.port.js';
import { NodeRemoteRefsCommandRunner } from '../dist/forge/remote-refs-command-runner.js';
import { GitRemoteRefsProbe } from '../dist/forge/remote-refs-probe.js';
import { NodeRemoteRefsSecretStore } from '../dist/forge/remote-refs-secret-store.js';

const GENERATED_BLOB_BYTES = 3 * 1024 * 1024;
const MAX_STAGE_OUTPUT_BYTES = 512 * 1024;
const MAX_ASSERTION_OUTPUT_BYTES = 1024 * 1024;
const TEST_WATCHDOG_MS = 30_000;
const CAPACITY_FAILURE = 'fatal: write error: No space left on device';

class ManualDeadlineDriver {
  currentMs = 0;
  scheduled = new Set();

  now() {
    return this.currentMs;
  }

  schedule(delayMs, trigger) {
    const scheduled = {
      atMs: this.currentMs + delayMs,
      trigger,
      active: true,
    };
    this.scheduled.add(scheduled);
    return () => {
      scheduled.active = false;
      this.scheduled.delete(scheduled);
    };
  }

  advance(deltaMs) {
    assert.ok(Number.isSafeInteger(deltaMs) && deltaMs >= 0);
    this.currentMs += deltaMs;
    while (true) {
      const due = [...this.scheduled]
        .filter((entry) => entry.active && entry.atMs <= this.currentMs)
        .sort((left, right) => left.atMs - right.atMs)[0];
      if (!due) return;
      due.active = false;
      this.scheduled.delete(due);
      due.trigger();
    }
  }

  get pendingTriggerCount() {
    return this.scheduled.size;
  }
}

/**
 * Host equivalent of a provider stage executor. It deliberately keeps the
 * production command shape (`/bin/sh -lc`) while bounding both output and
 * cancellation. Abort sends SIGKILL to the command process group and the
 * returned promise settles only after Node observes `close`.
 */
class BoundedShellStageExecutor {
  observations = [];
  active = new Map();

  constructor(lifecycle, forbiddenValues) {
    this.lifecycle = lifecycle;
    this.forbiddenValues = forbiddenValues;
  }

  async execute(execution) {
    if (execution.signal.aborted) {
      return {
        exitCode: 124,
        output: '',
        stdout: '',
        stderr: '',
        timedOut: true,
      };
    }

    const environment = gitProcessEnvironment();
    const argv = ['/bin/sh', '-lc', execution.request.command];
    assertForbiddenValuesAbsent(
      JSON.stringify({ argv, environment }),
      this.forbiddenValues,
      'stage argv/environment',
    );

    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: execution.request.cwd,
        detached: process.platform !== 'win32',
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let closeChild;
      const closed = new Promise((settle) => {
        closeChild = settle;
      });
      this.active.set(child, { child, stage: execution.stage, closed });

      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      let killReason = null;
      let spawnFailed = false;

      const stop = (reason) => {
        if (killReason !== null) return;
        killReason = reason;
        this.lifecycle.push(`process:kill:${execution.stage}:${reason}`);
        killProcessGroup(child);
      };
      const capture = (destination, chunk) => {
        const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = Math.max(0, MAX_STAGE_OUTPUT_BYTES - outputBytes);
        if (remaining > 0) {
          destination.push(source.subarray(0, remaining));
          outputBytes += Math.min(source.byteLength, remaining);
        }
        if (source.byteLength > remaining) stop('output_limit');
      };
      const onAbort = () => stop('abort');

      execution.signal.addEventListener('abort', onAbort, { once: true });
      if (execution.signal.aborted) onAbort();
      child.stdout?.on('data', (chunk) => capture(stdout, chunk));
      child.stderr?.on('data', (chunk) => capture(stderr, chunk));
      child.once('error', () => {
        spawnFailed = true;
      });
      child.once('close', (code, signal) => {
        execution.signal.removeEventListener('abort', onAbort);
        this.active.delete(child);
        this.lifecycle.push(`process:close:${execution.stage}`);
        closeChild?.();

        const stdoutText = Buffer.concat(stdout).toString('utf8');
        const stderrText = spawnFailed
          ? 'bounded stage process failed to spawn'
          : Buffer.concat(stderr).toString('utf8');
        const observation = {
          stage: execution.stage,
          argv,
          environment,
          stdout: stdoutText,
          stderr: stderrText,
          outputBytes,
          killReason,
          closeSignal: signal,
        };
        this.observations.push(observation);
        resolve({
          exitCode: killReason === 'abort' ? 124 : (code ?? 1),
          output: stderrText || stdoutText,
          stdout: stdoutText,
          stderr: stderrText,
          timedOut: killReason === 'abort',
        });
      });
    });
  }

  async dispose() {
    const active = [...this.active.values()];
    for (const entry of active) {
      this.lifecycle.push(`process:kill:${entry.stage}:dispose`);
      killProcessGroup(entry.child);
    }
    await Promise.all(active.map((entry) => entry.closed));
  }

  get activeChildCount() {
    return this.active.size;
  }
}

class HostSecretFileHarness {
  activePaths = new Set();
  writtenPaths = new Set();
  writtenModes = [];
  sawExpectedAuthorizationHeader = false;
  sequence = 0;

  constructor(directory, expectedAuthorizationHeader, lifecycle) {
    this.directory = directory;
    this.port = createSandboxSecretFilePort({
      directory,
      createId: () => `generated-private-git-${++this.sequence}`,
      transport: {
        writeFile: async (request) => {
          const content = Buffer.from(request.content);
          this.sawExpectedAuthorizationHeader ||= content.includes(
            expectedAuthorizationHeader,
          );
          await writeFile(request.path, content, {
            flag: 'wx',
            mode: request.mode,
          });
          await chmod(request.path, request.mode);
          const mode = (await stat(request.path)).mode & 0o777;
          this.writtenModes.push(mode);
          this.writtenPaths.add(request.path);
          this.activePaths.add(request.path);
          lifecycle.push('secret:write');
        },
        deleteFile: async (request) => {
          lifecycle.push('secret:delete:start');
          await rm(request.path, { force: true });
          this.activePaths.delete(request.path);
          lifecycle.push('secret:delete:complete');
        },
      },
    });
  }

  static async create(
    root,
    expectedAuthorizationHeader,
    lifecycle,
  ) {
    const directory = join(root, 'secrets');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return new HostSecretFileHarness(
      directory,
      expectedAuthorizationHeader,
      lifecycle,
    );
  }

  async assertClean() {
    assert.equal(this.activePaths.size, 0, 'no credential path remains active');
    assert.ok(this.writtenPaths.size > 0, 'the canonical secret port was used');
    assert.equal(this.sawExpectedAuthorizationHeader, true);
    assert.deepEqual(new Set(this.writtenModes), new Set([0o600]));
    for (const path of this.writtenPaths) {
      await assert.rejects(stat(path));
    }
  }

  async dispose() {
    assert.equal(this.activePaths.size, 0, 'secret cleanup settled before disposal');
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function createStoryResources() {
  const fixture = await createGeneratedPrivateGitFixture({
    largeBlobBytes: GENERATED_BLOB_BYTES,
  });
  const root = await mkdtemp(join(tmpdir(), 'cap-private-git-story-'));
  const authorizationHeader = basicAuthHeader(
    fixture.basicAuth.username,
    fixture.basicAuth.password,
  );
  assert.equal(authorizationHeader, fixture.basicAuth.authorizationHeader);
  const authorizationValue = authorizationHeader.slice(
    'Authorization: '.length,
  );
  const forbiddenValues = [
    fixture.basicAuth.password,
    authorizationValue,
    authorizationHeader,
  ];
  const lifecycle = [];
  const executor = new BoundedShellStageExecutor(lifecycle, forbiddenValues);
  const secrets = await HostSecretFileHarness.create(
    root,
    authorizationHeader,
    lifecycle,
  );
  return {
    fixture,
    root,
    workspaceDir: join(root, 'workspace'),
    authorizationHeader,
    forbiddenValues,
    lifecycle,
    executor,
    secrets,
  };
}

async function disposeStoryResources(
  story,
  operation,
) {
  story.fixture.transferBarrier.release();
  await story.executor.dispose();
  if (operation) await operation.catch(() => undefined);
  assert.equal(story.executor.activeChildCount, 0);
  await story.secrets.dispose();
  await rm(story.root, { recursive: true, force: true });
  await story.fixture.dispose();
  const diagnostics = story.fixture.diagnostics();
  assert.equal(diagnostics.disposed, true);
  assert.equal(diagnostics.activeBackendProcesses, 0);
  assert.equal(diagnostics.activeRequests, 0);
  assert.equal(diagnostics.crossOriginAuthorizationLeakCount, 0);
}

function createProbe(fixture) {
  const forge = {
    kind: 'gitee',
    cloneAuthHeader: () =>
      basicAuthHeader(fixture.basicAuth.username, fixture.basicAuth.password),
    findExistingChangeRequest: async () => null,
    openChangeRequest: async () => {
      throw new Error('not used by generated private Git fixture');
    },
    listRepos: async () => [],
  };
  const registry = {
    forKind: () => forge,
  };
  return new GitRemoteRefsProbe(
    registry,
    new NodeRemoteRefsCommandRunner(),
    new NodeRemoteRefsSecretStore(),
  );
}

function forgeTarget(fixture) {
  return {
    kind: 'gitee',
    apiBaseUrl: new URL('/api/v5', fixture.rootUrl).toString(),
    cloneUrl: fixture.rootUrl,
    repoId: { style: 'owner-repo', owner: 'generated', repo: 'private' },
    token: fixture.basicAuth.password,
  };
}

function materializationContext(
  story,
  args,
) {
  return {
    taskId: 'generated-private-git-story',
    plan: {
      repositoryUrl: story.fixture.rootUrl,
      callerBranch: null,
      resolvedBranch: story.fixture.defaultBranch,
      deadlineMs: args.deadlineMs,
      credential: createExactHostGitCredential(
        story.fixture.rootUrl,
        story.authorizationHeader,
      ),
    },
    workspaceDir: story.workspaceDir,
    stageExecutor: args.stageExecutor,
    secretFilePort: story.secrets.port,
  };
}

async function waitForTransferBarrierOrFail(fixture, operation) {
  const barrierAbort = new AbortController();
  const barrierOutcome = fixture.transferBarrier
    .waitUntilBlocked(barrierAbort.signal)
    .then(
      () => ({ kind: 'barrier' }),
      (error) => ({ kind: 'barrier_error', error }),
    );
  const operationOutcome = operation.then(
    (result) => ({ kind: 'operation_result', result }),
    (error) => ({ kind: 'operation_error', error }),
  );
  const outcome = await Promise.race([barrierOutcome, operationOutcome]);
  if (outcome.kind === 'barrier') return;

  barrierAbort.abort(
    new Error('workspace operation settled before the transfer barrier'),
  );
  await barrierOutcome;
  if (outcome.kind === 'barrier_error' || outcome.kind === 'operation_error') {
    throw outcome.error;
  }
  assert.fail(
    `workspace operation settled before the transfer barrier: ${JSON.stringify(outcome.result)}`,
  );
}

test('generated private Git fixture crosses the old deadline and preserves production clone policy', { timeout: TEST_WATCHDOG_MS }, async () => {
  const story = await createStoryResources();
  let operation;
  try {
    const probed = await createProbe(story.fixture).resolveDefaultBranch(
      forgeTarget(story.fixture),
      new AbortController().signal,
    );
    assert.deepEqual(probed, { ok: true, defaultBranch: 'master' });
    assert.equal(JSON.stringify(probed).includes(story.fixture.basicAuth.password), false);

    const clock = new ManualDeadlineDriver();
    const progress = [];
    let settled = false;
    story.fixture.transferBarrier.arm();
    const stageExecutor = story.executor;
    operation = materializeSandboxGitWorkspaceStaged(
      {
        ...materializationContext(story, { deadlineMs: 900_000, stageExecutor }),
        onProgress: (event) => {
          progress.push(event);
        },
      },
      { deadlineDriver: clock },
    ).finally(() => {
      settled = true;
    });

    await waitForTransferBarrierOrFail(story.fixture, operation);
    const blocked = story.fixture.diagnostics();
    assert.equal(blocked.barrierState, 'blocked');
    assert.ok(blocked.rootUploadPackRequests.lsRefs >= 1);
    assert.ok(blocked.rootUploadPackRequests.fetch >= 1);

    clock.advance(120_001);
    assert.equal(settled, false, 'the old 120-second boundary does not settle clone');
    assert.equal(story.secrets.activePaths.size, 1);
    story.fixture.transferBarrier.release();

    const result = await operation;
    assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
    assert.equal(
      story.fixture.diagnostics().rootUploadPackRequests.barrierBlocks,
      1,
    );
    assert.equal(clock.pendingTriggerCount, 0);
    await story.secrets.assertClean();

    assert.equal(await gitOutput(story.workspaceDir, ['branch', '--show-current']), 'master');
    assert.equal(
      await gitOutput(story.workspaceDir, ['rev-parse', '--is-shallow-repository']),
      'false',
    );
    await assert.rejects(gitOutput(story.workspaceDir, ['show-ref', '--verify', 'refs/heads/main']));
    assert.equal(await gitOutput(story.workspaceDir, ['rev-parse', 'HEAD']), story.fixture.headCommitSha);
    await gitOutput(story.workspaceDir, [
      'merge-base',
      '--is-ancestor',
      story.fixture.firstCommitSha,
      'HEAD',
    ]);
    assert.ok(Number(await gitOutput(story.workspaceDir, ['rev-list', '--count', 'HEAD'])) >= 3);
    const clonedBlob = await readFile(
      join(story.workspaceDir, story.fixture.largeBlob.path),
    );
    assert.equal(clonedBlob.byteLength, story.fixture.largeBlob.bytes);
    assert.equal(
      createHash('sha256').update(clonedBlob).digest('hex'),
      story.fixture.largeBlob.sha256,
    );
    assert.equal(
      await gitOutput(join(story.workspaceDir, story.fixture.submodules.sameOriginPath), [
        'rev-parse',
        '--is-inside-work-tree',
      ]),
      'true',
    );
    assert.equal(
      await gitOutput(join(story.workspaceDir, story.fixture.submodules.crossOriginPath), [
        'rev-parse',
        '--is-inside-work-tree',
      ]),
      'true',
    );

    const evidence = story.fixture.authorizationEvidence();
    const root = evidence.filter((entry) => entry.repository === 'root-private');
    const sameOrigin = evidence.filter(
      (entry) => entry.repository === 'same-origin-private',
    );
    const crossOrigin = evidence.filter(
      (entry) => entry.repository === 'cross-origin-public',
    );
    assert.ok(root.length > 0);
    assert.ok(
      root.every((entry) => entry.authorizationReceived && entry.authorized),
    );
    assert.ok(sameOrigin.length > 0);
    assert.ok(
      sameOrigin.every(
        (entry) => entry.authorizationReceived && entry.authorized,
      ),
    );
    assert.ok(crossOrigin.length > 0);
    assert.ok(
      crossOrigin.every(
        (entry) => !entry.authorizationReceived && entry.authorized,
      ),
    );
    assert.equal(story.fixture.diagnostics().crossOriginAuthorizationLeakCount, 0);
    assertStageObservationsSafe(story, 'success result/progress/evidence', {
      result,
      progress,
      evidence,
    });
  } finally {
    await disposeStoryResources(story, operation);
  }
});

test('production materializer classifies bounded capacity evidence without retry', { timeout: TEST_WATCHDOG_MS }, async () => {
  const story = await createStoryResources();
  let operation;
  try {
    const clock = new ManualDeadlineDriver();
    const stageExecutor = {
      execute: (execution) =>
        story.executor.execute(
          execution.stage === 'workspace_transfer'
            ? {
                ...execution,
                request: {
                  ...execution.request,
                  command: `printf '%s\\n' '${CAPACITY_FAILURE}' >&2; exit 1`,
                },
              }
            : execution,
        ),
    };
    operation = materializeSandboxGitWorkspaceStaged(
      materializationContext(story, { deadlineMs: 900_000, stageExecutor }),
      { deadlineDriver: clock },
    );
    const result = await operation;
    assert.deepEqual(result, {
      status: 'failed',
      stage: 'workspace_transfer',
      cause: 'capacity_exhausted',
      retryable: false,
    });
    assert.deepEqual(
      classifySandboxGitFailure({
        stage: 'workspace_transfer',
        result: {
          exitCode: 1,
          output: '',
          stdout: '',
          stderr: CAPACITY_FAILURE,
          timedOut: false,
        },
      }),
      { cause: 'capacity_exhausted', retryable: false },
    );
    assert.ok(story.fixture.diagnostics().rootUploadPackRequests.lsRefs >= 1);
    await story.secrets.assertClean();
    assertStageObservationsSafe(story, 'capacity result/observations', {
      result,
    });
  } finally {
    await disposeStoryResources(story, operation);
  }
});

test('workspace deadline kills transfer and closes the process before deleting credential', { timeout: TEST_WATCHDOG_MS }, async () => {
  const story = await createStoryResources();
  let operation;
  try {
    const clock = new ManualDeadlineDriver();
    story.fixture.transferBarrier.arm();
    const stageExecutor = story.executor;
    operation = materializeSandboxGitWorkspaceStaged(
      materializationContext(story, { deadlineMs: 130_000, stageExecutor }),
      { deadlineDriver: clock },
    );

    await waitForTransferBarrierOrFail(story.fixture, operation);
    assert.equal(story.secrets.activePaths.size, 1);
    clock.advance(130_000);
    story.fixture.transferBarrier.release();

    const result = await operation;
    assert.deepEqual(result, {
      status: 'failed',
      stage: 'workspace_transfer',
      cause: 'timeout',
      retryable: true,
    });
    assert.equal(clock.pendingTriggerCount, 0);
    assert.ok(
      story.lifecycle.includes('process:kill:workspace_transfer:abort'),
      'deadline sends SIGKILL to the active transfer',
    );
    const transferClose = story.lifecycle.lastIndexOf(
      'process:close:workspace_transfer',
    );
    const credentialDelete = story.lifecycle.lastIndexOf('secret:delete:start');
    assert.ok(transferClose >= 0);
    assert.ok(
      credentialDelete > transferClose,
      'credential deletion starts only after the killed process closes',
    );
    const transferObservation = [...story.executor.observations]
      .reverse()
      .find((observation) => observation.stage === 'workspace_transfer');
    assert.ok(transferObservation);
    assert.equal(transferObservation.killReason, 'abort');
    assert.equal(transferObservation.closeSignal, 'SIGKILL');
    await story.secrets.assertClean();
    assert.equal(story.executor.activeChildCount, 0);
    assertStageObservationsSafe(story, 'timeout result/lifecycle/observations', {
      result,
      lifecycle: story.lifecycle,
    });
  } finally {
    await disposeStoryResources(story, operation);
  }
});

function gitProcessEnvironment() {
  const environment = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    LC_ALL: 'C',
  };
  if (process.env.PATH) environment.PATH = process.env.PATH;
  if (process.env.SSL_CERT_FILE) environment.SSL_CERT_FILE = process.env.SSL_CERT_FILE;
  if (process.env.SSL_CERT_DIR) environment.SSL_CERT_DIR = process.env.SSL_CERT_DIR;
  return environment;
}

function killProcessGroup(child) {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
    child.kill('SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function assertForbiddenValuesAbsent(
  serialized,
  forbiddenValues,
  location,
) {
  for (const value of forbiddenValues) {
    assert.equal(
      serialized.includes(value),
      false,
      `${location} must not contain generated credential material`,
    );
  }
}

function assertStageObservationsSafe(
  story,
  location,
  result,
) {
  assert.ok(
    story.executor.observations.every(
      (observation) => observation.outputBytes <= MAX_STAGE_OUTPUT_BYTES,
    ),
    'each stage keeps combined stdout/stderr within its byte bound',
  );
  assertForbiddenValuesAbsent(
    JSON.stringify({ ...result, observations: story.executor.observations }),
    story.forbiddenValues,
    location,
  );
}

function gitOutput(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        encoding: 'utf8',
        env: gitProcessEnvironment(),
        maxBuffer: MAX_ASSERTION_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
