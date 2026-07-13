import * as React from "react";
import { SCHEDULE_MINUTE_INTERVALS } from "@cap/contracts";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildScheduleTimezoneOptions } from "@/lib/schedule-timezone";
import type { ScheduleFormState } from "@/lib/task-form";
import { cn } from "@/utils";

export const RECURRENCE_KIND_OPTIONS = [
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "工作日" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "hourly", label: "每小时" },
  { value: "minuteInterval", label: "每隔几分钟" },
] as const;

export const WEEKDAY_OPTIONS = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
] as const;

export const HOURLY_MINUTE_OPTIONS = Array.from(
  { length: 60 },
  (_, minute) => minute,
);

export type RecurrenceFieldsValue = Pick<
  ScheduleFormState,
  | "recurrenceKind"
  | "recurrenceTime"
  | "minuteOfHour"
  | "intervalMinutes"
  | "timezone"
  | "weekday"
  | "dayOfMonth"
  | "overlapPolicy"
>;

export interface RecurrenceFieldsProps {
  idPrefix: string;
  value: RecurrenceFieldsValue;
  timezoneOptions: readonly string[];
  onChange: (patch: Partial<RecurrenceFieldsValue>) => void;
  className?: string;
  labelClassName?: string;
}

export function RecurrenceFields({
  idPrefix,
  value,
  timezoneOptions,
  onChange,
  className,
  labelClassName,
}: RecurrenceFieldsProps) {
  const ids = {
    kind: `${idPrefix}-recurrence-kind`,
    time: `${idPrefix}-recurrence-time`,
    minuteOfHour: `${idPrefix}-minute-of-hour`,
    intervalMinutes: `${idPrefix}-interval-minutes`,
    weekday: `${idPrefix}-weekday`,
    dayOfMonth: `${idPrefix}-day-of-month`,
    timezone: `${idPrefix}-timezone`,
    overlapPolicy: `${idPrefix}-overlap-policy`,
  };
  const labelClass = cn(
    "text-[13px] font-medium text-foreground",
    labelClassName,
  );
  const calendarRecurrence =
    value.recurrenceKind === "daily" ||
    value.recurrenceKind === "weekdays" ||
    value.recurrenceKind === "weekly" ||
    value.recurrenceKind === "monthly";
  const selectableTimezones = React.useMemo(
    () =>
      buildScheduleTimezoneOptions({
        supportedTimezones: timezoneOptions,
        currentTimezone: value.timezone,
      }),
    [timezoneOptions, value.timezone],
  );

  return (
    <div className={cn("grid gap-3", className)}>
      <div className="grid gap-3 min-[821px]:grid-cols-2">
        <div className="grid gap-2">
          <label htmlFor={ids.kind} className={labelClass}>
            重复频率
          </label>
          <Select
            value={value.recurrenceKind}
            onValueChange={(recurrenceKind) =>
              onChange({
                recurrenceKind:
                  recurrenceKind as RecurrenceFieldsValue["recurrenceKind"],
              })
            }
          >
            <SelectTrigger id={ids.kind} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {value.recurrenceKind === "custom" ? (
                <SelectItem value="custom">沿用当前重复规则</SelectItem>
              ) : null}
              {RECURRENCE_KIND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {calendarRecurrence ? (
          <div className="grid gap-2">
            <label htmlFor={ids.time} className={labelClass}>
              触发时间
            </label>
            <Input
              id={ids.time}
              type="time"
              value={value.recurrenceTime}
              onChange={(event) =>
                onChange({ recurrenceTime: event.target.value })
              }
            />
          </div>
        ) : null}

        {value.recurrenceKind === "hourly" ? (
          <div className="grid gap-2">
            <label htmlFor={ids.minuteOfHour} className={labelClass}>
              每小时第几分钟
            </label>
            <Select
              value={String(value.minuteOfHour)}
              onValueChange={(minute) =>
                onChange({ minuteOfHour: Number(minute) })
              }
            >
              <SelectTrigger id={ids.minuteOfHour} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOURLY_MINUTE_OPTIONS.map((minute) => (
                  <SelectItem key={minute} value={String(minute)}>
                    第 {minute} 分钟
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              每小时第 {value.minuteOfHour} 分钟运行
            </p>
          </div>
        ) : null}

        {value.recurrenceKind === "minuteInterval" ? (
          <div className="grid gap-2">
            <label htmlFor={ids.intervalMinutes} className={labelClass}>
              间隔分钟数
            </label>
            <Select
              value={String(value.intervalMinutes)}
              onValueChange={(interval) =>
                onChange({
                  intervalMinutes: Number(
                    interval,
                  ) as RecurrenceFieldsValue["intervalMinutes"],
                })
              }
            >
              <SelectTrigger id={ids.intervalMinutes} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_MINUTE_INTERVALS.map((interval) => (
                  <SelectItem key={interval} value={String(interval)}>
                    每 {interval} 分钟
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              每 {value.intervalMinutes} 分钟运行（按时钟对齐）
            </p>
          </div>
        ) : null}
      </div>

      {value.recurrenceKind === "weekly" ? (
        <div className="grid gap-2">
          <label htmlFor={ids.weekday} className={labelClass}>
            每周哪一天
          </label>
          <Select
            value={String(value.weekday)}
            onValueChange={(weekday) => onChange({ weekday: Number(weekday) })}
          >
            <SelectTrigger id={ids.weekday} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEKDAY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {value.recurrenceKind === "monthly" ? (
        <div className="grid gap-2">
          <label htmlFor={ids.dayOfMonth} className={labelClass}>
            每月哪一天
          </label>
          <Select
            value={String(value.dayOfMonth)}
            onValueChange={(dayOfMonth) =>
              onChange({ dayOfMonth: Number(dayOfMonth) })
            }
          >
            <SelectTrigger id={ids.dayOfMonth} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                <SelectItem key={day} value={String(day)}>
                  {day} 日
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="grid gap-3 min-[821px]:grid-cols-2">
        {value.recurrenceKind !== "custom" ? (
          <div className="grid gap-2">
            <label htmlFor={ids.timezone} className={labelClass}>
              时区
            </label>
            <Select
              value={value.timezone}
              onValueChange={(timezone) => onChange({ timezone })}
            >
              <SelectTrigger id={ids.timezone} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {selectableTimezones.map((timezone) => (
                  <SelectItem key={timezone} value={timezone}>
                    {timezone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="grid gap-2">
          <label htmlFor={ids.overlapPolicy} className={labelClass}>
            上次未结束时
          </label>
          <Select
            value={value.overlapPolicy}
            onValueChange={(overlapPolicy) =>
              onChange({
                overlapPolicy:
                  overlapPolicy as RecurrenceFieldsValue["overlapPolicy"],
              })
            }
          >
            <SelectTrigger id={ids.overlapPolicy} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">跳过本次</SelectItem>
              <SelectItem value="enqueue">继续排队</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
