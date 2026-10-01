# ADR-0001: Synthetic fixture data source for the web app

Date: 2026-09-30

> **Status (Phase 2):** The revisit trigger for the default was met. The web app now defaults to `api`, served from real NFL tracking data; the fixture runs only with `NEXT_PUBLIC_PLAYLENS_DATA_SOURCE=fixture` and never as a fallback. The API base URL variable is now `NEXT_PUBLIC_PLAYLENS_API_BASE_URL`. See ADR-0002.

## Context

The design bible (`docs/PLAYLENS_DESIGN_BIBLE.md`) was implemented before the ingestion pipeline, FastAPI service, and trained models exist. The bible forbids presenting mock data or unimplemented features as live product evidence and says a capability appears as available only when its backing data or service exists. The Masterbrain (§36) allows mock adapters early, provided they are replaced by real model outputs before a feature is considered complete.

## Decision

The web app reads through one typed client (`apps/web/src/lib/datasource`) with two interchangeable sources, selected by `NEXT_PUBLIC_PLAYLENS_DATA_SOURCE`:

- `api`: the FastAPI service at `NEXT_PUBLIC_API_URL`, using the `/api/v1` endpoints in Masterbrain §21.1 plus the Analyst endpoints listed in `apps/web/README.md`.
- `fixture` (default): an in-browser implementation of the same contract over 120 procedurally simulated plays.

Both sources return raw JSON that is parsed by the same zod schemas (`src/lib/contracts.ts`), so the fixture cannot drift from the contract.

Fixture limits:

- Tracking is synthetic. Teams are "Team A" to "Team F", players have no names, and the navigation shows "Synthetic fixture data" on every page.
- Trajectory forecasts come from `cv-baseline-0`, a real constant-velocity baseline, with sampled futures from an explicitly assumed velocity noise. Samples are labeled nominal and uncalibrated.
- Similarity comes from `descriptor-baseline-0`, a handcrafted formation descriptor with exact cosine search. It is labeled as a baseline, not a learned embedding.
- PlayLab uses `mock-rule-0`, a labeled development mock. It is never evaluated.
- Evaluation shows "Pending evaluation" or "Unavailable" for every fixture model. The fixture computes no metrics on synthetic data.
- The Analyst runs deterministic PlayLens tools for a few explicit requests, such as separation evidence, similar plays, structural comparison, and "jump to the throw". It writes no AI interpretation text. With no language model connected, free-form questions return a service notice.

## Alternatives considered

- **Empty states only until the API exists.** This is faithful to the bible, but none of the Play, Compare, PlayLab, or Analyst interactions could be built or reviewed.
- **Fixture served from a Next.js route handler.** This adds a network hop and a server runtime, and it validates nothing that the shared schema parse does not already cover.
- **Invented evaluation numbers for layout review.** Rejected, because Masterbrain §48 and bible §11 forbid it. The chart and table code paths render real report payloads from the API.

## Consequences

- Every screen and state in the bible can be exercised today, and labels identify the fixture wherever its data appears.
- The FastAPI service must implement the contract in `src/lib/contracts.ts`. Any response that fails validation shows as a contract error, not partial data.
- The fixture models ship in the client bundle. Remove them, or tree-shake them behind the flag, once the API is the default.

## Revisit trigger

Switch the default to `api` once ingestion, `/api/v1/plays`, and a served trajectory model exist. Delete `mock-rule-0` once PlayLab has a served counterfactual model.
