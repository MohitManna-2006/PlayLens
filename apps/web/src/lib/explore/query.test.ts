import { describe, expect, it } from "vitest";
import { activeFilterCount, parseQuery, toSearch } from "./query";

describe("Explore URL state", () => {
  it("round-trips real-data filters through the URL", () => {
    const q = parseQuery(new URLSearchParams("week=3&formation=SHOTGUN&coverage=COVER_3_ZONE&down=2&page=2"));
    expect(q).toMatchObject({ week: 3, formation: "SHOTGUN", coverage: "COVER_3_ZONE", down: 2, page: 2, sort: "recent" });
    expect(activeFilterCount(q)).toBe(4);
    expect(parseQuery(new URLSearchParams(toSearch(q)))).toEqual(q);
  });

  it("ignores malformed numbers instead of guessing", () => {
    expect(parseQuery(new URLSearchParams("week=abc&down=1.5")).week).toBeUndefined();
  });
});
