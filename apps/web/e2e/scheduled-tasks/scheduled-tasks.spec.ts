import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type Request,
  type Response,
  type TestInfo,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

interface AuthSessionWire {
  readonly user: {
    readonly id: string;
    readonly githubId: number | null;
    readonly login: string | null;
    readonly name: string;
    readonly mustChangePassword: boolean;
  };
}

interface RepoWire {
  readonly id: string;
  readonly name: string;
}

interface ScheduleWire {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string | null;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly recurrence:
    | {
        readonly kind: "hourly";
        readonly minuteOfHour: number;
        readonly timezone: string;
        readonly label: string;
      }
    | {
        readonly kind: "minuteInterval";
        readonly intervalMinutes: number;
        readonly timezone: string;
        readonly label: string;
      }
    | {
        readonly kind: string;
        readonly timezone: string;
        readonly label: string;
      };
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly currentPeriod: {
    readonly key: string;
    readonly scheduledFor: string | null;
    readonly run: Omit<ScheduleRunWire, "scheduleId" | "updatedAt"> | null;
  };
}

interface ScheduleRunWire {
  readonly id: string;
  readonly scheduleId: string;
  readonly scheduledFor: string;
  readonly periodKey: string | null;
  readonly triggerSource: "manual" | "automatic" | null;
  readonly triggeredAt: string | null;
  readonly status: "claimed" | "created" | "skipped" | "failed";
  readonly taskId: string | null;
  readonly taskStatus: TaskWire["status"] | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TaskWire {
  readonly id: string;
  readonly repoId: string;
  readonly prompt: string;
  readonly status:
    | "pending"
    | "queued"
    | "running"
    | "awaiting_input"
    | "completed"
    | "failed"
    | "cancelled"
    | "agent_failed_to_start";
  readonly executionMode: "interactive-pty" | "headless-exec" | null;
  readonly scheduleProvenance?: {
    readonly scheduleId: string;
    readonly scheduledFor: string;
  } | null;
}

interface AuditEventWire {
  readonly id: string;
  readonly taskId: string;
  readonly userId: number;
  readonly type: string;
  readonly timestamp: string;
}

interface ProviderCallWire {
  readonly operation: string;
  readonly taskId: string;
  readonly time: string;
  readonly outcome: string;
}

interface EvidenceWire {
  readonly providerCalls: ProviderCallWire[];
  readonly diagnostics: {
    readonly tasks: Array<{
      readonly id: string;
      readonly ownerUserId: string | null;
    }>;
    readonly audit: Array<{
      readonly taskId: string;
      readonly userId: string | null;
      readonly type: string;
    }>;
  };
}

interface DueResponseWire {
  readonly schedule: ScheduleWire;
}

interface TickResponseWire {
  readonly now: string;
  readonly fired: number;
}

const API_URL = requiredUrl("E2E_API_URL");
const CONTROL_URL = requiredUrl("E2E_CONTROL_URL");
const ADMIN_EMAIL = requiredValue("E2E_ADMIN_EMAIL");
const ADMIN_PASSWORD = requiredValue("E2E_ADMIN_PASSWORD");
const ADMIN_NEW_PASSWORD = requiredValue("E2E_ADMIN_NEW_PASSWORD");
const WALL_CLOCK_MODE = process.env.E2E_WALL_CLOCK === "1";

const TERMINAL_TASK_STATUSES = new Set<TaskWire["status"]>([
  "completed",
  "failed",
  "cancelled",
  "agent_failed_to_start",
]);

let failureScheduleId: string | null = null;
let failureTaskId: string | null = null;

test.afterEach(async ({ context }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  await attachFailureDiagnostics(context.request, testInfo);
});

test("sub-day forms round-trip and owner dispatch remains exactly-once", async ({
  page,
  context,
}) => {
  test.setTimeout(WALL_CLOCK_MODE ? 150_000 : 90_000);

  const marker = randomUUID().slice(0, 8);
  const manualScheduleName = `schedule-manual-e2e-${marker}`;
  const automaticScheduleName = `schedule-automatic-e2e-${marker}`;
  const manualPrompt = `manual period verification ${marker}`;
  const automaticPrompt = `automatic control-plane verification ${marker}`;

  await loginAndRotateFirstPassword(page);

  const session = await apiJson<AuthSessionWire>(
    context.request,
    API_URL,
    "/auth/session",
  );
  expect(session.user.name).toBe(ADMIN_EMAIL);
  expect(session.user.githubId).toBeNull();
  expect(session.user.login).toBeNull();
  expect(session.user.mustChangePassword).toBe(false);

  // Repo import has its own owner-credential E2E coverage. This story only
  // needs a contract-valid repository prerequisite, so the isolated loopback
  // control plane seeds one in its disposable database without weakening the
  // production `POST /repos` authorization.
  const { repo } = await apiJson<{ readonly repo: RepoWire }>(
    context.request,
    CONTROL_URL,
    "/control/fixtures/repos",
    {
      method: "POST",
      data: {
        name: `scheduled-e2e-${marker}`,
        gitSource: "https://github.com/openai/codex.git",
        forge: "github",
        defaultBranch: "main",
      },
    },
  );

  await exerciseSubdayScheduleStory({
    page,
    request: context.request,
    repo,
    marker,
  });

  const manualSchedule = await createSchedule(
    context.request,
    repo.id,
    manualScheduleName,
    manualPrompt,
    "0 0 1 1 *",
  );
  const automaticClock = new Date();
  const automaticCron = WALL_CLOCK_MODE
    ? "* * * * *"
    : `${automaticClock.getUTCMinutes()} ${automaticClock.getUTCHours()} * * *`;
  const automaticSchedule = await createSchedule(
    context.request,
    repo.id,
    automaticScheduleName,
    automaticPrompt,
    automaticCron,
  );
  failureScheduleId = automaticSchedule.id;

  expect(manualSchedule.ownerUserId).toBe(session.user.id);
  expect(automaticSchedule.ownerUserId).toBe(session.user.id);
  expect(manualSchedule.nextRunAt).not.toBeNull();
  const normalNextRunAt = requiredDate(
    manualSchedule.nextRunAt,
    "initial manual nextRunAt",
  );
  expect(normalNextRunAt.getTime()).toBeGreaterThan(Date.now());
  expect(manualSchedule.currentPeriod.run).toBeNull();

  const scheduleIds = new Set([manualSchedule.id, automaticSchedule.id]);
  const schedulesClientReady = page.waitForResponse((response) => {
    if (response.request().method() !== "GET") return false;
    const match = new URL(response.url()).pathname.match(
      /^\/schedules\/([^/]+)\/runs$/,
    );
    return match !== null && scheduleIds.has(decodeURIComponent(match[1]!));
  });
  await page.goto("/schedules", { waitUntil: "domcontentloaded" });
  const clientReadyResponse = await schedulesClientReady;
  expect(clientReadyResponse.status()).toBeLessThan(400);
  await expect(page.getByRole("heading", { name: "定时任务" })).toBeVisible();
  const manualScheduleRow = page
    .getByRole("row")
    .filter({ hasText: manualScheduleName });
  const automaticScheduleRow = page
    .getByRole("row")
    .filter({ hasText: automaticScheduleName });
  await expect(manualScheduleRow).toHaveCount(1);
  await expect(automaticScheduleRow).toHaveCount(1);
  await expect(
    manualScheduleRow.getByLabel(/^下次定时运行 /),
  ).toBeVisible();
  await expect(manualScheduleRow).toContainText("本周期未执行");

  let manualDispatchRequestCount = 0;
  const countManualDispatchRequest = (request: Request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/schedules/${manualSchedule.id}/dispatch`
    ) {
      manualDispatchRequestCount += 1;
    }
  };
  page.on("request", countManualDispatchRequest);
  const clickedAt = Date.now();
  const dispatchResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/schedules/${manualSchedule.id}/dispatch`,
  );
  await manualScheduleRow.getByRole("button", { name: "立即执行" }).click();
  const dispatchResponse = await dispatchResponsePromise;
  page.off("request", countManualDispatchRequest);
  const dispatchReturnedAt = Date.now();
  expect(manualDispatchRequestCount).toBe(1);
  expect(dispatchResponse.ok(), await responseFailure(dispatchResponse)).toBe(true);
  expect(dispatchResponse.request().postDataJSON()).toEqual({
    expectedPeriodKey: manualSchedule.currentPeriod.key,
  });

  const manualRuns = await pollFor(
    () => listRuns(context.request, manualSchedule.id),
    (runs) => runs.length === 1 && runs[0]?.taskId !== null,
    "manual dispatch did not create one durable run and linked task",
  );
  const manualRun = manualRuns[0]!;
  expect(manualRun.status).toBe("created");
  expect(manualRun.periodKey).toBe(manualSchedule.currentPeriod.key);
  expect(manualRun.triggerSource).toBe("manual");
  const manualTriggeredAt = requiredDate(
    manualRun.triggeredAt,
    "manual run triggeredAt",
  );
  const manualCreatedAt = requiredDate(manualRun.createdAt, "manual run createdAt");
  expect(manualTriggeredAt.getTime()).toBeGreaterThanOrEqual(clickedAt - 2_000);
  expect(manualTriggeredAt.getTime()).toBeLessThanOrEqual(dispatchReturnedAt + 2_000);
  expect(manualCreatedAt.getTime()).toBeGreaterThanOrEqual(clickedAt - 2_000);
  expect(manualCreatedAt.getTime()).toBeLessThanOrEqual(dispatchReturnedAt + 2_000);

  const afterManual = await getSchedule(context.request, manualSchedule.id);
  expect(afterManual.currentPeriod.run?.id).toBe(manualRun.id);
  expect(afterManual.currentPeriod.run?.taskId).toBe(manualRun.taskId);
  expect(afterManual.nextRunAt).not.toBe(manualSchedule.nextRunAt);
  const advancedManualNextRunAt = requiredDate(
    afterManual.nextRunAt,
    "advanced manual nextRunAt",
  );
  expect(advancedManualNextRunAt.getTime()).toBeGreaterThan(
    normalNextRunAt.getTime(),
  );
  const visibleManualNextRun = manualScheduleRow.getByLabel(
    /^下次定时运行 /,
  );
  await expect(visibleManualNextRun).toHaveAttribute(
    "datetime",
    advancedManualNextRunAt.toISOString(),
  );
  await expect(visibleManualNextRun).not.toHaveAttribute(
    "datetime",
    normalNextRunAt.toISOString(),
  );
  await expect(manualScheduleRow).toContainText(
    formatScheduleTime(advancedManualNextRunAt, "UTC"),
  );
  await expect(
    manualScheduleRow.locator(`time[datetime="${manualRun.triggeredAt}"]`),
  ).toBeVisible();
  await expect(manualScheduleRow).toContainText(
    formatScheduleTime(manualTriggeredAt, "UTC"),
  );
  await expect(
    manualScheduleRow.getByRole("button", { name: "本周期已执行" }),
  ).toBeDisabled();
  await expect(manualScheduleRow).toContainText("本周期已执行");

  const retry = await apiJson<ScheduleWire>(
    context.request,
    API_URL,
    `/schedules/${manualSchedule.id}/dispatch`,
    {
      method: "POST",
      data: { expectedPeriodKey: manualSchedule.currentPeriod.key },
    },
  );
  expect(retry.currentPeriod.run?.id).toBe(manualRun.id);
  expect(retry.currentPeriod.run?.taskId).toBe(manualRun.taskId);
  expect(await listRuns(context.request, manualSchedule.id)).toHaveLength(1);

  const manualTask = await pollFor(
    () => getTask(context.request, manualRun.taskId!),
    (task) => TERMINAL_TASK_STATUSES.has(task.status),
    "manual task did not reach a terminal state through the deterministic provider",
  );
  expect(manualTask.scheduleProvenance).toEqual({
    scheduleId: manualSchedule.id,
    scheduledFor: manualRun.scheduledFor,
  });

  const recentRunsPanel = runsPanel(page);
  await expect(
    recentRunsPanel.locator(`time[datetime="${manualRun.triggeredAt}"]`),
  ).toBeVisible();

  const dueAt = WALL_CLOCK_MODE
    ? requiredDate(
        automaticSchedule.nextRunAt,
        "automatic wall-clock nextRunAt",
      ).toISOString()
    : new Date(
        Date.UTC(
          automaticClock.getUTCFullYear(),
          automaticClock.getUTCMonth(),
          automaticClock.getUTCDate(),
          automaticClock.getUTCHours(),
          automaticClock.getUTCMinutes(),
        ),
      ).toISOString();
  if (!WALL_CLOCK_MODE) {
    const dueResponse = await apiJson<DueResponseWire>(
      context.request,
      CONTROL_URL,
      `/control/schedules/${automaticSchedule.id}/due`,
      { method: "POST", data: { dueAt } },
    );
    expect(
      requiredDate(dueResponse.schedule.nextRunAt, "accelerated nextRunAt").getTime(),
    ).toBe(requiredDate(dueAt, "requested dueAt").getTime());
  }

  const runsAfterAutomaticFire = await pollFor(
    () => listRuns(context.request, automaticSchedule.id),
    (runs) =>
      runs.filter((run) => sameInstant(run.scheduledFor, dueAt)).length === 1 &&
      runs.some(
        (run) => sameInstant(run.scheduledFor, dueAt) && run.taskId !== null,
      ),
    "the real scheduler interval did not create the accelerated occurrence",
    WALL_CLOCK_MODE ? 95_000 : 30_000,
  );
  const automaticRun = runsAfterAutomaticFire.find((run) =>
    sameInstant(run.scheduledFor, dueAt),
  )!;
  expect(automaticRun.status).toBe("created");
  expect(automaticRun.taskId).not.toBeNull();
  expect(automaticRun.triggerSource).toBe("automatic");
  expect(automaticRun.periodKey).not.toBeNull();
  expect(automaticRun.triggeredAt).not.toBeNull();
  failureTaskId = automaticRun.taskId;

  const automaticTask = await pollFor(
    () => getTask(context.request, automaticRun.taskId!),
    (task) => TERMINAL_TASK_STATUSES.has(task.status),
    "automatic task did not traverse admission and reach a terminal state",
    30_000,
  );
  expect(automaticTask.status).toBe("failed");
  expect(automaticTask.repoId).toBe(repo.id);
  expect(automaticTask.prompt).toBe(automaticPrompt);
  expect(automaticTask.executionMode).toBe("headless-exec");
  expect(automaticTask.scheduleProvenance).toEqual({
    scheduleId: automaticSchedule.id,
    scheduledFor: automaticRun.scheduledFor,
  });

  const settledRuns = await pollFor(
    () => listRuns(context.request, automaticSchedule.id),
    (current) =>
      current.some(
        (run) => run.id === automaticRun.id && run.taskStatus === "failed",
      ),
    "the run API did not expose the linked task failure",
  );
  expect(
    settledRuns.find((run) => run.id === automaticRun.id)?.taskStatus,
  ).toBe("failed");

  const evidence = await pollFor(
    () =>
      apiJson<EvidenceWire>(
        context.request,
        CONTROL_URL,
        `/control/evidence?taskId=${encodeURIComponent(automaticTask.id)}&scheduleId=${encodeURIComponent(automaticSchedule.id)}`,
      ),
    (current) =>
      current.providerCalls.filter((call) => call.operation === "provision")
        .length === 1,
    "the recording sandbox provider was not invoked exactly once for the automatic task",
  );
  const provisionCalls = evidence.providerCalls.filter(
    (call) => call.operation === "provision",
  );
  expect(provisionCalls).toHaveLength(1);
  expect(provisionCalls[0]).toMatchObject({
    operation: "provision",
    taskId: automaticTask.id,
    outcome: "rejected",
  });
  expect(
    evidence.diagnostics.tasks.find((task) => task.id === automaticTask.id)
      ?.ownerUserId,
  ).toBe(session.user.id);
  expect(
    evidence.diagnostics.audit.find(
      (event) =>
        event.taskId === automaticTask.id && event.type === "task.created",
    )?.userId,
  ).toBe(session.user.id);
  expect(
    evidence.diagnostics.audit.find(
      (event) =>
        event.taskId === automaticTask.id && event.type === "task.running",
    )?.userId,
  ).toBe(session.user.id);

  const audit = await pollFor(
    () =>
      apiJson<AuditEventWire[]>(
        context.request,
        API_URL,
        `/audit/tasks/${automaticTask.id}`,
      ),
    (events) => {
      const types = new Set(events.map((event) => event.type));
      return (
        types.has("task.created") &&
        types.has("task.running") &&
        types.has("force_failed:provision_failed") &&
        types.has("task.failed")
      );
    },
    "automatic task audit trail did not record creation, admission, and provider failure",
  );
  expect(audit.every((event) => event.taskId === automaticTask.id)).toBe(true);
  expect(audit.findIndex((event) => event.type === "task.created")).toBeLessThan(
    audit.findIndex((event) => event.type === "task.running"),
  );

  const advancedSchedule = await getSchedule(
    context.request,
    automaticSchedule.id,
  );
  const advancedNextRunAt = requiredDate(
    advancedSchedule.nextRunAt,
    "advanced nextRunAt",
  );
  expect(advancedNextRunAt.getTime()).toBeGreaterThan(
    requiredDate(automaticRun.scheduledFor, "automatic scheduledFor").getTime(),
  );
  await expect(
    automaticScheduleRow.getByLabel(/^下次定时运行 /),
  ).toBeVisible({ timeout: 15_000 });
  await expect(automaticScheduleRow).toContainText(
    formatScheduleTime(advancedNextRunAt, "UTC"),
    { timeout: 15_000 },
  );
  await expect(
    automaticScheduleRow.getByText("任务失败", { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
  if (!WALL_CLOCK_MODE) {
    await expect(
      automaticScheduleRow.getByText("本周期已执行", { exact: true }),
    ).toBeVisible();
  }

  await expectExactlyOnceToRemainStable(
    context.request,
    automaticSchedule.id,
    dueAt,
    automaticTask.id,
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "定时任务" })).toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: automaticScheduleName })
    .click();
  const refreshedRunsPanel = runsPanel(page);
  await expect(refreshedRunsPanel.getByLabel(/^实际执行时间 /)).toHaveCount(1);
  await expect(refreshedRunsPanel.getByLabel(/^周期计划时间 /)).toHaveCount(1);
  await expect(
    refreshedRunsPanel.locator(`time[datetime="${automaticRun.triggeredAt}"]`),
  ).toBeVisible();
  const automaticTaskLink = refreshedRunsPanel.locator(
    `a[href="/tasks/${automaticTask.id}"]`,
  );
  await expect(automaticTaskLink).toHaveCount(1);
  await expect(automaticTaskLink).toHaveAccessibleName("任务");
  const automaticRunRecord = refreshedRunsPanel
    .locator("article")
    .filter({
      has: page.locator(`a[href="/tasks/${automaticTask.id}"]`),
    });
  await expect(
    automaticRunRecord.getByText("任务失败", { exact: true }),
  ).toBeVisible();
  await Promise.all([
    page.waitForURL(`**/tasks/${automaticTask.id}`),
    automaticTaskLink.click(),
  ]);
  await expect(page).toHaveURL(new RegExp(`/tasks/${automaticTask.id}$`));
  await expect(page.getByLabel("任务状态")).toHaveText("失败");
});

