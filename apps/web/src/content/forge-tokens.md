把任务在沙箱里的改动**推回你的仓库并自动开 PR / MR**，需要一个有「读写仓库 + 创建 PR/MR」权限的访问令牌（Personal Access Token）。令牌按账户 AES‑256‑GCM 加密存储，仅在任务推送 / 开 PR 时由服务端解密；保存后界面只展示后 4 位。

有些内网 Gitee 只给 clone / push 权限，不允许读取仓库列表 API。这种令牌仍可保存为 git 操作凭据；导入仓库时直接粘贴仓库 HTTP(S) URL，不需要先同步仓库列表。

下面每个平台都给两种方式：**网页版**（给人，一键打开已预填的创建页）和 **终端版（Agent）**（给沙箱里的 agent，命令优先）。

## GitHub

**所需 scope：`repo`**（私有库；仅公开库可用 `public_repo`）。GitHub 永远是 `github.com`，**无需填实例地址**。

### 网页版

- 一键创建（细粒度令牌，已预填 Contents + Pull requests 写权限）：[https://github.com/settings/personal-access-tokens/new?contents=write&pull_requests=write](https://github.com/settings/personal-access-tokens/new?contents=write&pull_requests=write)

  选好要授权的仓库 → Generate token → 复制 → 回控制台「代码托管连接 → GitHub → 连接」粘贴。
- 经典令牌兜底（已预填 `repo` scope）：[https://github.com/settings/tokens/new?scopes=repo](https://github.com/settings/tokens/new?scopes=repo)

### 终端版（Agent）

GitHub 的 PAT 需要在网页里创建。拿到 PAT 后，可以用 CLI 做一次校验：

```bash
printf '%s' '<PAT>' | gh auth login --with-token
gh auth status
```

## GitLab

**所需 scope：`api`**（覆盖 git 读写 + 创建 MR）。想最小权限可改用 `read_repository` + `write_repository`，但**只勾这两个开不了 MR**，要开 MR 必须有 `api`。GitLab 自托管常见，**需要实例地址**（默认 `gitlab.com`）。

### 网页版

- 一键创建（已预填 `api` scope；把 `<host>` 换成你的实例，默认 `gitlab.com`）：`https://<host>/-/user_settings/personal_access_tokens?scopes=api`

  公有版示例：[https://gitlab.com/-/user_settings/personal_access_tokens?scopes=api](https://gitlab.com/-/user_settings/personal_access_tokens?scopes=api)

  设 Expiration → Create personal access token → 复制 `glpat-…` → 回控制台「GitLab → 连接」；**自托管时在「实例地址」填 `https://<host>`**。

### 终端版（Agent）

> 动手前先问用户：**「你的 GitLab 实例地址？（默认 `https://gitlab.com`，自托管请填你的实例）」** —— 这个 host 既用于拼上面的创建链接，也是控制台连接时「实例地址」要填的值。

GitLab 的 PAT 不能纯终端铸（须网页创建）；拿到后可用 CLI 校验：

```bash
glab auth login --hostname <host> --token <glpat>
glab auth status
```

## Gitee

**完整功能 scope：`projects` + `pull_requests`**。如果你的内网 Gitee token 只有 git clone / push 权限，仍可连接并通过 URL 导入仓库，但仓库列表和自动开 PR 可能不可用。同样**需要实例地址**（默认 `gitee.com`）。

### 网页版

- 打开创建页（把 `<host>` 换成你的实例，默认 `gitee.com`）：`https://<host>/profile/personal_access_tokens`

  公有版示例：[https://gitee.com/profile/personal_access_tokens](https://gitee.com/profile/personal_access_tokens)

  **生成新令牌 → 手动勾选 `projects` 和 `pull_requests` → 提交**（可能二次输入登录密码）→ 复制令牌 → 回控制台「Gitee → 连接」粘贴。若实例策略只允许 git 权限，保存后在「添加仓库」中使用 URL 导入。
- ⚠️ Gitee **没有** scope 预填参数（不同于 GitHub / GitLab），scope 只能在页面里手动勾。

### 终端版（Agent）

> 动手前先问用户：**「你的 Gitee 实例地址？（默认 `https://gitee.com`）」**。

Gitee 无主流 CLI，令牌只能在网页创建；拿到后可用 API 校验有效性：

```bash
curl -s -H "Authorization: token <令牌>" https://<host>/api/v5/user
```

## 跨平台差异（免得踩坑）

| 平台 | 实例地址 | scope 预填 |
| --- | --- | --- |
| **GitHub** | 不需要（永远 `github.com`） | 支持（query 参数） |
| **GitLab** | 需要（默认 `gitlab.com`） | 支持（`?scopes=api`） |
| **Gitee** | 需要（默认 `gitee.com`） | **不支持**，须手动勾 |
