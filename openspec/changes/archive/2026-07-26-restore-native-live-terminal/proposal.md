## Why

当前运行中终端为了保留滚动历史，强制 Codex/Claude Code 离开默认全屏模式，并叠加 alternate-screen 过滤、headless snapshot、`session.log` tail 重放和视口修正，导致线上体验与真实 CLI 终端持续存在可见差异。真实 AIO 与 BoxLite 验证已经证明：新的 provider PTY 直接 attach 到同一个 detached tmux session，可以不重放长历史而完整恢复当前屏并继续接收实时输出，因此现在应把“原生 TUI 保真”置于“运行中滚动历史”之前。

## What Changes

- 交互式 Codex 与 Claude Code 恢复各自默认终端模式，不再强制 inline/normal buffer；运行中链路原样传递 alternate-screen、cursor、style、mouse/focus 与 terminal-query 字节。
- 将 task 级 agent owner/recorder 与 operator viewer 分离：owner 继续负责启动、存活检测、readoption、分类和唯一 best-effort 记录，并在 transport 异常关闭后无需人类输入地主动 attach-only redial；每个浏览器连接/重连获得一个新的 provider PTY，并以 attach-only 方式连接现有 tmux session。
- **BREAKING**：运行中终端重连不再使用 CAP headless snapshot + `session.log` tail replay，也不再保证刷新后的 xterm scrollback/history；fresh attach 只恢复 tmux 当前完整屏幕与之后的实时字节。
- **BREAKING**：移除 live terminal 的 alternate-screen stripping、scrollback viewport hack 以及 reconnect `fromSeq` 语义；保留 CAP browser-facing WebSocket、raw/control 分帧、认证、write lease 与 ACK/backpressure，但背压改为每个 viewer 独立生效。
- Gateway 同步接受首次 attach 时、在任何 owner/provider 异步工作前冻结 WebSocket 的 principal/task/generation 绑定；禁止 `attaching` 期间或之后通过 `connect_auth` 换 task、二次 attach 或跨 task 的 input/resize/ACK/terminal-response，防止异步 open 把旧 PTY 与新 task 控制面错配。
- 定义多 viewer 的输入与尺寸规则：人类输入仅由 write-lease holder 注入；`onData` terminal protocol reply 只能在匹配该 attachment 尚未消费且未过期的终端查询时回到各自 PTY；`onBinary` 的非 UTF-8 鼠标字节必须原样通过 lease-gated opaque-byte path；只有 writer 控制权威 tmux pane geometry，只读 viewer 不得争抢尺寸。
- 为浏览器/API 协商一个由 exact resolved xterm version、termName、response-affecting options 与 addons 指纹决定的版本化 terminal-response profile。当前 xterm.js 5.5.0 profile 覆盖其所有自动 data-response 类，而不只 DA/DSR/CPR；profile 漂移或任一 response-producing query 无法精确关联时阻断 native-default。
- **BREAKING**：完整 raw `session.log`/`session.cast` 默认关闭，完整终端历史与滚动历史一并延期；native live current-frame、activity、runtime failure classification、exit mapping 和 structured transcript 不依赖这两个文件。诊断部署可分别显式 opt-in，但每个 artifact 都受配置字节预算与 pending-write 硬上限约束，截断必须显式，finished Web 不得把 disabled/too-large/unavailable 伪装成“没有输出”。
- 为 AIO 与 BoxLite 增加同一套真实 fresh-attach conformance 与 CAP Playwright gate，覆盖长输出、静止画面完整重连、持续 repaint 的有界 reveal、真实 Codex/Claude 默认全屏模式、终端查询/响应、owner 断线、API restart、多 viewer、backpressure 和资源清理；任何实际触发 xterm 自动响应但尚未纳入有限关联映射、且无法证明不影响屏幕/控制流的 query 都阻断默认启用。
- 进行中的 `static-terminal-log` 继续只负责已结束任务的静态记录；它不定义或回退本变更的 live WebSocket/PTY 语义。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `realtime-terminal`: 用每连接 fresh provider PTY + tmux current-frame redraw 取代 live snapshot/tail replay 与滚动历史模拟，并定义原生字节、viewer-local backpressure、terminal response 和权威几何语义。
- `agent-runtime`: 交互式 Codex/Claude Code 恢复默认 alternate-screen TUI；相对于先归档的 `enable-yolo-agent-launch` 组合基线，headless execution、认证、模型与 transcript 策略不再改变。
- `sandbox-readoption`: 将 task owner/recorder 与 disposable browser attachments 分离，规定 attach-only、API restart、single-writer、断连和 resize 行为。
- `sandbox-provider-port`: 扩展 interactive terminal conformance，要求 AIO/BoxLite 提供独立 fresh PTY identity、完整 current-frame attach、并发隔离与可靠 cleanup。
- `terminal-execution`: 明确 owner output eligibility、activity/runtime classification 与可选 raw artifact policy 分离；viewer repaint 不进入任何 failure evidence 或 opt-in artifact。
- `session-terminal-replay`: 将完整 cast 历史改为默认关闭、显式 opt-in 且有界；disabled/oversize 由 API/Web 诚实呈现，不能整文件读取超限 legacy cast。

## Impact

- API：`TerminalGateway` 的 task session/client ownership、reconnect、resize、terminal-response、backpressure 与 recording 路径；WebSocket control-frame contracts。
- Sandbox packages：provider-neutral viewer attachment seam、AIO owner/attach 命令、BoxLite terminal open/close race fencing，以及两个 provider 的 conformance harness。
- Runtime：Codex、Claude Code interactive launch defaults 及镜像/测试中的重复 fallback；headless launch 不变。
- Change coordination：这是实施前的硬门槛，不授权本变更自动归档其他 change。必须先完成并按依赖归档 `refactor-sandbox-provider-split`、`rework-sandbox-provider-center-and-e2e` 与 `enable-yolo-agent-launch`，再 rebase/严格校验本 change。否则后归档的旧 delta 会重新引入 snapshot/tail、inline terminal 或 pre-YOLO flags。本 change 已写出组合后最终 requirement：Codex 保留 `--dangerously-bypass-approvals-and-sandbox`，Claude 保留 `--dangerously-skip-permissions` 及 dangerous-mode setting，provider-center/fixture 改为 fresh attachment；与 `static-terminal-log` 保持 live/finished 边界。
- Web：live xterm reconnect state machine、alternate-screen filtering、input filtering 与 viewport behavior；finished-session cast/static renderer 不变。
- Operations/tests：AIO `bwg-jp` 与本机 BoxLite gated canary、真实 Codex/Claude E2E、Playwright 截图与 screen-state 对比、attachment/resource leak audit。
- 存储：实测长会话 raw artifacts（`session.cast≈1.284GB`、`session.log≈1.04GB`）已超过 release budget，因此默认不创建两者；opt-in writer 在 enqueue 前同步计入字节与 pending-write 预算，legacy/opt-in cast 在读取前执行硬上限检查。