async function exerciseSubdayScheduleStory({
  page,
  request,
  repo,
  marker,
}: {
  page: Page;
  request: APIRequestContext;
  repo: RepoWire;
  marker: string;
}): Promise<void> {
  const hourlyName = `schedule-hourly-e2e-${marker}`;
  const intervalName = `schedule-interval-e2e-${marker}`;
  const hourlyPrompt = `hourly form verification ${marker}`;
  const intervalPrompt = `interval form verification ${marker}`;

  const pageFormReady = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/runtimes",
  );
  await page.goto("/tasks/new", { waitUntil: "domcontentloaded" });
  await pageFormReady;
  await expect(page.getByRole("heading", { name: "高级派发" })).toBeVisible();
  await page.getByRole("button", { name: "重复运行", exact: true }).click();
  await expect(page.getByLabel("时区")).toContainText("Asia/Shanghai");
  await page.getByLabel("计划名称").fill(hourlyName);
  await selectOption(page, page.getByLabel("重复频率"), "每小时");
  await selectOption(page, page.getByLabel("每小时第几分钟"), "第 23 分钟");
  await selectOption(page, page.getByLabel("仓库"), "openai/codex");
  await page.getByLabel("任务描述").fill(hourlyPrompt);

  const hourlyResponsePromise = page.waitForResponse(isScheduleCreateResponse);
  const hourlyNavigation = page.waitForURL("**/schedules", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "创建定时任务" }).click();
  const hourlyResponse = await hourlyResponsePromise;
  expect(hourlyResponse.ok(), await responseFailure(hourlyResponse)).toBe(true);
  const hourlyBody = hourlyResponse.request().postDataJSON() as JsonObject;
  expect(hourlyBody).toMatchObject({
    name: hourlyName,
    recurrence: {
      kind: "hourly",
      minuteOfHour: 23,
      timezone: "Asia/Shanghai",
    },
    taskTemplate: { repoId: repo.id, prompt: hourlyPrompt },
  });
  expect(hourlyBody).not.toHaveProperty("cronExpression");
  const hourlySchedule = (await hourlyResponse.json()) as ScheduleWire;
  expect(hourlySchedule.cronExpression).toBe("23 * * * *");
  expect(hourlySchedule.recurrence).toMatchObject({
    kind: "hourly",
    minuteOfHour: 23,
    timezone: "Asia/Shanghai",
    label: "每小时第 23 分钟",
  });
  await hourlyNavigation;

  const dialogFormReady = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/runtimes",
  );
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await dialogFormReady;
  await expect(page.getByRole("heading", { name: "运行工作台" })).toBeVisible();
  await page.getByRole("button", { name: "新建任务" }).click();
  const createDialog = page.getByRole("dialog", { name: "派发远端 Agent" });
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("button", { name: "重复运行", exact: true }).click();
  await expect(createDialog.getByLabel("时区")).toContainText("Asia/Shanghai");
  await createDialog.getByLabel("计划名称").fill(intervalName);
  await selectOption(
    page,
    createDialog.getByLabel("重复频率"),
    "每隔几分钟",
  );
  await selectOption(page, createDialog.getByLabel("间隔分钟数"), "每 15 分钟");
  await selectOption(page, createDialog.getByLabel("仓库"), "openai/codex");
  await createDialog.getByLabel("任务描述").fill(intervalPrompt);

  const intervalResponsePromise = page.waitForResponse(isScheduleCreateResponse);
  const intervalNavigation = page.waitForURL("**/schedules", {
    waitUntil: "domcontentloaded",
  });
  await createDialog.getByRole("button", { name: "创建定时任务" }).click();
  const intervalResponse = await intervalResponsePromise;
  expect(intervalResponse.ok(), await responseFailure(intervalResponse)).toBe(true);
  const intervalBody = intervalResponse.request().postDataJSON() as JsonObject;
  expect(intervalBody).toMatchObject({
    name: intervalName,
    recurrence: {
      kind: "minuteInterval",
      intervalMinutes: 15,
      timezone: "Asia/Shanghai",
    },
    taskTemplate: { repoId: repo.id, prompt: intervalPrompt },
  });
  expect(intervalBody).not.toHaveProperty("cronExpression");
  const intervalSchedule = (await intervalResponse.json()) as ScheduleWire;
  expect(intervalSchedule.cronExpression).toBe("*/15 * * * *");
  expect(intervalSchedule.recurrence).toMatchObject({
    kind: "minuteInterval",
    intervalMinutes: 15,
    timezone: "Asia/Shanghai",
    label: "每 15 分钟",
  });
  failureScheduleId = intervalSchedule.id;
  await intervalNavigation;

  await expect(page.getByRole("heading", { name: "定时任务" })).toBeVisible();
  const hourlyRow = page.getByRole("row").filter({ hasText: hourlyName });
  const intervalRow = page.getByRole("row").filter({ hasText: intervalName });
  await expect(hourlyRow).toContainText("每小时第 23 分钟");
  await expect(hourlyRow).toContainText("Asia/Shanghai");
  await expect(intervalRow).toContainText("每 15 分钟");
  await expect(intervalRow).toContainText("Asia/Shanghai");

  await hourlyRow.getByRole("button", { name: "编辑" }).click();
  const hourlyEditDialog = page.getByRole("dialog", { name: "编辑定时任务" });
  await expect(hourlyEditDialog.getByLabel("重复频率")).toContainText("每小时");
  await expect(hourlyEditDialog.getByLabel("每小时第几分钟")).toContainText(
    "第 23 分钟",
  );
  await expect(hourlyEditDialog.getByLabel("时区")).toContainText(
    "Asia/Shanghai",
  );
  await selectOption(page, hourlyEditDialog.getByLabel("时区"), "UTC");
  await expect(hourlyEditDialog.getByLabel("时区")).toContainText("UTC");

  const hourlyUpdateResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/schedules/${hourlySchedule.id}`,
  );
  await hourlyEditDialog
    .getByRole("button", { name: "保存定时任务" })
    .click();
  const hourlyUpdateResponse = await hourlyUpdateResponsePromise;
  expect(
    hourlyUpdateResponse.ok(),
    await responseFailure(hourlyUpdateResponse),
  ).toBe(true);
  expect(hourlyUpdateResponse.request().postDataJSON()).toMatchObject({
    recurrence: {
      kind: "hourly",
      minuteOfHour: 23,
      timezone: "UTC",
    },
  });
  expect(hourlyUpdateResponse.request().postDataJSON()).not.toHaveProperty(
    "cronExpression",
  );
  const updatedHourlySchedule =
    (await hourlyUpdateResponse.json()) as ScheduleWire;
  expect(updatedHourlySchedule.timezone).toBe("UTC");
  expect(updatedHourlySchedule.recurrence).toMatchObject({
    kind: "hourly",
    minuteOfHour: 23,
    timezone: "UTC",
  });
  await expect(hourlyEditDialog).toBeHidden();
  await expect(hourlyRow).toContainText("UTC");

  await hourlyRow.getByRole("button", { name: "编辑" }).click();
  await expect(hourlyEditDialog.getByLabel("重复频率")).toContainText("每小时");
  await expect(hourlyEditDialog.getByLabel("每小时第几分钟")).toContainText(
    "第 23 分钟",
  );
  await expect(hourlyEditDialog.getByLabel("时区")).toContainText("UTC");
  await hourlyEditDialog.getByRole("button", { name: "取消" }).click();
  await expect(hourlyEditDialog).toBeHidden();

  await intervalRow.getByRole("button", { name: "编辑" }).click();
  const intervalEditDialog = page.getByRole("dialog", { name: "编辑定时任务" });
  await expect(intervalEditDialog.getByLabel("重复频率")).toContainText(
    "每隔几分钟",
  );
  await expect(intervalEditDialog.getByLabel("间隔分钟数")).toContainText(
    "每 15 分钟",
  );
  await expect(intervalEditDialog.getByLabel("时区")).toContainText(
    "Asia/Shanghai",
  );
  await intervalEditDialog.getByRole("button", { name: "取消" }).click();
  await expect(intervalEditDialog).toBeHidden();

  // The test-only tick scans every enabled schedule, just like the production
  // scheduler. Isolate the interval race through the real pause endpoint so the
  // hourly form fixture cannot become due at the same synthetic instant.
  const pausedHourlySchedule = await apiJson<ScheduleWire>(
    request,
    API_URL,
    `/schedules/${hourlySchedule.id}/pause`,
    { method: "POST" },
  );
  expect(pausedHourlySchedule.enabled).toBe(false);
  expect(pausedHourlySchedule.nextRunAt).toBeNull();

  const initial = await getSchedule(request, intervalSchedule.id);
  const firstScheduledFor = requiredDate(
    initial.currentPeriod.scheduledFor,
    "sub-day current scheduledFor",
  ).toISOString();
  expect(initial.currentPeriod.key).toBe(`cron:${firstScheduledFor}`);
  expect(initial.nextRunAt).toBe(firstScheduledFor);

  const dispatchResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/schedules/${intervalSchedule.id}/dispatch`,
  );
  const tickPromise = apiJson<TickResponseWire>(
    request,
    CONTROL_URL,
    "/control/scheduler/tick",
    { method: "POST", data: { now: firstScheduledFor } },
  );
  await intervalRow.getByRole("button", { name: "立即执行" }).click();
  const [dispatchResponse, firstTick] = await Promise.all([
    dispatchResponsePromise,
    tickPromise,
  ]);
  expect(dispatchResponse.ok(), await responseFailure(dispatchResponse)).toBe(true);
  expect(dispatchResponse.request().postDataJSON()).toEqual({
    expectedPeriodKey: initial.currentPeriod.key,
  });
  expect(firstTick.now).toBe(firstScheduledFor);
  expect([0, 1]).toContain(firstTick.fired);

  const firstRuns = await pollFor(
    () => listRuns(request, intervalSchedule.id),
    (runs) =>
      runs.filter((run) => sameInstant(run.scheduledFor, firstScheduledFor))
        .length === 1 &&
      runs.some(
        (run) =>
          sameInstant(run.scheduledFor, firstScheduledFor) && run.taskId !== null,
      ),
    "manual and automatic dispatch did not converge on one sub-day occurrence",
  );
  const firstRun = firstRuns.find((run) =>
    sameInstant(run.scheduledFor, firstScheduledFor),
  )!;
  expect(firstRun.periodKey).toBe(`cron:${firstScheduledFor}`);
  expect(["manual", "automatic"]).toContain(firstRun.triggerSource);

  const afterFirst = await getSchedule(request, intervalSchedule.id);
  const secondScheduledFor = requiredDate(
    afterFirst.nextRunAt,
    "next sub-day occurrence",
  ).toISOString();
  expect(requiredDate(secondScheduledFor, "second occurrence").getTime()).toBeGreaterThan(
    requiredDate(firstScheduledFor, "first occurrence").getTime(),
  );
  const secondTick = await apiJson<TickResponseWire>(
    request,
    CONTROL_URL,
    "/control/scheduler/tick",
    { method: "POST", data: { now: secondScheduledFor } },
  );
  expect(secondTick).toEqual({ now: secondScheduledFor, fired: 1 });

  const settledRuns = await pollFor(
    () => listRuns(request, intervalSchedule.id),
    (runs) =>
      runs.filter(
        (run) =>
          sameInstant(run.scheduledFor, firstScheduledFor) ||
          sameInstant(run.scheduledFor, secondScheduledFor),
      ).length === 2,
    "later sub-day occurrence was not dispatched independently",
  );
  const secondRun = settledRuns.find((run) =>
    sameInstant(run.scheduledFor, secondScheduledFor),
  )!;
  expect(secondRun.periodKey).toBe(`cron:${secondScheduledFor}`);
  expect(secondRun.triggerSource).toBe("automatic");
  expect(secondRun.taskId).not.toBe(firstRun.taskId);
  failureTaskId = secondRun.taskId;

  const repeatedTick = await apiJson<TickResponseWire>(
    request,
    CONTROL_URL,
    "/control/scheduler/tick",
    { method: "POST", data: { now: secondScheduledFor } },
  );
  expect(repeatedTick.fired).toBe(0);
  expect(await listRuns(request, intervalSchedule.id)).toHaveLength(2);
}

