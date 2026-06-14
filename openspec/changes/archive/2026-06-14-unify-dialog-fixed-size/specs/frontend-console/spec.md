# frontend-console Spec Delta — unify-dialog-fixed-size

## ADDED Requirements

### Requirement: Dialog surfaces use a fixed-width, height-capped, internally-scrolling shell

All `role="dialog"` surfaces in `apps/web` SHALL be built on the shared `ui/dialog.tsx`
primitives and SHALL present a STABLE outer shell whose size does not change with inner content:
the shell SHALL keep a FIXED WIDTH (each dialog retains its configured width) and SHALL CAP its
height at `max-h-[85vh]` so a dialog NEVER exceeds the viewport. When content would exceed the
cap, overflow SHALL be contained and scrolled WITHIN the dialog rather than growing the outer
frame or overflowing the screen.

`ui/dialog.tsx` SHALL provide this regime at the primitive layer: `DialogContent` SHALL carry the
`max-h-[85vh]` cap (and, on the default `grid` path, `overflow-y-auto` so simple dialogs scroll as
one block); it SHALL export a `DialogBody` primitive that designates a SINGLE scroll region
(`flex-1 min-h-0` with NATIVE `overflow-x-hidden overflow-y-auto`); and `DialogHeader` /
`DialogFooter` SHALL be pinned (`shrink-0`) so they stay fixed while `DialogBody` scrolls. The
scroll region SHALL NOT clip its content horizontally: content inside the capped, fixed-width shell
SHALL fit the shell's inner width (the dialog body SHALL NOT use Radix `ScrollArea`, whose
`display:table` viewport lets `minmax`/grid content overflow the right edge; row/column layouts
inside a fixed-width dialog SHALL size their column minimums to fit that dialog width). The content-rich panel dialogs (新建任务, 导入仓库, Codex 直连,
Codex API Key) SHALL adopt a `flex flex-col max-h-[85vh] overflow-hidden` shell, keep their
existing fixed widths, pin their header/footer, and route their middle content through
`DialogBody`. This change SHALL be layout/style-only: no dialog's form logic, validation,
state machine, or dismissal behavior (including `new-task-dialog`'s `onInteractOutside`
Select-portal guard) SHALL change.

#### Scenario: Outer frame stays constant across content/state changes
- **WHEN** a panel dialog's inner content changes (e.g. import-dialog switches 待拉取 → 加载中 →
  长列表, or new-task-dialog expands its form)
- **THEN** the dialog's outer width AND height stay constant
- **AND** only the `DialogBody` region scrolls, while the header and footer stay pinned

#### Scenario: Dialog never exceeds the viewport
- **WHEN** a dialog's content is taller than the available viewport
- **THEN** the dialog height is capped at `max-h-[85vh]` and its overflow scrolls within the
  dialog rather than overflowing the screen

#### Scenario: Short-content dialogs are visually unchanged
- **WHEN** a dialog's content fits well within `85vh`
- **THEN** the `max-h` cap and overflow handling are inert and the dialog renders at its natural
  (unchanged) size

#### Scenario: Content is not clipped horizontally inside the fixed-width shell
- **WHEN** a fixed-width dialog renders content with multi-column rows (e.g. the repo import list)
- **THEN** the row content fits the dialog's inner width and all controls (e.g. the per-row action
  buttons) are fully visible — never clipped past the right edge — while the dialog stays centered
