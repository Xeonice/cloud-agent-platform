import {
  TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES,
  TaskProvisioningDiagnosticsResponseSchema,
  type TaskProvisioningDiagnosticAttempt,
  type TaskProvisioningDiagnosticsResponse,
} from "@cap/contracts";
import { Buffer } from "node:buffer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildTaskProvisioningDiagnosticsCopyText,
  mergeTaskProvisioningDiagnosticsPages,
  taskProvisioningDiagnosticsErrorReason,
  TaskProvisioningDiagnosticsView,
  type TaskProvisioningDiagnosticsTimeline,
} from "./task-provisioning-diagnostics-panel";

const CANARY = "console-diagnostic-secret-canary:+/@?=%";
const CANARY_VARIANTS = [
  CANARY,
  encodeURIComponent(CANARY),
  Buffer.from(CANARY, "utf8").toString("base64"),
  Buffer.from(CANARY, "utf8").toString("base64url"),
] as const;

function expectCanaryAbsent(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const variant of CANARY_VARIANTS) {
    expect(serialized).not.toContain(variant);
  }
}

function canonicalPartial(): TaskProvisioningDiagnosticsResponse {
  return TaskProvisioningDiagnosticsResponseSchema.parse(
    TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES
      .partialPrimaryAndCleanup.value,
  );
}

function paginatedFixture(): readonly TaskProvisioningDiagnosticsResponse[] {
  const base = canonicalPartial();
  const firstAttempt = { ...base.attempts[0]!, truncated: true };
  const secondAttempt: TaskProvisioningDiagnosticAttempt = {
    ...firstAttempt,
    id: "00000000-0000-4000-8000-000000000202",
    attempt: 2,
    providerFamily: "aio",
    eventCount: 0,
    startedAt: new Date("2026-07-18T01:03:03.000Z"),
    finishedAt: new Date("2026-07-18T01:03:03.400Z"),
    primary: {
      ...firstAttempt.primary!,
      observedAt: new Date("2026-07-18T01:03:03.400Z"),
    },
    cleanup: {
      ...firstAttempt.cleanup,
      observedAt: new Date("2026-07-18T01:03:04.600Z"),
    },
  };

  return [
    TaskProvisioningDiagnosticsResponseSchema.parse({
      ...base,
      attempts: [secondAttempt, firstAttempt],
      events: [base.events[1], base.events[0]],
      nextCursor: "page-two",
    }),
    TaskProvisioningDiagnosticsResponseSchema.parse({
      ...base,
      attempts: [firstAttempt],
      events: [base.events[1], base.events[3], base.events[2]],
      nextCursor: null,
    }),
  ];
}

function renderView(
  overrides: Partial<Parameters<typeof TaskProvisioningDiagnosticsView>[0]> = {},
): string {
  return renderToStaticMarkup(
    <TaskProvisioningDiagnosticsView
      timeline={null}
      loading={false}
      refreshing={false}
      loadingMore={false}
      errorReason={null}
      copied={false}
      onCopy={() => undefined}
      onRefresh={() => undefined}
      onLoadMore={() => undefined}
      {...overrides}
    />,
  );
}

