_DEFAULT_ENVIRONMENT = "dev"
_environment: str | None = None


def get_environment() -> str:
    if _environment is not None:
        return _environment
    import os
    return os.environ.get("AGENTEYE_ENVIRONMENT") or _DEFAULT_ENVIRONMENT


def set_environment(env: str | None) -> None:
    global _environment
    _environment = env if env else None
