/**
 * 中文文案 for the marketing site.
 *
 * 复用 console landing（apps/web/src/routes/index.tsx）已有的中文文案 where it
 * fits — hero 标题/副标题/描述、操作者模型、流程四步、边界账本（→ 安全章节）、
 * 信任 pill（→ 能力章节）均原样或就近承接；其余 section 按真实能力补写，保持与
 * `./en.ts` 同一 `SiteContent` 契约（缺字段即编译期报错）。
 *
 * `installCommand` 中的 `{domain}` 占位符由 installer 构建步骤（5.3）在发布时
 * 注入真实站点域名 —— 本模块不内置任何线上 URL。
 */
import type { SiteContent } from "./index";

export const zh: SiteContent = {
  meta: {
    title: "cloud-agent-platform — 可自托管的远端 Agent 控制面",
    description:
      "一个可自托管的控制面：在隔离容器中运行 Codex 与 Claude Code，并把字节级一致的终端实时串流到浏览器。一条命令即可在本地拉起。",
  },
  languageToggleLabel: "切换语言",
  nav: {
    links: [
      { label: "能力", href: "#features" },
      { label: "流程", href: "#how-it-works" },
      { label: "MCP", href: "#mcp" },
      { label: "权限", href: "#security" },
    ],
    console: { label: "控制台", href: "#self-host" },
    cta: { label: "自托管部署", href: "#self-host" },
  },
  hero: {
    eyebrow: "可自托管的远端 Agent 控制",
    title: "一个面向操作者的远端 Agent 运行池。",
    subtitle: "把每一次 CLI 会话变成可接管的工作流。",
    description:
      "GitHub OAuth 只负责确认身份；仓库导入决定 Agent 能碰什么；任务队列负责调度；实时终端把最后的控制权留给你。",
    methodsHeading: "把它跑起来",
    copyLabel: "复制命令",
    copiedLabel: "已复制",
    claudeCode: {
      title: "让 Claude Code 帮你装",
      badge: "推荐",
      blurb:
        "把这段话贴给 Claude Code。它会读安装脚本、检查你的主机、引导你完成 GitHub OAuth，帮你把平台感知的栈跑起来。",
      prompt:
        "在这台机器上部署 cloud-agent-platform。先读取 https://{domain}/install.sh 安装脚本，确认 Docker 与可用的 docker.sock 已就绪。然后克隆 https://github.com/{repo}，进入目录运行 `make up`（macOS 默认 BoxLite，Linux 默认 AIO）构建并启动栈。帮我创建 GitHub OAuth 应用并填好 .env，以便用白名单做生产登录；最后告诉我控制台地址和它打印的 Authorization: Bearer 令牌。",
      copyLabel: "复制 Claude Code 提示词",
    },
    install: {
      title: "自己用命令行装",
      blurb: "源码构建 + GitHub OAuth —— macOS 默认 BoxLite，Linux 默认 AIO。",
      command: "curl -fsSL https://{domain}/install.sh | sh",
      inspectLabel: "查看脚本",
      manual: {
        summary: "想先读一遍？用同样的流程手动执行：",
        commands: [
          "git clone https://github.com/{repo}.git",
          "cd cloud-agent-platform",
          "make up",
        ],
        note: "make up 始终是事实源 —— 一键命令只是对它的封装。可用 CAP_SANDBOX_PROVIDER=aio|boxlite|control-plane 覆盖。api/web 默认监听 0.0.0.0；公网 DNS/TLS/代理仍由你配置。",
      },
    },
    prebuilt: {
      title: "只想最快试一下",
      blurb: "预构建镜像，免 GitHub OAuth —— AIO/amd64 路径，在 WSL2 上最快，适合本地试用。",
      command: "curl -fsSL https://{domain}/quick-deploy.sh | bash",
      inspectLabel: "查看脚本",
      caveat:
        "仅限本地试用：自动生成 legacy 令牌，自带控制台仅限 localhost —— 不是生产路径。amd64/AIO；macOS 请走源码安装以默认使用 BoxLite。",
      manual: {
        summary: "想先读一遍？用预构建 compose 手动执行：",
        commands: [
          "curl -fsSL https://{domain}/docker-compose.prod.yml -o docker-compose.prod.yml",
          "# 写一个 .env：AUTH_TOKEN_LEGACY_ENABLED=true + AUTH_TOKEN/SESSION_SECRET/CODEX_CRED_ENC_KEY",
          "COMPOSE_PROFILES=web docker compose -f docker-compose.prod.yml up -d",
        ],
        note: "脚本会替你完成 .env 合成（见可读源码）。两个文件都由本站托管 —— 无需 clone。仅限 amd64/AIO。",
      },
    },
    secondaryCta: { label: "了解工作流程", href: "#how-it-works" },
  },
  terminal: {
    caption: "task → runner lease → operator takeover",
    lines: [
      { kind: "comment", text: "# 任务分配到空闲 runner" },
      { kind: "prompt", text: "codex \"重构鉴权守卫\"" },
      { kind: "output", text: "● 读取 apps/api/src/auth/guard.ts" },
      { kind: "output", text: "● 提议改动 — 新增 24 行，删除 11 行" },
      { kind: "comment", text: "# 写入前停顿：等待操作者接管" },
      { kind: "prompt", text: "git commit -m \"加固鉴权守卫\"" },
      { kind: "output", text: "✓ 操作者已确认 — 已提交" },
    ],
  },
  features: {
    eyebrow: "能力",
    title: "一切都收敛到具体任务，而不是交给 Agent 自行其是。",
    description: "按平台当下真实具备的能力撰写 —— 不画路线图，只讲真实表面。",
    items: [
      {
        title: "任务级容器隔离",
        body: "每个任务在主机上的独立容器中运行，一次会话的影响范围不会波及另一次。",
      },
      {
        title: "字节级一致的终端",
        body: "真实交互式 CLI 逐字节串流到浏览器 —— 你看到的，就是真实运行的。",
      },
      {
        title: "双运行时",
        body: "任务可运行在 Codex 或 Claude Code 上；按任务选择运行时，无需离开控制台。",
      },
      {
        title: "GitHub 仓库导入",
        body: "从你的 GitHub 账号导入仓库以界定 Agent 的可触达范围 —— 它不会扫描你名下的全部资产。",
      },
      {
        title: "历史、审计与指标",
        body: "任务、命令、Agent 输出与 GitHub 事件均被记录；指标呈现运行池的使用情况。",
      },
      {
        title: "OAuth + 硬白名单",
        body: "多用户 GitHub OAuth 依据硬白名单门控访问；没有公开注册入口。",
      },
    ],
  },
  howItWorks: {
    eyebrow: "流程",
    title: "从一台干净的主机，到一场你能接管的会话。",
    description: "五步，无任何定制 provisioning —— 安装器封装的，正是你会手动跑的平台感知 make up 流程。",
    steps: [
      {
        index: "01",
        title: "克隆",
        body: "把公共仓库拉取到一台具备 Docker 与可用 docker.sock 的主机上。",
      },
      {
        index: "02",
        title: "安装",
        body: "运行一键命令（或 make up）：macOS 选择 BoxLite，Linux 选择 AIO，并打印一个本地 Bearer 令牌。",
      },
      {
        index: "03",
        title: "登录",
        body: "本地用打印出的令牌登录；生产环境则用 GitHub OAuth 依据你的白名单登录。",
      },
      {
        index: "04",
        title: "创建任务",
        body: "导入仓库、选择运行时并把任务排队；控制面会把任务租约给一台空闲 runner。",
      },
      {
        index: "05",
        title: "盯住终端",
        body: "跟随实时、字节级一致的终端，在 commit、push、secret 或 PR 之前接管。",
      },
    ],
  },
  mcpConnect: {
    eyebrow: "远端 MCP",
    title: "把你的 MCP 客户端接入运行池。",
    description:
      "直接从 MCP 客户端驱动平台任务。通过 Streamable HTTP 指向远端 MCP 服务，并用你在控制台铸造的令牌完成认证。",
    endpointLabel: "Streamable HTTP 端点",
    endpoint: "https://{apiDomain}/mcp",
    copyLabel: "复制 MCP 端点",
    copiedLabel: "已复制",
    installLabel: "安装命令",
    directLabel: "A · 直连（推荐）",
    directCommand:
      'claude mcp add --transport http cap https://{apiDomain}/mcp --header "Authorization: Bearer mcp_<token>"',
    fallbackLabel: "B · mcp-remote（仅 stdio 客户端）",
    fallbackCommand:
      'npx mcp-remote https://{apiDomain}/mcp --header "Authorization: Bearer mcp_<token>"',
    transportNote:
      "大多数客户端（Claude Code、Cursor、VS Code）支持 Streamable HTTP —— 用 A。只支持 stdio 的客户端会在本地起一个进程；npx mcp-remote（B）把本地 stdio 桥接到这个远端端点。两种方式都需先在控制台铸造令牌。",
    steps: [
      {
        index: "01",
        title: "添加服务",
        body: "在 Cursor、Claude Desktop 或 VS Code 中添加一个 MCP 服务，把它的 URL 设为上面的 Streamable HTTP 端点。",
      },
      {
        index: "02",
        title: "粘入令牌",
        body: "把铸造出的 mcp_ 令牌作为 Authorization: Bearer <token> 请求头发送到该连接。",
      },
      {
        index: "03",
        title: "驱动任务",
        body: "客户端会列出平台的工具，并可在令牌权限范围内读取仓库、创建或停止任务。",
      },
    ],
    tokenNote:
      "令牌在控制台设置页铸造 —— MCP Server 区会一次性签发一个 mcp_ 令牌，权限由你界定。本页只说明连接方式，绝不铸造令牌。",
    tokenCta: { label: "在你的控制台中铸造令牌", href: "#self-host" },
  },
  security: {
    eyebrow: "权限",
    title: "对边界保持诚实：控制台访问即等于主机 root。",
    description: "我们不掩盖信任模型。在部署到你本机之外前，请先读这一段。",
    points: [
      {
        title: "任务经由 docker.sock 以主机 root 运行",
        body: "后端通过 Docker socket 驱动任务，因此能登录的人实际上就能在主机上以 root 运行。请把控制台访问视为主机 root 权限。",
      },
      {
        title: "fail-closed 白名单",
        body: "生产环境 OAuth 优先且 fail-closed：不在白名单上的账号停在拒绝访问状态，绝不触达任何控制台资源。",
      },
      {
        title: "高风险动作前的写入门",
        body: "commit、push、secret 和 PR 创建会停顿等待操作者确认，而不是无人值守地执行。",
      },
      {
        title: "可审计的安装路径",
        body: "安装脚本以纯文本提供，运行前即可阅读；等价的手动 git clone && make up 路径始终可用。",
      },
    ],
  },
  selfHost: {
    eyebrow: "自托管",
    title: "它完全运行在你自己的基础设施上。",
    description: "开源、无遥测、无 installer-as-a-service。一条命令即可在你掌控的主机上拉起整套栈。",
    primaryCta: { label: "复制安装命令", href: "#install" },
    secondaryCta: { label: "查看手动部署", href: "#how-it-works" },
  },
  footer: {
    tagline: "面向远端 Agent 运行的可自托管控制面。",
    links: [
      { label: "能力", href: "#features" },
      { label: "流程", href: "#how-it-works" },
      { label: "MCP", href: "#mcp" },
      { label: "权限", href: "#security" },
      { label: "GitHub", href: "https://github.com/{repo}" },
    ],
    legal: "开源。自托管。设计上即主机 root —— 请据此部署。",
  },
};
