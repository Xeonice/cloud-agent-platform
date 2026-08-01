# context-layout-report Specification

## Purpose
TBD - created by archiving change enforce-boundaries-from-manifest. Update Purpose after archive.
## Requirements
### Requirement: A layout v2 script performs three check classes from the contexts manifest

A new standalone script SHALL read `docs/refactor/contexts-manifest.json` and
report, over the manifest's declared scope, three classes of findings:
(1) cross-context imports that match none of the manifest's legal forms,
(2) layer-direction violations against the manifest's `layers.order`
(interface → application → domain/store), and (3) Prisma access
(`@prisma/client` or `PrismaService`) in files other than `*.store.ts`, outside
the manifest's declared shared-kernel exemptions.

#### Scenario: An illegal cross-context import is reported

- **WHEN** a governed file imports another context's internals in a form the
  manifest's crossContextRules do not allow, and the script runs
- **THEN** the report lists that import as a cross-context violation with file
  and specifier

#### Scenario: An upward layer import is reported

- **WHEN** a file classified in a lower layer imports a module classified in a
  higher layer (against `layers.order`), and the script runs
- **THEN** the report lists that import as a layer-direction violation

#### Scenario: Prisma outside the store layer is reported

- **WHEN** a governed file that is not a `*.store.ts` file and is not covered
  by a declared shared-kernel exemption imports `@prisma/client` or
  `PrismaService`, and the script runs
- **THEN** the report lists that file as a Prisma-placement violation

### Requirement: File-to-layer classification is declared once and fails closed

The rule mapping files to layers SHALL be declared exactly once — in the
contexts manifest or in the script's documented header — and applied
deterministically (e.g. `*.controller` / `*.service` / `*.store` naming
conventions).
A governed file that matches no classification rule SHALL be reported as
unclassified, never silently skipped.

#### Scenario: An unclassifiable file is surfaced

- **WHEN** a governed source file matches no declared file-to-layer rule and
  the script runs
- **THEN** the report lists that file as unclassified
- **AND** the file is not silently excluded from the layer-direction check

#### Scenario: The classification rule has a single declaration

- **WHEN** the repository is searched for the file-to-layer mapping
- **THEN** exactly one declaration exists (manifest or script header), and the
  script consumes that declaration

### Requirement: The report ratchets against a live-measured baseline via the shared comparator

The script SHALL compare its measured violation counts against committed
baselines at `scripts/ratchets/<rule-id>.json`, consuming the shared comparator
by import (no re-implemented comparison loop). Baseline numbers SHALL come from
a live measurement of the tree at landing time — not from prior document
snapshots — and the measurement SHALL be written back to 工件07. Within
baseline the script exits zero and prints per-class counts; above baseline it
exits non-zero.

#### Scenario: Counts above baseline are red

- **WHEN** the script measures more violations in any class than the committed
  baseline tolerates
- **THEN** it exits non-zero naming the violations the baseline does not cover

#### Scenario: The committed tree matches its baseline exactly

- **WHEN** the script runs on the committed tree at landing
- **THEN** measured counts equal the committed baseline (no over-count, no
  stale entry) and the script exits zero, printing the per-class counts

#### Scenario: Baseline handling is the shared comparator

- **WHEN** the script's baseline logic is inspected
- **THEN** it imports the shared comparator from `scripts/ratchets/` and
  contains no second implementation of the comparison semantics

### Requirement: The v1 layout gate is untouched and v2 runs in parallel

`scripts/api-module-layout-check.mjs` (the v1 gate) SHALL remain unmodified and
its existing CI step SHALL keep running; the v2 script is a separate, parallel
addition that does not replace, wrap, or alter v1.

#### Scenario: v1 survives the change verbatim

- **WHEN** the change lands
- **THEN** `scripts/api-module-layout-check.mjs` is byte-identical to its
  pre-change content and its CI step still executes

### Requirement: The v2 script is a canon gate

The v2 script SHALL ship with a paired self-test
(`node <script>.mjs && node --test <script>.test.mjs`) proving its red paths on
fixtures, and SHALL treat an empty scan as failure.

#### Scenario: Zero files scanned is a failure

- **WHEN** the script's governed scope resolves to zero source files
- **THEN** it exits non-zero reporting the empty scan

#### Scenario: The paired self-test proves the red paths

- **WHEN** the self-test runs under `node --test`
- **THEN** it demonstrates, against fixtures and without touching the
  committed baselines, non-zero outcomes for each of the three violation
  classes and for the unclassified-file case

