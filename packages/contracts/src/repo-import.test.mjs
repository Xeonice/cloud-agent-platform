import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CreateRepoRequestSchema,
  REPO_IMPORT_FAILURE_CODES,
  RepoImportFailureSchema,
  RepoResponseSchema,
  VerifiedRepoImportResponseSchema,
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
