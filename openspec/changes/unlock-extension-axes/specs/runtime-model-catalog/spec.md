## ADDED Requirements

### Requirement: The execution-environment source vocabulary derives from the sandbox-environment declaration

The kind members of `RuntimeExecutionEnvironmentSourceSchema` SHALL derive from
the single source-kind declaration in `sandbox-environment.ts` plus explicitly
modeled extension members, replacing the independently maintained four-member
list. Adding a managed source kind to the declaration SHALL surface in the
snapshot union without a second hand edit in `runtime-model.ts`.

#### Scenario: A new managed source kind needs no second declaration

- **WHEN** a managed source kind is added to `SandboxEnvironmentSourceKindSchema`
- **THEN** the runtime-model snapshot union accepts it through the derivation,
  with no independent member list edited on the runtime-model side

#### Scenario: The derivation is reconciled by the parity gate

- **WHEN** the R5 vocabulary parity gate runs over the merged vocabulary
- **THEN** the runtime-model side reconciles with the sandbox-environment
  declaration plus its declared extension members, and an injected divergence
  turns the gate red

### Requirement: provider-snapshot and boxlite-rootfs compatibility semantics are pinned

`provider-snapshot` MUST remain a valid member of the snapshot vocabulary: it
has a live production writer — the environment resolver falls back to it when a
checksum exists without a matching configured source kind — so the merge SHALL
NOT delete or rename it. `boxlite-rootfs` survives only on the read path
(historical persisted snapshots, validation refinement, and the taskless probe),
and those reads MUST continue to parse. Whether `boxlite-rootfs` is later
migrated away or kept permanently as a legacy member SHALL be decided as its own
explicitly approved task with a user decision point — not embedded as a side
effect of the derivation rewrite.

#### Scenario: The resolver fallback keeps producing valid snapshots

- **WHEN** environment resolution encounters a checksum with no matching
  configured source kind
- **THEN** it still produces a `provider-snapshot` source that parses against
  the merged vocabulary, identical in shape to the pre-merge output

#### Scenario: Historical boxlite-rootfs snapshots stay readable

- **WHEN** a persisted snapshot with kind `boxlite-rootfs` is read after the
  merge
- **THEN** it parses and flows through validation and the taskless probe exactly
  as before

#### Scenario: Retiring boxlite-rootfs is not a side effect of this change

- **WHEN** this change lands
- **THEN** `boxlite-rootfs` is still a member (modeled explicitly as
  extension/legacy), and no persisted-data migration has occurred as part of the
  derivation rewrite
