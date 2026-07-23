/**
 * `ImportDialog` — the `/repositories` 仓库导入 dialog (Track 14; tasks 14.1 + 14.2).
 *
 * A shadcn `Dialog` (Radix supplies Esc / backdrop close, focus trap,
 * `aria-modal`, `aria-labelledby`, focus-return — no manual a11y wiring) that
 * pulls the operator's importable GitHub repositories and lets them select which
 * to add to the platform's scheduling pool. It owns THREE states:
 *
 *   1. 待拉取 (empty)   — `.import-empty-layout`: a 待拉取 pill, the sync heading +
 *                         copy, and a 同步仓库列表 button that triggers the fetch.
 *   2. 正在拉取 (loading) — a 正在拉取 pill + the mono `GET /user/repos?…` line,
 *                         shown while `githubReposQuery` is fetching.
 *   3. available list  — a search row (筛选仓库 input + a「N 个可导入」count chip),
 *                         the list head, and one candidate row per GitHub repo.
 *
 * Candidate reconciliation (task 14.2): each candidate is checked against the
 * already-imported platform repos by stable GitHub id/slug or normalized clone
 * identity. An imported candidate offers verified default-branch refresh rather
 * than a second import; a synchronous fence prevents duplicate probes. An import
 * that races a concurrent import (the real endpoint answers 409 already-imported)
 * is reconciled the same way rather than surfaced as an error. Data is read through
 * `githubReposQuery` (never a bespoke fetch), so flipping the `githubImport`
 * capability repoints it at the real `GET /user/repos` with no change here; the
 * distinct empty-vs-error-vs-PAT-required states are kept as honest seams.
 *
 * SSR-safe: the dialog content mounts only when open (Radix portals on the
 * client); the fetch is deferred until the operator clicks 同步仓库列表 (the query
 * is `enabled` only once armed). Search state is plain `useState`; no
 * window/clock/random at module scope or during render.
 *
 * Fidelity (`.repo-import-modal` FINAL cascade): dialog 760px, white; modal-head
 * 18/20 padding + bottom hairline (eyebrow / h2 20px / muted p); the drawer body
 * padding `0 20px 22px`; empty layout max-w 560 with a fit-content ≥180px button;
 * search row two-column `minmax(0,1fr) auto`; candidate rows = the shared
 * `RepoRow`; a disabled action uses the muted `#fafafa` pill.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  LOCAL_REPO_IMPORT_ROOT_ENV,
  type RepoImportFailureCode,
  type AvailableGithubRepo,
  type AvailableForgeRepo,
  type CreateRepoRequest,
  type ForgeKind,
  type Repo,
} from "@cap/contracts";
import {
  availableForgeReposQuery,
  githubReposQuery,
  localRepoImportAvailabilityQuery,
} from "@/lib/api/queries";
import {
  createRepoMutation,
  importLocalRepoMutation,
  importRepoMutation,
  refreshRepoDefaultBranchMutation,
} from "@/lib/api/mutations";
import {
  claimRepoRefreshSubmission,
  releaseRepoRefreshSubmission,
} from "@/lib/repo-refresh-flow";
import {
  ApiError,
  repoImportFailureFromApiError,
} from "@/lib/api/real";
import { StatusPill } from "@/components/status-pill";
import { CountChip } from "@/components/count-chip";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { RepoRow, RepoListHead } from "./repo-row";

export interface ImportDialogProps {
  /** Whether the dialog is open (controlled by the page's 添加仓库 button). */
  open: boolean;
  /** Open/close callback (wired to Esc / backdrop / the close button). */
  onOpenChange: (open: boolean) => void;
  /** The already-imported platform repos, for candidate reconciliation. */
  importedRepos: readonly Repo[];
}

/**
 * Reconcile an already-imported set into the lookup keys a GitHub candidate is
 * matched against: the originating GitHub numeric id (as a string) AND the
 * `owner/name` slug. PURE — exported for unit-testing the dedup reconciliation.
 */
export function buildImportedIndex(repos: readonly Repo[]): {
  githubIds: ReadonlySet<string>;
  fullNames: ReadonlySet<string>;
} {
  const githubIds = new Set<string>();
  const fullNames = new Set<string>();
  for (const repo of repos) {
    if (repo.githubId) githubIds.add(repo.githubId);
    const match = repo.gitSource.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    const slug = match?.[1] ?? repo.name;
    fullNames.add(slug.toLowerCase());
  }
  return { githubIds, fullNames };
}

/** Whether a GitHub candidate is already imported (by id or `owner/name`). */
export function isAlreadyImported(
  candidate: AvailableGithubRepo,
  index: { githubIds: ReadonlySet<string>; fullNames: ReadonlySet<string> },
): boolean {
  return (
    index.githubIds.has(String(candidate.id)) ||
    index.fullNames.has(candidate.full_name.toLowerCase())
  );
}

/** Resolve an imported GitHub candidate to its canonical platform Repo. */
export function findImportedGithubRepo(
  candidate: AvailableGithubRepo,
  repos: readonly Repo[],
): Repo | null {
  const candidateId = String(candidate.id);
  const candidateFullName = candidate.full_name.toLowerCase();
  return (
    repos.find((repo) => {
      // A slug and numeric id are scoped to one forge installation. Require the
      // canonical github.com clone host as well as a compatible stored forge so
      // legacy null rows and self-hosted forges cannot turn a GitHub candidate
      // into a refresh action for the wrong platform Repo.
      if (repo.forge && repo.forge !== "github") return false;
      const parsedSource = parseImportGitUrl(repo.gitSource);
      if (!parsedSource.ok) return false;
      const source = new URL(parsedSource.gitSource);
      if (source.hostname !== "github.com") return false;
      if (repo.githubId === candidateId) return true;
      const fullName = source.pathname
        .replace(/^\/+|\/+$/g, "")
        .replace(/\.git$/i, "")
        .toLowerCase();
      return fullName === candidateFullName;
    }) ?? null
  );
}

