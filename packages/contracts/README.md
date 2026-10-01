# PlayLens contracts

Shared, generated artifacts for the web ⇄ API boundary (Masterbrain §52, C01).

| File | What it is |
|---|---|
| `openapi.json` | OpenAPI document of the FastAPI service (`/health`, `/api/v1/*`). |
| `examples/*.json` | Real responses from the API code serving a tiny **synthetic** dataset (`playlens_ml.data.testing`). No NFL data is committed. |

Regenerate after changing a Pydantic response model:

```bash
pnpm contracts:generate   # uv run python -m playlens_api.contract_examples
```

Two tests keep the contract honest:

- `services/api/tests/test_contract_examples.py` fails when these files differ from what the API code produces.
- `apps/web/src/lib/datasource/contract.test.ts` parses every example with the zod schemas in `apps/web/src/lib/contracts.ts` and fails if a field is missing, mistyped, or would be silently dropped.
