# Design — unify-dialog-fixed-size

## Decisions (locked in /opsx:explore)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Scope | ALL dialogs unified at the base `ui/dialog.tsx` layer (not per-instance one-offs) |
| D2 | Height policy | Fixed width (keep each dialog's current width) + capped max height |
| D3 | Max-height value | `max-h-[85vh]` — scales with viewport, ~7.5vh breathing top/bottom |
| D4 | Inner scroll impl | ~~`ScrollArea`~~ → **native `overflow-y-auto`** (REVISED during apply — see "ScrollArea reversal" below) |

## ScrollArea reversal (decided during apply, supersedes D4)

D4 originally picked Radix `ScrollArea` for a thin Geist-consistent scrollbar. Browser
verification exposed a blocking defect: `ScrollArea`'s viewport wraps children in a div with
`display:table` + `min-width:100%`. For dialog bodies containing CSS grids with `minmax`/fixed
columns (the import dialog's repo rows), `display:table` sizes the content to its INTRINSIC width,
which intermittently exceeds the container and clips on the right — reading to the user as "the
dialog isn't centered" (it was centered; the *content* was spilling past the right edge).

`DialogBody` was therefore switched to a plain block with native `overflow-x-hidden
overflow-y-auto`. A block keeps `width:100%`, never lets content escape horizontally, and scrolls
only vertically. The macOS/overlay scrollbar is already thin enough; the Geist-scrollbar nicety
was not worth a real layout bug. `ScrollArea` import was removed from `dialog.tsx`.

## Pre-existing horizontal-overflow fix (repo-row)

Switching the import dialog's body from the old DialogContent `grid` context to the new block
`DialogBody` unmasked a PRE-EXISTING overflow (confirmed by git-stash baseline: the original code
overflowed 45px, clipped silently by the old `overflow-hidden`). Root cause is in
`repositories/repo-row.tsx`: the 4-column template min-widths
(`220+270+150+104 = 744px` + `3×gap-4 = 48px` = **792px**) exceed the fixed dialog's inner width
(`820 − 40px px-5 = 780px`). The row also keys its multi-column layout on a VIEWPORT breakpoint
(`min-[821px]:`) even though it lives in an 820px dialog, so the wide layout activates in a space
too narrow for it. Fix: narrow the minimums to `180/220/120/104` (sum `624 + 48 = 672 ≤ 780`).
On the wide `/repositories` page the `fr` ratios dominate, so lowering the floors leaves that page
visually unchanged (regression-verified).

## The two-tier model

```
Tier 1 · base primitive (ui/dialog.tsx)
  DialogContent          + max-h-[85vh]            ← never exceeds viewport
    · default grid path  + overflow-y-auto         ← simple dialogs scroll as one block
  DialogHeader / Footer  + shrink-0                ← pinned
  DialogBody (NEW)        flex-1 min-h-0
                          overflow-hidden + <ScrollArea>   ← the one scroll region

Tier 2 · panel dialogs (the 4 p-0 custom shells)
  DialogContent: flex flex-col max-h-[85vh] overflow-hidden  (keep fixed width)
  ┌──────────────────────────────┐
  │ header   shrink-0            │  ← title/desc stay put
  ├──────────────────────────────┤
  │ <DialogBody> … only scroll … │  ← form / list / state-switch lives here
  ├──────────────────────────────┤
  │ footer   shrink-0           │  ← actions always reachable
  └──────────────────────────────┘
```

## Why `flex flex-col` (not the base `grid`) for panel dialogs

The base `DialogContent` is `grid gap-4`; simple dialogs rely on that grid+gap for spacing and
just need a height cap + whole-content scroll. The four panel dialogs already override to
`grid gap-0 p-0 overflow-hidden` with a self-drawn header/body/footer stack — for a pinned
header/footer + a single flex-grow scroll body, `flex flex-col` with `shrink-0` ends and a
`flex-1 min-h-0` middle is the natural, well-trodden shadcn pattern. `min-h-0` is the load-bearing
detail: without it a flex child refuses to shrink below its content and the scroll never engages.

## DialogBody as a primitive (vs. inlining classes per dialog)

Exporting `DialogBody` from `ui/dialog.tsx` keeps the scroll contract in ONE place (so a future
tweak to scrollbar styling or padding is a single edit) and makes consumer diffs read as intent
(`<DialogBody>…</DialogBody>`) rather than a copy-pasted `flex-1 min-h-0 overflow…` string. It
wraps `ScrollArea` so callers don't re-import it four times.

## Risk / blast radius

- **Logic-preserving.** Consumers change only their wrapper element + classNames. Critically,
  `new-task-dialog.tsx`'s `onInteractOutside` guard (Select renders options in a Radix portal
  OUTSIDE the content DOM; the guard cancels the resulting false "interact outside" dismiss)
  is on `DialogContent` and is untouched — the Select-portal scroll still lives outside, so the
  guard keeps working.
- **Nested scroll.** `new-task-dialog` has an inner terminal preview with its own
  `max-h-[230px] overflow-auto`; nesting it inside `DialogBody`'s ScrollArea is fine (inner
  scroll consumes wheel first, body scrolls when inner is at its bound).
- **Simple dialogs unchanged visually** when content is short — `max-h-[85vh]` + `overflow-y-auto`
  are inert until content would overflow.

## Verification gate

Per dialog, force the tallest realistic content state and confirm: outer width AND height are
constant, header+footer pinned, only `DialogBody` scrolls, and short-content dialogs look
identical to today.
