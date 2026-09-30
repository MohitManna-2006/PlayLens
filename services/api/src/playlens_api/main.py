from fastapi import FastAPI

from playlens_api.api.routes import health

app = FastAPI(title="PlayLens API", version="0.1.0")

app.include_router(health.router, prefix="/api/v1")

@app.get("/")
def read_root() -> dict[str, str]:
    return {"message": "Welcome to PlayLens API"}
