# PlayLens contracts

Shared, generated artifacts for the web ⇄ API boundary (Masterbrain §52, C01).

| File | What it is |
|---|---|
| `openapi.json` | OpenAPI document of the FastAPI service (`/health`, `/api/v1/*`). |
| `examples/*.json` | Real responses from the API code serving a tiny **synthetic** dataset (`playlens_ml.data.testing`). No NFL data is committed. The similarity and compare examples (`similar-plays*.json`, `compare.json`) run the real search and compare services over the in-memory reference store with deterministic, well-separated vectors, so their ranking is stable across machines; the served store is PostgreSQL + pgvector with the same contract. |

Regenerate after changing a Pydantic response model:

```bash
pnpm contracts:generate   # uv run python -m playlens_api.contract_examples
```

Two tests keep the contract honest:

- `services/api/tests/test_contract_examples.py` fails when these files differ from what the API code produces.
- `apps/web/src/lib/datasource/contract.test.ts` parses every example with the zod schemas in `apps/web/src/lib/contracts.ts` and fails if a field is missing, mistyped, or would be silently dropped.
