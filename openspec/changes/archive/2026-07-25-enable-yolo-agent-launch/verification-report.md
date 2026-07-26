# Verification Report: enable-yolo-agent-launch

Date: 2026-07-25 (Asia/Shanghai)

## Decision

PASS for this prerequisite change. The runtime policy, exact pinned CLI parsers,
provider-neutral launch path, fresh-sandbox first-run state, real interactive/headless
execution, supported resume, long-output reconnect, transcript collection, secret
non-disclosure checks, and exact canary cleanup all passed on local BoxLite and remote
AIO.

This result approves the YOLO launch-policy prerequisite only. It does not approve the
later native-terminal default: alternate-screen fidelity, independent viewer PTYs, raw
binary input, browser response correlation, and Playwright screenshots remain owned by
`restore-native-live-terminal`.

## Versions and immutable artifacts

| Surface | Evidence |
| --- | --- |
| Host parser | Codex `0.145.0`; Claude Code `2.1.219` |
| Required sandbox pins | Codex `0.144.1`; Claude Code `2.1.207`; OpenSpec `1.4.1` |
| Local BoxLite | BoxLite `0.9.5`; arm64 OCI manifest `sha256:c9ea9db7a80dacf0fe937fccafd056950fb83e156f21244fe6dfbcb4c7920a80` |
| Local AIO definition smoke | amd64 image `sha256:797f632315b23a8c2c22f5deb7f5df18ec3a173ecec1a9a342beb9b3eaeb153e` |
| Remote AIO | `cap-aio-sandbox:yolo-20260725-001`, immutable id `sha256:28946b608347c39be7860630dbc3010fa23a131fee7157e23880b64020804c35` |
| Remote network/repo | isolated `cap-yolo-net-20260725-001`; `/root/cap-yolo-canary-20260725-001` |

The host versions intentionally differ from the released image pins. Host probes test
current developer compatibility; the BoxLite/AIO probes test the release boundary.

## Parser and first-run probes

### Host argv parser

The following real argv shapes all exited zero and exposed every required flag in their
help surface:

- Codex interactive with `--no-alt-screen` plus
  `--dangerously-bypass-approvals-and-sandbox`.
- Codex fresh headless with `codex exec`, the bypass flag, and
  `--skip-git-repo-check`.
- Codex resume with `codex exec resume --json`, the bypass flag,
  `--skip-git-repo-check`, and a UUID session id.
- Claude interactive with `--dangerously-skip-permissions`.
- Claude fresh headless with `-p`, stream JSON, verbose output, and bypass permissions.
- Claude resume with `-p --resume <uuid>`, stream JSON, verbose output, and bypass
  permissions.

Only exit status, output byte counts, versions, and required-pattern booleans were
printed; help text and credentials were not persisted in this report.

### Exact BoxLite OCI parser and private-file probe

Command shape:

```text
node scripts/yolo-agent-canary.mjs boxlite \
  --endpoint http://127.0.0.1:18100 \
  --rootfs /tmp/cap-yolo-boxlite-oci.SbAS8n/oci \
  --phase parser
```

Result: PASS. Provider sandbox `V7sp8Nd4gHK3` was confirmed absent after the run.
All fresh/resume argv shapes parsed on the pinned CLIs. Five Claude private files were
transferred through the provider-private archive path, every fresh file was mode `0600`,
the settings acknowledgement was present, both onboarding copies were identical, and
workspace trust was pre-seeded. Repository contents survived every private archive
write. Thirty-seven ordinary request bodies and five private archive bodies were
checked without emitting secret material.

### Exact AIO Dockerfile image smoke

Command shape:

```text
AIO_SANDBOX_IMAGE=cap-aio-smoke:test SMOKE_REQUIRE_DYNAMIC=1 \
  bash scripts/aio-image-smoke.sh
```

Result: PASS. The exact built definition contained the three pinned CLIs and accepted
Codex/Claude interactive, fresh headless, and resume flags. Node, npm, tmux, metadata,
and runtime directories were present. Obsolete `hooks.json`, hook dist, and hook
dependency artifacts were absent.

The smoke now waits for a successful build result to become inspectable and runs the
already-inspected local tag without redundantly forcing `--platform`; this avoids a
Docker Desktop containerd-store race/mis-resolution that previously reported a present
single-architecture local image as a missing remote manifest.

## Real local BoxLite canaries

The real canary used the same pinned OCI layout and a local BoxLite REST daemon. Each
case used a fresh VM and repository, performed a real file/write/git action, observed
the runtime transcript, scanned ordinary control-plane requests and the bounded daemon
log delta for secret variants, and confirmed exact provider deletion.

| Runtime/mode | Provider sandbox | Result |
| --- | --- | --- |
| Codex interactive | `1AwlyNaOp3WZ` | PASS; autonomous TUI action, git commit, reconnect without relaunch, transcript, exact deletion |
| Codex headless new + resume | `PzP5EBdfeLJp` | PASS; both exits zero, same runtime session resumed, two commits/transcripts, exact deletion |
| Claude interactive | `a67Kj3HrDbBG` | PASS; no onboarding/trust/dangerous-mode/tool prompt, action/commit/reconnect/transcript, exact deletion |
| Claude headless new + resume | `pTKqjGSqd70a` | PASS; both exits zero, same runtime session resumed, two commits/transcripts, exact deletion |

The daemon log independently records removal of all four exact provider ids. The daemon
was stopped after verification. The OCI layout was retained only as a reusable local
test artifact; no canary VM remained active.

## Real remote bwg-jp AIO canaries

