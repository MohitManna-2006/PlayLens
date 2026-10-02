// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, SimilaritySearchResponseSchema, type SimilarityRequest, type SimilaritySearchResponse } from "@/lib/contracts";

const findSimilar = vi.fn<(req: SimilarityRequest, signal?: AbortSignal) => Promise<SimilaritySearchResponse>>();

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/datasource", async (original) => ({
  ...(await original<typeof import("@/lib/datasource")>()),
  getClient: () => ({ findSimilar }),
}));

const { SimilarPlays } = await import("./SimilarPlays");

// Generous waits so a loaded CI machine does not turn timing into failures.
configure({ asyncUtilTimeout: 5000 });

// Paths are resolved from the web package root (where vitest runs); a
// `new URL(..., import.meta.url)` would be rewritten as an asset in the jsdom build.
const EXAMPLES = join(process.cwd(), "..", "..", "packages", "contracts", "examples");
const load = (name: string) => SimilaritySearchResponseSchema.parse(JSON.parse(readFileSync(join(EXAMPLES, name), "utf8")));
const results = load("similar-plays.json");
const empty = load("similar-plays-empty.json");
const QUERY_ID = results.query.play_id;
const query = { ...results.results[0].play, id: QUERY_ID };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SimilarPlays playId={QUERY_ID} query={query} />
    </QueryClientProvider>,
  );
}

const request = () => fireEvent.click(screen.getByRole("button", { name: "Find similar plays" }));

// A block body: a function returned from beforeEach would run as a teardown hook.
beforeEach(() => {
  findSimilar.mockReset();
});
afterEach(cleanup);

describe("Similar plays", () => {
  it("waits for a request, shows a stable loading state, then ranked real results", async () => {
    const d = deferred<SimilaritySearchResponse>();
    findSimilar.mockReturnValueOnce(d.promise);
    renderPanel();
    expect(findSimilar).not.toHaveBeenCalled();
    request();
    expect(await screen.findByRole("list", { name: "Loading similar plays" })).toBeTruthy();
    expect(findSimilar).toHaveBeenCalledWith({ play_id: QUERY_ID, k: 10, mode: "approximate", filters: {} }, expect.anything());
    d.resolve(results);
    const list = await screen.findByRole("list", { name: "Similar plays, ranked" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(results.results.length);
    const first = results.results[0];
    expect(within(rows[0]).getByLabelText("Rank 1").textContent).toBe("#1");
    expect(within(rows[0]).getByText(`cos ${first.cosine_similarity.toFixed(3)}`)).toBeTruthy();
    expect(within(rows[0]).getByText("Same down")).toBeTruthy();
    expect(within(rows[0]).getByRole("link", { name: "Compare" }).getAttribute("href")).toBe(
      `/compare?left=${encodeURIComponent(QUERY_ID)}&right=${encodeURIComponent(first.play_id)}`,
    );
    expect(within(rows[0]).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      `/play/${encodeURIComponent(first.play_id)}?similar_to=${encodeURIComponent(QUERY_ID)}`,
    );
    // Never a percentage or probability.
    expect(document.body.textContent).not.toMatch(/\d+(\.\d+)?%/);
    expect(document.body.textContent).toMatch(/not a probability/);
  });

  it("reruns the database query when a filter changes, and clears filters", async () => {
    findSimilar.mockResolvedValue(results);
    renderPanel();
    request();
    await screen.findByRole("list", { name: "Similar plays, ranked" });
    const chip = screen.getByRole("button", { name: /Same down/ });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(findSimilar).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { down: query.down } }), expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: /Distance/ }));
    await waitFor(() =>
      expect(findSimilar).toHaveBeenLastCalledWith(
        expect.objectContaining({ filters: { down: query.down, yards_to_go_min: Math.max(1, query.yards_to_go! - 2), yards_to_go_max: query.yards_to_go! + 2 } }),
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Same down/ }).getAttribute("aria-pressed")).toBe("false"));
  });

  it("switches between the HNSW index and exact search", async () => {
    findSimilar.mockResolvedValue(results);
    renderPanel();
    request();
    await screen.findByRole("list", { name: "Similar plays, ranked" });
    fireEvent.click(screen.getByRole("radio", { name: "Exact scan" }));
    await waitFor(() => expect(findSimilar).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "exact" }), expect.anything()));
  });

  it("explains an empty filtered result and offers to broaden it", async () => {
    findSimilar.mockResolvedValueOnce(results).mockResolvedValue(empty);
    renderPanel();
    request();
    await screen.findByRole("list", { name: "Similar plays, ranked" });
    fireEvent.click(screen.getByRole("button", { name: /Same down/ }));
    expect(await screen.findByText("No similar plays matched these filters.")).toBeTruthy();
    expect(screen.getByText(/Try broadening the filters/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Clear filters" }).length).toBeGreaterThan(0);
  });

  it("shows retrieval as temporarily unavailable and retries on request", async () => {
    findSimilar
      .mockRejectedValueOnce(new ApiError("No database connection within 2 s.", 503, "server", "database_unavailable"))
      .mockResolvedValueOnce(results);
    renderPanel();
    request();
    expect(await screen.findByText("Similar-play retrieval is temporarily unavailable.")).toBeTruthy();
    expect(screen.getByText(/No database connection/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Similar plays, ranked" })).toBeTruthy();
    expect(findSimilar).toHaveBeenCalledTimes(2);
  });

  it("says when the play has no embedding and does not substitute anything", async () => {
    findSimilar.mockRejectedValue(new ApiError("Play x has no stored embedding.", 404, "user", "embedding_unavailable"));
    renderPanel();
    request();
    expect(await screen.findByText("No embedding for this play")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Similar plays, ranked" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("reports other failures as errors with Retry", async () => {
    findSimilar.mockRejectedValue(new ApiError("The similar plays response did not match the expected contract.", null, "contract"));
    renderPanel();
    request();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Similarity search failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
