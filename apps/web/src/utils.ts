import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * `cn` — the shadcn/ui class-name merge helper for apps/web.
 *
 * The shadcn `add` command targets the `utils` alias (`@/utils`) here rather
 * than the conventional `src/lib/utils.ts`, because `src/lib/**` is owned by the
 * data-layer track this run. Mirrors `@cap/ui`'s `cn` so shared and local
 * components merge classNames identically.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
