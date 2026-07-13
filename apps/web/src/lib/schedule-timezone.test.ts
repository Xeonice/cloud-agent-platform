import { describe, expect, it } from "vitest";

import {
  SCHEDULE_TIMEZONE_FALLBACK,
  buildScheduleTimezoneOptions,
  detectBrowserScheduleTimezone,
  listSupportedScheduleTimezones,
  resolveHydratedScheduleTimezone,
} from "./schedule-timezone";

describe("schedule timezone helpers", () => {
  it("detects a valid browser IANA timezone", () => {
    expect(detectBrowserScheduleTimezone(() => "Asia/Shanghai")).toBe(
      "Asia/Shanghai",
    );
  });

  it("falls back to UTC for missing, invalid, or failed detection", () => {
    expect(detectBrowserScheduleTimezone(() => undefined)).toBe(
      SCHEDULE_TIMEZONE_FALLBACK,
    );
    expect(detectBrowserScheduleTimezone(() => "Mars/Phobos")).toBe(
      SCHEDULE_TIMEZONE_FALLBACK,
    );
    expect(
      detectBrowserScheduleTimezone(() => {
        throw new Error("timezone unavailable");
      }),
    ).toBe(SCHEDULE_TIMEZONE_FALLBACK);
  });

  it("reads supportedValuesOf defensively and filters invalid identifiers", () => {
    expect(
      listSupportedScheduleTimezones(() => [
        "Europe/London",
        "Mars/Phobos",
        "Asia/Shanghai",
      ]),
    ).toEqual(["Europe/London", "Asia/Shanghai"]);
    expect(listSupportedScheduleTimezones(null)).toEqual([]);
    expect(
      listSupportedScheduleTimezones(() => {
        throw new Error("unsupported");
      }),
    ).toEqual([]);
  });

  it("deduplicates and sorts supported, detected, current, persisted, and UTC values", () => {
    expect(
      buildScheduleTimezoneOptions({
        supportedTimezones: ["Europe/Paris", "Asia/Shanghai", "Mars/Phobos"],
        detectedTimezone: "Asia/Shanghai",
        currentTimezone: "UTC",
        persistedTimezone: "Europe/London",
      }),
    ).toEqual([
      "Asia/Shanghai",
      "Europe/London",
      "Europe/Paris",
      "UTC",
    ]);
  });

  it("keeps known valid values when timezone enumeration is unavailable", () => {
    expect(
      buildScheduleTimezoneOptions({
        detectedTimezone: "Asia/Shanghai",
        currentTimezone: "Europe/London",
        persistedTimezone: "Europe/London",
      }),
    ).toEqual(["Asia/Shanghai", "Europe/London", "UTC"]);
  });

  it("applies detection only to untouched creates and preserves edit or dirty values", () => {
    expect(
      resolveHydratedScheduleTimezone({
        detectedTimezone: "Asia/Shanghai",
        currentTimezone: "UTC",
        editing: false,
        dirty: false,
      }),
    ).toBe("Asia/Shanghai");
    expect(
      resolveHydratedScheduleTimezone({
        detectedTimezone: "Asia/Shanghai",
        currentTimezone: "Europe/Paris",
        editing: false,
        dirty: true,
      }),
    ).toBe("Europe/Paris");
    expect(
      resolveHydratedScheduleTimezone({
        detectedTimezone: "Asia/Shanghai",
        currentTimezone: "UTC",
        persistedTimezone: "Europe/London",
        editing: true,
        dirty: false,
      }),
    ).toBe("Europe/London");
    expect(
      resolveHydratedScheduleTimezone({
        detectedTimezone: "Asia/Shanghai",
        currentTimezone: "UTC",
        persistedTimezone: "Europe/London",
        editing: true,
        dirty: true,
      }),
    ).toBe("UTC");
    expect(
      resolveHydratedScheduleTimezone({
        detectedTimezone: "Mars/Phobos",
        currentTimezone: "",
        editing: false,
        dirty: false,
      }),
    ).toBe("UTC");
  });
});
