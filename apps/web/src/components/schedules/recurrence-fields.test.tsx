import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SCHEDULE_MINUTE_INTERVALS } from "@cap/contracts";

import {
  HOURLY_MINUTE_OPTIONS,
  RECURRENCE_KIND_OPTIONS,
  RecurrenceFields,
  type RecurrenceFieldsValue,
} from "./recurrence-fields";

function value(
  overrides: Partial<RecurrenceFieldsValue> = {},
): RecurrenceFieldsValue {
  return {
    recurrenceKind: "weekdays",
    recurrenceTime: "09:00",
    minuteOfHour: 0,
    intervalMinutes: 5,
    timezone: "Asia/Shanghai",
    weekday: 1,
    dayOfMonth: 1,
    overlapPolicy: "skip",
    ...overrides,
  };
}

function render(overrides: Partial<RecurrenceFieldsValue> = {}): string {
  return renderToStaticMarkup(
    <RecurrenceFields
      idPrefix="test"
      value={value(overrides)}
      timezoneOptions={["UTC", "Asia/Shanghai", "Europe/London"]}
      onChange={vi.fn()}
    />,
  );
}

describe("RecurrenceFields", () => {
  it("owns the complete product recurrence and fixed interval catalogs", () => {
    expect(RECURRENCE_KIND_OPTIONS.map((option) => option.value)).toEqual([
      "daily",
      "weekdays",
      "weekly",
      "monthly",
      "hourly",
      "minuteInterval",
    ]);
    expect(SCHEDULE_MINUTE_INTERVALS).toEqual([5, 10, 15, 30]);
    expect(HOURLY_MINUTE_OPTIONS).toHaveLength(60);
    expect(HOURLY_MINUTE_OPTIONS.at(0)).toBe(0);
    expect(HOURLY_MINUTE_OPTIONS.at(-1)).toBe(59);
  });

  it("renders accessible calendar time, timezone, and overlap controls", () => {
    const html = render({ recurrenceKind: "weekly" });
    expect(html).toContain('for="test-recurrence-time"');
    expect(html).toContain('id="test-recurrence-time"');
    expect(html).toContain('for="test-weekday"');
    expect(html).toContain('id="test-weekday"');
    expect(html).toContain('for="test-timezone"');
    expect(html).toContain('id="test-timezone"');
    expect(html).toContain('for="test-overlap-policy"');
  });

  it("shows the hourly minute control and summary instead of calendar time", () => {
    const html = render({ recurrenceKind: "hourly", minuteOfHour: 15 });
    expect(html).toContain('for="test-minute-of-hour"');
    expect(html).toContain('id="test-minute-of-hour"');
    expect(html).toContain("每小时第 15 分钟运行");
    expect(html).not.toContain('id="test-recurrence-time"');
    expect(html).not.toContain('id="test-interval-minutes"');
  });

  it("shows the fixed interval control and clock-aligned summary", () => {
    const html = render({
      recurrenceKind: "minuteInterval",
      intervalMinutes: 15,
    });
    expect(html).toContain('for="test-interval-minutes"');
    expect(html).toContain('id="test-interval-minutes"');
    expect(html).toContain("每 15 分钟运行（按时钟对齐）");
    expect(html).not.toContain('id="test-recurrence-time"');
    expect(html).not.toContain('id="test-minute-of-hour"');
  });

  it("keeps custom timing opaque while retaining overlap behavior", () => {
    const html = render({ recurrenceKind: "custom" });
    expect(html).not.toContain('id="test-recurrence-time"');
    expect(html).not.toContain('id="test-timezone"');
    expect(html).not.toContain('id="test-minute-of-hour"');
    expect(html).not.toContain('id="test-interval-minutes"');
    expect(html).toContain('id="test-overlap-policy"');
  });
});
