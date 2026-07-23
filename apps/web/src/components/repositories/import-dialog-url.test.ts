import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { REPO_IMPORT_FAILURE_CODES } from "@cap/contracts";
import { ApiError } from "@/lib/api/real";

import {
  buildPickerImportRequest,
  buildUrlImportRequest,
  findImportedForgeRepo,
  findImportedGithubRepo,
  forgeListErrorCopy,
  parseImportGitUrl,
  repoImportFailurePresentation,
} from "./import-dialog";

describe("parseImportGitUrl", () => {
  it("builds URL import intent without owner, token, or browser branch metadata", () => {
    const parsed = parseImportGitUrl(
      " HTTPS://GITEE.COM/team/private-app.git/?utm=1#readme ",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const request = buildUrlImportRequest(parsed, "  private app  ", "gitee");

    expect(request).toEqual({
      name: "private app",
      gitSource: "https://gitee.com/team/private-app.git",
      forge: "gitee",
      importSource: "url",
    });
    expect(request).not.toHaveProperty("ownerUserId");
    expect(request).not.toHaveProperty("token");
    expect(request).not.toHaveProperty("defaultBranch");
  });

  it("marks forge-list selections as picker imports for server-side metadata verification", () => {
    expect(
      buildPickerImportRequest({
        forge: "gitee",
        fullPath: "team/private",
        gitSource: "https://gitee.com/team/private.git",
        visibility: "private",
        defaultBranch: "master",
      }),
    ).toEqual({
      name: "team/private",
      gitSource: "https://gitee.com/team/private.git",
      forge: "gitee",
      importSource: "picker",
    });
  });

  it("normalizes HTTP(S) git URLs and derives a display name", () => {
    expect(
      parseImportGitUrl(" HTTPS://GITEE.COM/team/app.git/?utm=1#readme "),
    ).toEqual({
      ok: true,
      gitSource: "https://gitee.com/team/app.git",
      name: "app",
    });
  });

  it("rejects credential-bearing URLs before submit", () => {
    expect(
      parseImportGitUrl("https://token:secret@gitee.internal/team/app.git"),
    ).toEqual({
      ok: false,
      message: "仓库 URL 不能包含用户名、密码或令牌。",
    });
  });

  it("rejects non-http clone specs", () => {
    expect(parseImportGitUrl("git@gitee.internal:team/app.git")).toEqual({
      ok: false,
      message: "仓库 URL 格式不正确。",
    });
  });

  it("renders list-unavailable as a URL-import fallback instead of a hard stop", () => {
    expect(
      forgeListErrorCopy(
        '{"error":"forge_list_unavailable","reason":"api_unverified"}',
        "gitee",
      ),
    ).toEqual({
      pill: "列表不可用",
      variant: "warn",
      message: "当前连接无法读取仓库列表，可直接使用上方 URL 导入。",
    });
  });

  it("keeps missing credentials distinct from list-unavailable", () => {
    expect(
      forgeListErrorCopy('{"error":"forge_not_connected"}', "gitlab"),
    ).toEqual({
      pill: "未连接",
      variant: "danger",
      message: "请先在「设置 · 代码托管连接」中连接 GitLab，再拉取仓库列表。",
    });
  });
});

describe("already-imported refresh reconciliation", () => {
  const repos = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "github-repo",
      gitSource: "https://github.com/team/github-repo.git",
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      forge: "github" as const,
      githubId: "101",
      defaultBranch: "trunk",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "gitlab-repo",
      gitSource: "https://gitlab.example/team/gitlab-repo.git",
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      forge: "gitlab" as const,
      defaultBranch: "develop",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "gitee-repo",
      gitSource: "https://gitee.example/team/gitee-repo.git",
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      forge: "gitee" as const,
      defaultBranch: "master",
    },
  ] as const;
  const gitlabRepo = repos[1]!;

  it("maps an imported GitHub candidate to the stable platform Repo id", () => {
    const found = findImportedGithubRepo(
      {
        id: 101,
        name: "renamed-browser-label",
        full_name: "team/github-repo",
        visibility: "private",
        defaultBranch: "stale-browser-branch",
        description: null,
      },
      repos,
    );

    expect(found).toMatchObject({
      id: repos[0]?.id,
      defaultBranch: "trunk",
    });
  });

  it.each([
    ["explicit GitLab", gitlabRepo],
    ["legacy null-forge GitLab", { ...gitlabRepo, forge: null }],
    [
      "self-hosted GitHub",
      {
        ...gitlabRepo,
        forge: "github" as const,
        gitSource: "https://github.example/team/gitlab-repo.git",
        githubId: "404",
      },
    ],
  ])(
    "does not reconcile a same-slug %s Repo as a github.com candidate",
    (_label, otherForgeRepo) => {
      const found = findImportedGithubRepo(
        {
          id: 404,
          name: "gitlab-repo",
          full_name: "team/gitlab-repo",
          visibility: "private",
          defaultBranch: "main",
          description: null,
        },
        [otherForgeRepo],
      );

      expect(found).toBeNull();
    },
  );

  it.each([
    ["gitlab", "https://gitlab.example/team/gitlab-repo.git", "develop", 1],
    ["gitee", "https://gitee.example/team/gitee-repo.git", "master", 2],
  ] as const)(
    "maps an imported %s candidate by normalized clone identity",
    (forge, gitSource, branch, index) => {
      const found = findImportedForgeRepo(
        {
          forge,
          fullPath: `team/${forge}-repo`,
          gitSource: `${gitSource.replace(
            `${forge}.example`,
            `${forge.toUpperCase()}.EXAMPLE`,
          )}/`,
          visibility: "private",
          defaultBranch: "stale-browser-branch",
        },
        repos,
      );

      expect(found).toMatchObject({
        id: repos[index]?.id,
        defaultBranch: branch,
      });
    },
  );

  it("wires imported candidates to refresh rather than a second import", () => {
    const source = readFileSync(
      new URL("./import-dialog.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("refreshRepoDefaultBranchMutation(queryClient)");
    expect(source).toContain("data-refresh-repo-id={importedRepo?.id}");
    expect(source).toContain("claimRepoRefreshSubmission(refreshFence, repo.id)");
    expect(source).toContain("repoImportFailurePresentation(error)");
    expect(source).not.toContain(">\n                              已导入\n");
  });
});

const failureCases = {
  session_operator_required: ["登录状态不可用", "login"],
  repo_git_source_invalid: ["URL 无效", undefined],
  repo_git_source_credentials_forbidden: ["URL 含有凭据", undefined],
  repo_forge_unresolved: ["无法识别代码托管平台", undefined],
  repo_forge_auth_required: ["尚未连接凭据", "forges"],
  repo_forge_authentication_failed: ["凭据验证失败", "forges"],
  repo_forge_access_denied: ["仓库访问被拒绝", "forges"],
  repo_forge_network_unavailable: ["网络或 TLS 不可用", undefined],
  repo_platform_dependency_unavailable: ["部署依赖不可用", undefined],
  repo_default_branch_unresolved: ["默认分支未解析", undefined],
  repo_picker_candidate_not_accessible: ["仓库已不可访问", undefined],
  repo_import_identity_conflict: ["仓库身份冲突", undefined],
  // add-repo-content-store — content-copy acquisition/refresh failures.
  repo_copy_authentication_failed: ["副本获取认证失败", "forges"],
  repo_copy_access_denied: ["副本获取被拒绝", "forges"],
  repo_copy_network_unavailable: ["副本网络不可用", undefined],
  repo_copy_source_invalid: ["副本来源无效", undefined],
  repo_copy_missing: ["副本尚未建立", undefined],
  repo_copy_store_unavailable: ["副本存储不可用", undefined],
  repo_copy_platform_dependency_unavailable: ["部署依赖不可用", undefined],
  repo_copy_acquisition_aborted: ["副本获取中断", undefined],
  // local-repo-import — local-path import gate failures.
  repo_local_import_disabled: ["本地导入未启用", undefined],
  repo_local_import_path_invalid: ["路径无效", undefined],
  repo_local_import_path_outside_root: ["路径超出允许范围", undefined],
  repo_local_import_path_not_found: ["路径不存在", undefined],
  repo_local_import_not_a_git_repository: ["不是 git 仓库", undefined],
} as const;

describe("repoImportFailurePresentation", () => {
  it("classifies every canonical code without parsing raw error prose", () => {
    expect(Object.keys(failureCases)).toEqual([...REPO_IMPORT_FAILURE_CODES]);

    for (const code of REPO_IMPORT_FAILURE_CODES) {
      const [pill, action] = failureCases[code];
      const presentation = repoImportFailurePresentation(
        new ApiError(
          500,
          "raw-json secret-canary repo_default_branch_unresolved",
          {
            error: code,
            message: "Same safe server message for every code.",
          },
        ),
      );

      expect(presentation).toMatchObject({ code, pill });
      expect(presentation.action).toBe(action);
      expect(JSON.stringify(presentation)).not.toContain("secret-canary");
      expect(JSON.stringify(presentation)).not.toContain("raw-json");
    }
  });

  it("uses a fixed safe fallback for unknown or diagnostic-bearing bodies", () => {
    for (const body of [
      { error: "not_canonical", message: "secret-canary" },
      {
        error: "repo_forge_network_unavailable",
        message: "safe",
        rawOutput: "secret-canary",
      },
    ]) {
      const presentation = repoImportFailurePresentation(
        new ApiError(500, JSON.stringify(body), body),
      );

      expect(presentation).toEqual({
        code: "repo_import_failed",
        pill: "导入验证失败",
        variant: "warn",
        message:
          "未能完成仓库访问与默认分支验证，请检查连接设置或稍后重试。",
      });
      expect(JSON.stringify(presentation)).not.toContain("secret-canary");
    }
  });

  it("wires classified inline feedback and explicit pending probe copy", () => {
    const source = readFileSync(
      new URL("./import-dialog.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('data-repo-import-failure={urlFailure.code}');
    expect(source).toContain('role="alert"');
    expect(source).toContain('role="status"');
    expect(source).toContain("验证仓库访问并解析远端默认分支");
    expect(source).toContain("urlImportFence.current");
    const urlHandler = source.slice(
      source.indexOf("function handleImportUrl()"),
      source.indexOf("// Distinguish the failure modes", source.indexOf("function handleImportUrl()")),
    );
    expect(urlHandler).not.toContain("error.message");
    expect(urlHandler).toContain("repoImportFailurePresentation(error)");
  });
});
