import { Button } from "@cap-console/ui";
import { listTasks } from "../lib/api/real";

export function TaskList() {
  const refresh = () => void listTasks();
  return Button(refresh);
}