function isScheduleCreateResponse(response: Response): boolean {
  return (
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/schedules"
  );
}

async function selectOption(
  page: Page,
  trigger: Locator,
  optionName: string,
): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function loginAndRotateFirstPassword(page: Page): Promise<void> {
  const capabilityResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/auth/session",
  );
  await page.goto("/login?redirect=%2Fschedules", { waitUntil: "domcontentloaded" });
  // The login form is server-rendered before React attaches its handlers. The
  // capability probe is started by the hydrated client, so waiting for it keeps
  // credentials from being typed into a pre-hydration form that is then replaced.
  await capabilityResponsePromise;

  const email = page.getByLabel("邮箱");
  const password = page.getByLabel("密码", { exact: true });
  await email.fill(ADMIN_EMAIL);
  await password.fill(ADMIN_PASSWORD);
  await expect(email).toHaveValue(ADMIN_EMAIL);

  const loginResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/auth/password",
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.ok(), await responseFailure(loginResponse)).toBe(true);

  const forcedChange = page.getByRole("dialog", { name: "设置你的新密码" });
  await expect(forcedChange).toBeVisible();
  await forcedChange.getByLabel("新密码", { exact: true }).fill(ADMIN_NEW_PASSWORD);
  await forcedChange.getByLabel("确认新密码").fill(ADMIN_NEW_PASSWORD);

  const changeResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/auth/change-password",
  );
  const schedulesNavigation = page.waitForURL("**/schedules", {
    waitUntil: "domcontentloaded",
  });
  await forcedChange.getByRole("button", { name: "保存并进入控制台" }).click();
  const changeResponse = await changeResponsePromise;
  expect(changeResponse.ok(), await responseFailure(changeResponse)).toBe(true);
  await schedulesNavigation;
}

