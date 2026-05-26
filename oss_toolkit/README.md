# oss_toolkit 使用说明

`oss_toolkit` 是对阿里云 OSS Python SDK（`oss2`）做的一层轻量封装，提供：

- `OssClient`：同步上传/下载 + 公网 URL 拼接
- `AsyncOssClient`：对同步 SDK 的异步包装（`asyncio.to_thread` + 锁串行）
- `create_oss_client()` / `create_async_oss_client()`：从本项目的配置读取环境变量并创建客户端

> 说明：当前实现**不是完全独立包**，内部会引用本仓库的 `app.core.logging` 与 `app.config.storage`（见下文“工厂方法与配置”）。

---

## 安装依赖

该工具依赖：

- `oss2`（阿里云 OSS SDK）

在本仓库中，`apps/api/requirements.txt` 已包含 `oss2`。

---

## 工厂方法与配置（推荐在本仓库内使用）

`create_oss_client()` / `create_async_oss_client()` 读取 `app.config.storage.get_oss_config()` 的返回值。

在本仓库里，它默认从以下环境变量获取配置（见 `apps/api/app/config/storage.py`）：

- `OSS_BUCKET`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`
- `OSS_ENDPOINT`（公网 endpoint，例如：`oss-cn-hangzhou.aliyuncs.com`）
- 可选：`OSS_INTERNAL_ENDPOINT`（VPC/内网 endpoint）
- 可选：`OSS_CDN`（CDN 域名/URL，例如：`https://cdn.example.com`）

示例：

```python
from oss_toolkit import create_oss_client

client = create_oss_client("default", oss_path="uploads/", use_internal_endpoint=False)
url = client.upload_file("uploads/hello.txt", "/tmp/hello.txt", headers={"Content-Type": "text/plain"})
print(url)
```

---

## 直接创建客户端（跨项目复用时更通用）

如果你不想依赖 `app.config.storage` 的配置读取逻辑，可以直接 new：

```python
from oss_toolkit import OssClient

client = OssClient(
    access_key_id="...",
    access_key_secret="...",
    endpoint="oss-cn-hangzhou.aliyuncs.com",
    internal_endpoint=None,
    bucket="your-bucket",
    cdn=None,
    oss_path="uploads/",
    use_internal_endpoint=False,
)
```

---

## 上传与下载 API

### 1) `upload_file(object_key, local_file_path, headers=None)`

- 适合小文件/常规上传
- `object_key` 为 OSS 对象 Key（你传什么就上传什么，不会自动拼 `oss_path`）
- 返回值为可访问的公开 URL（优先用 `OSS_CDN`，否则使用 `https://{bucket}.{endpoint}`）

```python
url = client.upload_file("uploads/a.png", "/tmp/a.png", headers={"Content-Type": "image/png"})
```

### 2) `upload_large_file(object_name, local_file_path, part_size=...)`

- 适合大文件分片上传（multipart）
- `object_name` 会被当作相对路径，最终 Key 为：`{oss_path}{object_name}`
- 返回公开 URL

```python
url = client.upload_large_file("big/a.bin", "/tmp/a.bin", part_size=5 * 1024 * 1024)
```

### 3) `download_bytes(object_key)`

```python
data = client.download_bytes("uploads/a.png")
```

---

## 异步用法

`oss2` SDK 本身是同步的，本工具用线程池做异步包装：

```python
import asyncio
from oss_toolkit import create_async_oss_client

async def main():
    client = create_async_oss_client("default", oss_path="uploads/")
    url = await client.upload_file("uploads/hello.txt", "/tmp/hello.txt")
    print(url)

asyncio.run(main())
```

---

## 异常与排查

- `OssDependencyMissingError`：缺少 `oss2` 或运行环境依赖导致 `oss2` 导入失败
- `OssConfigError`：通过工厂方法创建时，环境变量缺失导致配置不完整
- `OssUploadError`：上传/下载过程中发生异常（会带日志）

---

## 内网 endpoint 与 CDN

- `use_internal_endpoint=True` 且提供了 `internal_endpoint` 时，会优先使用内网 endpoint 发起 SDK 请求（通常用于同地域 VPC 环境）。
- `cdn`（或 `OSS_CDN`）只影响对外 URL 的拼接，不影响 SDK 上传 endpoint 的选择。

