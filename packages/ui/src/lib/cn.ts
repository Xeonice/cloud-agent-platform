import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * `cn` — the shadcn/ui class-name merge helper.
 *
 * Combines conditional class lists (clsx) and de-duplicates conflicting
 * Tailwind utilities (tailwind-merge). Every primitive in this package and
 * every consumer in `apps/web` uses this rather than re-implementing className
 * merging locally.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
