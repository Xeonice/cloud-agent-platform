# Verification Report

Verified on 2026-07-25 from the change worktree.

## Static and package gates

- `openspec validate rework-sandbox-provider-center-and-e2e --strict`: pass.
- `pnpm typecheck`: pass, 23/23 Turbo tasks.
- `pnpm lint`: pass, 23/23 Turbo tasks.
- `pnpm test:sandbox`: pass for sandbox-core, conformance, cloud-http, AIO,
  BoxLite, and the provider center.
- `pnpm coverage:sandbox`: pass; every included source file in sandbox-core,
  cloud-http, AIO, BoxLite, and sandbox reports 100% statements, branches,
  functions, and lines.
- `pnpm --filter @cap/api test:sandbox-src`: pass, including the API facade
  import boundary and host-harness wiring.
- `pnpm --filter @cap/api test:terminal-src`: pass.
- `pnpm test:web:provider-terminal-story`: pass with 7 fixture tests and one
  explicitly opt-in live-provider test skipped. The script now builds `@cap/ui`
  first so it also works from a clean package build state.
- `git diff --check`: pass.

## Provider E2E gates

- Real local BoxLite: pass against `boxlite serve` on `127.0.0.1:18100`, native
  protocol, PTY terminal mode, and pinned cached image
  `127.0.0.1:5001/cap-boxlite-sandbox:toolchain-e2e`. The suite covered create,
  readiness, 50 fast command drains, empty output, non-zero stderr, selected-run
  metadata, archive round trip, readoption, stop/remove, and final absence. The
  API token was supplied only through the environment and is not recorded here.
- BoxLite post-run inventory: no `provider-e2e-*` sandbox remained; only the
  unrelated stopped sandbox that predated this run was present.
- Default `pnpm test:sandbox:e2e`: pass with both provider suites explicitly
  reporting their documented prerequisite skip when opt-in variables are absent.
- Real AIO on `bwg-jp`: unavailable in this run because the configured 1Password
  SSH agent exposed no identities. Network and SSH handshake were reachable, but
  the provider runner could not be authorized. This does not broaden the change's
  “available opt-in provider” gate; the native-terminal change retains real AIO as
  a hard release gate before rollout.

## Regression found during verification

Independent review caught an in-memory cleanup-attempt ceiling regression that
would have thrown after the persisted maximum instead of returning `conflict`.
The ceiling was restored through an internal pure state transition and verified
at the exact boundary without mutating private store state. Full sandbox coverage
and package tests passed again after the fix.
