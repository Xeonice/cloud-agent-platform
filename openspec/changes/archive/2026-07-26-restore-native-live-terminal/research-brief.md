# Research brief: restore native live terminal

## 问题与目标

当前在线终端并非单纯把沙箱 PTY 的字节交给浏览器 xterm，而是在 Codex/Claude Code、tmux、API gateway 和浏览器之间叠加了一套“把全屏 TUI 改造成可滚动普通缓冲区”的兼容链路：交互式 Codex 强制 `--no-alt-screen`，Claude Code 强制 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`，浏览器过滤 tmux attach 的 alternate-screen 控制序列，API 再用 headless xterm snapshot 加 `session.log` tail 恢复重连。这个目标与“线上完整复刻本地 Codex/Claude Code 原生终端”直接冲突，也使重连、尺寸、视口与录制之间形成复杂耦合。

本变更的优先级是恢复原生全屏 TUI。运行中终端的跨刷新滚动历史明确延期；任务完成后的结构化会话与静态 terminal record 仍保留，但 API-resident recorder 不再声称跨 API restart 的字节完整性。

## 代码与规格调查

### 当前数据路径

1. `TerminalGateway.openSession()` 为每个 task 建立一个共享 `TerminalPty` 和一个 `SnapshotManager`；共享 PTY 的输出同时进入 headless xterm、`session.log`、`session.cast` 和所有浏览器客户端。
2. `TerminalGateway.onReconnect()` 按客户端 `fromSeq` 构造 snapshot/tail-replay，再把客户端订阅回同一个 task PTY。重连恢复的是 CAP 重建的终端状态，不是沙箱中新 PTY 上的 tmux 当前屏重绘。
3. `session-terminal.tsx` 对 snapshot、tail 和热输出都过滤 `?1049`/`?1047`/`?47` alternate-screen 序列，并维护隐藏/揭示、串行回放、ACK 和 viewport scroll-height 修正。
4. AIO 与 BoxLite 已经位于统一 `TerminalTransport` seam 后。AIO 的 provider client 已有严格 `attach-only` 模式；BoxLite 的每次 terminal open 都能建立新的 TTY execution/attach，二者都具备为浏览器连接创建独立 PTY 的基础。
5. 当前 interactive runtime 启动参数主动改变了 CLI 行为：Codex 默认行包含 `--no-alt-screen`；Claude Code 启动环境包含 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`。headless execution 是另一条路径，不应随本变更改变。
6. AIO 的现有 task-level `AioPtyClient` 还承担启动期 CR/DSR、agent readiness/auth classification、liveness 和 readoption；它不能直接被浏览器 viewer 替换。最小分离方式是保留该 owner/monitor，并在其旁边增加轻量 viewer attachment。
7. 当前 `AioPtyClient` 在 established owner WebSocket 关闭后不主动 redial，而是可能等下次 input 才触发 reconnect。新架构的人类 input 改走 viewer，所以 owner 必须新增独立 supervisor；否则 API 仍在线也会永久失去 recording/classification。
8. 当前 Gateway 允许已认证 WebSocket 再次 `connect_auth` 时改写 `state.taskId`。如果首个 attach 已被接受但 provider open 仍在异步等待，该能力就能在 attachment/query queue 创建前换靶，使 lease/resize/input 跨 task 错配；因此必须在同步接受 attach 请求时、任何 await 前冻结 principal/task/generation 绑定。
9. 共享 `packages/ui` Terminal 只订阅 `onData`；xterm 官方 API 说明某些非 UTF-8 legacy/default mouse reports 只经 `onBinary` 发出。现有 `keystroke.data` 虽声明为 base64 opaque bytes，但 Web 只编码 JS string，Gateway 又先解码为 UTF-8 string，BoxLite transport 也再次按 UTF-8 编码，无法证明 `0x80..0xff` 原样到达 PTY。fresh-attach canary 已同时订阅 `onData`/`onBinary`，产品路径也必须建立 provider-neutral opaque-byte seam 并由 AIO/BoxLite 真机证明，否则不能声称鼠标 1:1。

