# Terminal coordinated rollback canary

This is a local, credential-free rollout/rollback gate for the native terminal
wire. It uses the real `TerminalGateway`, `SandboxTerminalSession`,
`SandboxTerminalViewerAttachmentFactory`, a real disposable tmux server, and
real PTY clients created by a fixture-owned Python `forkpty` relay. It does not start BoxLite,
AIO, Codex, Claude, Docker, or any remote provider.

## What N-1 means in this gate

There is no historical native-terminal N-1 artifact in this repository: the
commits reachable before the current implementation do not contain
`packages/contracts/src/terminal-attachment-frames.ts`. The gate therefore does
not relabel a restart of the current constructor as an old build and does not
claim that its fixture was released.

Instead, `scripts/fixtures/terminal-coordinated-rollback/n-minus-one.json` pins a
separate response-affecting xterm descriptor and fingerprint. Its independent
Web builder and API parser/negotiator live in `n-minus-one-adapter.mjs`. The old
adapter delegates to the stable Gateway core only after its own exact wire has
negotiated successfully. Once a real native-terminal release exists, replace
this compatibility fixture with that release's pinned API/Web image digests and
retained adapter.

## Run

Prerequisites are Node 22+, pnpm, tmux, and Python 3. The integration story is
explicitly opt-in:

```sh
pnpm -w exec turbo run build --filter=@cap-console/api
CAP_TERMINAL_ROLLBACK_CANARY=1 node --test scripts/terminal-coordinated-rollback-canary.test.mjs
```

To retain a mode-0600 JSON evidence file:

```sh
CAP_TERMINAL_ROLLBACK_CANARY=1 node scripts/terminal-coordinated-rollback-canary.mjs \
  --evidence /tmp/cap-terminal-coordinated-rollback.json
```

The canary creates its own mode-0700 `TMUX_TMPDIR` and uses that directory's
default socket. It removes `TMUX` and `TMUX_PANE` from child environments, so it
cannot resolve or kill the operator's tmux server. Cleanup targets only that
isolated server plus PTY process groups created by the harness.

## Pass conditions

- Current API/current Web attach through the production frame builder.
- Current API/N-1 Web and N-1 API/current Web both return
  `failed + reloadRequired` before a viewer PTY opens.
- Each mismatch leaves the detached task's tmux pane PID, CLI PID, and CLI
  self-reported monotonic start ticks unchanged. Linux additionally verifies
  `/proc/<pid>/stat` field 22; Darwin records `ps lstart` without pretending it is
  a kernel tick counter.
- Coordinated N-1 attaches only to the existing exact tmux session; no
  `new-session` command is admitted.
- Restoring the current build attaches to the same task identity.
- Each Gateway shutdown confirms owner/viewer PTY cleanup without killing the
  task. Final cleanup proves CLI PID gone, pane PID gone, exact session absent,
  and isolated default socket absent. tmux 3.7b may leave a stale socket inode;
  after the absent-server proof the harness records `staleSocketRemoved` and
  unlinks only an `lstat`-verified socket under its private mode-0700 root.

This local story covers the API/Web compatibility and detached-task identity
slice of OpenSpec task 8.6. Provider-specific BoxLite/AIO cleanup evidence and
release metrics remain separate real-provider gates; this canary must not be
used to mark those portions complete.
