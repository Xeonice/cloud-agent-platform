# Verification Report — `restore-native-live-terminal`

Date: 2026-07-26 (Asia/Shanghai)

## Decision

**PASS — release-ready.**

The current native terminal implementation passed the real BoxLite/AIO ×
Codex/Claude Code matrix, the remote AIO deterministic 50,000-marker strict
conformance run, opaque-byte oracles, response correlation, owner/API recovery,
raw-history capacity boundary, coordinated rollback, and the full automated
verification set recorded below.

Per-case task/session/workspace/credential cleanup and the final externally
managed container, process, listener, and tunnel teardown all passed. The
native path is release-ready within the verified scope and explicit deferred
boundaries below.

OpenSpec apply status is `53/53`; every planned task is checked after its exact
allowlisted verifier passed.

## Evidence provenance

Real-provider values came from the secret-scanned structured JSON emitted by
`scripts/boxlite-real-cli-terminal-canary.mjs` and
`scripts/terminal-fresh-attach-canary.mjs`. Credentials were passed by bounded
stdin/private-file lifecycle and are not present in argv, this report, or the
retained deterministic artifacts.

Every real-runtime fresh/current/pressure screenshot was opened with
`view_image` at original resolution during its canary and checked as non-empty
native TUI output. A later ordinary Playwright run cleaned the real-runtime PNG
files from `apps/web/e2e/test-results/provider-terminal-story/`. The paths and
available generation-time digest evidence below describe the completed run;
they must not be presented as files that still exist in the worktree.

The deterministic terminal-story screenshots and their `.last-run.json` files
remain present. Both last-run files currently record `status: passed` and no
failed tests.

## Response profile and environment

| Field | Verified value |
| --- | --- |
| schema | `1` |
| xterm | `@xterm/xterm` `5.5.0` |
| termName | `xterm` |
| disableStdin | `false` |
| window reports | `getWinSizePixels=false`, `getCellSizePixels=false`, `getWinSizeChars=false` |
| response addon | `@xterm/addon-unicode11` `0.8.0`, `activeVersion=11` |
| active response classes | `da1`, `da2`, `dsr_status`, `cpr`, `private_cpr`, `decrqm_ansi`, `decrqm_private`, `decrqss`, `osc_4`, `osc_10`, `osc_11`, `osc_12` |
| fingerprint | `e491643e62538a297c8e2d03ec0396657b5575d8e9f56f56c5bdf44a0e4afd82` |
| profile id | `xterm-response-v1-sha256-e491643e62538a297c8e2d03ec0396657b5575d8e9f56f56c5bdf44a0e4afd82` |
| local BoxLite | `0.9.5` |
| BoxLite runtime pins | Codex `0.144.1`; Claude Code `2.1.207` |
| remote AIO image | `ghcr.io/xeonice/cap-aio-sandbox@sha256:f75ae09169026ec5155526e8d00d1f01caaf4fe7270a49179e17045d69d5f401` |
| remote AIO executed runtimes | Codex `0.144.1`; Claude Code case `2.1.207` |
| final AIO Codex container inventory | Codex `0.144.1`; installed Claude Code `2.1.220` |
| remote AIO tmux | `3.2a` |

Profile source-of-truth:

- `packages/contracts/src/terminal-attachment-frames.ts`
- `packages/ui/src/terminal/terminal-response-profile.ts`
- `scripts/terminal-response-profile-source-conformance.test.mjs`
- `apps/web/e2e/terminal-stories/terminal-stories.spec.ts`

The retained production-wrapper response-profile screenshot is
`apps/web/e2e/test-results/terminal-stories/terminal-stories-productio-ea7a4-en-state-and-input-channels/production-response-profile.png`,
SHA-256
`431e1aa29a88f5e6e8e90b26570dcb073e6da715c35ae5ff75c58dc359deedea`.

Safe command shapes used for the real matrix (credential bytes were never
placed in argv):

