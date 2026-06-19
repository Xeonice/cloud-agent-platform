## MODIFIED Requirements

### Requirement: Console restored to the finalized design baseline
The console screens SHALL match the finalized Open Design baseline (the 2026-06-19 frozen snapshot: 10 screens + `platform.css`), and that baseline's HTML/CSS source SHALL live at the STABLE location `apps/web/e2e/design-baseline/` — it SHALL NOT live inside an `openspec/changes/<name>/` directory, because a change directory is moved on archive and breaks the visual gate (this recurred across the 2026-06-11 and 2026-06-19 snapshots, each re-pointing the server at a soon-to-be-archived change path). Per-page pixel comparison SHALL use this snapshot — including the two added screens (transcript, api) — as the oracle, superseding the earlier 2026-06-11 baseline. The visual harness (`serve-design-baseline.mjs`, `baseline.capture.ts`, `manifest.ts`, and the one-off `verify-replay.mjs`) SHALL resolve the baseline from this stable location and SHALL NOT reference a change-scoped path. A screen is considered restored only when it visually matches its baseline at a fixed viewport.

#### Scenario: Screens are verified against the frozen baseline
- **WHEN** a restored console screen is compared to its `apps/web/e2e/design-baseline/` reference at a matched viewport
- **THEN** it visually matches, and the comparison target is the 2026-06-19 frozen snapshot served from the stable location

#### Scenario: Baseline source survives change archival
- **WHEN** any OpenSpec change is archived (its `openspec/changes/<name>/` directory is moved under `archive/`)
- **THEN** the visual gate's baseline source remains resolvable because it lives at `apps/web/e2e/design-baseline/`, outside any change directory, and `serve-design-baseline.mjs` / `verify-replay.mjs` still resolve their roots without edit
