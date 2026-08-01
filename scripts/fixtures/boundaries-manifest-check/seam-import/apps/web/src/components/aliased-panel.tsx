import { listTasks } from "@/lib/api/real";
import type { TaskRow } from "@/lib/api/real";

export function AliasedPanel(row: TaskRow) {
  return listTasks().then(() => row.id);
}
