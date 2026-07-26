## Context

CAP 当前把一个 task 级 `AgentTerminalPty` 同时当作 agent owner、生命周期观察器、持久记录源和所有浏览器的共享显示源。为了让运行中的 xterm 拥有滚动历史，interactive runtime 被强制改成 normal-buffer 模式；API 用 headless xterm 建 snapshot，再按 `session.log` offset 做 tail replay；Web 过滤 alternate-screen 控制序列并修正 viewport。这个链路恢复的是 CAP 合成状态，不是一个真实终端重新连接 tmux 时得到的状态。

本机 BoxLite 与远端 AIO 已证明另一条原语：在相同 `TERM` 与 geometry 下，让一个全新的 provider PTY 在同一个 tmux server 上 attach 已存在 session，tmux 会向新 client 重绘完整当前屏；50,000 行历史不会被重放，之后的 live update 会继续到达。该结果允许我们把 live reconnect 简化为“新的真实终端 attach”，但 task owner 仍必须常驻，因为无人浏览时也需要 exit detection、readoption、activity、runtime failure classification 与有界 failure evidence；完整 raw `session.log`/`session.cast` 不再是 owner 存活的理由。

涉及的主要边界是 `apps/api` gateway、`apps/web` xterm client、contracts、agent runtimes、`packages/sandbox-core`、shared sandbox terminal harness、AIO transport/client 与 BoxLite transport。浏览器仍只能连接 CAP WebSocket，不能获得 provider URL 或 token。活跃 change `enable-yolo-agent-launch` 同时拥有 runtime permission flags；本设计只改变 terminal-mode override，实施时必须合并而不能回滚其最终 permission/trust 决策。已完成但仍缺真实服务检查的 `static-terminal-log` 只拥有 finished-session renderer，本设计拥有 live path。

```text
                         detached tmux task session
                                   │
             ┌─────────────────────┼─────────────────────┐
             │                     │                     │
      task owner PTY        browser attachment A  browser attachment B
      (one per task)          (one per WS)           (one per WS)
             │                     │                     │
   lifecycle/classifier       current redraw +       current redraw +
   bounded failure evidence   subsequent live        subsequent live
   optional bounded raw files
             │                     │                     │
        never browser fan-out     CAP raw/control WS; input gated by lease
```

## Goals / Non-Goals

**Goals:**

- 让 interactive Codex 与 Claude Code 使用默认全屏 terminal mode，并把有效 UTF-8、ANSI/DEC 控制序列原样交给浏览器 xterm。
- 首连、网络重连、硬刷新和 API readoption 后都通过 fresh provider PTY attach 恢复当前完整屏，而不是回放历史字节。
- 保留 task 生命周期、单写者、认证、provider 隔离、API owner 存活但无人浏览时的 activity/classification，以及 finished-session structured transcript；完整 raw terminal history 默认延期。
- 让每个浏览器 attachment 拥有独立 transport、backpressure、close/abort 与错误状态；一个慢 viewer 或断连不能暂停 agent、owner 或其他 viewer。
- 在 AIO 与 BoxLite 上用同一 contract 和真实 canary 验证，不为测试 fixture 硬编码产品行为。

**Non-Goals:**

- 不保留运行中 xterm 的跨刷新 scrollback，也不从 raw TUI 字节合成语义历史。
- 不改变 headless execution、runtime authentication/model/transcript policy、finished-session structured transcript 或 `static-terminal-log` 的只读范围。
- 不让多个 viewer 分别控制同一个 tmux pane 的 geometry；读者看到的是 writer 的权威 geometry。
- 不直接把 AIO/BoxLite terminal endpoint 暴露给浏览器，也不以 VNC、GUI 模拟器、`capture-pane` 文本或截图流替代 PTY。
- 不承诺非法 UTF-8/binary payload 的逐字节 terminal rendering；现有有效 UTF-8 分片与 ANSI 字节保真要求保持。

## Decisions

### 1. 保留 task owner，新增轻量 viewer attachment

