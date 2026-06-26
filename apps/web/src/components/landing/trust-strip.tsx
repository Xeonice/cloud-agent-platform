/**
 * `TrustStrip` — the landing hero's access-mode pill row (`.trust-strip`,
 * Track 12).
 *
 * A wrapping row of plain `.pill` chips listing the product's access surfaces
 * (本地账号访问 / GitHub PAT 仓库导入 / 远端 Agent CLI). These are the
 * prototype's BASE `.pill` (the soft-blue info chip), distinct from the shared
 * `StatusPill` status family — so the exact prototype tint (#ebf5ff surface /
 * #0068d6 ink) is reproduced inline here rather than borrowing a status tone.
 *
 * SSR-safe: pure render off static literals, no window/clock/random.
 *
 * Fidelity: `.trust-strip` = flex wrap, gap 8, mt 30. `.pill` = inline-flex,
 * min-h 22, padding 0 10, rounded-full, 12px / 500, #ebf5ff / #0068d6.
 */
export interface TrustStripProps {
  /** The pill labels (verbatim prototype copy). */
  items: readonly string[];
}

/** The hero access-mode pill row. */
export function TrustStrip({ items }: TrustStripProps) {
  return (
    <div aria-label="访问模式" className="mt-[30px] flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex min-h-[24px] w-fit items-center gap-1.5 rounded-full bg-[#ebf5ff] px-3 text-xs font-medium whitespace-nowrap text-[#0068d6] ring-1 ring-inset ring-[#cfe4fb]"
        >
          {item}
        </span>
      ))}
    </div>
  );
}
