/**
 * add-multi-forge-task-delivery — per-forge golden tests.
 *
 * Pins each impl's EXACT request (host, path, Authorization bytes, body field
 * names) + response mapping + the idempotent-reuse + Gitee client-side filter,
 * against a capturing fetch stub (no network). Catches the copy-paste drift the
 * three forges invite (GitHub/Gitee share `/pulls`+head/base; GitLab is the
 * outlier with `/merge_requests`+source/target_branch+iid).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GithubForge } from './github-forge';
import { GiteeForge } from './gitee-forge';
import { GitlabForge } from './gitlab-forge';
import type { ForgeTarget } from './forge.port';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Queue-based capturing fetch stub. Each call consumes the next response. */
function stubFetch(responses: Array<{ ok?: boolean; status?: number; body?: string }>) {
  const captured: Captured[] = [];
  const queue = [...responses];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.push({
      url: String(url),
      method: (init?.method as string) ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body as string | undefined,
    });
    const r = queue.shift() ?? { ok: true, body: '' };
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.body ?? '',
    };
  }) as unknown as typeof fetch;
  return { captured, restore: () => (globalThis.fetch = orig) };
}

const GH: ForgeTarget = {
  kind: 'github',
  apiBaseUrl: 'https://api.github.com',
  cloneUrl: 'https://github.com/o/r.git',
  repoId: { style: 'owner-repo', owner: 'o', repo: 'r' },
  token: 'TOKEN',
};
const GITEE: ForgeTarget = {
  kind: 'gitee',
  apiBaseUrl: 'https://gitee.com/api/v5',
  cloneUrl: 'https://gitee.com/o/r.git',
  repoId: { style: 'owner-repo', owner: 'o', repo: 'r' },
  token: 'TOKEN',
};
const GL: ForgeTarget = {
  kind: 'gitlab',
  apiBaseUrl: 'https://gitlab.com/api/v4',
  cloneUrl: 'https://gitlab.com/g/p.git',
  repoId: { style: 'project', idOrPath: '123' },
  token: 'TOKEN',
};

const b64 = (s: string) => Buffer.from(s).toString('base64');

// --- cloneAuthHeader (git password slot differs per forge) -----------------

test('cloneAuthHeader: github/gitee use x-access-token, gitlab uses oauth2', () => {
  assert.equal(
    new GithubForge().cloneAuthHeader(GH),
    `Authorization: Basic ${b64('x-access-token:TOKEN')}`,
  );
  assert.equal(
    new GiteeForge().cloneAuthHeader(GITEE),
    `Authorization: Basic ${b64('x-access-token:TOKEN')}`,
  );
  assert.equal(
    new GitlabForge().cloneAuthHeader(GL),
    `Authorization: Basic ${b64('oauth2:TOKEN')}`,
  );
});

// --- GitHub ----------------------------------------------------------------

