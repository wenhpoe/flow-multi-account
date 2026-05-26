"""Aliyun OSS toolkit.

This module provides a minimal, reusable OSS wrapper based on `oss2`.

Key design points:
- Lazy-import `oss2` so the rest of the project can import this module even
  when `oss2` is not installed in some environments.
- Provide a small/regular upload API plus a multipart upload API for large files.
- Build public URLs using CDN (if configured) or the public OSS endpoint.

Environment configuration helpers should be provided by the host project.
Prefer wrapping `create_oss_client()` from this package in your own env/config
loader instead of hard-coding project-specific paths here.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Dict, Optional, Protocol, Union, cast
from urllib.parse import quote

try:
    from app.core.logging import get_app_logger  # type: ignore
except Exception:  # pragma: no cover
    import logging
    from typing import Any

    class _FallbackLogger:
        def __init__(self, logger: logging.Logger) -> None:
            self._logger = logger

        def bind(self, **_: Any) -> "_FallbackLogger":
            return self

        def exception(self, msg: str, *_: Any, **__: Any) -> None:
            self._logger.exception(msg)

        def info(self, msg: str, *_: Any, **__: Any) -> None:
            self._logger.info(msg)

        def warning(self, msg: str, *_: Any, **__: Any) -> None:
            self._logger.warning(msg)

    def get_app_logger() -> _FallbackLogger:
        return _FallbackLogger(logging.getLogger("oss_toolkit"))

from .exceptions import OssDependencyMissingError, OssToolkitError, OssUploadError


class _BucketProtocol(Protocol):
    def put_object_from_file(self, key: str, filename: str, headers: Dict[str, str]) -> object: ...

    def get_object(self, key: str) -> object: ...

    def init_multipart_upload(self, key: str) -> object: ...

    def upload_part(self, key: str, upload_id: str, part_number: int, data: bytes) -> object: ...

    def complete_multipart_upload(self, key: str, upload_id: str, parts: list[object]) -> object: ...


PathLike = Union[str, Path]


def _import_oss2():
    try:
        import oss2  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise OssDependencyMissingError(
            "Missing dependency `oss2`. Install it via `pip install oss2`."
        ) from exc
    except Exception as exc:  # pragma: no cover
        raise OssDependencyMissingError(
            "Failed to import `oss2` due to environment dependency issues "
            "(commonly OpenSSL/pyOpenSSL/cryptography mismatch). "
            "Try upgrading `pyOpenSSL` and `cryptography`, or pinning a compatible version set."
        ) from exc
    return oss2


class OssClient:
    """A minimal wrapper for uploading files to Aliyun OSS."""

    def __init__(
        self,
        *,
        access_key_id: str,
        access_key_secret: str,
        endpoint: str,
        bucket: str,
        oss_path: str = "uploads/",
        cdn: Optional[str] = None,
        internal_endpoint: Optional[str] = None,
        use_internal_endpoint: bool = False,
        **_: object,
    ) -> None:
        self._access_key_id = access_key_id
        self._access_key_secret = access_key_secret
        self._public_endpoint = endpoint
        self._internal_endpoint = internal_endpoint
        self._use_internal_endpoint = use_internal_endpoint
        self._bucket_name = bucket

        self._cdn = cdn.rstrip("/") if cdn else None
        self._oss_path = self._normalize_prefix(oss_path)

        base = f"https://{self._bucket_name}.{self._public_endpoint}"
        self._base_url = self._cdn or base

        self._logger = get_app_logger().bind(component="oss_toolkit")
        self._bucket: Optional[_BucketProtocol] = None

    @staticmethod
    def _normalize_prefix(prefix: str) -> str:
        normalized = (prefix or "").strip()
        if not normalized:
            return ""
        normalized = normalized.lstrip("/")
        if not normalized.endswith("/"):
            normalized += "/"
        return normalized

    def _get_bucket_endpoint(self) -> str:
        if self._use_internal_endpoint and self._internal_endpoint:
            return self._internal_endpoint
        return self._public_endpoint

    def _get_bucket(self) -> _BucketProtocol:
        if self._bucket is not None:
            return self._bucket

        oss2 = _import_oss2()
        auth = oss2.Auth(self._access_key_id, self._access_key_secret)
        bucket = oss2.Bucket(auth, self._get_bucket_endpoint(), self._bucket_name)
        self._bucket = cast(_BucketProtocol, bucket)
        return self._bucket

    def build_public_url(self, object_key: str) -> str:
        """Build a public URL for an OSS object key."""
        cleaned = object_key.lstrip("/")
        return f"{self._base_url}/{quote(cleaned, safe='/')}"

    def upload_file(
        self,
        object_key: str,
        local_file_path: PathLike,
        *,
        headers: Optional[Dict[str, str]] = None,
    ) -> str:
        """Upload a small/regular file."""
        try:
            bucket = self._get_bucket()
            bucket.put_object_from_file(str(object_key), str(local_file_path), headers or {})
        except OssToolkitError:
            raise
        except Exception as exc:  # pragma: no cover
            self._logger.exception("OSS upload_file failed", extra={"object_key": object_key})
            raise OssUploadError(f"OSS upload_file failed: {object_key}") from exc
        return self.build_public_url(object_key)

    def upload_large_file(
        self,
        object_name: str,
        local_file_path: PathLike,
        *,
        part_size: int = 1024 * 1024,
    ) -> str:
        """Upload a large file using multipart upload.

        Notes:
        - `object_name` is treated as a key relative to `oss_path` and is
          automatically prefixed with it.
        - For production workloads, consider increasing `part_size` (e.g. 5MB+)
          to reduce API calls.
        """
        if part_size <= 0:
            raise ValueError("part_size must be positive")

        oss2 = _import_oss2()
        object_key = f"{self._oss_path}{object_name.lstrip('/')}"

        try:
            bucket = self._get_bucket()
            init_result = bucket.init_multipart_upload(object_key)
            upload_id = cast(str, getattr(init_result, "upload_id"))

            parts: list[object] = []
            with open(str(local_file_path), "rb") as file:
                part_number = 1
                while True:
                    data = file.read(part_size)
                    if not data:
                        break
                    result = bucket.upload_part(object_key, upload_id, part_number, data)
                    etag = cast(str, getattr(result, "etag"))
                    parts.append(oss2.models.PartInfo(part_number, etag))
                    part_number += 1

            bucket.complete_multipart_upload(object_key, upload_id, parts)
        except OssToolkitError:
            raise
        except Exception as exc:  # pragma: no cover
            self._logger.exception("OSS upload_large_file failed", extra={"object_key": object_key})
            raise OssUploadError(f"OSS upload_large_file failed: {object_key}") from exc

        return self.build_public_url(object_key)

    def download_bytes(self, object_key: str) -> bytes:
        """Download an OSS object into memory."""
        try:
            bucket = self._get_bucket()
            obj = bucket.get_object(str(object_key))
            read = getattr(obj, "read", None)
            if not callable(read):
                raise OssToolkitError("OSS get_object() returned unreadable response.")
            return read()
        except OssToolkitError:
            raise
        except Exception as exc:  # pragma: no cover
            self._logger.exception("OSS download_bytes failed", extra={"object_key": object_key})
            raise OssUploadError(f"OSS download_bytes failed: {object_key}") from exc


class AsyncOssClient:
    """Async wrapper for :class:`~app.shared.oss_toolkit.client.OssClient`.

    Notes
    -----
    The upstream `oss2` SDK is synchronous. This wrapper runs blocking uploads in
    a thread via ``asyncio.to_thread`` and serializes operations with a lock to
    avoid concurrency issues on shared SDK objects.
    """

    def __init__(self, client: OssClient) -> None:
        self._client = client
        self._lock = asyncio.Lock()

    def build_public_url(self, object_key: str) -> str:
        return self._client.build_public_url(object_key)

    async def upload_file(
        self,
        object_key: str,
        local_file_path: PathLike,
        *,
        headers: Optional[Dict[str, str]] = None,
    ) -> str:
        async with self._lock:
            return await asyncio.to_thread(
                self._client.upload_file,
                object_key,
                local_file_path,
                headers=headers,
            )

    async def upload_large_file(
        self,
        object_name: str,
        local_file_path: PathLike,
        *,
        part_size: int = 1024 * 1024,
    ) -> str:
        async with self._lock:
            return await asyncio.to_thread(
                self._client.upload_large_file,
                object_name,
                local_file_path,
                part_size=part_size,
            )
