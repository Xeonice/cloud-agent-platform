## Why

Every `role="dialog"` surface in `apps/web` is built on the shared `ui/dialog.tsx`
(`DialogPrimitive.Content`), whose sizing strategy fixes WIDTH per instance but leaves
HEIGHT entirely content-driven — the base `DialogContent` carries `w-full
max-w-[calc(100%-2rem)] sm:max-w-lg` and NO `h-*` / `max-h-*` constraint at all. The four
content-rich panels (新建任务 `sm:max-w-[1040px]`, 导入仓库 `820px`, Codex 直连 `720px`,
Codex API Key `720px`) therefore JUMP in outer size as their inner content changes —
import-dialog switches between 待拉取 / 加载中 / 长列表 states, new-task-dialog expands its
form + terminal preview, codex dialogs toggle verification panels. On short viewports a tall
dialog can also overflow the screen with no scroll containment because nothing caps height to
the viewport. The desired behavior (confirmed): a STABLE shell — fixed width, height capped to
the viewport — where only an inner region scrolls, so the outer frame never moves.

## What Changes

- **Base primitive (`ui/dialog.tsx`) gains a height-capped, internally-scrolling regime:**
  - `DialogContent` SHALL cap its height at `max-h-[85vh]` so a dialog NEVER exceeds the
    viewport regardless of content; for the default (simple, `grid gap-4`) dialogs this pairs
    with `overflow-y-auto` so the whole content scrolls as one block when it would overflow.
  - Introduce a new `DialogBody` primitive — `flex-1 min-h-0` with NATIVE `overflow-x-hidden
    overflow-y-auto` — as the SINGLE designated scroll region for the panel-style dialogs. (NOTE:
    originally specced to wrap Radix `ScrollArea`; reversed during apply because `ScrollArea`'s
    `display:table` viewport lets grid/`minmax` row content overflow + clip on the right. See
    design.md "ScrollArea reversal".)
  - `DialogHeader` / `DialogFooter` SHALL gain `shrink-0` so they stay pinned while `DialogBody`
    scrolls.
- **The four panel dialogs adopt the unified shell (layout-only, no logic change):** each
  `DialogContent` becomes `flex flex-col max-h-[85vh] overflow-hidden` (keeping its existing
  fixed width — 1040 / 820 / 720 / 720), its header/footer get `shrink-0`, and its middle
  content moves into `<DialogBody>`. `new-task-dialog.tsx`'s `onInteractOutside` Select-portal
  protection and ALL form/state logic stay byte-for-byte intact — this is a wrapper/className
  reorganization only.

## Capabilities

### New Capabilities
<!-- No new capability — extends the existing frontend-console component-library requirement. -->

### Modified Capabilities
- `frontend-console`: ADD a requirement that all dialog surfaces use a fixed-width,
  height-capped (`max-h-[85vh]`), internally-scrolling shell via the shared `ui/dialog.tsx`
  primitives (`DialogContent` height cap + new `DialogBody` scroll region + `shrink-0`
  header/footer), so the outer frame is stable across content/state changes.

## Impact

- **Frontend (primitive):** `apps/web/src/components/ui/dialog.tsx` — add `max-h-[85vh]`
  (+ `overflow-y-auto` on the default path) to `DialogContent`, add the `DialogBody` export
  (wrapping `ScrollArea`), add `shrink-0` to `DialogHeader`/`DialogFooter`.
- **Frontend (consumers, layout-only):** `dashboard/new-task-dialog.tsx`,
  `repositories/import-dialog.tsx`, `settings/codex-direct-dialog.tsx`,
  `settings/codex-api-key-dialog.tsx` — switch each `DialogContent` to the flex-column capped
  shell and wrap the middle region in `<DialogBody>`; pin headers/footers with `shrink-0`.
- **Frontend (pre-existing-bug fix surfaced during verify):** `repositories/repo-row.tsx` — narrow
  the 4-column min-widths so the row fits the import dialog's 780px inner width (was 792px,
  clipping the action buttons; pre-existing, previously hidden by `overflow-hidden`). Harmless on
  the wide `/repositories` page (regression-verified).
- **No backend / contract / WebSocket impact.** No business logic, validation, or data-flow
  change — purely the dialog chrome's sizing/scroll behavior.
- **Verification:** drive each of the four dialogs in a browser, force the tallest content state
  (import 长列表, new-task expanded form, codex verification panel), and confirm the outer frame
  width+height stays constant while only the inner region scrolls and the header/footer stay
  pinned; confirm short-content dialogs are visually unchanged.