export type ImportGitUrlParseResult =
  | { ok: true; gitSource: string; name: string }
  | { ok: false; message: string };

type ParsedImportGitUrl = Extract<ImportGitUrlParseResult, { ok: true }>;

export interface RepoImportFailurePresentation {
  code: RepoImportFailureCode | "repo_import_failed";
  pill: string;
  variant: "danger" | "warn";
  message: string;
  action?: "forges" | "login";
}

const REPO_IMPORT_FAILURE_PRESENTATIONS = {
  session_operator_required: {
    pill: "登录状态不可用",
    variant: "danger",
    message: "仓库导入需要有效的 Console 登录状态，请重新登录后再试。",
    action: "login",
  },
  repo_git_source_invalid: {
    pill: "URL 无效",
    variant: "danger",
    message: "请填写包含项目路径的 HTTP(S) 仓库 URL。",
  },
  repo_git_source_credentials_forbidden: {
    pill: "URL 含有凭据",
    variant: "danger",
    message: "请移除 URL 中的用户名、密码或令牌；系统只使用当前账号已保存的凭据。",
  },
  repo_forge_unresolved: {
    pill: "无法识别代码托管平台",
    variant: "danger",
    message: "请确认 URL 与所选 GitHub、GitLab 或 Gitee 类型一致，并已注册对应主机。",
  },
  repo_forge_auth_required: {
    pill: "尚未连接凭据",
    variant: "danger",
    message: "请先连接这个仓库主机的代码托管凭据，再重新验证导入。",
    action: "forges",
  },
  repo_forge_authentication_failed: {
    pill: "凭据验证失败",
    variant: "danger",
    message: "当前代码托管凭据已失效或无法认证，请更新凭据后重试。",
    action: "forges",
  },
  repo_forge_access_denied: {
    pill: "仓库访问被拒绝",
    variant: "danger",
    message: "当前凭据无权访问该仓库，请检查令牌范围和仓库成员权限。",
    action: "forges",
  },
  repo_forge_network_unavailable: {
    pill: "网络或 TLS 不可用",
    variant: "warn",
    message: "无法连接仓库主机，请检查服务端网络、代理和证书信任后重试。",
  },
  repo_platform_dependency_unavailable: {
    pill: "部署依赖不可用",
    variant: "danger",
    message:
      "服务端缺少仓库验证所需的运行依赖，请修复或升级 API 部署后重试；无需重新连接代码托管凭据。",
  },
  repo_default_branch_unresolved: {
    pill: "默认分支未解析",
    variant: "danger",
    message: "仓库可访问，但无法解析远端默认分支；请检查默认分支或 symbolic HEAD 设置。",
  },
  repo_picker_candidate_not_accessible: {
    pill: "仓库已不可访问",
    variant: "danger",
    message: "该仓库已不在当前账号的可访问列表中，请重新同步后选择。",
  },
  repo_import_identity_conflict: {
    pill: "仓库身份冲突",
    variant: "danger",
    message: "该 URL 与已有仓库身份不一致，请检查导入来源或联系管理员。",
  },
  // add-repo-content-store：内容副本获取 / 刷新失败。与上面的元数据码分开，
  // 因为此时仓库本身已注册（或可注册），只是副本没就绪，补救动作是「刷新副本」。
  repo_copy_authentication_failed: {
    pill: "副本获取认证失败",
    variant: "danger",
    message: "拉取仓库内容时凭据认证失败，请更新代码托管凭据后重新刷新副本。",
    action: "forges",
  },
  repo_copy_access_denied: {
    pill: "副本获取被拒绝",
    variant: "danger",
    message: "当前凭据无权拉取该仓库内容，请检查令牌范围和仓库成员权限后重试。",
    action: "forges",
  },
  repo_copy_network_unavailable: {
    pill: "副本网络不可用",
    variant: "warn",
    message: "拉取仓库内容时无法连接远端，请检查服务端网络与代理后重试刷新副本。",
  },
  repo_copy_source_invalid: {
    pill: "副本来源无效",
    variant: "danger",
    message: "仓库来源地址无法用于拉取内容，请检查仓库来源后重新导入。",
  },
  repo_copy_missing: {
    pill: "副本尚未建立",
    variant: "warn",
    message: "该仓库还没有内容副本，请先刷新副本完成补建，再创建任务。",
  },
  repo_copy_store_unavailable: {
    pill: "副本存储不可用",
    variant: "danger",
    message: "服务端副本存储卷不可写或未挂载，请检查 API 部署的 repo-store 卷后重试。",
  },
  repo_copy_platform_dependency_unavailable: {
    pill: "部署依赖不可用",
    variant: "danger",
    message: "服务端缺少拉取仓库内容所需的运行依赖，请修复或升级 API 部署后重试。",
  },
  repo_copy_acquisition_aborted: {
    pill: "副本获取中断",
    variant: "warn",
    message: "本次副本获取被中断（超时或传输中止），已保留上一份可用副本，可重新刷新。",
  },
  // local-repo-import：本地路径导入的门禁失败。
  repo_local_import_disabled: {
    pill: "本地导入未启用",
    variant: "danger",
    message: `本地路径导入未启用，请在 API 端配置 ${LOCAL_REPO_IMPORT_ROOT_ENV} 允许根目录后重试。`,
  },
  repo_local_import_path_invalid: {
    pill: "路径无效",
    variant: "danger",
    message: "请填写允许根目录下的有效路径（不接受空值或非法字符）。",
  },
  repo_local_import_path_outside_root: {
    pill: "路径超出允许范围",
    variant: "danger",
    message: "该路径解析后不在允许根目录内（含 .. 或软链接逃逸），请改用根目录内的路径。",
  },
  repo_local_import_path_not_found: {
    pill: "路径不存在",
    variant: "danger",
    message: "允许根目录下找不到该路径，请确认路径已挂载进 API 容器后重试。",
  },
  repo_local_import_not_a_git_repository: {
    pill: "不是 git 仓库",
    variant: "danger",
    message: "该目录不是 git 仓库（既非含 .git 的工作区，也非 bare 仓库），请改选仓库目录。",
  },
} satisfies Record<
  RepoImportFailureCode,
  Omit<RepoImportFailurePresentation, "code">
