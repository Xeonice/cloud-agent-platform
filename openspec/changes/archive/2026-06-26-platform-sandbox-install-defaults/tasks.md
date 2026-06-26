<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: provider-selection-core (depends: none)

- [x] 1.1 Add a single provider-selection contract for startup scripts, e.g. `CAP_SANDBOX_PROVIDER=auto|aio|boxlite|control-plane`, with deterministic OS detection (`Darwin` -> BoxLite, `Linux` -> AIO) and explicit override handling.
- [x] 1.2 Update `Makefile` targets so `make up` uses provider auto-selection, while `make up-aio`, `make up-boxlite`, and `make up-cp` force the specific modes.
- [x] 1.3 Update `scripts/dev-up.sh` argument parsing and output to report the selected provider mode, honor existing env overrides, and preserve non-destructive local env reuse.
- [x] 1.4 Add unit/static tests for provider selection logic using mocked `uname`/env values, covering macOS default BoxLite, Linux default AIO, explicit overrides, and invalid provider values.

## 2. Track: mac-boxlite-startup (depends: provider-selection-core)

- [x] 2.1 Decide and implement the local BoxLite startup mechanism for macOS: compose profile/service, helper script, native daemon invocation, or validated external endpoint, with the chosen path documented in `design.md` if it differs from the initial plan.
- [x] 2.2 Generate or validate required `BOXLITE_*` env for local dev without overwriting operator-provided values, including endpoint, token, image/image map, priority, capabilities, workspace path, and terminal mode.
- [x] 2.3 Ensure macOS BoxLite bring-up fails clearly when BoxLite cannot be started/reached and does not report the stack as sandbox-ready.
- [x] 2.4 Add a lightweight BoxLite readiness/preflight check to startup, plus tests using a fake endpoint or mocked helper so CI does not require a real Mac or live BoxLite.

## 3. Track: linux-aio-parity (depends: provider-selection-core)

- [x] 3.1 Preserve Linux `auto` as the existing AIO full-stack path, including AIO image build/staging and the `aio-sandbox-image` compose service.
- [x] 3.2 Keep `control-plane-only` as an explicit mode only, not the macOS default.
- [x] 3.3 Update AIO-specific script text so Linux failures remain actionable and macOS no longer receives stale "defaulting to up-cp" guidance.
- [x] 3.4 Run the live AIO compose e2e or record the environment blocker, and keep the AIO parity evidence in the verification report.

## 4. Track: host-bind-and-compose (depends: none)

- [x] 4.1 Update source compose api/web port declarations to use explicit host-bind env defaults (`0.0.0.0`) and host-port env defaults, while preserving loopback-only observability services.
- [x] 4.2 Update source-free/prod compose and env examples where user-facing api/web ports are published so their host bind defaults and override names are consistent.
- [x] 4.3 Update startup health probes to keep probing loopback locally while output clearly distinguishes probe URL from all-interface listening behavior.
- [x] 4.4 Add compose render tests proving default api/web bindings are `0.0.0.0` and that `127.0.0.1` overrides render correctly.

## 5. Track: installer-and-docs (depends: provider-selection-core, mac-boxlite-startup, host-bind-and-compose)

- [x] 5.1 Update `apps/www/public/install.sh` so macOS defaults to the BoxLite path, Linux defaults to AIO, provider overrides are passed through, and all-interface/public-access caveats are printed.
- [x] 5.2 Update site/install copy and manual alternatives to describe macOS BoxLite default, Linux AIO default, and explicit override commands.
- [x] 5.3 Update `deploy/DEPLOY.md`, env examples, and package READMEs so source install, quick-deploy, source-free run package, and release upgrade docs do not contradict each other.
- [x] 5.4 Update `scripts/quick-deploy.sh` non-amd64 guidance so macOS users are directed to the platform-aware source installer/`make up`, while preserving quick-deploy's amd64/AIO constraints.

## 6. Track: verification (depends: installer-and-docs, linux-aio-parity)

- [x] 6.1 Run shell syntax checks for modified scripts and targeted node tests for installer/provider-selection/compose behavior.
- [x] 6.2 Run `docker compose config` checks for source and source-free compose files with default and loopback override env.
- [x] 6.3 Run or document live BoxLite verification for the macOS path; if a live BoxLite backend is unavailable, record fake readiness/preflight coverage and the exact remaining live dependency.
- [x] 6.4 Run `openspec validate platform-sandbox-install-defaults --strict --no-interactive`.
- [x] 6.5 Check source files for `debugger` before any future commit and write a verification report summarizing commands, results, AIO evidence, BoxLite evidence, and any live limitations.
