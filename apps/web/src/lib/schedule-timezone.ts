import { isValidScheduleTimezone } from "@cap/contracts";

export const SCHEDULE_TIMEZONE_FALLBACK = "UTC";

type TimezoneResolver = () => unknown;
type SupportedTimezoneReader = () => unknown;

function browserTimezone(): unknown {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function browserSupportedTimezones(): unknown {
  const supportedValuesOf = (
    Intl as unknown as {
      supportedValuesOf?: (key: "timeZone") => readonly string[];
    }
  ).supportedValuesOf;
  return supportedValuesOf?.("timeZone") ?? [];
}

export function detectBrowserScheduleTimezone(
  resolveTimezone: TimezoneResolver = browserTimezone,
): string {
  try {
    const timezone = resolveTimezone();
    return typeof timezone === "string" && isValidScheduleTimezone(timezone)
      ? timezone
      : SCHEDULE_TIMEZONE_FALLBACK;
  } catch {
    return SCHEDULE_TIMEZONE_FALLBACK;
  }
}

export function listSupportedScheduleTimezones(
  readSupportedTimezones: SupportedTimezoneReader | null =
    browserSupportedTimezones,
): string[] {
  if (!readSupportedTimezones) return [];
  try {
    const values = readSupportedTimezones();
    if (!Array.isArray(values)) return [];
    return values.filter(
      (value): value is string =>
        typeof value === "string" && isValidScheduleTimezone(value),
    );
  } catch {
    return [];
  }
}

export interface BuildScheduleTimezoneOptionsInput {
  supportedTimezones?: readonly unknown[];
  detectedTimezone?: string | null;
  currentTimezone?: string | null;
  persistedTimezone?: string | null;
}

export interface ResolveHydratedScheduleTimezoneInput {
  detectedTimezone: string;
  currentTimezone: string;
  persistedTimezone?: string | null;
  editing: boolean;
  dirty: boolean;
}

export function resolveHydratedScheduleTimezone({
  detectedTimezone,
  currentTimezone,
  persistedTimezone,
  editing,
  dirty,
}: ResolveHydratedScheduleTimezoneInput): string {
  const validOrFallback = (timezone: string | null | undefined): string =>
    timezone && isValidScheduleTimezone(timezone)
      ? timezone
      : SCHEDULE_TIMEZONE_FALLBACK;
  if (dirty) return validOrFallback(currentTimezone);
  if (editing) return validOrFallback(persistedTimezone ?? currentTimezone);
  return validOrFallback(detectedTimezone);
}

export function buildScheduleTimezoneOptions({
  supportedTimezones = [],
  detectedTimezone,
  currentTimezone,
  persistedTimezone,
}: BuildScheduleTimezoneOptionsInput = {}): string[] {
  const candidates = [
    ...supportedTimezones,
    SCHEDULE_TIMEZONE_FALLBACK,
    detectedTimezone,
    currentTimezone,
    persistedTimezone,
  ];
  return [
    ...new Set(
      candidates.filter(
        (value): value is string =>
          typeof value === "string" && isValidScheduleTimezone(value),
      ),
    ),
  ].sort();
}