### 现有规格冲突

- `realtime-terminal` 同时要求 live-frame parity，又要求 inline Codex、过滤 alternate-screen、运行中滚动历史、snapshot/tail reconnect 和 provider-independent replay；后四项正是非原生链路，需要以 native attach 语义替换。
- `agent-runtime` 把 Claude Code 的 disable-alternate-screen 环境变量写成规范，并以“inline buffer pinned for replay”作为验收场景；交互式 Codex 的 no-alt 行为也被现有实时终端规格钉住。
- `sandbox-readoption` 已经要求 detached named tmux、attach existing session、API restart readoption 和 single-writer，但目前把 task 级 lifecycle/recording bridge 与 operator viewer attach 混在一个 PTY 中。
- `sandbox-provider-port` 的 terminal conformance 只覆盖 output/input/resize/close-replacement/attach，没有要求 fresh PTY 身份、当前屏完整重绘、无历史泄漏以及 viewer cleanup。
- `terminal-execution` 与 finished-session specs 把 `session.log`/`session.cast` 用于任务结束后的终端记录；它们应继续由唯一 task recorder 产生，而不能由每个 viewer attach 重复写入。但该 recorder 位于 API 进程，API 停机与无法可靠分界的 owner attach bootstrap 必然可能形成记录缺口；用 tmux 当前屏回填反而会伪造连续性。
- 活跃 change `enable-yolo-agent-launch` 同时修改 Codex/Claude 的 permission flags 与 `ClaudeCodeRuntime launch line and sandbox flags` requirement。本变更只拥有 terminal-mode override；实施和归档时必须保留 yolo change 最终选定的 permission/trust 语义，不能用当前 canonical 的 `acceptEdits` 文本把它回滚。
- 活跃 change `rework-sandbox-provider-center-and-e2e` 又新增了“sandbox center 拥有 snapshot/tail replay”和“fixture 发送 snapshot + tail”两个 requirement，与本变更直接互斥。它与 `refactor-sandbox-provider-split` 已完成但未归档；`enable-yolo-agent-launch` 代码/tasks 已落地但 OpenSpec design 仍缺失。因此必须先按依赖完成/归档这些 change，再将本 change rebase 到 canonical base；strict validator 不会自动发现 active-change 之间的语义冲突。

### 历史变更

归档变更显示该复杂度是逐层增加的：`console-terminal-1to1` 首先追求直接 xterm 和几何一致；`fix-terminal-input-dead-after-reload` 为滚动历史加入 Codex inline；`fix-live-terminal-scrollback` 与 `fix-live-terminal-scrollback-strip` 再处理 tmux attach 的 alternate screen；`harden-aio-execution`、`fix-live-terminal-refresh-replay` 又加入 headless snapshot、tail replay 和刷新时的视口协调。本次不再让运行中 terminal 承担历史恢复；finished path 与活跃 `static-terminal-log` 保持静态只读终端记录语义，不恢复 timing player。

## 外部资料结论

