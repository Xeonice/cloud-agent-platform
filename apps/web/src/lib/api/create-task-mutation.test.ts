import { describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import type { ListTasksResponse, TaskResponse } from "@cap/contracts";

import {
  createTaskMutation,
  upsertAcceptedTask,
  type CreateTaskVars,
} from "./mutations";
import { queryKeys } from "./queries";

type Spy = ReturnType<typeof vi.fn>;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function taskFixture(n: number, prompt = "accepted task"): TaskResponse {
  return {
    id: uuid(n),
    repoId: uuid(100),
    prompt,
    status: "pending",
    createdAt: new Date(`2026-07-16T00:00:0${n}.000Z`),
    branch: null,
    provisioning: {
      state: "accepted",
      stage: "accepted",
      attempt: 0,
      resolvedBranch: null,
      updatedAt: new Date(`2026-07-16T00:00:0${n}.000Z`),
    },
  };
}

function queryClientStub() {
  return {
    setQueryData: vi.fn(),
    // Never resolves: create success must still finish synchronously.
    invalidateQueries: vi.fn(() => new Promise<void>(() => undefined)),
  } as unknown as QueryClient & { setQueryData: Spy; invalidateQueries: Spy };
}

describe("createTaskMutation durable-acceptance handoff", () => {
  it("seeds exact detail/list recovery before fire-and-forget list invalidation", () => {
    const client = queryClientStub();
    const task = taskFixture(1);
    const variables: CreateTaskVars = {
      repoId: task.repoId,
      body: { prompt: task.prompt },
    };
    const options = createTaskMutation(client);

    const result = options.onSuccess?.(task, variables, undefined, {} as never);

    expect(result).toBeUndefined();
    expect(client.setQueryData).toHaveBeenNthCalledWith(
      1,
      queryKeys.task(task.id),
      task,
    );
    expect(client.setQueryData).toHaveBeenNthCalledWith(
      2,
      queryKeys.tasks,
      expect.any(Function),
    );
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.tasks,
      exact: true,
    });
    expect(client.setQueryData.mock.invocationCallOrder[1]).toBeLessThan(
      client.invalidateQueries.mock.invocationCallOrder[0]!,
    );

    const updateList = client.setQueryData.mock.calls[1]?.[1] as
      | ((current: ListTasksResponse | undefined) => ListTasksResponse | undefined)
      | undefined;
    const older = taskFixture(2, "older task");
    expect(updateList?.([older])).toEqual([task, older]);
    expect(updateList?.([older, task])).toEqual([task, older]);
    expect(updateList?.(undefined)).toBeUndefined();
  });

  it("upserts a replayed acceptance idempotently without changing the source list", () => {
    const prior = taskFixture(1, "prior projection");
    const accepted = taskFixture(1, "fresh committed projection");
    const other = taskFixture(2);
    const current = [other, prior];

    expect(upsertAcceptedTask(current, accepted)).toEqual([accepted, other]);
    expect(current).toEqual([other, prior]);
  });

  it("leaves creating at the committed response while provisioning stays accepted and reconciliation never settles", async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const task = taskFixture(3);
    const variables: CreateTaskVars = {
      repoId: task.repoId,
      body: { prompt: task.prompt },
    };
    vi.spyOn(client, "invalidateQueries").mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const observer = new MutationObserver(client, {
      ...createTaskMutation(client),
      mutationFn: async () => task,
    });

    const resultPromise = observer.mutate(variables);
    expect(observer.getCurrentResult().isPending).toBe(true);
    await expect(resultPromise).resolves.toBe(task);
    expect(observer.getCurrentResult().isSuccess).toBe(true);
    expect(observer.getCurrentResult().data?.provisioning).toMatchObject({
      state: "accepted",
      stage: "accepted",
    });
    expect(client.getQueryData(queryKeys.task(task.id))).toBe(task);
  });
});
