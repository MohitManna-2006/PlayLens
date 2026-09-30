from typing import Any

import redis
from fastapi import APIRouter
from sqlalchemy import text

from playlens_api.config import settings
from playlens_api.db import engine

router = APIRouter()

@router.get("/health")
def health_check() -> dict[str, Any]:
    db_status = "unavailable"
    if engine:
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            db_status = "ok"
        except Exception:
            pass

    redis_status = "unavailable"
    try:
        r = redis.from_url(settings.redis_url)
        if r.ping():
            redis_status = "ok"
    except Exception:
        pass

    return {
        "status": "ok" if db_status == "ok" and redis_status == "ok" else "degraded",
        "service": "playlens-api",
        "version": "0.1.0",
        "dependencies": {
            "database": db_status,
            "redis": redis_status
        }
    }
