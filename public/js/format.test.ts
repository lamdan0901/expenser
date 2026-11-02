// Unit tests for the pure frontend formatting helpers. These run in the same
// Cloudflare Workers pool as the API tests, so `format.js` must stay DOM-free.
import { fmtVND, monthISOBounds, parseK, prettyDate, ymLabel } from "./format.js";

describe("fmtVND", () => {
  it("groups thousands and appends the dong sign", () => {
    expect(fmtVND(500_000)).toBe("500,000 ₫");
    expect(fmtVND(15_000_000)).toBe("15,000,000 ₫");
  });
});

describe("parseK", () => {
  it("scales whole thousands to dong", () => {
    expect(parseK("500")).toBe(500_000);
  });

  it("rejects zero, fractions, text and empty input", () => {
    for (const value of ["0", "12.5", "abc", ""]) {
      expect(parseK(value)).toBeNull();
    }
  });

  it("mirrors the server's amount bounds", () => {
    expect(parseK("999999999")).toBe(999_999_999_000);
    expect(parseK("1000000000")).toBeNull();
    expect(parseK("-5")).toBeNull();
  });
});

describe("monthISOBounds", () => {
  it("brackets a 30-day month", () => {
    expect(monthISOBounds("2026-11")).toEqual({ min: "2026-11-01", max: "2026-11-30" });
  });

  it("ends February on the 29th in a leap year", () => {
    expect(monthISOBounds("2024-02")).toEqual({ min: "2024-02-01", max: "2024-02-29" });
  });
});

describe("ymLabel", () => {
  it("spells out the month and year", () => {
    expect(ymLabel("2026-11")).toBe("November 2026");
  });
});

describe("prettyDate", () => {
  it("spells out a full ISO day", () => {
    expect(prettyDate("2026-11-15")).toBe("November 15, 2026");
  });
});
