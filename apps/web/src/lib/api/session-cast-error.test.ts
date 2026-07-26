import { describe, expect, it } from "vitest";

import {
  ApiError,
  sessionCastUnavailableReasonFromApiError,
} from "./real";

describe("session cast safe error states", () => {
  it("distinguishes disabled, oversized, and unavailable artifacts", () => {
    expect(
      sessionCastUnavailableReasonFromApiError(
        new ApiError(503, "disabled", {
          code: "terminal_raw_recording_disabled",
        }),
      ),
    ).toBe("disabled");
    expect(
      sessionCastUnavailableReasonFromApiError(
        new ApiError(413, "too large", {
          code: "terminal_raw_recording_too_large",
        }),
      ),
    ).toBe("too_large");
    expect(
      sessionCastUnavailableReasonFromApiError(
        new ApiError(503, "unavailable", {
          code: "terminal_raw_recording_unavailable",
        }),
      ),
    ).toBe("unavailable");
  });

  it("does not turn unrelated transport failures into a no-recording state", () => {
    expect(
      sessionCastUnavailableReasonFromApiError(
        new ApiError(503, "other", { code: "other_failure" }),
      ),
    ).toBeNull();
    expect(sessionCastUnavailableReasonFromApiError(new Error("network"))).toBeNull();
  });
});
