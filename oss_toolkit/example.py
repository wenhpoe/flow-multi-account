"""OSS toolkit usage example.

This example demonstrates how to:
- Create an async client from environment variables via `create_async_oss_client()`.
- Upload a small file with `upload_file()` (async).
- Upload via multipart with `upload_large_file()` (async).

Before running, export the required env vars (default config):
- `OSS_BUCKET`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`
- `OSS_ENDPOINT` (e.g. `oss-cn-hangzhou.aliyuncs.com`)
- Optional: `OSS_CDN`, `OSS_INTERNAL_ENDPOINT`
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from oss_toolkit import create_async_oss_client


async def demo_usage() -> None:
    tmp_path = Path("/tmp/oss-demo.txt")
    tmp_path.write_text("hello oss\n", encoding="utf-8")

    client = create_async_oss_client("default", oss_path="uploads/", use_internal_endpoint=False)

    file_url = await client.upload_file("uploads/oss-demo.txt", tmp_path)
    print("upload_file returned URL:", file_url)

    large_url = await client.upload_large_file("big/oss-demo.txt", tmp_path, part_size=1024 * 1024)
    print("upload_large_file returned URL:", large_url)


if __name__ == "__main__":
    asyncio.run(demo_usage())