async function expectExactlyOnceToRemainStable(
  request: APIRequestContext,
  scheduleId: string,
  scheduledFor: string,
  taskId: string,
): Promise<void> {
  let consecutiveStableReads = 0;
  await expect
    .poll(
      async () => {
        const [runs, tasks, evidence] = await Promise.all([
          listRuns(request, scheduleId),
          apiJson<TaskWire[]>(request, API_URL, "/tasks"),
          apiJson<EvidenceWire>(
            request,
            CONTROL_URL,
            `/control/evidence?taskId=${encodeURIComponent(taskId)}&scheduleId=${encodeURIComponent(scheduleId)}`,
          ),
        ]);
        const occurrenceRuns = runs.filter((run) =>
          sameInstant(run.scheduledFor, scheduledFor),
        );
        const occurrenceTasks = tasks.filter(
          (task) =>
            task.scheduleProvenance?.scheduleId === scheduleId &&
            sameInstant(task.scheduleProvenance.scheduledFor, scheduledFor),
        );
        const stable =
          occurrenceRuns.length === 1 &&
          occurrenceTasks.length === 1 &&
          occurrenceTasks[0]?.id === taskId &&
          evidence.providerCalls.filter((call) => call.operation === "provision")
            .length === 1;
        consecutiveStableReads = stable ? consecutiveStableReads + 1 : 0;
        return consecutiveStableReads;
      },
      {
        message: "automatic occurrence duplicated after subsequent scheduler polls",
        timeout: 10_000,
        intervals: [150, 250, 400, 800],
      },
    )
    .toBeGreaterThanOrEqual(4);
}