`AgentTerminalPty` 继续是一 task 一个的 owner。它保留 launch-or-attach、startup CR/DSR/autosubmit、liveness/exit、runtime failure classification、guardrail activity、readoption、有界 failure evidence 和唯一 eligible-output stream。完整 raw artifact writer 是该 stream 上独立的默认-off policy，不是 owner 的生命周期职责。API restart 恢复 owner 时仍走严格 `attach-only`，`absent`/`indeterminate` 不能制造新 agent。

owner transport 也必须被主动监督，不能再依赖“下一次人类输入”触发重连。已建立 owner PTY/WS 异常关闭后，单一 generation 的 supervisor 使用有上限的指数 backoff 与 jitter 重新探测精确 session：`alive` 才 attach-only redial，`indeterminate` 保持 degraded 并在现有超时预算内重试，`absent` 则走明确的 unobserved-exit/orphan failure reconciliation；任何分支都不 launch。旧 generation 的迟到 open/output/close 必须失效，任何时刻最多一个 owner evidence/classification authority。owner outage 与重 attach settle 窗口记录 duration metric；真实 CLI 没有独立 byte oracle，不伪造缺失字节数。

新增 provider-neutral `TerminalViewerAttachment` 与 factory。每次已认证 browser WebSocket attach 时，factory 都调用现有 `TerminalTransportFactory.open()` 创建新的外层 provider PTY，先设置权威 geometry，再在 task owner 所在的默认 tmux socket 上执行精确 target 的 `tmux attach-session -f ignore-size -t =task<id>`。attachment 只有 attach-existing、output、input、outer-PTY resize、pause/resume、close 和 attach outcome；它没有 launch、task exit、recording、classification 或 teardown 权限。

所有 browser tmux clients 使用 `ignore-size`，避免 tmux 的 largest/smallest/latest policy 因 viewer viewport 改变 pane。CAP 的现有 write lease 仍是唯一 human-input authority：没有 lease 的 connection 即使底层 client 可写，也永远收不到 gateway 转发的人类输入。这里不使用 `tmux -r` 作为主授权边界，因为 lease takeover 若要把同一 client 从 reader 升为 writer，会引入 attachment 重建/动态 client targeting；provider PTY 从未暴露给浏览器，CAP gating 已是现有安全边界。`tmux -r` 可作为后续 defense-in-depth，但不能取代 CAP lease。

选择该方案而不是“每个浏览器一个完整 `AioPtyClient`”，是为了不复制 launch/liveness/readoption 状态机；选择它而不是复用共享 owner PTY，是为了让 fresh attach 首屏、backpressure 和 disconnect 真正按 viewer 隔离。

### 2. live reconnect 变为 attach handshake，不再有 snapshot/tail

contracts 删除 live-only `snapshot`、`tail_replay` 和带 `lastSeq` 的 reconnect restore 语义，改为一个明确的 terminal attach handshake：

- client -> server：`terminal_attach { protocolVersion, responseProfileId, cols, rows }`；`responseProfileId` 指纹化 exact resolved xterm version、termName、`disableStdin`/`windowOptions` 与 response-affecting addons，API 不认识时 fail closed/reload-required；
- server -> client：`terminal_attachment_state { state, cols, rows, reason? }`，状态至少区分 `attaching`、`ready`、`unavailable` 与 `failed`；
- server -> client：现有 raw frame，seq/ACK 只在当前 WebSocket/attachment 生命周期内单调递增；
- server -> clients：`terminal_geometry { cols, rows }` 通知当前权威 geometry。

一个 WebSocket 生命周期只允许接受一次 `terminal_attach`，并一对一拥有一个 immutable viewer attachment；accepted attach 即使最终 unavailable/failed 也不允许在同一 socket 换 task 重试，需要重新 attach 时关闭 socket，由既有自动重连创建新的 WebSocket 与 PTY。这样 raw seq/ACK 天然以 connection 为边界，不在公共协议中再引入 attachment id。Gateway/transport 内部仍使用 generation 与 AbortSignal 丢弃异步 open/close 的晚到 callback。attachment 的所有首帧字节都进入该浏览器 xterm；它们不经过 owner output path，也不进入记录。attach session 不存在、probe 不确定、transport 关闭或首帧超时都产生明确状态，不能以“连接成功但空白”表示失败，更不能 fallback launch。

