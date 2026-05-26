from __future__ import annotations


class OssToolkitError(Exception):
    """Base exception for oss_toolkit errors."""


class OssDependencyMissingError(OssToolkitError):
    """Raised when the `oss2` dependency is not installed."""


class OssUploadError(OssToolkitError):
    """Raised when an upload to OSS fails."""


class OssConfigError(OssToolkitError):
    """Raised when OSS configuration is missing or invalid."""

