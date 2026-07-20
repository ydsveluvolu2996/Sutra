"""Sutra Public API v1 client (stdlib-only)."""

from .client import (
    ENDPOINTS,
    Endpoint,
    SutraApiError,
    SutraAuthError,
    SutraBadRequestError,
    SutraClient,
    SutraRateLimitError,
    SutraScopeError,
)

__all__ = [
    "SutraClient",
    "SutraApiError",
    "SutraAuthError",
    "SutraScopeError",
    "SutraBadRequestError",
    "SutraRateLimitError",
    "Endpoint",
    "ENDPOINTS",
]

__version__ = "1.0.0"
