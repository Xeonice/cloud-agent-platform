import { fetchTaskStream } from "../lib/api/real";

export function StreamPanel() {
  return fetchTaskStream();
}
