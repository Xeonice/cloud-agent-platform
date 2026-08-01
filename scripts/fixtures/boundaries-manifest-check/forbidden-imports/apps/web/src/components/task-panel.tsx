import { TasksService } from "@cap-console/api";

export function taskPanelLabel(): string {
  return TasksService.name;
}
