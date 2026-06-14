<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: dialog-primitive (depends: none)

- [x] 1.1 In `apps/web/src/components/ui/dialog.tsx`, add `max-h-[85vh]` to `DialogContent`'s base className, and add `overflow-y-auto` so the DEFAULT (simple `grid gap-4`) dialogs scroll as one block when content would exceed the cap; leave the existing width classes (`w-full max-w-[calc(100%-2rem)] sm:max-w-lg`) intact.
- [x] 1.2 In `apps/web/src/components/ui/dialog.tsx`, add a new exported `DialogBody` primitive: a `min-h-0 flex-1 overflow-x-hidden overflow-y-auto` block scroll region, accepting `className` to merge via `cn`, with `data-slot="dialog-body"`. NOTE: this uses NATIVE vertical scroll, NOT Radix `ScrollArea` — `ScrollArea`'s viewport child sets `display:table` + `min-width:100%`, which lets grid/`minmax` row content size to its intrinsic width and intermittently overflow + clip on the right (reads as "the dialog isn't centered"). A plain block keeps `width:100%` and only ever scrolls vertically; `overflow-x-hidden` contains any residual horizontal spill.
- [x] 1.3 In `apps/web/src/components/ui/dialog.tsx`, add `shrink-0` to `DialogHeader` and `DialogFooter` base classNames so they stay pinned when `DialogBody` scrolls; add `DialogBody` to the export list.

## 2. Track: panel-consumers (depends: dialog-primitive)

- [x] 2.1 In `apps/web/src/components/dashboard/new-task-dialog.tsx`, change `DialogContent` className to a flex-column capped shell (`flex flex-col max-h-[85vh] overflow-hidden`, keep `sm:max-w-[1040px] rounded-xl p-0` + shadow); wrap the `<form>` body in `<DialogBody>` and add `shrink-0` to the `<header>`. Do NOT touch the `onInteractOutside` Select-portal guard or any form/state logic.
- [x] 2.2 In `apps/web/src/components/repositories/import-dialog.tsx`, switch `DialogContent` to the flex-column capped shell (keep `sm:max-w-[820px]`), add `shrink-0` to the `<header>`, and wrap the body `<div>` (the 待拉取/加载中/列表 state region) in `<DialogBody>`; pin any footer with `shrink-0`.
- [x] 2.3 In `apps/web/src/components/settings/codex-direct-dialog.tsx`, switch `DialogContent` to the flex-column capped shell (keep `sm:max-w-[720px]`), pin header/footer with `shrink-0`, and wrap the middle content in `<DialogBody>`.
- [x] 2.4 In `apps/web/src/components/settings/codex-api-key-dialog.tsx`, switch `DialogContent` to the flex-column capped shell (keep `sm:max-w-[720px]`), make the wrapping `<form>` `flex min-h-0 flex-1 flex-col`, pin header/footer with `shrink-0`, and wrap the middle content in `<DialogBody>`.
- [x] 2.5 In `apps/web/src/components/repositories/repo-row.tsx`, narrow the 4-column minimums from `minmax(220px,1fr)_minmax(270px,1.25fr)_minmax(150px,0.62fr)_104px` to `minmax(180px,1fr)_minmax(220px,1.25fr)_minmax(120px,0.62fr)_104px` (both `RepoRow` and `RepoListHead`). Pre-existing bug surfaced by the capped/native-scroll body: the old minimums summed to 744px + 48px gaps = 792px > the import dialog's 780px inner width, clipping the 操作 buttons on the right (looked like the dialog was off-center). New minimums sum to 624px + 48px = 672px ≤ 780px; on the wide `/repositories` page the `fr` distribution dominates so the appearance is unchanged.

## 3. Track: verify (depends: panel-consumers)

- [x] 3.1 Build/typecheck `apps/web` and confirm no unused-import or type regressions from the `DialogBody` wiring (`ScrollArea` import removed).
- [x] 3.2 Browser-verified (Playwright, mock mode, 1280×680) new-task + import: outer frame width AND height constant (both capped at 85vh=578), header pinned (headerY=52 unchanged when body scrolled to bottom), only `DialogBody` scrolls. codex-direct verified centered + no overflow. Screenshots captured.
- [x] 3.3 Browser-verified short content: import at 1280×1100 renders natural height 623 (< cap 935) with NO scroll; codex-direct natural height 413 (< cap) no scroll — `max-h`/`overflow` inert until overflow. Regression-checked `/repositories` wide page: repo-row columns unchanged.
