"""Typed API errors and the handlers that render them as ``ErrorEnvelope``.

User errors (4xx) and server/data errors (5xx) stay distinct so the web app can
show the right recovery action.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .schemas.common import ErrorBody, ErrorEnvelope

log = logging.getLogger("playlens.api.errors")


class ApiError(Exception):
    status = 500
    code = "internal_error"

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class PlayNotFound(ApiError):
    status = 404
    code = "play_not_found"


class InvalidPlayId(ApiError):
    status = 422
    code = "invalid_play_id"


class InvalidQuery(ApiError):
    status = 422
    code = "invalid_query"


class CapabilityUnavailable(ApiError):
    status = 422
    code = "capability_unavailable"


class DatasetUnavailable(ApiError):
    status = 503
    code = "dataset_unavailable"


def _request_id(request: Request) -> str | None:
    value = getattr(request.state, "request_id", None)
    return value if isinstance(value, str) else None


def envelope(
    request: Request,
    status: int,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    body = ErrorEnvelope(
        error=ErrorBody(
            code=code,
            message=message,
            status=status,
            request_id=_request_id(request),
            details=details,
        )
    )
    return JSONResponse(status_code=status, content=body.model_dump(mode="json"))


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        if exc.status >= 500:
            log.error("api_error code=%s message=%s", exc.code, exc.message)
        return envelope(request, exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        code = "not_found" if exc.status_code == 404 else "http_error"
        message = (
            f"No route for {request.method} {request.url.path}."
            if exc.status_code == 404
            else str(exc.detail)
        )
        return envelope(request, exc.status_code, code, message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        problems = [
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
        ]
        return envelope(
            request,
            422,
            "invalid_request",
            "; ".join(problems) or "Invalid request.",
            {
                "errors": [
                    {"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()
                ]
            },
        )

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled_error path=%s", request.url.path)
        return envelope(
            request,
            500,
            "internal_error",
            "Unexpected server error. See API logs for the request ID.",
        )