Gateway 在同步接受首个有效 `terminal_attach` 时、任何 task-owner decision、provider probe/open 或其他 `await` 之前，原子执行 `unattached -> attaching`、预留 generation，并冻结 `{canonical principal identity, boundTaskId, generation}`。principal identity 从已解析的 `OperatorPrincipal` 派生稳定的非秘密 kind/user/key identity，绝不保存 raw credential。`attaching` 已视为绑定完成；并发或迟到 auth resolution 必须受 auth-attempt epoch/cancellation fencing，不能在 attach accepted 后改写 principal/task。`attaching` 期间及之后的 `connect_auth` 只能重验同一 principal/task，不能把 task A 的 pending 或已挂载 socket 改指 task B；需要换 task 或失败重试必须新建 WebSocket。

所有 client-to-server task-scoped action，包括 keystroke、resize、heartbeat、takeover、decision、ACK、terminal response 及未来新增 frame，都只从冻结 ClientState 解析；frame 自带的 task/session id 必须等于 `boundTaskId`，decision 还必须匹配 pending approval 的 task。任何二次 attach、跨 task/principal frame、迟到 auth、旧 generation 事件都先关闭 generation、取消 pending open 并 fail closed；迟到 provider open result 只执行 exact attachment cleanup，不得触及任一 task。

替代方案 headless SerializeAddon + `session.log` tail 被拒绝：从任意 offset 重放 cursor-addressed alternate-buffer 字节不能保证恢复 TUI state，也是当前复杂度来源。`capture-pane` 被拒绝，因为它把 cell/text 状态重新编码，不能覆盖终端模式、光标、颜色能力协商和之后的真实交互。

### 3. 浏览器不丢 fresh attach 字节，以有界 settle 揭示

新 attachment 不复用 owner 的“attach bootstrap 不可记录”逻辑来丢弃显示字节。tmux attach 的 SMCUP、clear、cursor positioning 与当前屏 repaint 正是重连恢复所需内容，必须全部转发。

Web 在 `attaching` 时重置一个隐藏的 xterm、应用 server 返回的权威 geometry，并正常消费/ACK raw frames。provider wrapper/gateway 在观察到首个 output burst 后，以有上限的 quiet-window 标记 `ready`；持续更新的 TUI 到达上限时也必须 ready，quiet-window 只控制 UI 揭示时机，不参与字节过滤或正确性判断，也不证明 tmux 存在协议级“帧结束”。静止当前屏由 canonical-state gate 证明在 reveal 前已完整；持续 repaint 的 TUI 在 deadline reveal 后仍按序消费新字节并收敛。`ready` 之前页面显示明确“正在重新连接终端”，而不是把空白 xterm 当作成功。attach error 显示可重试错误。

替代方案“收到第一个 chunk 就展示”实现更少，但可能把多 frame 的半屏 repaint 暴露给用户；双 xterm 交叉淡入会增加 renderer 和 input ownership，因此不采用。隐藏同一个 xterm 到 bounded settle 能保留现有 renderer 且不重新引入 replay queue。

### 4. owner eligibility 与 raw artifact policy 分离

`TerminalGateway.onOwnerOutput`（由现有 `onPtyOutput` 收敛而来）先判断 producer/provenance eligibility：attach bootstrap 与 resize repaint 不进入 owner evidence；eligible agent output 无条件更新有界 rolling failure evidence 并调用 runtime classifier，activity 继续独立记录。随后才由互相独立的 `session.log` 与 `session.cast` policy 决定是否写 raw artifact。任何 browser attachment output，包括首屏 repaint、terminal query、重复 live update，都只发送给所属 WebSocket，永远不触发 evidence/classification/task-exit。

