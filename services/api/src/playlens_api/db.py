from typing import Any

from sqlalchemy import create_engine

from playlens_api.config import settings

# simple synchronous engine for health check
try:
    engine: Any = create_engine(settings.database_url)
except Exception:
    engine = None