describe("task provisioning diagnostics page merge", () => {
  it("deduplicates cursor overlap and keeps attempts/events in stable order", () => {
    const timeline = mergeTaskProvisioningDiagnosticsPages(paginatedFixture());

    expect(timeline?.groups.map(({ attemptNumber }) => attemptNumber)).toEqual([
      1, 2,
    ]);
    expect(timeline?.groups[0]?.events.map(({ sequence }) => sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(timeline?.groups[0]?.events).toHaveLength(4);
    expect(timeline?.hasNextPage).toBe(false);
  });

  it("ignores pages and rows that belong to a different task", () => {
    const [first] = paginatedFixture();
    const foreignTaskId = "00000000-0000-4000-8000-000000000999";
    const foreign = {
      ...first!,
      taskId: foreignTaskId,
    } as TaskProvisioningDiagnosticsResponse;

    const timeline = mergeTaskProvisioningDiagnosticsPages([first!, foreign]);

    expect(timeline?.taskId).toBe(first!.taskId);
    expect(timeline?.groups[0]?.events).toHaveLength(2);
  });
});

describe("task provisioning diagnostics safe rendering", () => {
  it("separates primary and cleanup evidence and stays responsive", () => {
    const [first] = paginatedFixture();
    const timeline = mergeTaskProvisioningDiagnosticsPages([first!]);
    const html = renderView({ timeline });

    expect(html).toContain("主流程结果");
    expect(html).toContain("清理与确认");
    expect(html).toContain("受控命令失败");
    expect(html).toContain("清理失败");
    expect(html).toContain("md:grid-cols-2");
    expect(html).toContain("详细证据已达到保留上限");
    expect(html).toContain("加载更早/后续证据");
    expect(html).not.toContain(first!.taskId);
    expect(html).not.toContain(first!.attempts[0]!.id);
    expect(html).not.toContain(first!.events[0]!.eventId);
    expect(html).not.toContain(first!.events[0]!.operationId);
    expect(html).not.toContain("runtime_setup");
  });

  it("renders reconciliation-pending without replacing the primary failure", () => {
    const base = canonicalPartial();
    const pending = TaskProvisioningDiagnosticsResponseSchema.parse({
      ...base,
      attempts: [
        {
          ...base.attempts[0]!,
          cleanup: {
            state: "pending",
            cause: "cleanup_unconfirmed",
            attemptCount: 1,
            lastAttemptOutcome: "indeterminate",
            observedAt: "2026-07-18T01:02:04.600Z",
          },
        },
      ],
      nextCursor: null,
    });
    const html = renderView({
      timeline: mergeTaskProvisioningDiagnosticsPages([pending]),
    });

    expect(html).toContain("沙箱清理仍在协调或等待确认");
    expect(html).toContain("受控命令失败");
    expect(html).toContain("等待清理确认");
  });

  it("renders honest loading, denied, not-started, and unavailable states", () => {
    const notStarted = mergeTaskProvisioningDiagnosticsPages([
      TaskProvisioningDiagnosticsResponseSchema.parse(
        TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES.notStarted.value,
      ),
    ]);
    const unavailable = mergeTaskProvisioningDiagnosticsPages([
      TaskProvisioningDiagnosticsResponseSchema.parse(
        TASK_PROVISIONING_DIAGNOSTICS_RESPONSE_EXAMPLES.historicalUnavailable
          .value,
      ),
    ]);

    expect(renderView({ loading: true })).toContain("正在读取安全诊断证据");
    expect(renderView({ errorReason: "denied" })).toContain("无权读取");
    expect(renderView({ timeline: notStarted })).toContain(
      "尚未进入提供方处理",
    );
    expect(renderView({ timeline: notStarted })).toContain("这不是历史缺失");
    expect(renderView({ timeline: unavailable })).toContain("不会从审计文本");
  });

  it("never interpolates an arbitrary cached error into the DOM", () => {
    const cause = new Error(CANARY_VARIANTS[1]);
    const error = new Error(CANARY_VARIANTS[0], { cause });
    error.stack = `Error: ${CANARY_VARIANTS[2]}`;
    const reason = taskProvisioningDiagnosticsErrorReason(error);
    const html = renderView({ errorReason: reason });

    expect(reason).toBe("request_failed");
    expect(html).toContain("暂时无法读取任务准备诊断");
    expectCanaryAbsent(html);
  });
});

describe("task provisioning diagnostics safe copy", () => {
  it("copies only the closed projection and omits every identity/raw field", () => {
    const timeline = mergeTaskProvisioningDiagnosticsPages(paginatedFixture());
    expect(timeline).not.toBeNull();
    const poisoned = {
      ...timeline!,
      groups: timeline!.groups.map((group) => ({
        ...group,
        attempt: group.attempt
          ? {
              ...group.attempt,
              providerResourceId: CANARY_VARIANTS[0],
              stack: CANARY_VARIANTS[1],
              body: Buffer.from(CANARY, "utf8"),
            }
          : null,
        events: group.events.map((event) => ({
          ...event,
          command: CANARY_VARIANTS[0],
          argv: [CANARY_VARIANTS[1]],
          cwd: `/tmp/${CANARY_VARIANTS[1]}`,
          prompt: CANARY_VARIANTS[2],
          stdout: CANARY_VARIANTS[3],
          stderr: CANARY_VARIANTS[0],
          error: new Error(CANARY_VARIANTS[1]),
          cause: CANARY_VARIANTS[2],
          body: Buffer.from(CANARY, "utf8"),
          wsReason: CANARY_VARIANTS[3],
          tokenUrl: `https://provider.test/?token=${CANARY_VARIANTS[1]}`,
          headers: { authorization: CANARY_VARIANTS[2] },
          temporaryPath: `/tmp/${CANARY_VARIANTS[0]}`,
          providerSandboxId: "boxlite-private-provider-id-canary",
        })),
      })),
    } as TaskProvisioningDiagnosticsTimeline;

    const copied = buildTaskProvisioningDiagnosticsCopyText(poisoned);

    expect(copied).toContain("主流程：失败 / 受控命令失败");
    expect(copied).toContain("清理：清理失败");
    expectCanaryAbsent(copied);
    expect(copied).not.toContain("boxlite-private-provider-id-canary");
    expect(copied).not.toContain(timeline!.taskId);
    for (const group of timeline!.groups) {
      if (group.attempt) expect(copied).not.toContain(group.attempt.id);
      for (const event of group.events) {
        expect(copied).not.toContain(event.eventId);
        expect(copied).not.toContain(event.operationId);
      }
    }
  });
});
