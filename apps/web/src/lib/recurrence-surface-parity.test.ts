import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SURFACES = [
  {
    name: "NewTaskDialog",
    path: new URL(
      "../components/dashboard/new-task-dialog.tsx",
      import.meta.url,
    ),
  },
  {
    name: "/tasks/new",
    path: new URL("../routes/_app/tasks/new.tsx", import.meta.url),
  },
] as const;

describe("recurring-task surface parity", () => {
  it.each(SURFACES)(
    "$name adopts the shared fields and timezone lifecycle without free text",
    ({ path }) => {
      const source = readFileSync(path, "utf8");
      expect(source.match(/<RecurrenceFields\b/g)).toHaveLength(1);
      expect(source).toContain("timezoneOptions={timezoneOptions}");
      expect(source).toContain("detectBrowserScheduleTimezone");
      expect(source).toContain("resolveHydratedScheduleTimezone");
      expect(source).toContain("timezoneDirtyRef.current = true");
      expect(source).not.toMatch(/id=["{]?(?:modal)?Timezone/);
      expect(source).not.toMatch(/placeholder="UTC"/);
    },
  );

  it.each(SURFACES)(
    "$name uses the shared verified-branch projection without a main fallback",
    ({ path }) => {
      const source = readFileSync(path, "utf8");
      expect(source).toContain(
        "taskBranchFormValue(selectedRepo?.defaultBranch)",
      );
      expect(source).toContain("taskBranchOptions(defaultBranch, branch)");
      expect(source).toContain("buildTaskRequest(taskForm)");
      expect(source).not.toMatch(/defaultBranch\s*\?\?\s*["']main["']/);
      expect(source).not.toMatch(/form\.branch\s*\|\|\s*["']main["']/);
    },
  );

  it.each(SURFACES)(
    "$name records acceptance before navigation and uses the synchronous create fence",
    ({ name, path }) => {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("useMutation(createTaskMutation(queryClient))");
      expect(source).toContain("claimTaskCreateSubmission");
      expect(source).toContain("releaseRejectedTaskCreate");
      expect(source).toContain("createdTaskId !== null");
      expect(source).toContain("latestRunId: task.id");
      expect(source).toContain("selectedBranch: body.branch ?? null");
      expect(source).toContain('toast.success("任务已进入远端 Agent 队列"');
      expect(source.indexOf("setCreatedTaskId(task.id)")).toBeLessThan(
        source.indexOf('to: "/tasks/$taskId"'),
      );
      const callbackStart = source.indexOf("onSuccess: (task) => {");
      const callbackEnd = source.indexOf("onError:", callbackStart);
      const acceptedCallback = source.slice(callbackStart, callbackEnd);
      expect(callbackStart).toBeGreaterThan(-1);
      expect(callbackEnd).toBeGreaterThan(callbackStart);
      expect(acceptedCallback).toContain("openCreatedTask();");
      expect(acceptedCallback).not.toContain("await ");
      if (name === "NewTaskDialog") {
        expect(acceptedCallback.indexOf("onOpenChange(false)")).toBeLessThan(
          acceptedCallback.indexOf("openCreatedTask();"),
        );
      }
    },
  );
});
