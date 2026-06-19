import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * `cn` — the shadcn/ui class-name merge helper.
 *
 * Combines conditional class lists (clsx) and de-duplicates conflicting
 * Tailwind utilities (tailwind-merge). Mirrors `@cap/ui`'s `cn` but is kept
 * self-contained in `apps/www` so the marketing site stays fully decoupled from
 * the console package tree (no `@cap/*` runtime import). Every primitive under
 * `components/` imports this via the `@/lib/utils` alias.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
