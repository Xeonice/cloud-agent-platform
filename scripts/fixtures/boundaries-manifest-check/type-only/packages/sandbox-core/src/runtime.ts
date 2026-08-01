import { taskStatusSchema } from "@cap-console/contracts";

export function parseStatus(input: unknown) {
  return taskStatusSchema.parse(input);
}