async function pollFor<T>(
  read: () => Promise<T>,
  accepted: (value: T) => boolean,
  message: string,
  timeout = 20_000,
): Promise<T> {
  let latest: T | undefined;
  await expect
    .poll(
      async () => {
        latest = await read();
        return accepted(latest);
      },
      { message, timeout, intervals: [100, 200, 400, 800, 1_000] },
    )
    .toBe(true);
  if (latest === undefined) throw new Error(`${message}: no value observed`);
  return latest;
}

function runsPanel(page: Page) {
  return page.locator('[data-slot="settings-panel"]').filter({
    has: page.getByRole("heading", { name: "最近运行" }),
  });
}

async function createSchedule(
  request: APIRequestContext,
  repoId: string,
  name: string,
  prompt: string,
  cronExpression: string,
): Promise<ScheduleWire> {
  return apiJson<ScheduleWire>(request, API_URL, "/schedules", {
    method: "POST",
    data: {
      name,
      cronExpression,
      timezone: "UTC",
      taskTemplate: {
        repoId,
        prompt,
        runtime: "codex",
        sandboxEnvironmentId: null,
        deliver: "none",
      },
      enabled: true,
      overlapPolicy: "enqueue",
      misfirePolicy: "fire-once",
    },
  });
}

async function getSchedule(
  request: APIRequestContext,
  scheduleId: string,
): Promise<ScheduleWire> {
  return apiJson<ScheduleWire>(request, API_URL, `/schedules/${scheduleId}`);
}

