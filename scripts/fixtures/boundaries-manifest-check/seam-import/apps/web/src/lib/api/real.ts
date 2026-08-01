export class ApiError extends Error {}

export type TaskRow = { id: string };

export async function fetchTaskStream() {
  const res = await fetch("https://example.invalid/tasks/stream");
  return res.body;
}
