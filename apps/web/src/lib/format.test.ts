import { describe, expect, it } from "vitest";
import { codeLabel, cosine, DASH, downDistance, elapsed, fixed, ms, outcome, passResult, playResult, quarterClock, signed, tokenLabel, yards } from "./format";

describe("numeric formatting (§13)", () => {
  it("uses the bible's precision per quantity", () => {
    expect(yards(3.456)).toBe("3.5 yd");
    expect(fixed(1.2345, 2)).toBe("1.23");
    expect(cosine(0.87349)).toBe("0.873");
    expect(ms(12.345)).toBe("12.3 ms");
  });

  it("renders missing values as an em dash, never zero", () => {
    expect(yards(null)).toBe(DASH);
    expect(fixed(NaN, 1)).toBe(DASH);
    expect(cosine(undefined)).toBe(DASH);
  });

  it("uses a true minus sign and no negative zero", () => {
    expect(signed(-1.26, 1)).toBe("−1.3");
    expect(signed(0.01, 1)).toBe("0.0");
    expect(fixed(-0.001, 2)).toBe("0.00");
    expect(elapsed(-0.8)).toBe("−0.8 s");
    expect(elapsed(1.4)).toBe("+1.4 s");
  });

  it("formats game context", () => {
    expect(downDistance({ down: 3, yards_to_go: 7 })).toBe("3rd & 7");
    expect(downDistance({ down: null, yards_to_go: 7 })).toBeNull();
    expect(quarterClock({ quarter: 2, game_clock: "06:18" })).toBe("Q2 06:18");
    expect(outcome(12)).toBe("+12 yd");
    expect(outcome(null)).toBeNull();
  });
});

describe("dataset labels", () => {
  it("formats supplied codes without inventing meaning", () => {
    expect(codeLabel("COVER_3_ZONE")).toBe("Cover 3 zone");
    expect(codeLabel("SHOTGUN")).toBe("Shotgun");
    expect(codeLabel("3x1")).toBe("3x1");
    expect(codeLabel(null)).toBeNull();
    expect(passResult("IN")).toBe("Intercepted");
    expect(passResult("R")).toBe("R");
  });

  it("shows yards only for completions and handles missing outcomes", () => {
    expect(playResult({ pass_result: "C", yards_gained: 18 })).toBe("Complete · +18 yd");
    expect(playResult({ pass_result: "I", yards_gained: 0 })).toBe("Incomplete");
    expect(playResult({ pass_result: null, yards_gained: -3 })).toBe("−3 yd");
    expect(playResult({ pass_result: null, yards_gained: null })).toBeNull();
  });

  it("labels tokens by jersey, falling back to position", () => {
    expect(tokenLabel({ jersey: "12", position: "QB" })).toBe("12");
    expect(tokenLabel({ jersey: null, position: "CB" })).toBe("CB");
    expect(tokenLabel({ jersey: null, position: null })).toBeNull();
  });
});
