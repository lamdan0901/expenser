import {
  currentYm,
  dateInYm,
  isYm,
  kIntoVnd,
  nextTopPosition,
  ymBounds,
} from "../src/month-utils";

describe("isYm", () => {
  it("accepts zero-padded year-month strings", () => {
    expect(isYm("2026-01")).toBe(true);
    expect(isYm("2026-12")).toBe(true);
  });

  it("rejects malformed or out-of-range months", () => {
    for (const value of ["2026-00", "2026-13", "2026-1", "26-11", "2026-11-01", ""]) {
      expect(isYm(value)).toBe(false);
    }
  });
});

describe("ymBounds", () => {
  it("brackets a 30-day month", () => {
    expect(ymBounds("2026-11")).toEqual({ min: "2026-11-01", max: "2026-11-30" });
  });

  it("ends February on the 28th in a common year", () => {
    expect(ymBounds("2026-02").max).toBe("2026-02-28");
  });

  it("ends February on the 29th in a leap year", () => {
    expect(ymBounds("2024-02").max).toBe("2024-02-29");
  });

  it("handles December without rolling into the next year", () => {
    expect(ymBounds("2026-12")).toEqual({ min: "2026-12-01", max: "2026-12-31" });
  });
});

describe("dateInYm", () => {
  it("rejects a date from another month", () => {
    expect(dateInYm("2026-10-28", "2026-11")).toBe(false);
  });

  it("accepts dates inside the month", () => {
    expect(dateInYm("2026-11-01", "2026-11")).toBe(true);
    expect(dateInYm("2026-11-30", "2026-11")).toBe(true);
  });

  it("rejects another year and non-ISO dates", () => {
    expect(dateInYm("2025-11-30", "2026-11")).toBe(false);
    expect(dateInYm("2026-11-3", "2026-11")).toBe(false);
  });
});

describe("currentYm", () => {
  it("formats the UTC month with a two-digit number", () => {
    expect(currentYm(new Date(Date.UTC(2026, 10, 2)))).toBe("2026-11");
    expect(currentYm(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01");
  });
});

describe("kIntoVnd", () => {
  it("converts whole thousands to dong", () => {
    expect(kIntoVnd(500)).toBe(500_000);
  });

  it("rejects zero, negative, fractional and out-of-range input", () => {
    expect(kIntoVnd(0)).toBeNull();
    expect(kIntoVnd(-1)).toBeNull();
    expect(kIntoVnd(12.5)).toBeNull();
    expect(kIntoVnd(1e9)).toBeNull();
  });
});

describe("nextTopPosition", () => {
  it("starts at 1 for an empty list", () => {
    expect(nextTopPosition([])).toBe(1);
  });

  it("places the next row above the highest existing position", () => {
    expect(nextTopPosition([{ position: 1 }, { position: 5 }, { position: 3 }])).toBe(6);
  });
});