owner readoption 的 attach bootstrap 在有上限的 settle 窗口内标为 non-eligible，窗口结束后恢复 owner evidence/classification。tmux attach 没有可靠的 bootstrap-end marker，因此窗口内真实新 agent output 仍可能漏过分类；viewer 字节和 tmux 当前屏不得用于回填。`meta.recordable=false` 保留为 producer eligibility 信号，绝不能被拿来表示全局 artifact disable，否则会错误关闭 runtime failure classification。

完整 raw `session.log` 与 `session.cast` 默认分别关闭。部署只有显式 opt-in 后才创建对应 map/file，并必须配置有代码 hard max 的 byte budget 与 pending-write budget；预算在 promise closure enqueue 前同步预留，达到上限只追加一次诚实 truncation marker 后停止。`session.log` 与 cast 不共享 gate 或 tail chain。Guardrails 的兼容 `readSessionLogTail` seam 优先读取有界 owner evidence，而不要求 full log。structured transcript 独立保留。

finished cast endpoint 在 disabled 时返回明确 503、在 legacy/opt-in 文件超过同一安全预算时于任何 payload read 前返回 413；它通过一个已 stat 的文件句柄最多读取预算内字节，不调用 whole-file `readFile`。Web 将 disabled/too-large/unavailable 分别显示，只有 enabled-but-missing 才是 honest empty，且非 ready 状态不 mount xterm。

仅给 cast 做前缀/尾部截断而继续默认展示“完整终端历史”的替代方案被拒绝：prefix 会丢最终状态，tail 缺少此前 terminal mode/geometry，rotation 破坏单 header/单调 timeline。完整 history 延期后，默认-off 是更诚实且更小的 release slice。

### 5. 人类输入和 terminal protocol response 分流

xterm `onData` 同时可能产生人类按键/paste/mouse 序列和 terminal query 自动响应，`onBinary` 还承载特定非 UTF-8 mouse reports。旧 replay 路径会丢弃 responses，当前共享 Terminal 又没有订阅 `onBinary`；fresh live attachment 必须同时保真返回两条输入源，但只有 query-correlated `onData` response 可以绕过 write lease，mouse/focus 始终是人类交互。

contracts 增加 `terminal_response` frame，并让 attach 协商版本化 response profile，但语法 allowlist/profile id 本身都不作为授权依据。profile 由生产共享 Terminal wrapper 的 source-conformance 生成/校验，绑定 exact resolved xterm version、termName、`disableStdin`、`windowOptions` 与 response-affecting addons；read-only viewer 仍保持 `disableStdin=false` 以允许协议自动响应，写权限只由 Gateway 控制。当前 resolved xterm.js 5.5.0 profile 必须覆盖 DA1/DA2、DSR status、normal/private CPR、ANSI/private DECRQM、DECRQSS、OSC 4/10/11/12 color reports；CSI 14/16/18 window reports 只在对应 `windowOptions` 启用时进入 profile。版本/options/addons 指纹改变而 profile 未通过 conformance 时构建或发布失败。

Gateway 以可分片的流式旁路 parser 观察每个 viewer output 中 active profile 的查询；7-bit ESC 与实际 transport 可送达 xterm 的 C1/UTF-8 编码、CSI/OSC/DCS、BEL/ST terminator 都进入矩阵。无论 parser 是否识别，provider output 都必须 byte-for-byte、有序地发往 xterm。parser carry/sequence/string payload 有代码硬上限，malformed/endless prefix 超限即丢弃 parser state 并复位，且不能在 OSC/DCS 等 payload 内误认 query-looking bytes。查询按 FIFO 进入 attachment-local 有界 queue，TTL 有安全默认和硬上限，非法/non-finite/non-positive/over-max 配置阻断 native attachment；queue 满时保留已有 token、拒绝为新 query 创建授权并发出 diagnostic，但仍原样投递 query。对应 query 必须在会触发 xterm response 的最后一个 raw byte 发往 WebSocket 前入队，避免快速响应超前。