>;

/** Classify only the stable response code; never inspect raw error prose. */
export function repoImportFailurePresentation(
  error: unknown,
): RepoImportFailurePresentation {
  const failure = repoImportFailureFromApiError(error);
  if (failure) {
    return {
      code: failure.error,
      ...REPO_IMPORT_FAILURE_PRESENTATIONS[failure.error],
    };
  }
  return {
    code: "repo_import_failed",
    pill: "导入验证失败",
    variant: "warn",
    message: "未能完成仓库访问与默认分支验证，请检查连接设置或稍后重试。",
  };
}

export function parseImportGitUrl(value: string): ImportGitUrlParseResult {
  const raw = value.trim();
  if (raw.length === 0) {
    return { ok: false, message: "请填写仓库 URL。" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: "仓库 URL 格式不正确。" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "仓库 URL 仅支持 HTTP(S)。" };
  }
  if (url.username || url.password) {
    return { ok: false, message: "仓库 URL 不能包含用户名、密码或令牌。" };
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "") {
    return { ok: false, message: "仓库 URL 需要包含项目路径。" };
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.pathname = path;
  url.search = "";
  url.hash = "";
  const segment = path.split("/").filter(Boolean).at(-1) ?? "repository";
  let decodedSegment = segment;
  try {
    decodedSegment = decodeURIComponent(segment);
  } catch {
    decodedSegment = segment;
  }
  const name = decodedSegment.replace(/\.git$/i, "") || "repository";
  return { ok: true, gitSource: url.toString(), name };
}

export function buildUrlImportRequest(
  parsed: ParsedImportGitUrl,
  displayName: string,
  forge: ForgeKind,
): CreateRepoRequest {
  return {
    name: displayName.trim() || parsed.name,
    gitSource: parsed.gitSource,
    forge,
    importSource: "url",
  };
}

export function forgeListErrorCopy(
  errorMessage: string,
  source: ForgeKind,
): { pill: string; variant: "danger" | "warn"; message: string } {
  if (errorMessage.includes("forge_not_connected")) {
    return {
      pill: "未连接",
      variant: "danger",
      message: `请先在「设置 · 代码托管连接」中连接 ${
        source === "gitlab" ? "GitLab" : "Gitee"
      }，再拉取仓库列表。`,
    };
  }
  if (errorMessage.includes("forge_list_unavailable")) {
    return {
      pill: "列表不可用",
      variant: "warn",
      message: "当前连接无法读取仓库列表，可直接使用上方 URL 导入。",
    };
  }
  return {
    pill: "列表不可用",
    variant: "warn",
    message: "暂时无法读取仓库列表，可直接使用上方 URL 导入或稍后重试。",
  };
}

/** Picker writes identify the selection; the API re-verifies its metadata. */
export function buildPickerImportRequest(
  candidate: AvailableForgeRepo,
): CreateRepoRequest {
  return {
    name: candidate.fullPath,
    gitSource: candidate.gitSource,
    forge: candidate.forge,
    importSource: "picker",
  };
}

/** Resolve a Gitee/GitLab picker candidate by its normalized clone identity. */
export function findImportedForgeRepo(
  candidate: AvailableForgeRepo,
  repos: readonly Repo[],
): Repo | null {
  const parsedCandidate = parseImportGitUrl(candidate.gitSource);
  const candidateGitSource = parsedCandidate.ok
    ? parsedCandidate.gitSource
    : candidate.gitSource.trim();
  return (
    repos.find((repo) => {
      if (repo.forge && repo.forge !== candidate.forge) return false;
      const parsedRepo = parseImportGitUrl(repo.gitSource);
      const repoGitSource = parsedRepo.ok
        ? parsedRepo.gitSource
        : repo.gitSource.trim();
      return repoGitSource === candidateGitSource;
    }) ?? null
  );
}

/**
 * The import sources the dialog switches between. `local` is the third mode
 * (add-repo-content-store / local-repo-import): it is offered ONLY when the api
 * reports the allowlist root configured, and is never a forge — it imports a git
 * repository from a path the api process can see.
 */
export type ImportSourceKind = ForgeKind | "local";

/** The 仓库导入 dialog. */
export function ImportDialog({
  open,
  onOpenChange,
  importedRepos,
}: ImportDialogProps) {
  const queryClient = useQueryClient();

  // The GitHub list is fetched lazily through the connected GitHub PAT: armed
  // only after the operator clicks 同步仓库列表 (and re-armed whenever the dialog
  // reopens). Reading through `githubReposQuery` keeps the real/mock switch +
  // cache key intact.
  const [armed, setArmed] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [importingId, setImportingId] = React.useState<number | null>(null);
  // add-multi-forge-task-delivery: the selected import source (the picker switch).
  // add-repo-content-store: `local` joins it as the third mode when enabled.
  const [source, setSource] = React.useState<ImportSourceKind>("github");
  const [importingPath, setImportingPath] = React.useState<string | null>(null);
  const [refreshingRepoId, setRefreshingRepoId] = React.useState<string | null>(
    null,
  );
  const [urlValue, setUrlValue] = React.useState("");
  const [urlName, setUrlName] = React.useState("");
  const [urlFailure, setUrlFailure] =
    React.useState<RepoImportFailurePresentation | null>(null);
  const [localPath, setLocalPath] = React.useState("");
  const [localName, setLocalName] = React.useState("");
  const [localFailure, setLocalFailure] =
    React.useState<RepoImportFailurePresentation | null>(null);
  const urlImportFence = React.useRef(false);
  const localImportFence = React.useRef(false);
  const refreshFence = React.useRef<string | null>(null);

  // Local-path import is FAIL-CLOSED: the mode exists only when the api reports
  // an allowlist root configured. Probed while the dialog is open so a freshly
  // configured root surfaces without a reload; an unavailable/erroring probe
  // simply leaves the mode unoffered.
  const localAvailability = useQuery({
    ...localRepoImportAvailabilityQuery(),
    enabled: open,
  });
  const localEnabled = localAvailability.data?.enabled === true;
  const localRoot = localAvailability.data?.root ?? null;
  const isLocal = source === "local";
  // The forge the forge-scoped reads/writes use; `local` is not a forge, so it
  // never selects one (the local panel replaces those reads entirely).
  const forgeSource: ForgeKind = isLocal ? "github" : source;

  const githubRepos = useQuery({ ...githubReposQuery(), enabled: armed && !isLocal });
  const importMutation = useMutation(importRepoMutation(queryClient));
  const localImportMutation = useMutation(importLocalRepoMutation(queryClient));
  // The connected non-github forge's repos (lists via GET /settings/forges/repos).
  const forgeRepos = useQuery({
    ...availableForgeReposQuery(forgeSource),
    enabled: armed && !isLocal && forgeSource !== "github",
  });
  const createMutation = useMutation(createRepoMutation(queryClient));
  const refreshMutation = useMutation(
    refreshRepoDefaultBranchMutation(queryClient),
  );
  const importingUrl =
    createMutation.isPending &&
    createMutation.variables?.importSource === "url";

  // Reset the dialog's fetch + search state whenever it (re)opens so a reopened
  // dialog always starts from the 待拉取 state rather than a stale list.
  React.useEffect(() => {
    if (open) return;
    setArmed(false);
    setSearch("");
    setImportingId(null);
    setSource("github");
    setImportingPath(null);
    setUrlValue("");
    setUrlName("");
    setUrlFailure(null);
    setLocalPath("");
    setLocalName("");
    setLocalFailure(null);
  }, [open]);

  // The local mode can disappear between opens (the api root was unconfigured);
  // never leave the dialog stranded on a mode that is no longer offered.
  React.useEffect(() => {
    if (isLocal && localAvailability.isSuccess && !localEnabled) {
      setSource("github");
    }
  }, [isLocal, localAvailability.isSuccess, localEnabled]);

  const candidates = githubRepos.data ?? [];

  // Client-only filter over the candidate list (never touches the cache).
  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter((c) =>
      `${c.full_name} ${c.name}`.toLowerCase().includes(needle),
    );
  }, [candidates, search]);

  function handleImport(candidate: AvailableGithubRepo) {
    setImportingId(candidate.id);
    importMutation.mutate(candidate, {
      onSuccess: () => {
        toast.success(`已导入 ${candidate.full_name}`);
        setImportingId(null);
      },
      onError: (error) => {
        setImportingId(null);
        // A 409 means the repo was already imported (e.g. a concurrent import):
        // reconcile it as imported, not as a hard failure. The repo list is
        // invalidated so the candidate flips to 已导入 on the next read.
        if (error instanceof ApiError && error.status === 409) {
          void queryClient.invalidateQueries();
          toast.message(`${candidate.full_name} 已在调度池中`);
          return;
        }
        toast.error(`导入失败：${error.message}`);
      },
    });
  }

  // --- forge (gitlab/gitee) picker source ---------------------------------
  const forgeCandidates = forgeRepos.data ?? [];
  const visibleForge = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return forgeCandidates;
    return forgeCandidates.filter((c) =>
      c.fullPath.toLowerCase().includes(needle),
    );
  }, [forgeCandidates, search]);

  function handleImportForge(candidate: AvailableForgeRepo) {
    setImportingPath(candidate.gitSource);
    createMutation.mutate(
      buildPickerImportRequest(candidate),
      {
        onSuccess: () => {
          toast.success(`已导入 ${candidate.fullPath}`);
          setImportingPath(null);
        },
        onError: (error) => {
          setImportingPath(null);
          const failure = repoImportFailurePresentation(error);
          toast.error(`${failure.pill}：${failure.message}`);
        },
      },
    );
  }

  function handleRefreshRepo(repo: Repo) {
    if (!claimRepoRefreshSubmission(refreshFence, repo.id)) return;
    setRefreshingRepoId(repo.id);
    refreshMutation.mutate(repo.id, {
      onSuccess: (refreshed) => {
        toast.success(
          `已刷新 ${refreshed.name} 的默认分支：${refreshed.defaultBranch ?? "待解析"}`,
        );
      },
      onError: (error) => {
        const failure = repoImportFailurePresentation(error);
        toast.error(`${failure.pill}：${failure.message}`);
      },
      onSettled: () => {
        releaseRepoRefreshSubmission(refreshFence, repo.id);
        setRefreshingRepoId(null);
      },
    });
  }

  function handleImportUrl() {
    if (urlImportFence.current || createMutation.isPending) return;
    const parsed = parseImportGitUrl(urlValue);
    if (!parsed.ok) {
      setUrlFailure({
        code: "repo_git_source_invalid",
        pill: "URL 无效",
        variant: "danger",
        message: parsed.message,
      });
      return;
    }
    setUrlFailure(null);
    urlImportFence.current = true;
    createMutation.mutate(
      buildUrlImportRequest(parsed, urlName, forgeSource),
      {
        onSuccess: (repo) => {
          toast.success(
            `已验证并导入 ${repo.name}（默认分支 ${repo.defaultBranch}）`,
          );
          setUrlValue("");
          setUrlName("");
        },
        onError: (error) => {
          const failure = repoImportFailurePresentation(error);
          setUrlFailure(failure);
          toast.error(failure.pill);
        },
        onSettled: () => {
          urlImportFence.current = false;
        },
      },
    );
  }

  /**
   * Import a git repository from a path the api process can see. The console
   * only forwards what the operator typed — containment in the allowlist root,
   * symlink resolution and the "is a git repository" check are SERVER-side, and
   * every rejection is classified from its stable code (never raw prose).
   */
  function handleImportLocal() {
    if (localImportFence.current || localImportMutation.isPending) return;
    const path = localPath.trim();
    if (path.length === 0) {
      setLocalFailure({
        code: "repo_local_import_path_invalid",
        pill: "路径无效",
        variant: "danger",
        message: "请填写要导入的仓库路径。",
      });
      return;
    }
    const name = localName.trim();
    setLocalFailure(null);
    localImportFence.current = true;
    localImportMutation.mutate(
      name ? { path, name } : { path },
      {
        onSuccess: (repo) => {
          toast.success(`已导入本地仓库 ${repo.name}`);
          setLocalPath("");
          setLocalName("");
        },
        onError: (error) => {
          const failure = repoImportFailurePresentation(error);
          setLocalFailure(failure);
          toast.error(failure.pill);
        },
        onSettled: () => {
          localImportFence.current = false;
        },
      },
    );
  }

  // Distinguish the failure modes honestly (task 14.2). A PAT signal (401/403)
  // prompts a settings-side token refresh; everything else is a transient/unknown
  // listing error. An empty-but-successful list is NOT an error.
  const fetchError = githubRepos.error;
  const needsPat =
    fetchError instanceof ApiError &&
    (fetchError.status === 401 || fetchError.status === 403);

  const isGithub = source === "github";
  const showEmptyState = !armed && !isLocal;
  const showLoadingState = armed && isGithub && githubRepos.isLoading;
  const showError = armed && isGithub && !githubRepos.isLoading && fetchError != null;
  const showList =
    armed && isGithub && !githubRepos.isLoading && fetchError == null && candidates.length > 0;
  const showNoRepos =
    armed && isGithub && !githubRepos.isLoading && fetchError == null && candidates.length === 0;

  // forge (gitlab/gitee) source states.
  const forgeError = forgeRepos.error;
  const forgeErrorCopy =
    forgeError instanceof Error
      ? forgeListErrorCopy(forgeError.message, forgeSource)
      : null;
  const isForgePicker = !isGithub && !isLocal;
  const showForgeLoading = armed && isForgePicker && forgeRepos.isLoading;
  const showForgeError =
    armed && isForgePicker && !forgeRepos.isLoading && forgeError != null;
  const showForgeList =
    armed && isForgePicker && !forgeRepos.isLoading && forgeError == null && forgeCandidates.length > 0;
  const showForgeNone =
    armed && isForgePicker && !forgeRepos.isLoading && forgeError == null && forgeCandidates.length === 0;
  const importingLocal = localImportMutation.isPending;

  const SOURCES: ReadonlyArray<{ kind: ForgeKind; label: string }> = [
    { kind: "github", label: "GitHub" },
    { kind: "gitlab", label: "GitLab" },
    { kind: "gitee", label: "Gitee" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-labelledby="repo-import-title"
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_28px_90px_rgba(0,0,0,0.22)] sm:max-w-[820px]"
      >
        {/* Head */}
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-card px-5 py-[18px]">
          <div>
            <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              仓库导入
            </span>
            <DialogTitle
              id="repo-import-title"
              className="mt-1 mb-[5px] text-[22px] font-semibold tracking-[-0.8px] text-ink"
            >
              添加仓库
            </DialogTitle>
            <DialogDescription className="max-w-[620px] text-[13px] leading-[1.55] text-muted-foreground">
              同步可访问仓库，或直接粘贴 HTTP(S) 仓库 URL 加入远端调度池。
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label="关闭添加导入"
            onClick={() => onOpenChange(false)}
            className="grid size-8 place-items-center rounded-md bg-transparent text-2xl leading-none text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            ×
          </button>
        </header>

        <DialogBody>
        <div className="grid gap-3.5 px-5 pt-0.5 pb-[22px]">
          {/* Source switcher (add-multi-forge-task-delivery) */}
          <div
            className="flex gap-1.5 pt-1"
            role="tablist"
            aria-label="选择导入来源"
          >
            {SOURCES.map((s) => (
              <button
                key={s.kind}
                type="button"
                role="tab"
                aria-selected={source === s.kind}
                onClick={() => {
                  setSource(s.kind);
                  setSearch("");
                  setUrlFailure(null);
                }}
                className={`inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium ${
                  source === s.kind
                    ? "bg-foreground text-background"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {s.label}
              </button>
            ))}
            {/* The third mode (local-repo-import). Rendered only once the
                availability probe has answered: enabled ⇒ a real tab; disabled ⇒
                a non-actionable disabled tab, with the enabling configuration
                named below so the operator knows what would turn it on. */}
            {localAvailability.isSuccess ? (
              <button
                type="button"
                role="tab"
                data-import-source="local"
                aria-selected={isLocal}
                disabled={!localEnabled}
                title={
                  localEnabled
                    ? undefined
                    : `未启用：需在 API 端配置 ${LOCAL_REPO_IMPORT_ROOT_ENV}`
                }
                onClick={() => {
                  if (!localEnabled) return;
                  setSource("local");
                  setSearch("");
                  setUrlFailure(null);
                }}
                className={`inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium disabled:pointer-events-none disabled:opacity-50 ${
                  isLocal
                    ? "bg-foreground text-background"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                本地路径
              </button>
            ) : null}
          </div>

          {localAvailability.isSuccess && !localEnabled ? (
            <p
              data-local-import-disabled
              className="m-0 text-xs leading-[1.5] text-muted-foreground"
            >
              本地路径导入未启用：在 API 端配置 {LOCAL_REPO_IMPORT_ROOT_ENV}
              （允许导入的根目录）后，这里会出现第三种导入方式。
            </p>
          ) : null}

          {/* Local-path import (add-repo-content-store / local-repo-import) */}
          {isLocal ? (
            <div
              data-local-import-panel
              className="grid gap-3 rounded-lg bg-secondary/40 p-3.5 shadow-ring"
            >
              <div className="grid gap-1">
                <h3 className="m-0 text-[14px] font-semibold text-ink">
                  从本地路径导入
                </h3>
                <p className="m-0 text-xs leading-[1.5] text-muted-foreground">
                  导入 API 进程可见、且位于允许根目录
                  {localRoot ? (
                    <>
                      {" "}
                      <code className="font-mono">{localRoot}</code>{" "}
                    </>
                  ) : (
                    "内"
                  )}
                  的 git 仓库；导入时会在服务端建立内容副本，本地仓库不提供 PR / MR 回写。
                </p>
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-end">
                <label className="grid min-w-0 gap-2">
                  <span className="text-[13px] font-semibold text-ink">仓库路径</span>
                  <input
                    data-local-import-path
                    value={localPath}
                    onChange={(e) => {
                      setLocalPath(e.target.value);
                      setLocalFailure(null);
                    }}
                    placeholder={localRoot ? `${localRoot}/my-repo` : "my-repo"}
                    className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 font-mono text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]"
                  />
                </label>
                <label className="grid min-w-0 gap-2">
                  <span className="text-[13px] font-semibold text-ink">显示名称</span>
                  <input
                    value={localName}
                    onChange={(e) => setLocalName(e.target.value)}
                    placeholder="自动推断"
                    className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]"
                  />
                </label>
                <button
                  type="button"
                  disabled={importingLocal || localPath.trim().length === 0}
                  onClick={handleImportLocal}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
                >
                  {importingLocal ? "导入中…" : "验证并导入"}
                </button>
              </div>
              {importingLocal ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground"
                >
                  <StatusPill variant="neutral">正在导入</StatusPill>
                  <span>
                    正在校验路径并建立内容副本；大仓库可能需要数分钟，请保持页面打开。
                  </span>
                </div>
              ) : null}
              {localFailure ? (
                <div
                  role="alert"
                  data-repo-import-failure={localFailure.code}
                  className="grid gap-2 rounded-md bg-danger-soft px-3 py-2.5"
                >
                  <StatusPill
                    variant={localFailure.variant}
                    className="justify-self-start"
                  >
                    {localFailure.pill}
                  </StatusPill>
                  <p className="m-0 text-[13px] leading-relaxed text-foreground">
                    {localFailure.message}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {isLocal ? null : (
          <div className="grid gap-3 rounded-lg bg-secondary/40 p-3.5 shadow-ring">
            <div className="grid gap-1">
              <h3 className="m-0 text-[14px] font-semibold text-ink">通过 URL 导入</h3>
              <p className="m-0 text-xs leading-[1.5] text-muted-foreground">
                适用于只具备 git clone / push 权限、无法读取仓库列表的内网实例。
              </p>
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-end">
              <label className="grid min-w-0 gap-2">
                <span className="text-[13px] font-semibold text-ink">仓库 URL</span>
                <input
                  value={urlValue}
                  onChange={(e) => {
                    setUrlValue(e.target.value);
                    setUrlFailure(null);
                  }}
                  placeholder={`https://${source === "github" ? "github.com" : source === "gitlab" ? "gitlab.com" : "gitee.com"}/team/repo.git`}
                  className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]"
                />
              </label>
              <label className="grid min-w-0 gap-2">
                <span className="text-[13px] font-semibold text-ink">显示名称</span>
                <input
                  value={urlName}
                  onChange={(e) => setUrlName(e.target.value)}
                  placeholder="自动推断"
                  className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]"
                />
              </label>
              <button
                type="button"
                disabled={createMutation.isPending || urlValue.trim().length === 0}
                onClick={handleImportUrl}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
              >
                {importingUrl ? "验证并导入中…" : "验证并导入"}
              </button>
            </div>
            {importingUrl ? (
              <div
                role="status"
                aria-live="polite"
                className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground"
              >
                <StatusPill variant="neutral">正在验证</StatusPill>
                <span>正在使用当前登录账号验证仓库访问并解析远端默认分支…</span>
              </div>
            ) : null}
            {urlFailure ? (
              <div
                role="alert"
                data-repo-import-failure={urlFailure.code}
                className="grid gap-2 rounded-md bg-danger-soft px-3 py-2.5"
              >
                <StatusPill
                  variant={urlFailure.variant}
                  className="justify-self-start"
                >
                  {urlFailure.pill}
                </StatusPill>
                <p className="m-0 text-[13px] leading-relaxed text-foreground">
                  {urlFailure.message}
                </p>
                {urlFailure.action === "forges" ? (
                  <Link
                    to="/settings"
                    hash="forges"
                    className="w-fit text-xs font-medium text-foreground underline underline-offset-2"
                  >
                    检查代码托管连接
                  </Link>
                ) : urlFailure.action === "login" ? (
                  <Link
                    to="/login"
                    className="w-fit text-xs font-medium text-foreground underline underline-offset-2"
                  >
                    重新登录
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
          )}

          {/* State 1: 待拉取 (empty) */}
          {showEmptyState ? (
            <div className="grid gap-3 pt-1">
              <StatusPill variant="neutral" className="justify-self-start">
                待拉取
              </StatusPill>
              <h3 className="m-0 text-xl font-semibold leading-[1.25] tracking-[-0.5px] text-foreground">
                先同步仓库列表，再选择调度范围。
              </h3>
              <p className="m-0 text-[13px] leading-[1.55] text-muted-foreground">
                同步只读取仓库名称、默认分支和更新时间；PAT 只在服务端使用，不会返回浏览器。
              </p>
              <button
                type="button"
                onClick={() => setArmed(true)}
                className="inline-flex h-9 w-fit min-w-[180px] items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                同步仓库列表
              </button>
            </div>
          ) : null}

          {/* State 2: 正在拉取 (loading) */}
          {showLoadingState ? (
            <div className="grid gap-3 pt-1">
              <StatusPill variant="neutral" className="justify-self-start">
                正在拉取
              </StatusPill>
              <p className="m-0 font-mono text-xs leading-[1.55] text-muted-foreground">
                GET /user/repos?affiliation=owner
              </p>
            </div>
          ) : null}

          {/* Error states (task 14.2: re-auth vs transient, distinct from empty) */}
          {showError ? (
            <div
              role="alert"
              className="grid gap-3 rounded-lg bg-[#fff1f0] p-[18px] shadow-ring"
            >
              <StatusPill variant="danger" className="justify-self-start">
                {needsPat ? "需要 GitHub PAT" : "拉取失败"}
              </StatusPill>
              <p className="m-0 text-[13px] leading-[1.55] text-foreground">
                {needsPat
                  ? "GitHub PAT 未连接、已失效或权限不足，请在设置「代码托管连接」中连接后再同步仓库列表。"
                  : "暂时无法读取 GitHub 仓库列表，请稍后重试。"}
              </p>
              <button
                type="button"
                onClick={() => void githubRepos.refetch()}
                className="inline-flex h-9 w-fit min-w-[180px] items-center justify-center rounded-md bg-card px-4 text-sm font-medium text-foreground shadow-ring hover:bg-secondary"
              >
                重试同步
              </button>
            </div>
          ) : null}

          {/* Empty-but-successful list (NOT an error) */}
          {showNoRepos ? (
            <div className="grid gap-3 rounded-lg bg-[#fafafa] p-[18px] shadow-ring">
              <StatusPill variant="neutral" className="justify-self-start">
                没有可导入仓库
              </StatusPill>
              <p className="m-0 text-[13px] leading-[1.55] text-muted-foreground">
                当前 GitHub 账号下没有可导入的仓库；新建仓库后可再次同步。
              </p>
            </div>
          ) : null}

          {/* State 3: available list */}
          {showList ? (
            <div className="grid gap-2.5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                <label className="m-0 grid gap-2">
                  <span className="text-[13px] font-semibold text-ink">筛选仓库</span>
                  <input
                    type="search"
                    data-repo-search
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="输入仓库名"
                    className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]"
                  />
                </label>
                <CountChip data-available-count className="self-end">
                  {visible.length} 个可导入
                </CountChip>
              </div>

              <RepoListHead />

              {visible.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                  没有匹配的仓库。
                </p>
              ) : (
                <div data-available-repo-list>
                  {visible.map((candidate) => {
                    const importedRepo = findImportedGithubRepo(
                      candidate,
                      importedRepos,
                    );
                    const imported = importedRepo !== null;
                    const importing = importingId === candidate.id;
                    const refreshing = refreshingRepoId === importedRepo?.id;
                    return (
                      <RepoRow
                        key={candidate.id}
                        name={candidate.name}
                        fullName={candidate.full_name}
                        policy={
                          <>
                            <p className="m-0 truncate">
                              {candidate.visibility === "private"
                                ? "私有仓库"
                                : "公开仓库"}
                            </p>
                            {candidate.description ? (
                              <p className="m-0 truncate text-xs">
                                {candidate.description}
                              </p>
                            ) : null}
                          </>
                        }
                        sync={
                          <>
                            <span className="font-mono text-xs text-foreground">
                              {importedRepo
                                ? importedRepo.defaultBranch ?? "待解析"
                                : candidate.defaultBranch}
                            </span>
                            <small className="text-xs">默认分支</small>
                          </>
                        }
                        action={
                          imported ? (
                            <button
                              type="button"
                              data-refresh-repo-id={importedRepo?.id}
                              disabled={refreshingRepoId !== null}
                              onClick={() => {
                                if (importedRepo) handleRefreshRepo(importedRepo);
                              }}
                              className="inline-flex h-[30px] items-center justify-center whitespace-nowrap rounded-md bg-[#f6f8fa] px-[7px] text-[13px] font-medium text-foreground shadow-[0_0_0_1px_var(--border)] hover:bg-secondary disabled:pointer-events-none disabled:opacity-60"
                            >
                              {refreshing ? "刷新中…" : "刷新分支"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={importMutation.isPending}
                              onClick={() => handleImport(candidate)}
                              className="inline-flex h-[30px] items-center justify-center whitespace-nowrap rounded-md bg-primary px-[7px] text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
                            >
                              {importing ? "导入中…" : "导入"}
                            </button>
                          )
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
          {/* Forge (gitlab/gitee) source: loading / not-connected / none / list */}
          {showForgeLoading ? (
            <div className="grid gap-3 pt-1">
              <StatusPill variant="neutral" className="justify-self-start">
                正在拉取
              </StatusPill>
              <p className="m-0 font-mono text-xs leading-[1.55] text-muted-foreground">
                GET /settings/forges/repos?kind={source}
              </p>
            </div>
          ) : null}

          {showForgeError ? (
            <div
              role="alert"
              className="grid gap-3 rounded-lg bg-[#fff1f0] p-[18px] shadow-ring"
            >
              <StatusPill
                variant={forgeErrorCopy?.variant ?? "warn"}
                className="justify-self-start"
              >
                {forgeErrorCopy?.pill ?? "列表不可用"}
              </StatusPill>
              <p className="m-0 text-[13px] leading-[1.55] text-foreground">
                {forgeErrorCopy?.message ??
                  "暂时无法读取仓库列表，可直接使用上方 URL 导入或稍后重试。"}
              </p>
            </div>
          ) : null}

          {showForgeNone ? (
            <div className="grid gap-3 rounded-lg bg-[#fafafa] p-[18px] shadow-ring">
              <StatusPill variant="neutral" className="justify-self-start">
                没有可导入仓库
              </StatusPill>
              <p className="m-0 text-[13px] leading-[1.55] text-muted-foreground">
                当前账号下没有可导入的仓库。
              </p>
            </div>
          ) : null}

          {showForgeList ? (
            <div className="grid gap-2.5">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                <label className="m-0 grid gap-2">
                  <span className="text-[13px] font-semibold text-ink">
                    筛选仓库
                  </span>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="输入仓库名"
                    className="min-h-10 w-full min-w-0 rounded-md bg-card px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] outline-none placeholder:text-muted-foreground focus-visible:shadow-[inset_0_0_0_1px_var(--foreground),0_0_0_3px_rgba(10,114,239,0.12)]"
                  />
                </label>
                <CountChip className="self-end">
                  {visibleForge.length} 个可导入
                </CountChip>
              </div>

              <RepoListHead />

              {visibleForge.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                  没有匹配的仓库。
                </p>
              ) : (
                <div data-available-repo-list>
                  {visibleForge.map((candidate) => {
                    const importedRepo = findImportedForgeRepo(
                      candidate,
                      importedRepos,
                    );
                    const imported = importedRepo !== null;
                    const importing = importingPath === candidate.gitSource;
                    const refreshing = refreshingRepoId === importedRepo?.id;
                    return (
                      <RepoRow
                        key={candidate.gitSource}
                        name={
                          candidate.fullPath.split("/").pop() ?? candidate.fullPath
                        }
                        fullName={candidate.fullPath}
                        policy={
                          <p className="m-0 truncate">{candidate.visibility}</p>
                        }
                        sync={
                          <>
                            <span className="font-mono text-xs text-foreground">
                              {importedRepo
                                ? importedRepo.defaultBranch ?? "待解析"
                                : candidate.defaultBranch}
                            </span>
                            <small className="text-xs">默认分支</small>
                          </>
                        }
                        action={
                          imported ? (
                            <button
                              type="button"
                              data-refresh-repo-id={importedRepo?.id}
                              disabled={refreshingRepoId !== null}
                              onClick={() => {
                                if (importedRepo) handleRefreshRepo(importedRepo);
                              }}
                              className="inline-flex h-[30px] items-center justify-center whitespace-nowrap rounded-md bg-[#f6f8fa] px-[7px] text-[13px] font-medium text-foreground shadow-[0_0_0_1px_var(--border)] hover:bg-secondary disabled:pointer-events-none disabled:opacity-60"
                            >
                              {refreshing ? "刷新中…" : "刷新分支"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={createMutation.isPending}
                              onClick={() => handleImportForge(candidate)}
                              className="inline-flex h-[30px] items-center justify-center whitespace-nowrap rounded-md bg-primary px-[7px] text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
                            >
                              {importing ? "导入中…" : "导入"}
                            </button>
                          )
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
