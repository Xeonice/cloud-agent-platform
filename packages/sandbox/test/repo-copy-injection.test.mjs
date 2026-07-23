/**
 * add-repo-content-store Track 4 — repo-copy injection seam.
 *
 * Drives the REAL staged materialization engine with the REAL workspace-source
 * variants and pins the whole chain end to end:
 *
 *  - volume: mount preparation -> in-sandbox local clone from the read-only
 *    mount -> checkout + `origin` rewritten to the Repo's recorded git source
 *  - archive: a REAL tar of a REAL bare mirror streamed through the provider
 *    archive transport -> in-sandbox local clone -> checkout + origin rewrite
 *  - neither variant stages a git credential inside the sandbox, contacts a
 *    remote, or launches a detached transfer job
 *  - transfer failures settle on a different durable stage than local-clone
 *    failures (task-provisioning-diagnostics delta)
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

const CANARY = 'CAP_INJECTION_SECRET_CANARY_51ab';
const GIT_SOURCE = 'https://gitee.com/acme/private.git';
const REPO_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_DIR = '/home/gem/workspace';
const REPO_SOURCE_DIR = '/home/gem/.cap-repo-source';

let passed = 0;
function check(condition, label) {
  assert.ok(condition, label);
  passed++;
}

function executionResult(overrides = {}) {
  return {
    exitCode: 0,
    output: '',
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function recordingExecutor(behavior = () => executionResult()) {
  const calls = [];
  return {
    calls,
    executor: {
      async execute(execution) {
        calls.push(execution);
        return behavior(execution, calls.length);
      },
    },
  };
}

function secretPortSpy() {
  const writes = [];
  return {
    writes,
    port: {
      async writeSecretFile() {
        writes.push('written');
        return { path: '/run/cap-secrets/fixture', mode: 0o600 };
      },
      async deleteSecretFile() {},
    },
  };
}

function context(overrides = {}) {
  return {
    taskId: 'task-injection-fixture',
    plan: {
      repositoryUrl: GIT_SOURCE,
      callerBranch: null,
      resolvedBranch: 'main',
      deadlineMs: 60_000,
      credential: mod.createExactHostGitCredential(
        GIT_SOURCE,
        `Authorization: Basic ${CANARY}`,
      ),
    },
    workspaceDir: WORKSPACE_DIR,
    ...overrides,
  };
}

const volumeSource = {
  kind: 'volume',
  repoId: REPO_ID,
  volumeName: 'cap_repo-store',
  subpath: `${REPO_ID}.git`,
  mountPath: '/cap-repo-source',
  gitSource: GIT_SOURCE,
};

// ---------------------------------------------------------------- volume ---
{
  const { calls, executor } = recordingExecutor();
  const secrets = secretPortSpy();
  const progress = [];
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    context({
      source: volumeSource,
      stageExecutor: executor,
      secretFilePort: secrets.port,
      onProgress: (event) => progress.push(event),
      // A detached-transfer configuration must be IGNORED by injection: the
      // default path may never launch an in-sandbox detached clone job.
      detachedTransfer: { pollIntervalMs: 10 },
    }),
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.deepEqual(
    calls.map((call) => call.stage),
    ['remote_ref_resolution', 'workspace_transfer', 'checkout'],
    'volume injection runs mount-prepare, local clone, checkout',
  );
  const [mountProbe, clone, checkout] = calls.map(
    (call) => call.request.command,
  );
  check(
    /test -d '\/cap-repo-source'/u.test(mountProbe) &&
      // safe.directory must come from a PROTECTED config scope: `-c` and
      // GIT_CONFIG_* are ignored by git (verified live on git 2.34.1).
      /\[safe\]\\n\\tdirectory = %s\\n' '\/cap-repo-source'/u.test(mountProbe) &&
      /GIT_CONFIG_GLOBAL="\$cap_repo_copy_gitconfig" git -C '\/cap-repo-source' rev-parse --verify --quiet 'refs\/heads\/main\^\{commit\}'/u.test(
        mountProbe,
      ) &&
      /rm -f "\$cap_repo_copy_gitconfig"; exit \$cap_repo_copy_status$/u.test(
        mountProbe,
      ),
    'mount preparation trusts the copy, verifies the branch, and cleans up',
  );
  check(
    /GIT_CONFIG_GLOBAL="\$cap_repo_copy_gitconfig" git clone --no-hardlinks --no-checkout --single-branch --branch 'main' -- '\/cap-repo-source' '\/home\/gem\/workspace'/u.test(
      clone,
    ),
    'workspace is produced by a local clone from the read-only mount',
  );
  check(
    /checkout --force -B 'main' 'refs\/remotes\/origin\/main'/u.test(checkout) &&
      checkout.includes(`remote set-url origin '${GIT_SOURCE}'`),
    'checkout converges the workspace and repoints origin at the recorded source',
  );
  const allCommands = calls.map((call) => call.request.command).join('\n');
  check(
    !allCommands.includes(CANARY) &&
      !/ls-remote/u.test(allCommands) &&
      // The recorded git source appears ONLY as the origin rewrite target;
      // nothing ever fetches from it inside the sandbox.
      !/(clone|fetch|pull)[^\n]*https:\/\//u.test(allCommands),
    'no credential and no network transfer reaches the sandbox on the volume path',
  );
  check(
    secrets.writes.length === 0,
    'no git credential file is staged for an injected workspace',
  );
  check(
    !/setsid|cap-jobs/u.test(allCommands),
    'no detached workspace-transfer job is launched',
  );
  check(
    progress.some(
      (event) =>
        event.status === 'succeeded' && event.stage === 'workspace_transfer',
    ) && progress.at(-1).stage === 'complete',
    'stage progress is reported for the injection stages',
  );
}

// volume: a failing local clone settles on the workspace_transfer stage
{
  const { executor } = recordingExecutor((execution) =>
    execution.stage === 'workspace_transfer'
      ? executionResult({ exitCode: 128, output: 'fatal: destination exists' })
      : executionResult(),
  );
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    context({ source: volumeSource, stageExecutor: executor }),
  );
  check(
    result.status === 'failed' && result.stage === 'workspace_transfer',
    'a failed in-sandbox local clone settles on its own stage',
  );
}

// --------------------------------------------------------------- archive ---
const scratch = mkdtempSync(join(tmpdir(), 'cap-repo-store-'));
try {
  // A REAL bare mirror, so the streamed tar carries real git content.
  const origin = join(scratch, 'origin');
  mkdirSync(origin);
  const git = (args, cwd) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'cap',
        GIT_AUTHOR_EMAIL: 'cap@example.com',
        GIT_COMMITTER_NAME: 'cap',
        GIT_COMMITTER_EMAIL: 'cap@example.com',
      },
    });
  git(['init', '--initial-branch=main', '.'], origin);
  writeFileSync(join(origin, 'README.md'), '# injected\n');
  git(['add', '.'], origin);
  git(['commit', '-m', 'seed'], origin);
  const storePath = join(scratch, `${REPO_ID}.git`);
  git(['clone', '--mirror', origin, storePath], scratch);

  const archiveSource = {
    kind: 'archive',
    repoId: REPO_ID,
    storePath,
    gitSource: GIT_SOURCE,
  };

  const { calls, executor } = recordingExecutor();
  const uploads = [];
  const progressEvents = [];
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    context({
      source: archiveSource,
      stageExecutor: executor,
      onProgress: (event) => {
        if (event.status === 'progress') progressEvents.push(event);
      },
      archiveTransfer: {
        async uploadArchive(request) {
          const chunks = [];
          let delivered = 0;
          for await (const chunk of request.archive) {
            chunks.push(chunk);
            delivered += chunk.length;
            // Transports report monotonically increasing delivered bytes
            // (chunk-archive-injection-with-progress D2).
            request.onBytesUploaded?.(delivered);
          }
          uploads.push({ path: request.path, tar: Buffer.concat(chunks) });
        },
      },
    }),
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  check(
    progressEvents.length >= 1 &&
      progressEvents.every(
        (event) =>
          event.stage === 'workspace_transfer' &&
          event.progress.receivedBytes > 0 &&
          (event.progress.percent === null ||
            (event.progress.percent >= 0 && event.progress.percent <= 99)),
      ),
    'archive transfer emits byte-based workspace_transfer progress capped below 100',
  );
  assert.deepEqual(
    calls.map((call) => call.stage),
    ['workspace_transfer', 'checkout'],
    'archive injection stages the box directory then clones locally',
  );
  check(
    /rm -rf -- '\/home\/gem\/\.cap-repo-source' && mkdir -p -- '\/home\/gem\/\.cap-repo-source'/u.test(
      calls[0].request.command,
    ),
    'the box-side repo source directory is prepared before the transfer',
  );
  check(uploads.length === 1, 'exactly one archive upload is performed');
  check(
    uploads[0].path === REPO_SOURCE_DIR,
    'the archive is uploaded to the repo-source directory',
  );

  // The uploaded bytes are a real tar of the bare mirror: unpack and prove it.
  const unpack = join(scratch, 'unpacked');
  mkdirSync(unpack);
  const tarPath = join(scratch, 'upload.tar');
  writeFileSync(tarPath, uploads[0].tar);
  execFileSync('tar', ['-C', unpack, '-xf', tarPath], { stdio: 'pipe' });
  const unpacked = join(unpack, `${REPO_ID}.git`);
  const head = execFileSync('git', ['-C', unpacked, 'rev-parse', 'HEAD'], {
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
    .toString()
    .trim();
  const refs = execFileSync('git', ['-C', unpacked, 'show-ref'], {
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).toString();
  check(/^[0-9a-f]{40}$/u.test(head), 'the uploaded tar is a usable bare repo');
  check(refs.includes('refs/heads/main'), 'the uploaded mirror carries its refs');

  const cloneCommand = calls[1].request.command;
  check(
    cloneCommand.includes(`${REPO_SOURCE_DIR}/${REPO_ID}.git`) &&
      cloneCommand.includes(`${REPO_SOURCE_DIR}/extracted/${REPO_ID}.git`),
    'the local clone resolves both daemon extraction layouts',
  );
  check(
    /\[safe\]\\n\\tdirectory = %s\\n' "\$src"/u.test(cloneCommand) &&
      /GIT_CONFIG_GLOBAL="\$cap_repo_copy_gitconfig" git clone --no-hardlinks/u.test(
        cloneCommand,
      ),
    'the local clone trusts the unpacked copy through a protected config scope',
  );
  check(
    cloneCommand.includes(`remote set-url origin '${GIT_SOURCE}'`),
    'the archive path repoints origin at the recorded git source',
  );
  check(
    !cloneCommand.includes(CANARY),
    'no credential material reaches the box on the archive path',
  );

  // Transfer failure settles on workspace_transfer, distinct from the clone.
  {
    const failing = recordingExecutor();
    const failed = await mod.materializeSandboxGitWorkspaceStaged(
      context({
        source: archiveSource,
        stageExecutor: failing.executor,
        archiveTransfer: {
          async uploadArchive() {
            throw new Error('boxlite archive upload failed: HTTP 502');
          },
        },
      }),
    );
    check(
      failed.status === 'failed' && failed.stage === 'workspace_transfer',
      'a failed archive transfer settles on the transfer stage',
    );
    check(
      failing.calls.every((call) => call.stage !== 'checkout'),
      'no local clone is attempted after a failed transfer',
    );
  }

  // A missing archive transport is a configuration failure, not a silent skip.
  {
    const noTransport = recordingExecutor();
    const failed = await mod.materializeSandboxGitWorkspaceStaged(
      context({ source: archiveSource, stageExecutor: noTransport.executor }),
    );
    check(
      failed.status === 'failed' && failed.stage === 'workspace_transfer',
      'archive injection without a transport fails closed',
    );
  }

  // ------------------------------------------- boxlite provider end-to-end ---
  // Task 4.8: drive the REAL BoxLite provider + REAL materialization engine
  // against a mocked daemon, and prove the whole chain: tar of the real bare
  // mirror lands through uploadArchive, and the box then runs the
  // safe.directory local clone + origin rewrite. (Real-daemon end-to-end is a
  // verify-stage step on vibe-zlyan; the daemon layer is mocked here.)
  {
    const configResult = mod.readBoxLiteProviderConfig({
      BOXLITE_ENDPOINT: 'https://boxlite.example.test',
      BOXLITE_API_TOKEN: 'token',
      BOXLITE_IMAGE: 'ghcr.io/xeonice/cap-boxlite-sandbox:vtest',
      BOXLITE_PROVIDER_ID: 'boxlite-injection-test',
      BOXLITE_CAPABILITIES:
        'command.exec,workspace.git.materialize,workspace.git.deliver',
    });
    assert.equal(configResult.status, 'valid');
    const client = new mod.FakeBoxLiteClient();
    const provider = new mod.BoxLiteSandboxProvider({
      config: configResult.config,
      client,
      workspaceMaterialization: (workspaceContext) =>
        mod.materializeSandboxGitWorkspaceStaged(workspaceContext),
    });
    check(
      provider
        .getProviderCapabilities()
        .includes('workspace.source.archive') &&
        provider.getProviderCapabilities().includes('workspace.source.git') &&
        !provider.getProviderCapabilities().includes('workspace.source.volume'),
      'boxlite declares archive + gated git injection, never volume',
    );

    await provider.provision({
      taskId: 'boxlite-archive-injection',
      modelIntent: { kind: 'runtime-default' },
      runtimeId: 'codex',
      executionMode: 'headless-exec',
      workspace: {
        repositoryUrl: GIT_SOURCE,
        callerBranch: null,
        resolvedBranch: 'main',
        deadlineMs: 60_000,
      },
      cloneSpec: null,
      workspaceSource: {
        kind: 'archive',
        repoId: REPO_ID,
        storePath,
        gitSource: GIT_SOURCE,
      },
    });

    const sandboxId = [...client.sandboxes.keys()][0];
    // chunk-archive-injection-with-progress: the daemon buffers uploads under
    // a ~2MB body limit (modeled by FakeBoxLiteClient), so the mirror arrives
    // as ordered limit-safe parts that reassemble byte-identically.
    const partPaths = client
      .archivePaths(sandboxId)
      .filter((path) => path.startsWith(`${REPO_SOURCE_DIR}/.parts/`))
      .sort();
    check(
      partPaths.length >= 1,
      'the provider uploaded the mirror as ordered parts under .parts/',
    );
    const partBuffers = [];
    for (const path of partPaths) {
      const part = await client.downloadArchive({ sandboxId, path });
      check(part !== null, `part ${path} was stored by the daemon`);
      partBuffers.push(Buffer.from(part));
    }
    const reassembled = Buffer.concat(partBuffers);
    check(reassembled.length > 512, 'the reassembled parts carry the archive');
    const providerTar = join(scratch, 'provider-upload.tar');
    const providerUnpack = join(scratch, 'provider-unpacked');
    mkdirSync(providerUnpack);
    writeFileSync(providerTar, reassembled);
    execFileSync('tar', ['-C', providerUnpack, '-xf', providerTar], {
      stdio: 'pipe',
    });
    const providerRefs = execFileSync(
      'git',
      ['-C', join(providerUnpack, `${REPO_ID}.git`), 'show-ref'],
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    ).toString();
    check(
      providerRefs.includes('refs/heads/main'),
      'the reassembled archive is the bare mirror, refs included',
    );

    const commands = client.execCalls.map((call) => call.command);
    check(
      commands.some(
        (command) =>
          command.includes(
            `if test -d '${REPO_SOURCE_DIR}/.parts/extracted'; then parts_src='${REPO_SOURCE_DIR}/.parts/extracted'; fi`,
          ) &&
          command.includes(
            `cat "$parts_src"/* > '${REPO_SOURCE_DIR}/.cap-archive.tar'`,
          ) &&
          command.includes(`rm -rf -- '${REPO_SOURCE_DIR}/.parts'`),
      ),
      'the box resolved the extraction layout and reassembled the parts before extraction',
    );
    check(
      commands.some(
        (command) =>
          command.includes('sha256sum') && command.includes('wc -c'),
      ),
      'the box verified byte count and SHA-256 before extracting',
    );
    check(
      commands.some((command) =>
        command.includes(
          `tar -xf '${REPO_SOURCE_DIR}/.cap-archive.tar' -C '${REPO_SOURCE_DIR}'`,
        ),
      ),
      'the box extracted the verified archive at the repo-source directory',
    );
    check(
      commands.some((command) =>
        command.includes(`mkdir -p -- '${REPO_SOURCE_DIR}'`),
      ),
      'the box staged the repo-source directory before the transfer',
    );
    const localClone = commands.find((command) =>
      command.includes('clone --no-hardlinks'),
    );
    check(
      localClone !== undefined &&
        localClone.includes('directory = %s') &&
        localClone.includes('GIT_CONFIG_GLOBAL="$cap_repo_copy_gitconfig" git clone') &&
        localClone.includes(`remote set-url origin '${GIT_SOURCE}'`),
      'the box ran the trusted local clone and repointed origin',
    );
    check(
      // `origin` is rewritten to the https source in a LATER command segment;
      // what must never appear is a clone/fetch whose own arguments are a URL.
      !commands.some((command) => /(clone|fetch)[^&|]*https:\/\//u.test(command)),
      'no network git clone ran inside the box',
    );
  }

  // The tar stream itself is a real stream over the real store path.
  {
    const chunks = [];
    for await (const chunk of mod.createRepoStoreArchiveStream({ storePath })) {
      chunks.push(chunk);
    }
    check(
      Buffer.concat(chunks).length > 512,
      'createRepoStoreArchiveStream yields the mirror as streamed chunks',
    );
    await assert.rejects(
      async () => {
        for await (const _chunk of mod.createRepoStoreArchiveStream({
          storePath: join(scratch, 'does-not-exist.git'),
        })) {
          void _chunk;
        }
      },
      (error) => error?.name === 'RepoStoreArchiveStreamError',
      'a missing store path raises a typed archive-stream failure',
    );
    passed++;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// --------------------------------------------------------------- routing ---
// Orchestration picks the variant from the router's declared UNION, so the
// router must route to a provider that actually declares it — and fail closed
// when none does, instead of handing a `volume` source to an archive provider.
{
  const routable = (name, capabilities) => {
    const contexts = [];
    return {
      contexts,
      provider: {
        contexts,
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => capabilities,
        async provision(ctx) {
          contexts.push(ctx);
          return {
            taskId: ctx.taskId,
            baseUrl: `http://${name}`,
            wsUrl: `ws://${name}`,
          };
        },
      },
    };
  };
  const archiveProvider = routable('archive-provider', [
    'terminal.websocket',
    'workspace.git.materialize',
    'workspace.source.archive',
  ]);
  const volumeProvider = routable('volume-provider', [
    'terminal.websocket',
    'workspace.git.materialize',
    'workspace.source.volume',
  ]);
  const router = new mod.SandboxProviderRouter([
    mod.defineLocalSandboxProvider({
      id: 'archive-provider',
      provider: archiveProvider.provider,
      priority: 100,
    }),
    mod.defineLocalSandboxProvider({
      id: 'volume-provider',
      provider: volumeProvider.provider,
      priority: 1,
    }),
  ]);
  const provisionArgs = (source) => ({
    taskId: 'task-routing',
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    workspace: {
      repositoryUrl: GIT_SOURCE,
      callerBranch: null,
      resolvedBranch: 'main',
      deadlineMs: 60_000,
    },
    workspaceSource: source,
  });
  // Even though the archive provider has the higher priority, a `volume`
  // source routes to the provider that declares it.
  await router.provision(provisionArgs(volumeSource));
  check(
    volumeProvider.contexts.length === 1 && archiveProvider.contexts.length === 0,
    'a volume source routes to the volume-capable provider',
  );
  await assert.rejects(
    () =>
      router.provision(
        provisionArgs({
          kind: 'git',
          spec: { url: GIT_SOURCE },
        }),
      ),
    /workspace\.source\.git/u,
    'no provider declaring the gated git variant fails closed',
  );
  passed++;
}

// ----------------------------------------------------------- diagnostics ---
// Track 4.5: the durable evidence must NAME the variant it materialized from
// and identify the injection stages, keeping a transfer failure
// distinguishable from an in-sandbox local-clone failure, inside the existing
// closed diagnostic vocabulary.
function diagnosticsRecorder(seed) {
  const events = [];
  let eventId = seed;
  let operationId = seed + 50;
  const uuid = (index) =>
    `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    events,
    diagnostics: mod.createSandboxProvisioningDiagnosticEmitter({
      attemptContext: {
        schemaVersion: 1,
        taskId: '11111111-1111-4111-8111-111111111111',
        attemptId: '22222222-2222-4222-8222-222222222222',
        attempt: 1,
        admissionMode: 'durable',
        providerFamily: 'aio',
      },
      createEventId: () => uuid(eventId++),
      createOperationId: () => uuid(operationId++),
      now: () => new Date('2026-07-23T06:00:00.000Z'),
      record: async (event) => {
        events.push(event);
        return { kind: 'recorded', sequence: event.sequence };
      },
    }),
  };
}

{
  const { events, diagnostics } = diagnosticsRecorder(100);
  const { executor } = recordingExecutor();
  await mod.materializeSandboxGitWorkspaceStaged(
    context({ source: volumeSource, stageExecutor: executor, diagnostics }),
  );
  await diagnostics.flush();
  const operations = events
    .filter((event) => event.outcome !== 'started')
    .map((event) => `${event.operation}:${event.outcome}`);
  check(
    operations.join(',') ===
      [
        'credential_setup:succeeded',
        'remote_ref_resolve:succeeded',
        'repository_transfer:succeeded',
        'checkout:succeeded',
        'credential_cleanup:succeeded',
      ].join(','),
    `volume injection emits its stages durably (got ${operations.join(',')})`,
  );
  check(
    events.length > 0 &&
      events.every((event) => event.workspaceSourceKind === 'volume'),
    'every volume-injection event names the volume variant',
  );
  check(
    events.every((event) => event.stage !== 'submodules'),
    'injection never claims the network-only submodule stage',
  );
  check(
    events.length <= 12,
    'diagnostic events stay bounded for an injected materialization',
  );
}

// archive: the same closed stage vocabulary, named as the `archive` variant.
{
  const { events, diagnostics } = diagnosticsRecorder(300);
  const { executor } = recordingExecutor();
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    context({
      // The transfer body is exercised by the real-tar cases above; this case
      // only pins the evidence, so the transport may ignore the stream.
      source: {
        kind: 'archive',
        repoId: REPO_ID,
        storePath: `/var/lib/cap/repo-store/${REPO_ID}.git`,
        gitSource: GIT_SOURCE,
      },
      stageExecutor: executor,
      diagnostics,
      archiveTransfer: {
        async uploadArchive() {},
      },
    }),
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  await diagnostics.flush();
  check(
    events.length > 0 &&
      events.every((event) => event.workspaceSourceKind === 'archive'),
    'every archive-injection event names the archive variant',
  );
  check(
    events.some(
      (event) =>
        event.operation === 'repository_transfer' &&
        event.workspaceSourceKind === 'archive',
    ) &&
      events.some(
        (event) =>
          event.operation === 'checkout' &&
          event.workspaceSourceKind === 'archive',
      ),
    'the archive transfer and the in-sandbox local clone are separately named',
  );
}

// git: the legacy network-clone fallback is named too, so no workspace
// materialization evidence is left unattributed.
{
  const { events, diagnostics } = diagnosticsRecorder(500);
  const { executor } = recordingExecutor();
  const secrets = secretPortSpy();
  await mod.materializeSandboxGitWorkspaceStaged(
    context({
      source: { kind: 'git', spec: { url: GIT_SOURCE } },
      stageExecutor: executor,
      secretFilePort: secrets.port,
      diagnostics,
    }),
  );
  await diagnostics.flush();
  check(
    events.length > 0 &&
      events.every((event) => event.workspaceSourceKind === 'git'),
    'every legacy network-clone event names the git variant',
  );

  // An ABSENT source is the same legacy clone and must not be unattributed.
  const fallback = diagnosticsRecorder(700);
  const plain = recordingExecutor();
  await mod.materializeSandboxGitWorkspaceStaged(
    context({
      stageExecutor: plain.executor,
      secretFilePort: secretPortSpy().port,
      diagnostics: fallback.diagnostics,
    }),
  );
  await fallback.diagnostics.flush();
  check(
    fallback.events.length > 0 &&
      fallback.events.every((event) => event.workspaceSourceKind === 'git'),
    'an absent workspace source still reports the git variant',
  );
}

// ------------------------------------------------------- git passthrough ---
{
  const { calls, executor } = recordingExecutor();
  const secrets = secretPortSpy();
  const result = await mod.materializeSandboxGitWorkspaceStaged(
    context({
      source: { kind: 'git', spec: { url: GIT_SOURCE } },
      stageExecutor: executor,
      secretFilePort: secrets.port,
    }),
  );
  assert.deepEqual(result, { status: 'succeeded', stage: 'complete' });
  assert.deepEqual(
    calls.map((call) => call.stage),
    ['remote_ref_resolution', 'workspace_transfer', 'checkout', 'submodules'],
    'the gated git variant keeps the legacy network-clone stage sequence',
  );
  check(
    secrets.writes.length === 1,
    'the legacy path still stages its credential exactly as before',
  );
}

console.log(`repo-copy-injection: ${passed} assertions passed`);
