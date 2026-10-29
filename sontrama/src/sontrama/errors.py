"""Language-independent error identities with English diagnostic messages."""

from typing import Any

from pydantic import ValidationError


class ApplicationError(ValueError):
    def __init__(self, code: str, message: str, **params: Any):
        super().__init__(message)
        self.code = code
        self.params = params


class Diagnostic(str):
    """Keep text diagnostics compatible while exposing structured error metadata."""

    code: str
    params: dict[str, Any]

    def __new__(cls, code: str, message: str, **params: Any):
        instance = super().__new__(cls, message)
        instance.code = code
        instance.params = params
        return instance


def error_detail(error: Exception | str, code: str = "operation_failed") -> dict:
    if isinstance(error, ValidationError):
        return {"code": "validation_failed", "message": str(error), "params": {}}
    return {
        "code": getattr(error, "code", code),
        "message": str(error),
        "params": getattr(error, "params", {}),
    }
