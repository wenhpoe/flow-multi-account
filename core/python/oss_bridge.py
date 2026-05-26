from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


ROOT = _project_root()
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from oss_toolkit import create_oss_client  # noqa: E402


def _env_flag(name: str) -> bool:
    value = str(os.environ.get(name, "")).strip().lower()
    return value in {"1", "true", "yes", "on"}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Flow multi-account OSS bridge")
    subparsers = parser.add_subparsers(dest="command", required=True)

    upload = subparsers.add_parser("upload", help="upload a file to OSS")
    upload.add_argument("--local-path", required=True)
    upload.add_argument("--object-key", required=True)
    upload.add_argument("--content-type", default="")
    return parser


def _create_client():
    use_internal = _env_flag("FLOW_OSS_USE_INTERNAL_ENDPOINT") or _env_flag("OSS_USE_INTERNAL_ENDPOINT")
    return create_oss_client("default", oss_path="", use_internal_endpoint=use_internal)


def _cmd_upload(args: argparse.Namespace) -> dict[str, object]:
    local_path = Path(args.local_path).expanduser().resolve()
    if not local_path.exists():
        raise FileNotFoundError(f"local file not found: {local_path}")
    client = _create_client()
    headers = {"Content-Type": args.content_type} if str(args.content_type or "").strip() else None
    public_url = client.upload_file(str(args.object_key), str(local_path), headers=headers)
    return {
        "ok": True,
        "objectKey": str(args.object_key),
        "publicUrl": public_url,
        "sizeBytes": local_path.stat().st_size,
        "contentType": str(args.content_type or "").strip() or None,
    }


def main(argv: list[str]) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "upload":
        payload = _cmd_upload(args)
    else:
        raise RuntimeError(f"unsupported command: {args.command}")
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