Web 只有在整个 `onData` burst 能无歧义地完整分词为一个或多个 active-profile response、且不存在 prefix/suffix/interstitial remainder 时，才将它拆为每 frame 一个 atomic `terminal_response`。只要混有人类按键、paste、mouse/focus、未知字节、残缺序列或其他歧义，就不得抽取其中的 allowlisted 子串；整个原始 burst 走 existing lease-gated keystroke frame。Gateway 的有限映射精确校验 query/response 动态参数：DA grammar 与 profile 一致；`CSI 5 n` 只能到 exact `CSI 0 n`；normal/private CPR 不可互换且使用 1-based grid bounds；DECRQM 保持 ANSI/private prefix 与 mode 并限制 status；DECRQSS 保持 request subtype/positive-negative grammar；OSC color 保持 command/color index/slot，stacked query 产生的多个 response 分别关联。全部校验成功后，在 provider write 之前原子消费最旧匹配 query；并发重放最多成功一次，write 失败也不恢复授权。

write-lease holder 的 mixed burst 仍 byte-for-byte 只走 keystroke write，但 Gateway 对其中可完整识别且匹配本 attachment query 的 response token 执行同样的 consume-before-write accounting，防止已经随 human path 写入的响应留下可再次免租约消费的 token；这项 accounting 绝不能授权无 lease frame。attachment close/replacement 先原子关闭 generation，再清 parser carry/queue；response validate、consume 与 write 必须绑定同一 live generation，close 之后不得写旧 PTY。无匹配查询、重放、过期、越 attachment/task/generation 或超限 payload 全部 fail closed。只有严格关联的 response-only completion path 不经 write lease，也不写 owner。owner 的固定 startup CPR 只留在 owner state machine，不能注入 viewer。

共享 Terminal 新增 `onBinary` callback：`onData` JS string 用 UTF-8 编码，`onBinary` JS binary string 按每个 code unit 的低 8 位恢复 opaque bytes，两者直接进入现有 base64 input envelope。Gateway 不得先 `.toString('utf8')`，viewer attachment/provider transport 接口也必须能写 `Uint8Array`/Buffer。BoxLite 原生 binary WS 和 AIO JSON terminal 必须分别用真实 byte-echo/X10 fixture证明端到端无转码；若 provider 协议无法承载，它不能宣称通过 native terminal capability。`onBinary` 绝不走 `terminal_response`，始终校验 frozen binding 与 write lease。

BoxLite 0.9.5 的 server output route 会对每个独立 gRPC chunk 执行 lossy UTF-8 conversion；若 chunk 恰好从 `─` 等 code point 中间切开，原始 bytes 在到达 host transport 前已经变成 replacement bytes，host 侧 `StringDecoder` 无法恢复。因此 BoxLite native terminal 不直接把 child shell PTY bytes 暴露给该边界。CAP BoxLite 镜像在固定路径安装 provider-owned child-PTY bridge：外层 BoxLite TTY 只看到有硬上限的 ASCII 行，child output 与全部 input/terminal-response payload 使用 canonical base64，resize 使用 ASCII decimal，并以 generation、连续 output sequence、协议版本和严格 grammar fail closed。bridge 在外层 TTY 设置 raw/noecho 后 forkpty 并 `exec bash -l`（viewer attach mode可在相同 bridge 内 exec exact tmux target）；cwd、`TERM=xterm-256color` 与 authoritative geometry 由 execution/bridge 参数继承和设置。host 绝不猜测、替换或修复 child bytes，只解码已验证的 O frame 回原始 bytes。

