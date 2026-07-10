## Context

CAP's official sandbox Dockerfiles already install exact Codex, Claude Code, and OpenSpec versions, but the versions exist only as build arguments and build logs. Managed custom images have validation and immutable image identity, yet no required contract for declaring the small set of dependencies their builders want operators to see. Runtime preflight can prove binaries exist, while task reads and the console cannot identify which versions the provisioned sandbox actually contained.

This change deliberately starts from newly rebuilt images. It does not preserve compatibility with images that predate the metadata contract. The solution must work identically for AIO containers and BoxLite rootfs/OCI assets and must not introduce package-manager scanning or per-task CLI upgrades.

## Goals / Non-Goals

**Goals:**

- Define one minimal metadata contract shared by official and custom sandbox images.
- Let image builders declare only operator-relevant dependencies and exact versions.
- Read and validate the metadata before Codex or Claude Code launches.
- Persist the exact metadata used by a sandbox run and expose it on task reads.
- Show the effective sandbox and dependency versions while a task starts and runs.
- Keep official registry images and packaged offline assets metadata-identical.

**Non-Goals:**

- Generate or display a complete SBOM.
- Scan npm, pip, apt, or other installed package inventories.
- Install or upgrade dependencies during task startup.
- Support old images without the metadata file.
- Model package ecosystems, version ranges, provenance attestations, or arbitrary UI-defined probes.
- Treat dependencies installed by an agent during a task as changes to the base image metadata.

## Decisions

### D1: A required in-image JSON file is the canonical contract

Every supported image contains `/etc/cap/sandbox-metadata.json`:

```json
{
  "schemaVersion": 1,
  "sandboxVersion": "v0.37.0",
  "dependencies": {
    "codex": "0.132.0",
    "claude-code": "2.1.181",
    "openspec": "1.4.1"
  }
}
```

`dependencies` is a non-empty-key string map. Builders include only dependencies they choose to expose. Values must be non-empty exact build values and must not be moving selectors such as `latest`. CAP preserves unknown dependency keys so custom tooling requires no backend schema change.

The file is preferred over a label-only payload because the same provider-neutral command executor can read it from AIO and BoxLite sandboxes without registry API, Docker inspect, OCI config, or registry credential branches. Optional OCI labels may advertise the schema/path, but they are not authoritative.

Alternative considered: infer versions by running each known CLI. Rejected because it cannot support arbitrary builder-declared dependencies without executing builder-controlled commands at runtime and creates a second source of truth.

### D2: One build helper writes metadata from exact build inputs

A small repository build helper accepts `sandboxVersion` and dependency key/value pairs, validates them, sorts keys for deterministic output, and writes the JSON file. Both official Dockerfiles invoke the same helper after installing their exact pinned versions. Custom-image templates document and invoke the same helper.

The official dependency set is Codex, Claude Code, and OpenSpec. The helper does not discover packages. Docker image builds continue to run the existing CLI `--version` assertions so an installation failure remains a build failure.

Alternative considered: embed hand-written JSON separately in each Dockerfile. Rejected because the AIO and BoxLite contracts could drift and shell JSON escaping is brittle.

### D3: Provider-neutral preflight reads metadata before runtime setup

After the provider provisions an addressable sandbox but before runtime credential/setup commands and Agent launch, the host harness reads the fixed file through the selected run's command executor. It parses the shared contract and fails preflight when the file is missing, invalid, uses an unsupported schema version, contains a moving version value, or does not include the selected official runtime key.

This ordering ensures the displayed snapshot belongs to the actual sandbox, not merely the requested tag. It also keeps AIO and BoxLite behavior identical.

Alternative considered: read metadata only during managed-environment registration. Rejected because deployment-level default images and a mutable-tag race could otherwise start a different image from the one validated.

### D4: Environment validation caches metadata; sandbox-run metadata is authoritative

Managed custom-image validation reads the same file and stores the parsed value in the validation record so image management and task selection can preview it. At actual provisioning, CAP reads it again from the provisioned sandbox and stores the parsed snapshot in the existing `SandboxRun.metadata` JSON alongside effective image identity.

Task response contracts expose an additive `sandboxMetadata` summary derived from the effective run snapshot. Historical task display never rereads the current environment validation or current image tag.

Alternative considered: normalize dependencies into relational rows. Rejected because the dependency map is intentionally small, immutable per run, and not queried independently.

### D5: The task startup/session surface renders the effective snapshot

The task detail startup area renders `sandboxVersion` followed by every declared dependency in deterministic key order. Official keys receive product labels (`Codex`, `Claude Code`, `OpenSpec`); unknown custom keys use their key as the label. While metadata is not yet available, the existing sandbox-starting state remains. Invalid metadata is surfaced through the task's preflight failure instead of a fabricated version.

The create-task form may preview metadata cached on a selected managed environment later, but it is not the source of truth and is not required for this change. The required display is the effective task snapshot after the sandbox is provisioned.

### D6: Release verification compares official image and asset metadata

Release CI builds both official sandbox images from the same version inputs. Image smoke checks read and validate their metadata. Offline AIO and BoxLite assets are packaged from those published images, and release verification extracts/reads the metadata from each asset to assert equality with the registry image contract and release version.

## Risks / Trade-offs

- [A custom image can declare an inaccurate version] -> Treat metadata as the image's build contract; CAP guarantees it read the actual image file but does not independently understand arbitrary custom tools.
- [A mutable image tag changes after environment validation] -> Read metadata again from the actually provisioned sandbox and persist that run snapshot; image digest remains part of effective run metadata.
- [Metadata validation adds one command before launch] -> The read is a single small file operation through the already-required command executor and is negligible compared with provisioning.
- [Making metadata mandatory breaks existing images] -> This is an intentional rebuild boundary; rebuild official images and published templates together, and fail old images with a concrete preflight error.
- [Dependency keys produce poor labels] -> Provide labels for official keys and render custom keys literally; avoid a second display-name schema until a real need appears.

## Migration Plan

1. Add the metadata contract, parser, and deterministic build helper.
2. Rebuild official AIO and BoxLite images with the required metadata.
3. Update custom-image templates and documentation to call the helper.
4. Add environment-validation and provider-neutral pre-launch reads.
5. Persist and expose the effective sandbox-run snapshot.
6. Add console rendering and release/asset verification.
7. Publish the first CAP release whose sandbox contract requires metadata, then upgrade deployments and stage both official sandbox artifacts before accepting new tasks.

Rollback requires rolling CAP and its official sandbox images/assets back together to the preceding release. New metadata is additive inside images, but a new API rolled back without its reader simply ignores it.

## Open Questions

None. The change intentionally fixes the metadata path, schema shape, mandatory-new-image boundary, and display location so implementation can proceed without further product decisions.
