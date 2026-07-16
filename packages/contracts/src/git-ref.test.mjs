import test from 'node:test';
import assert from 'node:assert/strict';

import { GitBranchNameSchema, isValidGitBranchName } from '../dist/git-ref.js';

test('verified git branch names preserve exact valid values, including master', () => {
  assert.equal(GitBranchNameSchema.parse('master'), 'master');
  assert.equal(GitBranchNameSchema.parse('feature/topic-1'), 'feature/topic-1');
});

test('git branch schema rejects surrounding whitespace instead of normalizing intent', () => {
  assert.equal(GitBranchNameSchema.safeParse(' feature/topic ').success, false);
});

test('git branch validator rejects option-like, control, and invalid ref syntax', () => {
  for (const value of [
    '-malicious',
    'feature\nname',
    'feature name',
    '../main',
    'feature//name',
    'feature@{1}',
    '.hidden/name',
    'feature/name.lock',
    'feature\\name',
  ]) {
    assert.equal(isValidGitBranchName(value), false, value);
  }
});