BoxLite WebSocket open 只代表 provider attachment 建立，不代表 child PTY 可用。transport 必须等待匹配 generation/version/mode/initial-geometry 的 `R` frame 才发 normalized `ready`；在此之前禁止 input/resize。bridge 缺失、ready timeout/提前退出、outer stderr、非 ASCII、畸形或非 canonical base64、超长 frame、stale generation、重复/跳跃 sequence 都显式失败，并仍只对已创建的 exact execution 执行 DELETE 后 GET=404 的 cleanup proof。image preflight验证固定 bridge 可执行；每次 transport 的 `R` handshake 才是实际 connection readiness gate。该封装允许已确认 raw route lossy 的 BoxLite 版本承载 byte-faithful terminal，而不把 provider bug 隐藏为 host UTF-8 修复。

替代方案让所有 `onData` 绕过 lease 会产生输入越权；继续全部过滤 terminal replies 会让 tmux/CLI capability negotiation 和 cursor report 不完整；把 `onBinary` 当 UTF-8 string 传输则会静默改写 legacy mouse coordinates。

### 6. writer 控制唯一权威 geometry

`TerminalSession` 保存 `{cols, rows}` 作为 live pane authority，初值来自 launch/default geometry。第一个获得 lease 的 operator attach 可提交其 fit geometry；之后只有 lease holder 的 resize frame会：

1. 调用 owner resize 路径，显式 `tmux resize-window` 并同步 owner outer PTY；
2. 更新 session authority；仅当 bounded cast policy 显式启用时记录一次 cast resize event；
3. resize 每个 viewer outer PTY，并广播 `terminal_geometry`，让所有 xterm 使用相同 rows/cols。

reader 的本地 ResizeObserver 只能保存本地 desired geometry，不能改变 tmux；获得 lease 后它重新上报，才成为新的 authority。所有 tmux clients 都 `ignore-size`，因此最终 pane 大小不依赖 attach 顺序。不同大小的 reader 容器可以裁切/滚动呈现权威 grid，但不能要求独立 reflow。

替代方案让每个 viewer 调用 resize 会使共享 pane 在窗口之间来回重排，无法定义哪一帧是 1:1。

### 7. backpressure、并发与关闭都按 attachment 隔离

每个 `ClientState` 持有自己的 attachment、subscription、generation 和 `BackpressureController`。ACK 只推进该 client 的 seq；达到 high-water 只 pause 该 viewer transport，绝不能 pause owner 或另一个 viewer。owner activity/classification 和可选 bounded raw writer 都不依赖 browser ACK。

Gateway 对每 task 的 viewer attachments 设可配置上限；超过时返回明确 busy 状态。WebSocket close、reauth failure、task unregister 和 attach replacement 都通过 AbortSignal + idempotent close 回收 attachment。BoxLite transport 必须 fence `POST /exec` 的 late success：若 close 在 exec descriptor 返回前发生，后续不得建立 ghost WebSocket，并应 best-effort close 已创建 execution。AIO/BoxLite close 都只关闭 outer PTY，不 kill tmux session、agent 或 sandbox；task lifecycle teardown 才拥有后者。

### 8. runtime 只恢复 interactive 默认模式

