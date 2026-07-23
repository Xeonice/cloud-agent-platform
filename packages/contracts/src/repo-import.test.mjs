import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CreateRepoRequestSchema,
  LOCAL_REPO_IMPORT_ROOT_ENV,
  LocalRepoImportAvailabilitySchema,
  LocalRepoImportRequestSchema,
  REPO_IMPORT_FAILURE_CODES,
  RepoCopyStatusSchema,
  RepoImportFailureSchema,
  RepoResponseSchema,
  VerifiedRepoImportResponseSchema,
  isLocalRepoGitSource,
  repoOffersForgeDelivery,
} from '../dist/index.js';

const repo = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'private-app',
  gitSource: 'https://gitee.com/team/private-app.git',
  createdAt: '2026-07-16T00:00:00.000Z',
  forge: 'gitee',
};

test('verified import responses require a real valid branch while legacy reads stay nullable', () => {
  assert.equal(
    VerifiedRepoImportResponseSchema.parse({
      ...repo,
      defaultBranch: 'master',
    }).defaultBranch,
    'master',
  );
  for (const defaultBranch of [null, undefined, ' invalid branch ']) {
    assert.equal(
      VerifiedRepoImportResponseSchema.safeParse({
        ...repo,
        defaultBranch,
      }).success,
      false,
    );
  }
  assert.equal(
    RepoResponseSchema.safeParse({ ...repo, defaultBranch: null }).success,
    true,
  );
  assert.equal(RepoResponseSchema.safeParse(repo).success, true);
});

test('repo import request carries selection intent but cannot select owner, token, or branch metadata', () => {
  const parsed = CreateRepoRequestSchema.parse({
    name: 'private-app',
    gitSource: repo.gitSource,
    forge: 'gitee',
    importSource: 'url',
    ownerUserId: 'attacker-selected-owner',
    token: 'secret-canary',
    defaultBranch: 'main',
  });

  assert.deepEqual(parsed, {
    name: 'private-app',
    gitSource: repo.gitSource,
    forge: 'gitee',
    importSource: 'url',
  });
});

test('repo import failure codes are complete, bounded, and reject diagnostic fields', () => {
  assert.deepEqual(REPO_IMPORT_FAILURE_CODES, [
    'session_operator_required',
    'repo_git_source_invalid',
    'repo_git_source_credentials_forbidden',
    'repo_forge_unresolved',
    'repo_forge_auth_required',
    'repo_forge_authentication_failed',
    'repo_forge_access_denied',
    'repo_forge_network_unavailable',
    'repo_platform_dependency_unavailable',
    'repo_default_branch_unresolved',
    'repo_picker_candidate_not_accessible',
    'repo_import_identity_conflict',
    // add-repo-content-store: content-copy acquisition/refresh failures, kept
    // distinct from the metadata codes above so a console can tell "could not
    // verify the repo" from "repo registered, copy not ready (retry a refresh)".
    'repo_copy_authentication_failed',
    'repo_copy_access_denied',
    'repo_copy_network_unavailable',
    'repo_copy_source_invalid',
    'repo_copy_missing',
    'repo_copy_store_unavailable',
    'repo_copy_platform_dependency_unavailable',
    'repo_copy_acquisition_aborted',
    // add-repo-content-store: repo DELETION refused while tasks/schedules still
    // reference the repo (the DB cascade would silently take them along).
    'repo_has_tasks',
    // local-repo-import: the fail-closed local-path gate.
    'repo_local_import_disabled',
    'repo_local_import_path_invalid',
    'repo_local_import_path_outside_root',
    'repo_local_import_path_not_found',
    'repo_local_import_not_a_git_repository',
  ]);

  for (const error of REPO_IMPORT_FAILURE_CODES) {
    assert.equal(
      RepoImportFailureSchema.safeParse({ error, message: 'Safe operator copy.' })
        .success,
      true,
      error,
    );
  }
  assert.equal(
    RepoImportFailureSchema.safeParse({
      error: 'repo_default_branch_unresolved',
      message: 'Safe operator copy.',
      token: 'secret-canary',
      rawOutput: 'git ls-remote diagnostic',
      providerEndpoint: 'https://provider.internal',
    }).success,
    false,
  );
  assert.equal(
    RepoImportFailureSchema.safeParse({
      error: 'repo_not_canonical',
      message: 'Safe operator copy.',
    }).success,
    false,
  );
  assert.equal(
    RepoImportFailureSchema.safeParse({
      error: 'repo_forge_network_unavailable',
      message: 'x'.repeat(1_025),
    }).success,
    false,
  );
});