```sh
node scripts/boxlite-real-cli-terminal-canary.mjs \
  --provider boxlite --endpoint http://127.0.0.1:8100 \
  --rootfs <exact-release-rootfs> --runtime codex --auth local --surface cap

node scripts/boxlite-real-cli-terminal-canary.mjs \
  --provider boxlite --endpoint http://127.0.0.1:8100 \
  --rootfs <exact-release-rootfs> --runtime claude-code --auth local --surface cap

node scripts/emit-yolo-canary-credentials.mjs --runtime codex | \
node scripts/boxlite-real-cli-terminal-canary.mjs \
  --provider aio --endpoint http://127.0.0.1:18083 \
  --runtime codex --auth stdin --aio-state-ownership isolated-disposable \
  --surface cap --owner-fault drop

node scripts/emit-yolo-canary-credentials.mjs --runtime claude-code | \
node scripts/boxlite-real-cli-terminal-canary.mjs \
  --provider aio --endpoint http://127.0.0.1:18083 \
  --runtime claude-code --auth stdin --aio-state-ownership isolated-disposable \
  --surface cap --owner-fault drop

node scripts/terminal-fresh-attach-canary.mjs aio \
  --endpoint http://127.0.0.1:18083 --strict-conformance
```

## Real provider/runtime matrix

| Provider/runtime | Task | Exact tmux session | Result |
| --- | --- | --- | --- |
| BoxLite / Codex | `terminal-story-cx-3a72001d4ff3` | `taskterminal-story-cx-3a72001d4ff3` | PASS: native TUI, continuous output, fresh viewers, query correlation, opaque input, API restart, and cleanup |
| BoxLite / Claude Code | `terminal-story-cc-57341e202ff9` | `taskterminal-story-cc-57341e202ff9` | PASS: native TUI, continuous output, fresh viewers, query correlation, opaque input, API restart, and cleanup |
| AIO / Codex | `terminal-story-cx-a1bdf83799d3` | `taskterminal-story-cx-a1bdf83799d3` | PASS: native TUI, continuous output, fresh viewers, query correlation, opaque input, owner drop, API restart, and cleanup |
| AIO / Claude Code | `terminal-story-cc-bb84e911e8d7` | `taskterminal-story-cc-bb84e911e8d7` | PASS: native TUI, continuous output, fresh viewers, query correlation, opaque input, owner drop, API restart, and cleanup |
| AIO strict 50k | fixture-owned strict run | `task1d70ec101a1d` on the product default tmux socket | PASS: 50k pressure, third attach, identity, Playwright, opaque input, and exact session cleanup |

No completed runtime case observed an unmapped, rejected, replayed, or
indeterminate active-profile browser response. The real CLI reports only the
query classes it actually emitted; the full positive/negative profile matrix
is covered by the production-wrapper and Gateway automated suites.

## Real continuous output and bounded reveal

Each runtime received a deterministic harmless pressure command through its
real CLI composer. The canary required begin/end markers, a new browser PTY
while output was still advancing, bounded reveal, continuing bytes after
reveal, a dynamic non-empty screenshot, and exact cleanup.

| Provider/runtime | Output bytes | Chunks | Duration | Reveal after first output | Additional dynamic evidence |
| --- | ---: | ---: | ---: | ---: | --- |
| BoxLite / Codex | `962303` | `1369` | `12802ms` | `2001ms` | post-reveal advancement and dynamic screenshot assertions PASS |
| BoxLite / Claude Code | `120278` | `1206` | `12904ms` | `2002ms` | post-reveal advancement and dynamic screenshot assertions PASS |
| AIO / Codex | `586278` | `870` | `12343ms` | `2000ms` | `376699` post-ready bytes / `596` chunks; `51` visual changes across `7966ms` |
| AIO / Claude Code | `141214` | `1013` | `12244ms` | `1788ms` | post-reveal advancement and dynamic screenshot assertions PASS |

The real-runtime files below were generated and inspected before the later
Playwright cleanup. Their complete PNG bytes remain recoverable in the
secret-scanned verification-session evidence ledger.

