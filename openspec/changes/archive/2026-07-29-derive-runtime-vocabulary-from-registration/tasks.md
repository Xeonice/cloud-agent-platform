<!-- Track 1 establishes the evidence this change is judged against; Tracks 2 and 3
     touch disjoint packages (`packages/contracts` vs `apps/api/src/agent-runtime`)
     but 3 consumes 2's declaration, so 3 follows 2. Track 4 gates on all. -->

## 1. Track: baseline-evidence (depends: none)

- [x] 1.1 Record the pre-change baseline: run the api and contracts suites and note pass counts, and capture the current `RuntimeSchema` consumer list with line numbers so Track 4 can prove none was edited by hand.
- [x] 1.2 Record what admitting a third runtime costs today: add a throwaway identifier to each of the three statements in turn and record, per statement, what the compiler and the suites demand. This is the number `4.4` must beat, and it must be measured rather than asserted.
- [x] 1.3 Confirm the enabling facts the design rests on, from source rather than from the design: the Prisma column is unconstrained, the console reads the runtime list from the readiness endpoint, and no exhaustive `switch` on the runtime union exists. Any of these being false changes the approach.

## 2. Track: one-declaration (depends: baseline-evidence)

- [x] 2.1 Introduce the single runtime-identifier declaration in `@cap/contracts`, spelled the same way the provider axis already spells its own (`SANDBOX_PROVIDER_FAMILIES`), so the two axes stop being asymmetric.
- [x] 2.2 Derive the validation schema and the exported runtime type from that declaration, leaving the accepted and rejected value sets identical.
- [x] 2.3 Derive the contract's default runtime from the declaration rather than asserting a literal against a separately written union.
- [x] 2.4 Leave every existing `RuntimeSchema` consumer untouched. If any of the eight positions needs an edit, record why — a consumer that must change is evidence the derivation is not equivalent.
- [x] 2.5 Run the contracts build and any contracts-level tests; the schema's accepted set must be unchanged.

## 3. Track: registration-parity (depends: one-declaration)

- [x] 3.1 Replace the api's hand-written runtime identifier union with the derived one, keeping the api's own name for it at its use sites.
- [x] 3.2 Derive the api's default runtime constant from the contract's, removing the second spelling.
- [x] 3.3 Convert the production registry wiring from a positional list to a total mapping from declared identifier to implementation, so a declared identifier with no implementation cannot be expressed.
- [x] 3.4 Prove the guard fires: remove one entry from the mapping, confirm the typecheck fails naming the missing identifier, restore it, confirm the typecheck returns clean. Record both outputs.
- [x] 3.5 Add the compile-fail fixture per design D5, following the existing `.typecheck.ts` convention, including a case that fails if the mapping is weakened to a partial or index-signature shape.
- [x] 3.6 Derive the console's own re-declared runtime union from the contract it already depends on (`apps/web/src/lib/api/real.ts`), so the fourth statement found in 1.2 stops existing.
- [x] 3.7 Update the registry docstrings that currently describe the aspirational arrangement so they describe what the code now does. The claim "registering a third runtime needs no edit here" must become true or be removed.

## 4. Track: verification (depends: one-declaration, registration-parity)

- [x] 4.1 Run `pnpm --filter @cap/api typecheck`, `pnpm --filter @cap/api lint`, and the full `pnpm --filter @cap/api test`. Also build and test `@cap/contracts` and typecheck the web app, since the contract type crosses that boundary.
- [x] 4.2 Confirm behaviour was preserved rather than re-baselined: no existing test file was modified. A test that needs changing means the derivation was not equivalent and must be reworked, not accommodated.
- [x] 4.3 Run `node scripts/api-module-layout-check.mjs` and the repository test-discovery gate, so the new fixture is actually mounted rather than silently unrun.
- [x] 4.4 Measure the admission cost again by the same method as 1.2 and compare against the recorded baseline: four vocabulary statements must become one, and registration must go from unchecked to compile-enforced. The six per-runtime policy tables recorded in 1.2 are correct as they are and MUST still be demanded — a change that stops demanding them has removed a decision point, not a defect. Record the compiler's demanded-edit list verbatim; any vocabulary statement beyond the single declaration is a defect in this boundary, and either it is fixed or the gap is written down.
- [x] 4.5 Confirm the four statements are now one: grep for any remaining independent enumeration of runtime identifiers across `packages/` and `apps/`, and record what is left. Literals inside tests and fixtures are acceptable; a second *definition* of the set is not — and neither is a hand-written enumeration that stays silent when the declaration grows, which is the case this search actually has to catch.
