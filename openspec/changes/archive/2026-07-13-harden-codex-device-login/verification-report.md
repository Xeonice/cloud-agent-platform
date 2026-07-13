# Verification Report — harden-codex-device-login

Date: 2026-07-13

## Result

All 29 implementation and verification tasks pass. The production flow now uses
the pinned Codex App Server structured device-code protocol, returns an immediate
CAP session, keeps browser navigation user-activated, and provides a verified
clipboard compatibility/manual-copy path.

The implementation follows the official [Codex App Server protocol](https://developers.openai.com/codex/app-server)
and [Codex authentication storage guidance](https://developers.openai.com/codex/auth).

## Static and collected tests

- Contracts: build, typecheck, and lint pass; compiled contract tests pass
  `120/120`, including all eight new device-login contract cases.
- API: `pnpm --filter @cap/api test`, build, typecheck, and lint pass. The final
  focused run of the six new collected specifications passes `56/56`; the full
  sandbox-source (`24/24`) and terminal-source (`20/20`) suites also pass.
- Web: build, typecheck, lint, and the full Vitest suite pass (`51` files,
  `374/374`). The new clipboard/dialog/real-client cases account for 33 of those
  collected tests.
- `git diff --check` passes.

## Docker-backed App Server smoke

- Docker Server: `29.5.3`.
- Pinned local image: `ghcr.io/xeonice/cap-aio-sandbox:v0.37.1`, image ID prefix
  `sha256:1b19926e`, Codex `0.144.1`.
- The production `DockerCodexDeviceLoginRunner` started a non-TTY direct exec on
  `cap-net`, completed `initialize`/`initialized`, and received the structured
  `loginId`, `verificationUrl`, and `userCode` response in `2.322s`.
- The smoke validated field presence in memory only. It did not print the URL,
  code, or credentials and did not authorize a real account.
- Immediate `account/login/cancel` plus disposal completed with zero labelled
  login workers remaining.
- The path did not call or wait for AIO HTTP readiness or shell endpoints.

The first smoke exposed an `AutoRemove` versus explicit-remove Docker 409 race.
Cleanup now performs a bounded inspect after a conflict, accepts only a confirmed
404 as success, retries a still-present container, and fails if it remains at the
deadline. Three regression cases cover absent, retryable-present, and persistent
conflict outcomes.

## Browser and visual verification

The reproducible harness is `apps/web/e2e/codex-device-login/`; run it with:

```sh
pnpm --filter @cap/web test:codex-device-login
```

Playwright passes `5/5`:

- localhost stays in the preparing dialog without creating a blank page; the
  later authorization link uses the exact server URL, `_blank`,
  `noopener noreferrer`, and `no-referrer`, with a null opener and empty referrer;
- the secure Clipboard API writes and reads the exact code;
- real non-loopback HTTP (`http://10.10.144.52:4331`) has
  `isSecureContext=false` and no `navigator.clipboard`, while the compatibility
  copy path successfully pastes the exact code;
- forced compatibility-copy failure focuses/selects the visible code and shows
  the Ctrl+C / Command+C instruction;
- close during preparation, immediate retry, and a late first POST delete the
  exact stale session without polling it or reviving its UI;
- the production dialog remains 720px wide at desktop size, capped at 85vh, with
  an independently scrolling body and visible footer.

The existing settings visual gate passes `24/24` (22 baseline captures plus two
settings comparisons). No baseline was refreshed and no pixel threshold was
relaxed. Browser console/page errors are hard failures; this caught and removed
a duplicate manual Radix title association so the generated `aria-labelledby`
now points to the real dialog title.

## Race and lifecycle checks added during verification

- A shutdown now rejects a late preparation transition and performs a second
  cleanup pass after tracked background work, reclaiming even a runner that
  resolves after its abort signal.
- Docker `AutoRemove` cleanup conflict handling is confirmed against both fake
  Docker frames and the real pinned image.
- A cancelled or superseded frontend POST cannot unlock or restore a newer
  attempt.

## Negative checks

Production sources contain none of the removed paths or patterns:

- `about:blank` or `window.open`;
- `codex login --device-auth`, `/tmp/codexlogin.log`, `parseDeviceCode`,
  `lastPolledAt`, or `ABANDONED_AFTER_MS`;
- AIO `/v1/docs`, `/v1/shell/exec`, or readiness polling in device login;
- a hard-coded OpenAI verification URL;
- account-implicit status/cancel routes or web calls.

`openspec validate harden-codex-device-login --strict` passes.
