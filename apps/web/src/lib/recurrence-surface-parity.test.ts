import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SURFACES = [
  {
    name: "NewTaskDialog",
    path: new URL(
      "../components/dashboard/new-task-dialog.tsx",
      import.meta.url,
    ),
  },
  {
    name: "/tasks/new",
    path: new URL("../routes/_app/tasks/new.tsx", import.meta.url),
  },
] as const;

describe("recurring-task surface parity", () => {
  it.each(SURFACES)(
    "$name adopts the shared fields and timezone lifecycle without free text",
    ({ path }) => {
      const source = readFileSync(path, "utf8");
      expect(source.match(/<RecurrenceFields\b/g)).toHaveLength(1);
      expect(source).toContain("timezoneOptions={timezoneOptions}");
      expect(source).toContain("detectBrowserScheduleTimezone");
      expect(source).toContain("resolveHydratedScheduleTimezone");
      expect(source).toContain("timezoneDirtyRef.current = true");
      expect(source).not.toMatch(/id=["{]?(?:modal)?Timezone/);
      expect(source).not.toMatch(/placeholder="UTC"/);
    },
  );
});
