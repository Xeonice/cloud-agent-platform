# Design: edit-sandbox-environment-parameters

## Context

Image parameters live on the `sandbox_environments` row as two jsonb columns: `env_vars` (plain, readable) and `secret_env_vars` (AES-256-GCM `ciphertext.iv.authTag` envelopes written by `encryptToStored` under `CODEX_CRED_ENC_KEY`). They are set exactly once, by `POST /sandbox-environments` via `encodeParameters`. The read model (`toParameterDescriptors`) already redacts: plain entries carry values, secret entries carry `{name, secret: true}` only. Task provisioning decrypts per task at provision time (`resolveImageParameterProfileForTask`) and materializes `/home/gem/.cap/image-env` before agent launch, so the storage row is the single source of truth and there is no cached copy to invalidate.

Constraints: secret plaintext must never appear on any read surface (established discipline across settings credentials); validation state is orthogonal to parameters (spec + docs already say so); all environment mutations go through `requireAdmin`.

## Goals / Non-Goals

**Goals:**
- Admins can change an existing environment's parameter set (add/remove/rename plain and secret entries, rotate secret values) from the console without re-registering.
- Secret write-only semantics survive the edit surface end to end.
- Parameter edits are invisible to validation: no status flip, no new validation record, no re-validation requirement.
- Deterministic effect timing: tasks provisioned after the write see the new set; running sandboxes are untouched.

**Non-Goals:**
- No parameter editing for non-admin users and no per-user parameter overrides.
- No public V1 / MCP / OpenAPI exposure.
- No audit_events schema work beyond names-only service logging (module precedent).
- No migration of existing rows (storage shape is unchanged).

## Decisions

1. **Replace-set `PATCH /sandbox-environments/:id/parameters`** (single endpoint, whole-set semantics) over per-parameter CRUD. The dialog always knows the full desired set because the read model lists every parameter name; whole-set replace keeps the server contract one validated array, reuses `encodeParameters` duplicate detection, and avoids partial-update ordering questions. Alternative (per-entry POST/DELETE) rejected: three routes, more states, no user benefit at this scale.
2. **Keep-existing sentinel for secrets.** Request entries are a discriminated union: `{name, value, secret?}` to set a value, or `{name, keep: true}` to retain the current stored ciphertext for that name. `keep` is only legal for names that currently exist as secret parameters (`sandbox_environment_unknown_keep_parameter` otherwise). This lets the dialog resubmit untouched secrets without ever holding plaintext. Alternative (secrets must always be retyped) rejected: turns every plain-value tweak into a full secret re-entry ceremony. Alternative (server-side merge PATCH with null-to-delete) rejected: implicit deletes are error-prone and unreadable in review.
3. **Reuse the existing write path unchanged.** The service update method builds `{plain, secret}` via the same `encodeParameters` (with `keep` entries copying the stored envelope verbatim — no decrypt/re-encrypt round trip) and writes both columns in one `update`. No new crypto code.
4. **Validation decoupling enforced by construction.** The update touches only `env_vars`, `secret_env_vars`, `updated_at`. It does not read or write `status`, `last_validation_id`, `contract_version`, or `is_default`, and is permitted on any non-retired environment regardless of status (editing a `stale`/`failed` environment's parameters is legal — an admin may fix parameters before re-validating a rebuilt image).
5. **Console UX: edit dialog on the environment card,** prefilled from the redacted read model — plain rows editable with values, secret rows name-only with state "保留现有值" until the admin types a replacement or removes the row. Submit maps untouched secret rows to `{name, keep: true}`.
6. **Effect timing is documentation + spec, not code.** Provision-time resolution already yields the desired semantics; the spec pins it so future caching work cannot silently break rotation.

## Risks / Trade-offs

- [Lost-update between two admins editing concurrently] → Accept last-write-wins on the whole set; single-admin deployments dominate, and the dialog round-trip is seconds. Documented in the spec scenario rather than adding optimistic-locking machinery.
- [`keep` sentinel referencing a name that was concurrently deleted] → Reject with a 400 (`sandbox_environment_unknown_keep_parameter`); the dialog refetches and re-renders.
- [Admin edits parameters expecting running task to pick them up] → Spec scenario + console copy state that only newly provisioned tasks see changes.
- [Secret value briefly in request body] → Same exposure class as create; body is admin-session-gated over the operator's own transport, and values are never logged (existing scrub discipline extended to the new route's error paths).

## Migration Plan

Pure additive endpoint + UI; no data migration. Rollback = revert the release; stored rows remain valid for older code (columns unchanged).

## Open Questions

_None blocking. Two prior verify blockers were metadata/environment issues, both resolved 2026-07-20: (1) unresolvable public-surface base diff (detached HEAD without upstream) — fixed by checking out `change/edit-sandbox-environment-parameters` tracking `origin/main`; (2) `undeclared-impact` on publicV1/mcp/openapi/apiPlayground — the path classifier attributes any `packages/contracts/src` edit to all four public surfaces, so the sidecar's `not-applicable` claims were rewritten as scoped `changed` declarations (shared-contracts-module scope, no operation/tool/projection change) with the registry's eight standing protocol differences mirrored, per the validator's selects-all-existing rule for scoped publicV1/mcp declarations. Static re-traces of all four requirements PASS; `pnpm verify:public-surface` and the repository metadata validator both pass with the corrected sidecar. Audit-event emission for admin mutations is a module-wide gap tracked separately, not expanded here._