| Case | Generated screenshot path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| BoxLite Codex pressure | `apps/web/e2e/test-results/provider-terminal-story/boxlite-codex-3a72001d4ff3-continuous-output.png` | `133444` | `f1bc2868877baf6df4f23943ebdb84457f0800b1cc7f6fcfe8f63189bbccb7f3` |
| BoxLite Codex fresh | `apps/web/e2e/test-results/provider-terminal-story/boxlite-codex-3a72001d4ff3-fresh-attach.png` | `30814` | `0e84b889c7797204314cb57cde940cac1959f3177da100836e77a8dee356ec83` |
| BoxLite Claude pressure | `apps/web/e2e/test-results/provider-terminal-story/boxlite-claude-code-57341e202ff9-continuous-output.png` | `168596` | `399e1ed2131b1cae0f410506491e9e79536fa3f03241871b7bfafe409f5c03f2` |
| BoxLite Claude fresh | `apps/web/e2e/test-results/provider-terminal-story/boxlite-claude-code-57341e202ff9-fresh-attach.png` | `21438` | `615150e2a3e99a1b3f6436c21cc0118bd1a914f10ea6e67758615bb9e2523c87` |
| AIO Codex pressure | `apps/web/e2e/test-results/provider-terminal-story/aio-codex-a1bdf83799d3-continuous-output.png` | `136818` | `2bb5161663a166d2cf2f4b112b66ac444c38bffe8b4a5dc4450e0d3ea6531ed6` |
| AIO Codex fresh | `apps/web/e2e/test-results/provider-terminal-story/aio-codex-a1bdf83799d3-fresh-attach.png` | `25309` | `a59618b4ae8b909f4000a88f020b19612a5ea413f9a13878a3ffea1fc48d165e` |
| AIO Claude pressure | `apps/web/e2e/test-results/provider-terminal-story/aio-claude-code-bb84e911e8d7-continuous-output.png` | `167013` | `99dae10aff617a0af25ecb79203eb08aa783e6bed6fb06cedbe936cd3e595901` |
| AIO Claude fresh | `apps/web/e2e/test-results/provider-terminal-story/aio-claude-code-bb84e911e8d7-fresh-attach.png` | `22966` | `5273fedb8d0e188573b00bb11197ddb99064250a9843100cd33e514ffc0833ac` |

The retained deterministic quiet reconnect images remain byte-identical:

- `apps/web/e2e/test-results/terminal-stories/terminal-stories-productio-8812f-frame-after-fresh-reconnect/session-quiet-first.png`
- `apps/web/e2e/test-results/terminal-stories/terminal-stories-productio-8812f-frame-after-fresh-reconnect/session-quiet-fresh-attach.png`
- SHA-256:
  `589f1fde259af1e4f6e474551a64ba0fff334fe1951a250a8bb51c76b841bd54`

## Query/response/provider-write correlation

| Provider/runtime | Observed query inventory | Accepted browser responses | Written provider responses | Result |
| --- | --- | ---: | ---: | --- |
| BoxLite / Codex | `da2=4` | `4` | `4` | exact-once PASS |
| BoxLite / Claude Code | `da2=5` | `5` | `5` | exact-once PASS |
| AIO / Codex | `da2=4` | `4` | `4` | exact-once PASS |
| AIO / Claude Code | `da2=4` | `4` | `4` | exact-once PASS |

The canary fails on rejected active-profile queries, unmatched/replayed browser
responses, response/write byte multiset mismatch, reused query ids, or any
provider response outcome other than `written`. None occurred. CSI 14/16/18
window reports were disabled by the negotiated profile and therefore were not
expected.

## Opaque browser-input oracle

All four real runtime cases passed the same 78-byte product-viewer oracle:

- segments: focus `onData`, keyboard `onData`, bracketed UTF-8/CJK/emoji paste,
  SGR mouse `onData`, and classic X10 `onBinary` containing byte `0x84`;
- expected and actual bytes: `78`;
- expected and actual SHA-256:
  `f984f8f99b83a485455e96038a05cee61fbb6e59eb1bdd7cea66f51781f0fd32`;
- surplus bytes: `0` for BoxLite Codex, BoxLite Claude, AIO Codex, and AIO
  Claude.

The AIO strict conformance run separately passed a 272-byte oracle containing
the complete `0x00..0xff` range, `中文🙂`, and legacy mouse bytes:

- expected and actual bytes: `272`;
- expected and actual SHA-256:
  `5ede7ae9bec1a6c6b6ba1ebe0f4d6e09504bf33ea40f1da037ab4edf279c9993`;
- surplus bytes: `0`;
- oracle session and temporary byte/surplus files: cleanup PASS.

## Owner transport drop and API restart

All real recovery reports explicitly use `missingByteCount: "unknown"`. A real
interactive CLI has no independent outage byte oracle, so the report never
relabels unknown loss as zero.

