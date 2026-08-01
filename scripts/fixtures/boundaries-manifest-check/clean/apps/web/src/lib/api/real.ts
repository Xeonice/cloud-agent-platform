import type { TaskStatus } from "@cap-console/contracts";

export async function listTasks(): Promise<TaskStatus[]> {
  const res = await fetch("https://example.invalid/tasks");
  return res.json();
}