- tmux 的正式文档将 session 定义为可 detach 后继续运行、随后再次 attach 的终端集合，并明确一个 session 可以同时挂载多个 client；因此“每个浏览器连接一个新的外层 PTY/tmux client”符合 tmux 原生模型，而不是模拟器。[tmux manual](https://man.openbsd.org/tmux.1) / [tmux Getting Started](https://github.com/tmux/tmux/wiki/Getting-Started)
- tmux 明确说明不会保证外层 terminal scrollback 在窗口/窗格切换及多客户端场景中保持一致，因此不应把 tmux attach 重绘与浏览器普通缓冲区拼成可靠历史。[tmux FAQ](https://github.com/tmux/tmux/wiki/FAQ)
- tmux 窗口尺寸由 attached clients 和 `window-size` 策略共同决定；`latest`、`largest`、`smallest` 都会让多个不同尺寸 viewer 相互影响。产品必须定义唯一权威尺寸，而不能让每个只读 viewer 竞争 resize。[tmux Advanced Use](https://github.com/tmux/tmux/wiki/Advanced-Use)
- AIO 线上版本 tmux 3.2a 的手册确认 `attach -r` 同时设置 `read-only` 与 `ignore-size`，适合只读 viewer；后台 owner/monitor 可用 `attach -f ignore-size` 避免影响权威 pane 尺寸。`tmux -L` 会选择另一套 server/socket，不能拿它 attach 默认 server 上的业务 session。[tmux 3.2a manual](https://raw.githubusercontent.com/tmux/tmux/3.2a/tmux.1)
- xterm.js 官方提供 attach addon 来消费 WebSocket 终端流，也提供 headless/serialize 用于状态恢复；serialize 是可选恢复方案，不是保真显示全屏 TUI 的前提。对于本目标，最短路径是把 fresh tmux client 的原始字节直接交给新的浏览器 xterm。[xterm.js](https://github.com/xtermjs/xterm.js)
- xterm.js 的稳定 API 把 `reset()` 定义为完整 RIS reset，并允许直接写入 `Uint8Array`；原生 live path 应从干净 terminal state 消费 fresh PTY 字节，而不是把旧 buffer 与新 attach 混合。[xterm.js Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/)
- 同一 API 要求常规集成将 `onData` 转发到 backing PTY；lockfile 当前精确解析到 xterm.js 5.5.0，其源码除了 primary/secondary DA、DSR status 与 normal/private CPR，还注册了 ANSI/private DECRQM、DECRQSS、OSC 4/10/11/12 颜色查询，以及受 `windowOptions` 控制的 window reports。具体响应受 exact version、termName、options 与 browser integration/addons 影响，因此不能凭预设的五类列表声称 1:1：浏览器/API 必须协商一个经生产 wrapper source-conformance 验证的 response profile。因为人类输入与协议响应共用 `onData`，Gateway 必须用 attachment-local outstanding query 作授权关联，不能仅信任浏览器声明或 regex。[xterm.js 5.5.0 InputHandler](https://raw.githubusercontent.com/xtermjs/xterm.js/5.5.0/src/common/InputHandler.ts)
- xterm 官方将 `onBinary` 专门用于把不符合 UTF-8 的二进制消息送回 backend，目前用于特定 mouse reports，并要求按 binary bytes 写入 PTY。它不能经过 UTF-8 `string -> Buffer -> string` 往返；同时 mouse/focus 仍是人类交互，必须保留 write lease。[xterm.js Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/)
- AIO Sandbox 官方把 `/v1/shell/ws` 定义为 PTY-backed WebTerminal，并明确连接失败后应创建新的 terminal session、不要依赖 reconnect 获得完整历史；这与 CAP 的 fresh outer PTY + tmux current redraw 选择一致。[AIO Shell Terminal](https://sandbox.agent-infra.com/guide/basic/shell)

## 真实 provider 验证

`scripts/terminal-fresh-attach-canary.mjs` 已在本机真实 BoxLite 与远端 `bwg-jp` AIO 上验证 fresh PTY + tmux attach。测试不是读取 `capture-pane` 后拼文本，而是让两个/三个互不相同的 provider PTY 依次 attach 到同一个静止 tmux session，并用新的 headless/browser xterm 消费实际字节。

为避免触碰远端业务 session，独立 canary 使用唯一 `tmux -L capfresh...` socket；这只用于隔离测试资源。产品 attachment 必须在 task owner 所在的默认 tmux server/socket 上以精确 `=task<id>` target attach，不能用 `-L` 创建另一套看不到业务 session 的 server。

加强后的验证覆盖：

- 80x24 alternate-buffer 当前屏的 24 行完整重建；包含 clear、cursor addressing、粗体、256 色、CJK 宽字符、cursor position 和 SMCUP。
- 50,000 条唯一 normal-buffer 历史施压后，fresh attach 只恢复当前屏；first/middle/last history marker 均未泄漏到 fresh attach 字节，说明方案不依赖历史重放。
- 第二个 viewer attach 后，同一连接继续收到 live marker；只有目标行变化且 marker 只出现一次。
- 完全关闭 viewer、等待后再用第三个不同 PTY 重连，headless canonical state 仍一致；Playwright 中 xterm 可见 24 行，截图非空并与第一次 attach 一致。
- BoxLite（tmux 3.3a）fresh attach 约 2675 bytes，约为 50k 历史原始量的 0.001189；AIO（tmux 3.2a）约 2910 bytes，比例约 0.001293。两端 live delta 均为 92 bytes。临时 BoxLite、AIO tmux socket/session 与长驻 fixture 均在成功/失败路径清理。

该验证证明了 provider 传输和 tmux fresh-client redraw 原语可行，但不是最终产品验收的替代品。fixture 的长输出压力在 inner normal buffer 上完成，alternate buffer 是静态全屏帧；移除 runtime 的 no-alt 开关后，还必须用真实 Codex 与 Claude Code 默认全屏模式跑长时更新、断网重连、resize 和 API restart E2E，才能发布。

## 推荐架构

```text
detached tmux task session (agent process)
  ├─ task recorder/supervisor PTY
  │    ├─ lifecycle / exit detection
  │    └─ session.log + session.cast (single writer)
  └─ disposable viewer PTY per browser connection
       ├─ attach-only to existing tmux session
       ├─ raw bytes -> CAP WS -> browser xterm
       ├─ viewer-local ACK/backpressure
       └─ close on browser disconnect; never kills agent
```

关键约束：

1. interactive runtime 使用 Codex/Claude Code 默认 terminal mode，不再强制 normal buffer；原始 alternate-screen、mouse、cursor、style 和 clear 控制序列不得在 live path 被过滤或改写。
2. browser 首连和每次重连都清空/重置当前 xterm，然后由 provider 建立新的 attach-only PTY。viewer 绝不走 launch fallback；目标 session 不存在时返回明确 terminal-unavailable，而不是启动第二个 agent。
3. task recorder 是 lifecycle 与 best-effort recording 的唯一拥有者。viewer attach 的 command echo、tmux bootstrap 和当前屏 repaint 不写入 `session.log`/`session.cast`，避免多 viewer 重复与 attach 污染；API 停机/readoption settle 窗口允许有明确缺口，不用重绘字节伪造连续性。
4. 每个 viewer 的 high-water/ACK 只 pause 自己的 PTY/transport，不能阻塞 recorder、agent 或其他 viewer。
5. 只有 write-lease holder 的 resize 影响权威 tmux pane geometry；只读 viewer 跟随该 geometry，不得相互争抢。lease 转移后新 holder 的当前尺寸成为权威值并通知其他 viewer。
6. `session.log`/`session.cast`、structured transcript 和任务结束后的静态只读终端记录继续保留，但不再参与运行中 browser reconnect，也不被宣称为跨 API restart 的完整字节审计。
7. xterm response profile 内的自动 `onData` 查询响应属于各 viewer attachment 的终端协议流，不是人类输入；它只有在 Gateway 已从该 attachment output 观察到同类、未消费、未过期的 outstanding query 时才能绕过 write lease，匹配后单次消费并回到同一 viewer PTY。只有能完整分词为已知响应且无任何剩余字节的 `onData` burst 可走该路径；mixed/ambiguous burst 整体走 lease-gated human-input path，不能抽出一个看似合法的子串绕过 lease。`onBinary` mouse report 不属于 query response，必须原字节、lease-gated。现有固定 CPR 只属于 task owner 的启动兼容，不能注入 viewer。
8. fresh attach 的 bootstrap 正是 tmux 发出的 SMCUP、clear 和当前屏 repaint。live viewer 必须消费所有到达的这些字节；若要避免 shell echo 闪烁，可以在有界 settle + xterm flush 后再揭示，但不能过滤 bootstrap，否则静止 TUI 会永久空白。
9. tmux attach 没有 bootstrap/frame-end marker。对静止 TUI，quiet-window + canonical-state 可以验收完整当前屏；对持续 repaint，`ready` 只是有上限的 UI reveal 阈值，不是完整帧证明，之后 raw bytes 仍按序收敛。同样，owner settle 只能在窗口内抑制字节：可能漏掉真实输出，也可能在 deadline 后录入迟到 repaint。

## 范围与发布门槛

### 本次包含

- 原生 interactive runtime flags、per-viewer fresh attach、viewer lifecycle、write lease/resize 规则。
- 删除 live snapshot/tail protocol、前端 alt stripping 与 scrollback viewport hack；保留通用 raw/control WS、ACK/backpressure、ready fallback。
- AIO 与 BoxLite 的 provider-neutral conformance，以及完整 CAP gateway/browser E2E。
- 将真实 canary 固化为可重复、显式开启的 provider gate；所有临时资源可验证清理。

### 明确延期

- 运行中终端跨刷新或跨设备的 scrollback/history。
- 从 `session.log` 合成可滚动的语义对话。
- 多个 viewer 各自独立决定 pane 尺寸。
- 引入 sandbox-resident recorder/exit sentinel 来保证 API 缺席期间的字节完整性或自然退出结算；无 durable exit evidence 的停机期间退出按 unobserved/orphan failure 处理。

### 发布门槛

- 真实 Codex 和 Claude Code 均以默认 alternate-screen 模式完成长输出/长时 redraw、输入、resize、瞬断、完全断开后重连、API restart readoption。
- AIO 和 BoxLite 都证明 fresh PTY identity、完整当前屏、无历史前缀、live continuation、single-writer、viewer-local backpressure、无 viewer 重复录制和无残留资源。API restart gate 必须量化并如实报告 recorder gap，不验收“字节连续”。
- owner transport 在 API 在线期间断开后必须无需 viewer/input 主动 attach-only 恢复；API 停机期间 agent 结束且无 durable exit evidence 时必须明确失败且绝不重启。真实 CLI 只报 owner 缺席/settle duration 且将 missing-byte count 标为 unknown；只有 sequence-marked fixture 计算精确缺失 bytes/events。
- 量化恢复默认 alternate-screen 后 `session.log`/`session.cast` 的增长；每个 task 只允许 owner recorder 写入，viewer repaint 绝不能被重复录制。若现有 retention 上限不足，应在发布前形成独立、明确的容量策略，而不是在 live path 偷偷丢字节。
- Playwright 在 CAP 页面验证首连/重连前后非空截图与标准化 screen state 一致；不是仅依赖文本断言。
- 对每个真实 Codex/Claude/tmux/provider/browser 组合盘点实际 query：每一类要么被有限映射完整关联并由只读 viewer 成功响应，要么有证据证明 xterm 不产生 data response 且缺失不影响屏幕/控制流；任何 xterm 会响应但未覆盖、或影响未知的 query 都阻断 native path 默认启用，运行时 fail-closed diagnostic 本身不算通过。
- 使用生产共享 Terminal wrapper 建立 source-conformance matrix，固定 exact resolved xterm version、termName、`disableStdin`/`windowOptions` 与 response-affecting addons；覆盖 DA、DSR/CPR、ANSI/private DECRQM、DECRQSS、OSC color、7-bit/C1 编码及条件 window reports。版本、选项或 addon 指纹改变时，profile 未重新验证即阻断构建/发布。
- AIO 与 BoxLite 都必须证明 `onBinary` legacy mouse report 和代表性高位 byte 经 browser -> CAP -> provider PTY 全程无 UTF-8 变换；如果某 provider 原生协议无法承载 opaque bytes，则该 provider 的 native terminal capability 不得默认启用。
- finished task 的结构化记录与 `static-terminal-log` 静态只读终端记录回归通过，并对可能的 API restart 缺口保持语义诚实。

## 结论

fresh provider PTY + tmux attach 已由真实 AIO/BoxLite 证明能在不重放长历史的前提下恢复完整当前屏，并继续接收实时输出。方案可行，但必须把 task lifecycle/recorder 与 viewer attach 分离，才能避免多 viewer 重复录制；同时明确接受 API restart/readoption 窗口的 best-effort 记录缺口。这个边界比继续修补 snapshot/tail 与 alternate-screen filtering 更直接，也与“原生体验优先、运行中历史延期”的产品决定一致。