| Provider/runtime/fault | Evidence |
| --- | --- |
| BoxLite / Codex API restart | PASS: attach-only re-adoption, stable pane/CLI identity, non-empty fresh viewer, no relaunch, cleanup confirmed |
| BoxLite / Claude API restart | PASS: attach-only re-adoption, stable pane/CLI identity, non-empty fresh viewer, no relaunch, cleanup confirmed |
| AIO / Claude owner drop | outage `6196ms`; producer settle `641ms`; resume probe `98ms`; exactly one attach-only recovery; no relaunch |
| AIO / Claude API restart | owner absent `13118ms`; owner attach settle `11088ms`; re-adoption decision `2304ms`; non-empty fresh viewer; no relaunch |
| AIO / Codex owner drop | outage `6216ms`; producer settle `681ms`; resume probe `111ms`; exactly one attach-only recovery; no relaunch |
| AIO / Codex API restart | owner absent `14130ms`; owner attach settle `11501ms`; re-adoption decision `2546ms`; non-empty fresh viewer; no relaunch |

For the AIO Codex case, CLI PID `31117` with start identity `500998` and pane
PID `31095` remained stable across both faults. Bootstrap redraw remained
producer-ineligible; eligible evidence/classification output resumed after the
settle window.

The explicit socket-drop relay is AIO-only. BoxLite is covered by its real API
restart plus the shared deterministic owner-supervision matrix; this is a
documented fault-injection coverage split, not a claim that BoxLite outages
cannot occur.

## AIO deterministic 50,000-marker strict conformance

`scripts/terminal-fresh-attach-canary.mjs aio --strict-conformance` passed on
the product default tmux socket and exact target:

| Measurement | Result |
| --- | --- |
| requested/observed unique markers | `50000 / 50000` |
| bounded history-line observation | `50024` |
| estimated historical bytes | `2250000` |
| fresh current-frame bytes | `2973` |
| fresh/history byte ratio | `0.001321` |
| historical prefix in fresh attach | absent |
| live delta | `92` bytes, exactly once, observed in `396ms` |
| third attachment | canonical parity PASS |
| provider PTY identities | `10` distinct identities |
| Playwright screen | paired captures identical, non-empty, `24` rows; current SHA-256 `360b0addaab18956adffd357f8695beb78cfc7f1348155c3e7bfc3ab2815f30d`; pressure SHA-256 `4002354580b1b5c86b386c6d67d8409457a42a376cb331a9a33bc1a060ade4f1` |
| opaque input | `272` exact bytes, digest above, surplus `0` |
| cleanup | main/pressure/byte-oracle sessions and exact temporary files confirmed absent |

This proves long history is not replayed while the complete current frame and
future live bytes remain available. It does not promise running-terminal
scrollback reconstruction.

## Raw history default-off and bounded opt-in diagnostics

The capacity boundary remains intentionally unchanged:

- default policy independently disables `session.log` and `session.cast`;
- bounded owner failure evidence, activity, runtime classification, exit
  handling, and structured transcript do not depend on either raw artifact;
- opt-in log/cast writers independently reserve byte and pending-write budgets
  before enqueue;
- saturation appends exactly one valid truncation marker, stops later enqueue,
  and retains valid cast JSONL;
- cast-off resize creates no pending cast state;
- the finished cast endpoint reports explicit `503` while disabled and rejects
  oversized payloads with `413` after stat but before reading bytes;
- measured deferred raw history (`session.cast≈1.284GB`,
  `session.log≈1.04GB`) remains evidence for keeping full history deferred, not
  a reason to alter live PTY bytes.

Primary evidence:

- `apps/api/src/terminal/terminal-recording.spec.ts`
- `apps/api/src/terminal/readoption-history.test.mjs`
- `apps/api/src/tasks/session-cast.controller.test.mjs`
- `apps/api/src/terminal/terminal-recording-policy.ts`

## Rollout, rollback, and observability

`pnpm test:terminal-coordinated-rollback` passed `3/3`: two deterministic
current/N-1 negotiation cases plus the real private-tmux/forkpty path. The
mixed current/N-1 directions return `reloadRequired=true` before a viewer PTY
opens; coordinated rollback and restoration attach to the same detached task
without relaunch. Final fixture cleanup proves CLI/pane gone, exact session
absent, and isolated socket absent.

The N-1 fixture is explicitly a versioned independent compatibility fixture,
not falsely labelled as a historical released build. Exact xterm,
window-option, or addon drift changes the fingerprint and fails negotiation
closed.

Viewer-limit, attach-timeout, per-viewer backpressure, cleanup outcome, and
low-cardinality terminal diagnostics are covered by the API/metrics suites and
the passing task 8.6 public-surface verifier.

Primary evidence:

- `scripts/terminal-coordinated-rollback-canary.test.mjs`
- `scripts/terminal-coordinated-rollback-canary.mjs`
- `scripts/fixtures/terminal-coordinated-rollback/n-minus-one.json`
- `apps/api/src/terminal/native-terminal-attachment.spec.ts`
- `apps/api/src/metrics/terminal-diagnostics-metrics.service.spec.ts`

## Automated verification

| Gate | Result |
| --- | --- |
| `openspec validate restore-native-live-terminal --strict --no-interactive` | PASS |
| `pnpm verify` | PASS |
| `pnpm --filter @cap/contracts test` | `229` PASS |
| `pnpm test:sandbox` | PASS |
| allowlisted `api-mcp` verifier for tasks 8.3 and 8.4 | PASS on both runs |
| `pnpm --filter @cap/web test` | `613` PASS |
| `pnpm --filter @cap/web test:terminal-stories` | `15` PASS |
| `pnpm --filter @cap/web test:provider-terminal-story` | `15` PASS; `2` explicitly opt-in cases skipped as designed and covered by the real canaries above |
| `node --test scripts/terminal-fresh-attach-create-cleanup.test.mjs` | `8` PASS |
| `node --test scripts/boxlite-real-cli-terminal-canary.test.mjs` | `19` PASS |
| `node --test scripts/aio-preload-canary-credential.test.mjs` | `5` PASS |
| `pnpm test:terminal-coordinated-rollback` | `3` PASS |
| `node scripts/openspec-metadata.mjs run-task restore-native-live-terminal 8.1` | `public-surface-full` PASS |
| `node scripts/openspec-metadata.mjs run-task restore-native-live-terminal 8.6` | `public-surface-full` PASS |
| `node scripts/openspec-metadata.mjs run-task restore-native-live-terminal 8.7` | `public-surface-full` PASS |
| `git diff --check` | PASS |

The final report edit is checked with `git diff --check`; all three final
public-surface task verifiers passed before the final repository-wide
public-surface and metadata gates.

## Cleanup and isolation

Confirmed inside each passing canary:

- every BoxLite throwaway box was confirmed absent and the baseline inventory
  was unchanged;
- each AIO real-runtime task tmux session, workspace, selected runtime
  credential paths, owner/viewer PTYs, and Gateway resources reached confirmed
  cleanup;
- the strict 50k main, pressure, and byte-oracle sessions and exact temporary
  files were confirmed absent;
- serialized reports, bounded captures, request bodies, and cleanup surfaces
  contained no registered secret variant.

Final outer-infrastructure teardown also passed:

- before deletion, the exact remote container was resolved as id prefix
  `a866f3d007e45c62…`, name
  `cap-native-terminal-aio-canary-20260725a`, and the fixed AIO image digest
  recorded above; it ran as uid `1000`, and its default tmux socket reported no
  server after the per-case cleanup;
- the exact remote container was stopped and removed;
- local temporary containers `cap-aio-frame-contract-20260725` and
  `cap-boxlite-canary-registry` were stopped and removed;
- the exact local BoxLite process PID `56581` was terminated;
- the SSH tunnel PID `46532`, session `47634`, was closed with Ctrl-C;
- ports `8100`, `18083`, `18084`, and `5001` had no remaining listeners, and
  both exact local PIDs were absent;
- the three temporary local/remote containers were absent from the final
  inventories, and the enumerated `/tmp` audit files/directories were already
  absent;
- the unrelated stopped BoxLite baseline remained unchanged: id
  `y5I1zvAMIO4t`, name
  `cap-boxlite-8142a2fc-f44f-479c-994e-583b43f70f5c`, status `stopped`.

The cleanup targeted exact canary identities and did not remove or mutate the
unrelated BoxLite baseline or production AIO resources.

## Explicitly unsupported or deferred behavior

- Fresh attach restores the complete native current frame and future bytes; it
  intentionally does not reconstruct xterm scrollback or prepend historical
  output.
- Full raw `session.log`/`session.cast` history remains default-off and deferred
  to a future bounded streaming/index/retention design.
- Missing bytes during a real CLI owner/API outage remain explicitly unknown.
- CSI 14/16/18 window reports are disabled in the current response profile and
  require a newly validated fingerprint if enabled.
- The cleaned real-runtime PNGs are generation-time evidence, not currently
  retained files. Requiring immutable long-term screenshot retention would
  require rerunning/copying them before the ordinary Playwright cleanup phase.
