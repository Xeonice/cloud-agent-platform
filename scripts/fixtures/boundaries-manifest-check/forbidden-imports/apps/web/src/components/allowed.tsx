import { Button } from "@cap-console/ui";
import { formatTask } from "../lib/format";

// A specifier that only mentions a forbidden package inside a string or a
// comment is not an import: "@cap-console/api" stays a string here.
export const specifierName = "@cap-console/api";

export function Panel() {
  return Button(formatTask());
}
