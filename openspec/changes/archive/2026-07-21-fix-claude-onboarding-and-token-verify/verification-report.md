# Verification Report — fix-claude-onboarding-and-token-verify

Routing pass date: 2026-07-21. Raw skeptic unmet findings: none. Machine-routed
public findings: none. All 3 requirements across the two spec deltas re-traced
end-to-end against the codebase and adjudicated **MET**.

## Requirement tally

| Stable id | Verdict | Evidence |
| --- | --- | --- |
| `agent-runtime/provision-time-trust-and-onboarding-pre-seed` | MET | `apps/api/src/agent-runtime/claude-code-runtime.ts` — `CLAUDE_JSON_PATH` (`/home/gem/.claude.json`) and `CLAUDE_CONFIG_DIR_JSON_PATH` (`/home/gem/.claude/.claude.json`) both written in the single `credential_setup` command (base64 → file, owner-only mode), dual-path rationale doc comment rewritten; unit tests assert identical content at both paths (`agent-runtime.test.mjs`). |
| `agent-runtime/claude-auth-failure-classification-covers-current-cli-phrasings` | MET | `apps/api/src/agent-runtime/runtime-output-failure-classifier.ts` — `classifyClaudeOutputFailure` carries the inline standalone-line patterns (`inlineRejected401` / `inlineExpired401`, order-independent `/login` + `API Error: 401`, `●` bullet stripped via `hasStandaloneTerminalLine`) and the wizard-screen dual-anchor pattern (`welcome to claude code` AND `select login method`); golden-fixture + negative (quoted-fragment) tests in `runtime-output-failure-classifier.spec.ts`; pre-existing pattern tests unchanged. |
| `account-settings/claude-code-runtime-credential` | MET | Save-time verification implemented across `apps/api/src/settings/claude-credential-probe.ts` (single-attempt probe, mode-appropriate auth, ~10 s timeout), `apps/api/src/settings/settings.service.ts` `saveClaudeCredential` (definitive-reject refuses save + preserves prior state; definitive-accept incl. HTTP-400 body complaints persists `connected`; indeterminate persists `connected` with marker), `packages/contracts/src/settings.ts` (`ClaudeCredentialVerificationSchema` + rejected-error shape), and frontend surfacing in `apps/web/src/components/settings/claude-credential.tsx` + `apps/web/src/routes/_app/settings.tsx` (rejected/indeterminate/verified states); secret-boundary and no-retry assertions in `claude-credential-verify.spec.ts` / `claude-credential.test.tsx` / `account-scope.spec.ts`. |

## Gap findings

Full gap sweep found no requirement lacking implementation: every scenario in
`specs/agent-runtime/spec.md` and `specs/account-settings/spec.md` traces to
concrete code (presence verified; see table above). No gaps recorded.

## Scope findings (unrequested surface, recorded — not reopened)

1. **Probe redirect hardening beyond spec** — the probe sets
   `redirect: 'error'` and treats any resulting fetch rejection (including an
   unexpected redirect from api.anthropic.com) as `indeterminate`
   (`apps/api/src/settings/claude-credential-probe.ts:78-79`, `:85-92`). No spec
   requirement or scenario mentions redirect handling; this is unrequested
   SSRF-style defense-in-depth on a fixed, non-operator-supplied host.
   Adjudication: benign hardening that cannot violate any scenario — the worst
   case (a redirect misclassified as indeterminate) still lands in the
   spec-sanctioned indeterminate path (save succeeds with warning). Kept as-is;
   no task or spec change required.

All other reviewed diffs (dual-path pre-seed, classifier patterns, contracts
schema, save wiring, probe provider registration, web notice UI, and the
test-only diffs) map directly to tasks in `tasks.md` and requirements/scenarios
in the two spec files, with no extra product surface.

## Three-way routing outcome

- Reopened as code tasks: none
- Spec defects (design.md Open Questions): none
- Blocking spec defects (public impact / false exclusions): none
- Reclassified MET (skeptic-refuted → re-traced satisfied): none needed — no
  requirement was raw-unmet to begin with
