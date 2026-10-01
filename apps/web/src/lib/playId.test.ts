import { describe, expect, it } from "vitest";
import { formatPlayId, parsePlayId } from "./playId";

describe("PlayLens play IDs", () => {
  it("round-trips the natural key", () => {
    expect(formatPlayId(2023090700, 101)).toBe("2023090700-101");
    expect(parsePlayId("2023090700-101")).toEqual({ gameId: 2023090700, playId: 101 });
  });

  it("rejects values that are not <game_id>-<play_id>", () => {
    for (const bad of ["101", "2023090700_101", "2023090700-", "-101", "a-1", "1-2-3", " 1-2", "", "fx09-003"]) {
      expect(parsePlayId(bad)).toBeNull();
    }
    expect(() => formatPlayId(-1, 2)).toThrow();
    expect(() => formatPlayId(1.5, 2)).toThrow();
  });

  it("matches the backend format for URL use", () => {
    const id = formatPlayId(2023091008, 3826);
    expect(encodeURIComponent(id)).toBe(id);
  });
});
