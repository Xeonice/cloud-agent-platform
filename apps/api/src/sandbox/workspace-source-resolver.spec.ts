/**
 * add-repo-content-store Track 4.1 — workspace-source selection.
 *
 * Pins the injection matrix at its single decision point: capability-driven
 * variant choice, fail-closed behavior when no variant is available, copy
 * readiness gating, repo-store volume resolution (env override + container
 * self-detection), and the operator gate that restores the legacy clone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPO_SOURCE_MOUNT_PATH,
  REPO_STORE_VOLUME_ENV,
  WORKSPACE_GIT_FALLBACK_ENV,
  WorkspaceSourceResolutionError,
  WorkspaceSourceResolver,
  isWorkspaceSourceResolutionError,
  type RepoStoreVolumeInspector,
  type WorkspaceSourceFailureReason,
} from './workspace-source-resolver';
import { classifyTaskProvisioningDiagnosticPrimaryFailure } from '../task-provisioning-diagnostics/task-provisioning-diagnostic-primary.classifier';
import type { PrismaService } from '../prisma/prisma.service';
import type { RepoStoreService } from '../repo-store/repo-store.service';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const GIT_SOURCE = 'https://github.com/acme/widgets.git';

function makePrisma(
  repo: { id: string; gitSource: string; copyStatus: string } | null,
): PrismaService {
  return {
    task: {
      findUnique: async () => (repo === null ? null : { repo }),
    },
  } as unknown as PrismaService;
}

function makeRepoStore(hasCopy: boolean): RepoStoreService {
  return {
    storeRoot: () => '/repo-store',
    copySubpath: (repoId: string) => `${repoId}.git`,
    copyPath: (repoId: string) => `/repo-store/${repoId}.git`,
    hasCopy: async () => hasCopy,
  } as unknown as RepoStoreService;
}

function makeInspector(name: string | null): RepoStoreVolumeInspector & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    resolveVolumeName: async (destination: string) => {
      calls.push(destination);
      return name;
    },
  };
}

const readyRepo = {
  id: REPO_ID,
  gitSource: GIT_SOURCE,
  copyStatus: 'ready',
};

test('volume-capable providers receive a read-only per-repo subpath source', async () => {
  const inspector = makeInspector('cap_repo-store');
  const resolver = new WorkspaceSourceResolver(
    makePrisma(readyRepo),
    makeRepoStore(true),
    inspector,
    {},
  );
  const source = await resolver.resolve(TASK_ID, [
    'terminal.websocket',
    'workspace.git.materialize',
    'workspace.source.volume',
    'workspace.source.git',
  ]);
  assert.deepEqual(source, {
    kind: 'volume',
    repoId: REPO_ID,
    volumeName: 'cap_repo-store',
    subpath: `${REPO_ID}.git`,
    mountPath: REPO_SOURCE_MOUNT_PATH,
    gitSource: GIT_SOURCE,
  });
  assert.deepEqual(inspector.calls, ['/repo-store']);
});

test('archive-only providers receive the host store path to stream', async () => {
  const resolver = new WorkspaceSourceResolver(
    makePrisma(readyRepo),
    makeRepoStore(true),
    makeInspector(null),
    {},
  );
  const source = await resolver.resolve(TASK_ID, [
    'workspace.git.materialize',
    'workspace.source.archive',
    'workspace.source.git',
  ]);
  assert.deepEqual(source, {
    kind: 'archive',
    repoId: REPO_ID,
    storePath: `/repo-store/${REPO_ID}.git`,
    gitSource: GIT_SOURCE,
  });
});

test('volume wins when a provider declares both variants', async () => {
  const resolver = new WorkspaceSourceResolver(
    makePrisma(readyRepo),
    makeRepoStore(true),
    makeInspector('vol'),
    {},
  );
  const source = await resolver.resolve(TASK_ID, [
    'workspace.source.archive',
    'workspace.source.volume',
  ]);
  assert.equal(source.kind, 'volume');
});

test('an env-configured volume name overrides container self-detection', async () => {
  const inspector = makeInspector('detected');
  const resolver = new WorkspaceSourceResolver(
    makePrisma(readyRepo),
    makeRepoStore(true),
    inspector,
    { [REPO_STORE_VOLUME_ENV]: 'operator-volume' },
  );
  const source = await resolver.resolve(TASK_ID, ['workspace.source.volume']);
  assert.equal(
    source.kind === 'volume' ? source.volumeName : null,
    'operator-volume',
  );
  assert.deepEqual(inspector.calls, [], 'no docker inspection when configured');
});

test('an undetectable repo-store volume fails closed and names the env var', async () => {
  const resolver = new WorkspaceSourceResolver(
    makePrisma(readyRepo),
    makeRepoStore(true),
    makeInspector(null),
    {},
  );
  await assert.rejects(
    () => resolver.resolve(TASK_ID, ['workspace.source.volume']),
    (error: unknown) => {
      assert.ok(isWorkspaceSourceResolutionError(error));
      assert.equal(error.reason, 'store_volume_unresolved');
      assert.match(error.message, new RegExp(REPO_STORE_VOLUME_ENV));
      return true;
    },
  );
});

test('a provider with no injection capability fails closed naming capability and gate', async () => {
  const resolver = new WorkspaceSourceResolver(
    makePrisma(readyRepo),
    makeRepoStore(true),
    makeInspector('vol'),
    {},
  );
  await assert.rejects(
    () =>
      resolver.resolve(TASK_ID, ['terminal.websocket', 'workspace.git.materialize']),
    (error: unknown) => {
      assert.ok(isWorkspaceSourceResolutionError(error));
      assert.equal(error.reason, 'unsupported_provider');
      assert.match(error.message, /workspace\.source\.volume/u);
      assert.match(error.message, /workspace\.source\.archive/u);
      assert.match(error.message, new RegExp(WORKSPACE_GIT_FALLBACK_ENV));
      return true;
    },
  );
});

test('a copy that is not ready fails closed with an actionable refresh hint', async () => {
  for (const [copyStatus, present] of [
    ['missing', false],
    ['refreshing', true],
    ['failed', true],
    // Durable row says ready but the store volume no longer carries the copy.
    ['ready', false],
  ] as const) {
    const resolver = new WorkspaceSourceResolver(
      makePrisma({ ...readyRepo, copyStatus }),
      makeRepoStore(present),
      makeInspector('vol'),
      {},
    );
    await assert.rejects(
      () => resolver.resolve(TASK_ID, ['workspace.source.volume']),
      (error: unknown) => {
        assert.ok(isWorkspaceSourceResolutionError(error));
        assert.equal(error.reason, 'copy_not_ready');
        assert.match(error.message, /Refresh the repository/u);
        return true;
      },
      `copyStatus=${copyStatus} present=${present}`,
    );
  }
});

test('the git fallback gate selects the legacy clone variant without touching the store', async () => {
  const store = makeRepoStore(false);
  const resolver = new WorkspaceSourceResolver(
    makePrisma({ ...readyRepo, copyStatus: 'missing' }),
    store,
    makeInspector(null),
    { [WORKSPACE_GIT_FALLBACK_ENV]: 'true' },
  );
  assert.equal(resolver.gitFallbackEnabled(), true);
  const source = await resolver.resolve(TASK_ID, ['terminal.websocket']);
  assert.deepEqual(source, { kind: 'git', spec: { url: GIT_SOURCE } });
});

test('the fallback gate is off unless explicitly enabled', () => {
  const build = (env: NodeJS.ProcessEnv) =>
    new WorkspaceSourceResolver(
      makePrisma(readyRepo),
      makeRepoStore(true),
      makeInspector('vol'),
      env,
    );
  assert.equal(build({}).gitFallbackEnabled(), false);
  assert.equal(
    build({ [WORKSPACE_GIT_FALLBACK_ENV]: 'false' }).gitFallbackEnabled(),
    false,
  );
  assert.equal(
    build({ [WORKSPACE_GIT_FALLBACK_ENV]: '1' }).gitFallbackEnabled(),
    true,
  );
});

test('selection failures carry a typed, distinguishable durable diagnostic', () => {
  // Track 4.5: copy-not-ready, an unsupported provider, and a deployment-wiring
  // failure must not collapse into one indistinguishable "unknown".
  const classify = (reason: WorkspaceSourceFailureReason) =>
    classifyTaskProvisioningDiagnosticPrimaryFailure(
      new WorkspaceSourceResolutionError(reason, 'test'),
      'accepted',
    );
  const copyNotReady = classify('copy_not_ready');
  assert.equal(copyNotReady.stage, 'workspace_transfer');
  assert.equal(copyNotReady.operation, 'repository_transfer');
  assert.equal(copyNotReady.cause, 'ref_not_found');
  assert.equal(copyNotReady.retryable, false);

  const unsupported = classify('unsupported_provider');
  assert.equal(unsupported.stage, 'provider_selection');
  assert.equal(unsupported.cause, 'provider_unavailable');

  const volume = classify('store_volume_unresolved');
  assert.equal(volume.stage, 'workspace_transfer');
  assert.equal(volume.cause, 'protocol_failed');

  // …and all three stay distinct from an in-sandbox local-clone failure, which
  // the materialization engine reports on the checkout stage.
  assert.notEqual(copyNotReady.operation, 'checkout');
  assert.notEqual(unsupported.cause, copyNotReady.cause);
  assert.notEqual(volume.cause, copyNotReady.cause);
});

test('a task without a resolvable repository fails closed', async () => {
  const resolver = new WorkspaceSourceResolver(
    makePrisma(null),
    makeRepoStore(true),
    makeInspector('vol'),
    {},
  );
  await assert.rejects(
    () => resolver.resolve(TASK_ID, ['workspace.source.volume']),
    (error: unknown) => {
      assert.ok(isWorkspaceSourceResolutionError(error));
      assert.equal(error.reason, 'repo_unavailable');
      return true;
    },
  );
});
