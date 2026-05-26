from __future__ import annotations

try:
    from app.config.storage import OSSConfig, get_oss_config  # type: ignore
except Exception:  # pragma: no cover
    import os
    from dataclasses import dataclass

    @dataclass(frozen=True)
    class OSSConfig:
        bucket: str = ""
        access_key_id: str = ""
        access_key_secret: str = ""
        endpoint: str = ""
        internal_endpoint: str | None = None
        cdn: str | None = None

    def get_oss_config(name: str = "default") -> OSSConfig:
        _ = name
        return OSSConfig(
            bucket=os.getenv("OSS_BUCKET", ""),
            access_key_id=os.getenv("OSS_ACCESS_KEY_ID", ""),
            access_key_secret=os.getenv("OSS_ACCESS_KEY_SECRET", ""),
            endpoint=os.getenv("OSS_ENDPOINT", ""),
            internal_endpoint=os.getenv("OSS_INTERNAL_ENDPOINT") or None,
            cdn=os.getenv("OSS_CDN") or None,
        )

from .client import AsyncOssClient, OssClient
from .exceptions import OssConfigError


def create_oss_client(
    name: str = "default",
    *,
    oss_path: str = "uploads/",
    use_internal_endpoint: bool = False,
) -> OssClient:
    """Create an OssClient from host-project config.

    Environment variables (default config):
    - `OSS_BUCKET`
    - `OSS_ACCESS_KEY_ID`
    - `OSS_ACCESS_KEY_SECRET`
    - `OSS_ENDPOINT` (public endpoint)
    - `OSS_INTERNAL_ENDPOINT` (optional; VPC/internal endpoint)
    - `OSS_CDN` (optional)
    """
    config = get_oss_config(name)
    _validate_oss_config(config, name=name)
    return OssClient(
        access_key_id=config.access_key_id,
        access_key_secret=config.access_key_secret,
        endpoint=config.endpoint,
        internal_endpoint=config.internal_endpoint,
        bucket=config.bucket,
        cdn=config.cdn,
        oss_path=oss_path,
        use_internal_endpoint=use_internal_endpoint,
    )


def create_async_oss_client(
    name: str = "default",
    *,
    oss_path: str = "uploads/",
    use_internal_endpoint: bool = False,
) -> AsyncOssClient:
    """Create an AsyncOssClient from host-project config."""
    return AsyncOssClient(
        create_oss_client(
            name,
            oss_path=oss_path,
            use_internal_endpoint=use_internal_endpoint,
        )
    )


def _validate_oss_config(config: OSSConfig, *, name: str) -> None:
    missing = []
    if not config.bucket:
        missing.append("bucket")
    if not config.access_key_id:
        missing.append("access_key_id")
    if not config.access_key_secret:
        missing.append("access_key_secret")
    if not config.endpoint:
        missing.append("endpoint")
    if missing:
        raise OssConfigError(f"OSS config `{name}` missing: {', '.join(missing)}")
