/**
 * `ConfigList` — the boxed label/value summary at the foot of the login page's
 * assurance panel (Track 12 fe-page-landing-login; prototype `login.html`
 * `.config-list`).
 *
 * A rounded, ring-bordered list where each row is a flex `space-between` of a
 * muted label and a bold right-aligned value; rows are separated by 1px lines,
 * the last row dropping its bottom border.
 *
 * Stateless + deterministic — pure render, no window/clock/random; SSR-safe.
 *
 * Fidelity (prototype base `.config-list` / `.config-list div`/`span`/`strong`,
 * no `.console-body` override applies on `login.html`):
 *   wrap = rounded-md(8), overflow-hidden, inset ring (shadow-ring).
 *   row  = flex between, min-h 44px, px 12, 13px, bottom 1px `--line`; last:none.
 *   span = muted label; strong = ink 600, right-aligned value.
 */
import { cn } from "@/utils";

/** One label → value pair in the list. */
export interface ConfigRow {
  /** The muted left-hand label (full-width Chinese copy, verbatim). */
  label: string;
  /** The bold right-hand value (full-width Chinese copy, verbatim). */
  value: string;
}

export interface ConfigListProps {
  /** The rows to render, top-to-bottom. */
  rows: readonly ConfigRow[];
  /** Optional extra classes merged onto the wrapper. */
  className?: string;
}

/**
 * Render the assurance summary list. Each row shows a muted label and its bold
 * value, separated by hairline `--line` borders.
 */
export function ConfigList({ rows, className }: ConfigListProps) {
  return (
    <div
      data-slot="config-list"
      className={cn("grid overflow-hidden rounded-md shadow-ring", className)}
    >
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex min-h-11 items-center justify-between gap-3 border-b border-line bg-background px-3 text-[13px] last:border-b-0"
        >
          <span className="text-muted-foreground">{row.label}</span>
          <strong className="text-right font-semibold text-foreground">
            {row.value}
          </strong>
        </div>
      ))}
    </div>
  );
}