// ---------------------------------------------------------------------------
// add-repo-content-store — additive repo content-copy fields
// ---------------------------------------------------------------------------

test('repo reads expose copy status and timestamp while pre-copy payloads still parse', () => {
  // A payload produced BEFORE the content store existed carries neither field.
  // It must keep parsing, with both fields simply absent (never defaulted into a
  // claim that a copy exists).
  const legacy = RepoResponseSchema.parse(repo);
  assert.equal('copyStatus' in legacy, false);
  assert.equal('copyUpdatedAt' in legacy, false);

  const ready = RepoResponseSchema.parse({
    ...repo,
    copyStatus: 'ready',
    copyUpdatedAt: '2026-07-23T01:02:03.000Z',
  });
  assert.equal(ready.copyStatus, 'ready');
  assert.deepEqual(ready.copyUpdatedAt, new Date('2026-07-23T01:02:03.000Z'));

  // `missing` is legal WITHOUT a timestamp: nothing has ever been materialized.
  const missing = RepoResponseSchema.parse({
    ...repo,
    copyStatus: 'missing',
    copyUpdatedAt: null,
  });
  assert.equal(missing.copyStatus, 'missing');
  assert.equal(missing.copyUpdatedAt, null);

  assert.deepEqual(RepoCopyStatusSchema.options, [
    'missing',
    'refreshing',
    'ready',
    'failed',
  ]);
  assert.equal(
    RepoResponseSchema.safeParse({ ...repo, copyStatus: 'stale' }).success,
    false,
  );
});

test('locally imported repos are classified as forge-less for delivery reads', () => {
  assert.equal(isLocalRepoGitSource('/local-repos/acme/app'), true);
  assert.equal(isLocalRepoGitSource('  /local-repos/acme/app  '), true);
  assert.equal(isLocalRepoGitSource('https://gitee.com/team/private-app.git'), false);
  assert.equal(isLocalRepoGitSource('http://git.internal/team/app.git'), false);
  // A UNC-ish/protocol-relative form is NOT treated as a local absolute path.
  assert.equal(isLocalRepoGitSource('//host/share/repo.git'), false);

  assert.equal(
    repoOffersForgeDelivery({ gitSource: '/local-repos/acme/app', forge: null }),
    false,
  );
  // A forge column can never resurrect delivery for a local path.
  assert.equal(
    repoOffersForgeDelivery({ gitSource: '/local-repos/acme/app', forge: 'github' }),
    false,
  );
  // A remote repo with an unknown forge stays eligible (host inferred at use).
  assert.equal(repoOffersForgeDelivery({ gitSource: repo.gitSource, forge: null }), true);
});

test('local import request and availability shapes are bounded and fail-closed', () => {
  assert.deepEqual(
    LocalRepoImportRequestSchema.parse({ path: '  acme/app  ', name: ' App ' }),
    { path: 'acme/app', name: 'App' },
  );
  assert.equal(LocalRepoImportRequestSchema.safeParse({ path: '' }).success, false);
  assert.equal(LocalRepoImportRequestSchema.safeParse({}).success, false);

  assert.deepEqual(
    LocalRepoImportAvailabilitySchema.parse({
      enabled: false,
      root: null,
      envVar: LOCAL_REPO_IMPORT_ROOT_ENV,
    }),
    { enabled: false, root: null, envVar: 'CAP_LOCAL_IMPORT_ROOT' },
  );
  // The probe never carries anything beyond the three declared fields.
  assert.equal(
    LocalRepoImportAvailabilitySchema.safeParse({
      enabled: true,
      root: '/local-repos',
      envVar: LOCAL_REPO_IMPORT_ROOT_ENV,
      entries: ['acme/app'],
    }).success,
    false,
  );
});
