import { describe, expect, it } from "vitest";

import { forgeListErrorCopy, parseImportGitUrl } from "./import-dialog";

describe("parseImportGitUrl", () => {
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