async function listRuns(
  request: APIRequestContext,
  scheduleId: string,
): Promise<ScheduleRunWire[]> {
  return apiJson<ScheduleRunWire[]>(
    request,
    API_URL,
    `/schedules/${scheduleId}/runs`,
  );
}

async function getTask(
  request: APIRequestContext,
  taskId: string,
): Promise<TaskWire> {
  return apiJson<TaskWire>(request, API_URL, `/tasks/${taskId}`);
}

async function apiJson<T>(
  request: APIRequestContext,
  baseUrl: string,
  path: string,
  options: { readonly method?: string; readonly data?: JsonObject } = {},
): Promise<T> {
  const response = await request.fetch(endpoint(baseUrl, path), {
    method: options.method ?? "GET",
    data: options.data,
  });
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(
      `${options.method ?? "GET"} ${path} failed with ${response.status()}: ${body}`,
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${options.method ?? "GET"} ${path} returned invalid JSON`);
  }
}

async function attachFailureDiagnostics(
  request: APIRequestContext,
  testInfo: TestInfo,
): Promise<void> {
  const control = await safeJson(
    request,
    endpoint(
      CONTROL_URL,
      `/control/diagnostics${failureScheduleId ? `?scheduleId=${encodeURIComponent(failureScheduleId)}` : ""}`,
    ),
  );
  await testInfo.attach("control-diagnostics.json", {
    body: Buffer.from(JSON.stringify(control, null, 2)),
    contentType: "application/json",
  });

  if (!failureScheduleId) return;
  const product = {
    schedule: await safeJson(
      request,
      endpoint(API_URL, `/schedules/${failureScheduleId}`),
    ),
    runs: await safeJson(
      request,
      endpoint(API_URL, `/schedules/${failureScheduleId}/runs`),
    ),
    tasks: await safeJson(request, endpoint(API_URL, "/tasks")),
    audit: failureTaskId
      ? await safeJson(request, endpoint(API_URL, `/audit/tasks/${failureTaskId}`))
      : null,
  };
  await testInfo.attach("product-state.json", {
    body: Buffer.from(JSON.stringify(product, null, 2)),
    contentType: "application/json",
  });
}

async function safeJson(request: APIRequestContext, url: string): Promise<unknown> {
  try {
    const response = await request.get(url);
    const body = await response.text();
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      // Keep the raw non-secret response in diagnostics when it is not JSON.
    }
    return { status: response.status(), body: parsed };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function responseFailure(response: Response): Promise<string> {
  if (response.ok()) return "";
  return `${response.request().method()} ${response.url()} failed with ${response.status()}: ${await response.text()}`;
}

function requiredValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the scheduled-task E2E`);
  return value;
}

function requiredUrl(name: string): string {
  const value = requiredValue(name);
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ""), `${baseUrl}/`).toString();
}

function requiredDate(value: string | null, label: string): Date {
  if (value === null) throw new Error(`${label} is unexpectedly null`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is not ISO-8601`);
  return parsed;
}

function sameInstant(left: string, right: string): boolean {
  return requiredDate(left, "timestamp").getTime() === requiredDate(right, "timestamp").getTime();
}

function formatScheduleTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