test('GithubForge.openChangeRequest pins /pulls + head/base + Bearer + maps number/html_url', async () => {
  const { captured, restore } = stubFetch([
    { body: JSON.stringify({ number: 7, html_url: 'https://github.com/o/r/pull/7', state: 'open', merged_at: null, head: { ref: 'cap/task-x' } }) },
  ]);
  try {
    const ref = await new GithubForge().openChangeRequest(GH, {
      headBranch: 'cap/task-x',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    assert.equal(captured[0].url, 'https://api.github.com/repos/o/r/pulls');
    assert.equal(captured[0].method, 'POST');
    assert.equal(captured[0].headers.Authorization, 'Bearer TOKEN');
    assert.equal(captured[0].headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.deepEqual(JSON.parse(captured[0].body!), { head: 'cap/task-x', base: 'main', title: 'T', body: 'B' });
    assert.deepEqual(ref, { number: 7, url: 'https://github.com/o/r/pull/7', state: 'open', headBranch: 'cap/task-x' });
  } finally {
    restore();
  }
});

test('GithubForge.openChangeRequest reuses an existing PR on 422', async () => {
  const { captured, restore } = stubFetch([
    { ok: false, status: 422, body: '{"message":"already exists"}' },
    { body: JSON.stringify([{ number: 9, html_url: 'u', state: 'open', merged_at: null, head: { ref: 'cap/task-x' } }]) },
  ]);
  try {
    const ref = await new GithubForge().openChangeRequest(GH, { headBranch: 'cap/task-x', baseBranch: 'main', title: 'T', body: 'B' });
    assert.equal(ref.number, 9, 'reused the existing PR');
    assert.match(captured[1].url, /\/pulls\?state=open&head=/);
  } finally {
    restore();
  }
});

// --- Gitee (no head filter → client-side) ----------------------------------

test('GiteeForge.findExistingChangeRequest filters client-side on head.ref', async () => {
  const { captured, restore } = stubFetch([
    { body: JSON.stringify([
      { number: 1, html_url: 'a', state: 'open', merged_at: null, head: { ref: 'other' } },
      { number: 2, html_url: 'b', state: 'open', merged_at: null, head: { ref: 'cap/task-x' } },
    ]) },
  ]);
  try {
    const ref = await new GiteeForge().findExistingChangeRequest(GITEE, 'cap/task-x');
    assert.match(captured[0].url, /gitee\.com\/api\/v5\/repos\/o\/r\/pulls\?state=open/);
    assert.equal(captured[0].headers.Authorization, 'Bearer TOKEN');
    assert.equal(ref?.number, 2, 'matched the cap/task-x head');
  } finally {
    restore();
  }
});

// --- GitLab (the outlier) --------------------------------------------------

test('GitlabForge.openChangeRequest pins /merge_requests + source/target_branch + PRIVATE-TOKEN + maps iid/web_url', async () => {
  const { captured, restore } = stubFetch([
    { body: JSON.stringify({ iid: 4, web_url: 'https://gitlab.com/g/p/-/merge_requests/4', state: 'opened', source_branch: 'cap/task-x' }) },
  ]);
  try {
    const ref = await new GitlabForge().openChangeRequest(GL, { headBranch: 'cap/task-x', baseBranch: 'main', title: 'T', body: 'B' });
    assert.equal(captured[0].url, 'https://gitlab.com/api/v4/projects/123/merge_requests');
    assert.equal(captured[0].headers['PRIVATE-TOKEN'], 'TOKEN');
    assert.deepEqual(JSON.parse(captured[0].body!), { source_branch: 'cap/task-x', target_branch: 'main', title: 'T', description: 'B' });
    assert.deepEqual(ref, { number: 4, url: 'https://gitlab.com/g/p/-/merge_requests/4', state: 'open', headBranch: 'cap/task-x' });
  } finally {
    restore();
  }
});

test('GitlabForge.findExistingChangeRequest uses state=opened&source_branch', async () => {
  const { captured, restore } = stubFetch([{ body: '[]' }]);
  try {
    const ref = await new GitlabForge().findExistingChangeRequest(GL, 'cap/task-x');
    assert.match(captured[0].url, /\/projects\/123\/merge_requests\?state=opened&source_branch=cap%2Ftask-x/);
    assert.equal(ref, null);
  } finally {
    restore();
  }
});

// --- listRepos mapping (all three) -----------------------------------------

test('listRepos maps each forge to AvailableRepo', async () => {
  let s = stubFetch([{ body: JSON.stringify([{ full_name: 'o/r', clone_url: 'https://github.com/o/r.git', private: true, default_branch: 'master' }]) }]);
  try {
    const gh = await new GithubForge().listRepos(GH);
    assert.deepEqual(gh, [{ forge: 'github', fullPath: 'o/r', gitSource: 'https://github.com/o/r.git', visibility: 'private', defaultBranch: 'master' }]);
  } finally {
    s.restore();
  }

  s = stubFetch([{ body: JSON.stringify([{ id: 55, path_with_namespace: 'g/p', http_url_to_repo: 'https://gitlab.com/g/p.git', visibility: 'private', default_branch: 'master' }]) }]);
  try {
    const gl = await new GitlabForge().listRepos(GL);
    assert.equal(gl[0].forge, 'gitlab');
    assert.equal(gl[0].fullPath, 'g/p');
    assert.equal(gl[0].gitlabProjectId, '55');
    assert.equal(gl[0].defaultBranch, 'master');
    assert.match(s.captured[0].url, /\/projects\?membership=true/);
  } finally {
    s.restore();
  }

  s = stubFetch([{ body: JSON.stringify([{ full_name: 'o/r', html_url: 'https://gitee.com/o/r', private: true, default_branch: 'master' }]) }]);
  try {
    const gitee = await new GiteeForge().listRepos(GITEE);
    assert.equal(gitee[0].defaultBranch, 'master');
  } finally {
    s.restore();
  }
});

test('listRepos drops missing, whitespace-normalized, and invalid default refs', async () => {
  const s = stubFetch([{ body: JSON.stringify([
    { full_name: 'o/missing', html_url: 'https://gitee.com/o/missing', private: true },
    { full_name: 'o/spaced', html_url: 'https://gitee.com/o/spaced', private: true, default_branch: ' master ' },
    { full_name: 'o/option', html_url: 'https://gitee.com/o/option', private: true, default_branch: '-master' },
  ]) }]);
  try {
    assert.deepEqual(await new GiteeForge().listRepos(GITEE), []);
  } finally {
    s.restore();
  }
});
