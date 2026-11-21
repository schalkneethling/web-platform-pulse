import { describe, expect, it } from "vite-plus/test";
import { formatUtcDate } from "./dates.ts";

describe("formatUtcDate", () => {
  it("writes the long British date of the UTC day", () => {
    expect(formatUtcDate("2026-06-14T06:00:00.000Z")).toBe("14 June 2026");
  });

  it("names the UTC day, not the reader's, around midnight", () => {
    // Late on the 14th in UTC is already the 15th in Auckland and still the
    // 14th in Honolulu; the answer must not depend on where this runs.
    expect(formatUtcDate("2026-06-14T23:59:59.000Z")).toBe("14 June 2026");
    expect(formatUtcDate("2026-06-15T00:00:00.000Z")).toBe("15 June 2026");
  });

  it("accepts the offset form PostgREST returns", () => {
    expect(formatUtcDate("2026-06-14T00:30:00+00:00")).toBe("14 June 2026");
    expect(formatUtcDate("2026-06-14T00:30:00+02:00")).toBe("13 June 2026");
  });
});
