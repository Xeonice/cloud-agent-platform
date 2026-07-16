import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({
  apiBaseUrl: () => "http://api.test",
  operatorToken: () => "legacy-console-token",
}));
vi.mock("../server-cookie", () => ({
  getIncomingCookieHeader: async () => "cap_session=signed-session",
}));

import {
  ApiError,
  createRepo,
  repoImportFailureFromApiError,
} from "./real";

const REQUEST = {
  name: "team/private-app",
  gitSource: "https://gitee.com/team/private-app.git",
  forge: "gitee",
  importSource: "url",
} as const;

function repo(defaultBranch: string | null | undefined = "master") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: REQUEST.name,
    gitSource: REQUEST.gitSource,
    createdAt: "2026-07-16T00:00:00.000Z",
    forge: "gitee",
    defaultBranch,
  };
}

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("real.createRepo verified Console import", () => {
  it("sends the authenticated internal POST without owner, token, or branch metadata", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(repo()));
    vi.stubGlobal("fetch", fetchMock);

    const imported = await createRepo(REQUEST);

    expect(imported.defaultBranch).toBe("master");
    expect(imported.createdAt).toBeInstanceOf(Date);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://api.test/repos");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      body: JSON.stringify(REQUEST),
    });
    expect(init.headers).toMatchObject({
      Authorization: "Bearer legacy-console-token",
      Cookie: "cap_session=signed-session",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
    expect(String(init.body)).not.toMatch(/ownerUserId|token|defaultBranch/);
  });

  it("does not settle before the access/default-branch probe response", async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;

    const importing = createRepo(REQUEST).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(settled).toBe(false);
    release(jsonResponse(repo()));
    await expect(importing).resolves.toMatchObject({ defaultBranch: "master" });
    expect(settled).toBe(true);
  });

  it("fails closed when a nominal 201 response has no verified default branch", async () => {
    const responses = [
      repo(null),
      { ...repo(), defaultBranch: undefined },
      repo(" invalid branch "),
    ];
    for (const body of responses) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(body)),
      );

      await expect(createRepo(REQUEST)).rejects.toMatchObject({
        name: "ZodError",
      });
    }
  });

  it("preserves and classifies only the canonical safe ApiError body", async () => {
    const body = {
      error: "repo_default_branch_unresolved",
      message: "The repository default branch could not be resolved.",
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body, 422)));

    let caught: unknown;
    try {
      await createRepo(REQUEST);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 422, body });
    expect(repoImportFailureFromApiError(caught)).toEqual(body);
  });

  it("rejects diagnostic-bearing error bodies from the safe classifier", () => {
    const error = new ApiError(503, "raw-json-canary", {
      error: "repo_forge_network_unavailable",
      message: "Safe operator copy.",
      rawOutput: "secret-canary",
    });

    expect(repoImportFailureFromApiError(error)).toBeNull();
  });
});