Credentials were emitted locally and piped directly to the remote canary stdin. They
were never included in SSH argv, command output, this report, or a remote credential
file outside the canary's private transfer lifecycle. Existing production AIO resources
were not reused or modified.

### Codex

Interactive case:

- sandbox `cap-yolo-codex-interactive-a38cc6113d`
- task `yolo-codex-i-238a1cdb00`
- terminal session `f282ffc9-e504-4671-8282-ffc9e504e671`
- runtime session `019f9755-cc2f-7fb0-9fca-4cde461a5ebb`
- real marker `CAP_YOLO_CODEX_I_dcd48d8187`
- git commit `ca670c2b6b7f6cf40a8294dd036585448da2a783`
- transcript: Codex rollout, 35,661 bytes

Headless new + resume case:

- sandbox `cap-yolo-codex-headless-07cb4a9561`
- tasks `yolo-codex-h1-2378c59fb4` and `yolo-codex-h2-4b188c1f8c`
- resumed runtime session `019f9758-00ce-7662-9de3-6084a07e5a36`
- exits `[0, 0]`; lifecycle settlement was non-abnormal
- commits `5bb03f...` and `e16c29...`
- transcripts 36,216 and 45,661 bytes

### Claude Code

Interactive case:

- sandbox `cap-yolo-claude-code-interactive-0c2bd496f9`
- task `yolo-claude-code-i-e22efa7778`
- terminal/runtime session `13839cb0-6bcd-4a49-8383-9cb06bcd7a49`
- real marker `CAP_YOLO_CLAUDE_CODE_I_61554c6c2f`
- git commit `02f1cf8...`
- transcript: Claude JSONL, 28,002 bytes

Headless new + resume case:

- sandbox `cap-yolo-claude-code-headless-65de7923fe`
- tasks `yolo-claude-code-h1-bb43d8b6a1` and
  `yolo-claude-code-h2-2fe000573c`
- resumed runtime session `2d32a3c1-81bf-4e7a-8d32-a3c181bf7e7a`
- exits `[0, 0]`; lifecycle settlement was non-abnormal
- commits `f94766...` and `4b8b8b...`
- transcripts 23,198 and 29,801 bytes

### Long-output reconnect evidence

This is a current-screen/reconnect test, not a claim that raw TUI history is ordered
conversation history.

| Runtime | First attachment | Reconnect | Canonical result |
| --- | ---: | ---: | --- |
| Codex | 55,145 raw bytes | 5,716 raw bytes | same pane; canonical frame equal; 1,189 nonblank cells; alternate-buffer and modes equal; 0 differing cells |
| Claude Code | 68,759 raw bytes | 8,314 raw bytes | same pane; canonical frame equal; 1,671 nonblank cells; alternate-buffer and modes equal; 0 differing cells |

Both reconnects used the existing task pane and launched no second agent. The fresh
frame was non-empty and byte pressure exceeded 50 KiB before reconnect. This proves the
tested current implementation can recover the same visible terminal state after long
output. It does not make raw `session.log` a reliable semantic scrollback source; the
native-terminal follow-up deliberately drops running-terminal history reconstruction.

### Remote cleanup and isolation

Every canary reported `confirmed-absent`, after checking three Codex or five Claude
private paths. Ordinary request bodies, private archive uploads, terminal output,
transcripts, and bounded provider-log deltas were scanned. At the final recorded remote
check:

- canary container count was zero;
- Netdata was active;
- Grafana Alloy was running and not paused;
- the isolated release image and test network remained for reproducible verification;
- the production AIO container was untouched.

## Automated verification

The final worktree passed:

- `node apps/api/src/agent-runtime/agent-runtime.test.mjs` — 68 passed.
- `node apps/api/src/terminal/approvals-endpoint-roundtrip.test.mjs` — 10 passed.
- sandbox-core build plus regression and detached-job tests — 19 + 16 passed.
- `pnpm test:sandbox` — all sandbox core, conformance, cloud, AIO, BoxLite, and shared
  sandbox suites passed.
- `pnpm --filter @cap/api test` — compiled, sandbox-source, terminal-source, tooling,
  and generated-private-git suites passed; the explicitly gated live private-Git case
  remained skipped as designed.
- `pnpm --filter @cap/sandbox-hooks test` — 24 passed.
- `node --test scripts/sandbox-metadata-image.test.mjs` — 1 passed.
- `pnpm verify` — 42/42 typecheck, lint, and build tasks passed.
- `openspec validate enable-yolo-agent-launch --strict` — passed.
- `openspec validate restore-native-live-terminal --strict` — passed at its proposal
  boundary.
- `git diff --check` — passed.

`openspec validate --all --strict` reports one unrelated pre-existing incomplete change,
`session-approval-flow`: it has only a proposal and no delta yet. It was not modified or
counted as evidence for this change; all canonical specs and both changes in this
sequence validate strictly.

## Security boundary and limitations

- The evidence proves non-disclosure only across the scanned control plane, argv,
  terminal, transcript, provider log, serialized errors/plans, and post-delete residue
  checks.
- Credentials necessarily exist in sandbox-private files while the task runs. Claude's
  OAuth token necessarily enters the Claude guest process environment.
- Agent code and repository code execute as the same guest UID. These canaries do not
  prove resistance to deliberate same-UID credential exfiltration or prompt injection.
- Container/VM deletion is lifecycle cleanup, not forensic erasure.
- The dormant approval enforcer has no production gated exec call site. Bypass-mode
  interactive execution relies on task sandbox isolation and post-hoc evidence, not a
  per-command human-approval guarantee.
- Resume retains the model recorded by the existing runtime session; a newly selected
  task model is used only for fresh interactive or fresh headless launches.
