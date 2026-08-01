import { ApiError } from "../lib/api/real";
import type { TaskRow } from "../lib/api/real";
import { useCapability } from "../lib/api/capabilities";

export function Classified(row: TaskRow) {
  const query = useCapability();
  return query.isError ? ApiError.name : row.id;
}
