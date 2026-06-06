/**
 * `AuditTimeline` — the history page RIGHT panel "事件流" (Track 15, task 15.2).
 *
 * A read-only, most-recent-first list of audit events (`historyEventsQuery`).
 * Each `.audit-event` row is a 4-column grid: a mono `HH:MM:SS` time, a colored
 * `.audit-dot` (info = green default / warning = amber `.warn` / error = red
 * `.danger`), a title (strong) + description (p) block, and the right-side mono
 * HTTP `resultCode` (200 / 201 / 409 / 422).
 *
 * The events handed in are ALREADY narrowed by the page's single
 * `useClientFilter` instance — BOTH its text search AND its level segment apply
 * here (the timeline is the level-filtered surface), so this component owns no
 * filter state and is a pure presenter.
 *
 * SSR-safe: the time is formatted from the stored `Date`'s UTC fields
 * (`formatClock`, no `Date.now()`, no local-timezone getters), so server and
 * first-client renders are byte-identical regardless of either process's TZ.
 *
 * Fidelity (FINAL `.console-body` cascade): `.audit-timeline` = zero-gap grid;
 * `.audit-event` = `88px 10px 1fr auto` grid, 12px gap, 12px vertical pad, a
 * bottom hairline (none on the last row); `time` mono 12 muted; `.audit-dot`
 * 8px round green with a 4px soft glow ring (warn amber / danger red variants);
 * `strong` 14 ink block, `p` 12 muted; the trailing code is mono.
 */
import * as React from "react";

import type { AuditEvent, AuditLevel } from "@cap/contracts";
import { cn } from "@/utils";
import { StatusPill } from "@/components/status-pill";
import { Panel, PanelHead } from "@/components/settings/panel";
import { formatClock } from "./format";

/** Per-level dot color + soft glow ring (`.audit-dot` / `.warn` / `.danger`). */
const DOT_CLASS: Record<AuditLevel, string> = {
  info: "bg-success shadow-[0_0_0_4px_rgba(26,127,55,0.1)]",
  warning: "bg-warning shadow-[0_0_0_4px_rgba(154,103,0,0.1)]",
  error: "bg-danger shadow-[0_0_0_4px_rgba(207,34,46,0.1)]",
};

export interface AuditTimelineProps {
  /** The (already search- AND level-filtered) events, most-recent-first. */
  events: readonly AuditEvent[];
}

/** A single timeline row (one audit event). */
function AuditRow({ event }: { event: AuditEvent }) {
  return (
    <div
      data-log-level={event.level}
      className="grid grid-cols-[88px_10px_minmax(0,1fr)_auto] items-start gap-3 py-3 shadow-[rgba(0,0,0,0.06)_0_1px_0] last:shadow-none"
    >
      <time className="font-mono text-xs text-muted-foreground">
        {formatClock(event.timestamp)}
      </time>
      <span
        aria-hidden="true"
        className={cn("mt-[5px] size-2 rounded-full", DOT_CLASS[event.level])}
      />
      <div className="min-w-0">
        <strong className="block text-sm text-ink">{event.title}</strong>
        <p className="mt-1 text-xs text-muted-foreground">{event.description}</p>
      </div>
      {event.resultCode != null ? (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {event.resultCode}
        </span>
      ) : (
        <span aria-hidden="true" />
      )}
    </div>
  );
}

/** The RIGHT panel: head + the filtered event timeline. */
export function AuditTimeline({ events }: AuditTimelineProps) {
  return (
    <Panel>
      <PanelHead right={<StatusPill variant="dark">可过滤</StatusPill>}>
        <h3 className="text-[15px] font-semibold text-foreground">事件流</h3>
      </PanelHead>
      {events.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">
          没有匹配的事件。
        </p>
      ) : (
        <div className="grid gap-0">
          {events.map((event) => (
            <AuditRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </Panel>
  );
}