硬前置是 `enable-yolo-agent-launch` 先归档为 canonical baseline。在该基线上，Codex interactive argv 只额外删除 `--no-alt-screen` 并保留 `--dangerously-bypass-approvals-and-sandbox`；Claude Code interactive launch 保留 `--dangerously-skip-permissions` 和 dangerous-mode setting，仅不再导出 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`。所有 duplicate fallback（包括 provider package、镜像或 characterization tests）必须从同一 runtime policy 生成或同步清除，避免某个 provider 悄悄回退 inline/pre-YOLO。相对该组合基线，headless command、trust/auth env、model argument、prompt file、transcript capture 和 exit semantics 不再改变。

真实 Codex 与 Claude Code 默认 alternate-screen 的长时 E2E 是 release gate，不以 deterministic fixture 代替。deterministic fixture 先证明 transport/tmux 原语，真实 CLI gate 再证明产品行为。每个 pinned Codex/Claude/tmux/provider/browser 组合都要记录实际 query inventory；每一类必须是“有限映射已支持且只读 viewer 关联完成”，或有证据证明 pinned xterm 不产生 data response 且缺失不影响屏幕/控制流。xterm 实际会响应但映射未覆盖、或影响无法判定的 query 一律阻断 native-default；运行时拒绝并记录 unsupported 只是安全 fallback，不是 release-pass 条件。

### 9. structured history 保持独立，raw finished history 默认延期

`session-terminal.tsx` 的 live 分支不再调用 `stripAltScreen*`，也不维护 snapshot/tail queue 或 live scrollback viewport hack。structured transcript 继续作为 finished-history 主路径，且不受 raw recording policy 影响。`session.cast` endpoint 与 static renderer 作为显式 opt-in diagnostic surface 保留 API 兼容；默认 finished tab 显示“终端历史暂未保留”，不得 fetch 后把 503/413 当空 body，也不得在 unavailable 状态 mount xterm。

实测单个长会话 `session.cast≈1.284GB`、`session.log≈1.04GB`，已证明默认完整 raw history 超出当前 retention/storage budget。release 因而以“默认不创建 raw 文件”作为容量边界，而不是修改 live PTY 字节。opt-in artifact 的 byte/pending-write 上限、truncation marker、controller pre-read 上限和 Web error state 都必须参数化验证；未来重新规划完整历史时另行设计 streaming/index/retention。

## Risks / Trade-offs

- [刷新后没有旧 scrollback/finished raw history] → 这是本次明确接受的 breaking trade-off；当前屏由 fresh attach 恢复，过去对话使用 structured transcript，完整 raw terminal history 留待后续独立规划。
- [tmux fresh redraw没有协议级 end marker] → 完整转发所有字节，以首 burst 的 bounded quiet-window 只控制揭示；超时显示明确 attaching/failed 状态，并用静止 TUI 与持续刷新 TUI 两类 E2E 验证。
- [owner 与 writer geometry 不同步会损坏 current frame] → writer resize 同步 session authority、owner outer PTY与所有 viewer；opt-in cast 才追加有界 resize event，tmux clients 全部 ignore-size。
- [一个慢 viewer在 provider/tmux 侧积压] → viewer-local pause/close、连接上限与资源指标；达到 provider 安全边界时只断开该 viewer。
- [BoxLite open/close 竞态产生 ghost execution] → closed generation、AbortController、late result cleanup、idempotent close 和 execution-count leak test。
- [terminal_response 可被伪造成输入] → 双端 grammar allowlist 只是第一层；Gateway 还必须匹配本 attachment 的 outstanding query、校验 response class/参数、单次消费、TTL、有界 queue 和限速；mixed/ambiguous burst 整体走 lease，并只做同 generation query accounting。未匹配时 fail closed，普通 input 仍需 lease。真实组合出现映射外的 xterm data response 时阻断默认发布，不能用运行时丢弃来宣称 1:1。
- [xterm response 行为随依赖/选项漂移] → attach 协商 response profile，生产 wrapper source-conformance 固定 exact resolved version/options/addons；profile id 不匹配要求 reload，未验证的新指纹阻断构建/发布。
- [provider 字符串协议改写 output code point 或 `onBinary` 高位鼠标字节] → browser、Gateway 与 viewer seam 全程使用 opaque bytes；BoxLite 通过镜像内 ASCII/canonical-base64 child-PTY bridge 越过 lossy output chunk boundary，AIO 使用其已验证的 opaque input path，并在真实 provider 以 byte oracle 验证。任何路径都不用 host UTF-8 猜测或 replacement repair 掩盖缺失 bytes。
- [API restart 期间 failure classification 有缺口] → owner 缺席/settle 仍可能漏过输出；不用 viewer/tmux 重绘猜测回填。raw artifacts 默认关闭不扩大这条 owner-availability 边界。
- [owner transport 在 API 存活时异常关闭] → 主动 attach-only supervisor，generation fencing，有界 backoff/jitter 与 degraded metric；不依赖 viewer 输入触发恢复。
- [agent 在 API/owner 缺席期间结束] → 本变更不引入 sandbox-resident exit recorder；无 durable exit evidence 时明确走 unobserved-exit/orphan failure，不伪报成功、不重启 agent。
- [默认 alternate-screen 使 cast/log 增长] → 实测已超预算，因此 full raw log/cast 默认关闭；显式 opt-in 仍受 24MiB 默认/64MiB hard max 与有界 pending-write policy 约束（具体部署值可调，不能突破代码 hard max）。
- [API/Web 协议不一致] → attach frame 携带 protocol version；不兼容 client 收到明确 reload-required/close reason，而不是静默空白。API 与 Web 协调发布并保留可回滚 build。
- [回滚后正在运行的 default-alt task 遇到旧 renderer] → 回滚不停止 detached tmux/agent；旧 build可重新 attach，但显示可能降级，需在 canary 后再切默认，并把完整 API+Web build rollback作为操作手册步骤。

## Migration Plan

0. 在任何产品代码实施前，先由独立流程完成/归档 `refactor-sandbox-provider-split` 和 `rework-sandbox-provider-center-and-e2e`，再完成/归档 `enable-yolo-agent-launch`；然后将本 change rebase 到新 canonical specs 并 strict validate。本变更不自动归档它们。该顺序不得反转：否则 stale active delta 会重新引入 snapshot/tail fixture、Claude inline mode 或 pre-YOLO flags。本 delta 已写出两个 provider-center/fixture requirement 与 runtime requirement 的最终组合文本，rebase 时必须对照 effective spec 确认。
1. 先在 shared sandbox layer 建立 viewer attachment seam、严格 attach-only outcome、default-socket exact target、close fencing 和 provider contract tests；保留现有 owner 生命周期，但补上无需 viewer input 的主动 owner redial supervisor。
2. 改造 Gateway，使 owner output eligibility 只控制 bootstrap/resize exclusion；activity、bounded failure evidence、runtime classification 与 exit 独立于 artifact policy。完整 `session.log`/`session.cast` 默认关闭；各自 opt-in writer 在 enqueue 前执行 byte/pending-write 预算，cast off 时不得积累 pending resize。browser client 使用独立 attachment。
3. 改造 Web live xterm handshake，移除 live snapshot/tail、alt stripping 与 viewport hack。finished cast API 在 disabled/oversize 时明确失败且不 whole-file read；Web 显示诚实状态且不 mount raw replay。生产共享 Terminal 同时接入 `onData`/`onBinary`，用 source-conformance + Playwright 验证 profile、hidden-until-ready、非空首屏、输入与 resize。
4. 删除 interactive runtime 的 no-alt overrides，运行真实 Codex/Claude 在本机 BoxLite 与 `bwg-jp` AIO 的长输出、静止重连、网络重连、API restart、多 viewer 和 cleanup gate；盘点所有 xterm data-response query。验证默认 raw-off 不创建文件、classification/activity/exit/transcript 不受影响；opt-in 只验证有界诊断语义，不把截断 cast 宣称为完整历史。
5. 协调发布 API/Web。先确认 protocol version mismatch 会显式要求刷新，再切 native path；观察 attach latency/error、viewer count、close leak、bounded evidence 和 task exit metrics。完整 raw history 的 streaming/index/retention 作为后续 change。
6. gate 全部通过后删除不再被 live 或 bounded diagnostic path 引用的 headless snapshot/reconnect代码与测试。回滚使用上一完整 API/Web build；不删除 detached task session或用户既有持久记录。

## Open Questions

没有未决的产品选择，但 Migration Plan 第 0 步是 apply 的硬阻塞前置：相关 active changes 未正确归档/rebase 前不进入实施。quiet-window、viewer 上限、query TTL、failure-evidence 与 opt-in raw budgets 必须由配置和真实 provider gate 校准，并有代码 hard max/失败语义，不作为 fixture 专用常量硬编码。structured transcript 自身的 provider read、compressed read 与 decompressed output 上限是独立后续容量边界；本 release slice 不以关闭 transcript 掩盖该问题。
