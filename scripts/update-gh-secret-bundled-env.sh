#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/update-gh-secret-bundled-env.sh [--dry-run] [--allow-secrets] [env_file]

What it does:
  - Base64-encodes the given env file (default: .env)
  - Writes it to the GitHub Actions secret: FMA_BUNDLED_ENV_BASE64
  - Target repo is inferred from `git remote get-url origin`

Notes:
  - This is for flow-multi-account GitHub Releases auto-update packaging.
  - Do NOT commit real secrets into the repository; keep them in the secret.
  - If the env file contains credential keys (e.g. AWS_SECRET_ACCESS_KEY),
    you must pass --allow-secrets (or set FMA_ALLOW_BUNDLED_SECRETS=1).
EOF
}

DRY_RUN=0
ALLOW_SECRETS=0
ENV_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --allow-secrets)
      ALLOW_SECRETS=1
      shift
      ;;
    *)
      if [[ -n "${ENV_FILE}" ]]; then
        echo "Unexpected extra arg: $1" >&2
        usage >&2
        exit 2
      fi
      ENV_FILE="$1"
      shift
      ;;
  esac
done

cd "$(dirname "$0")/.."

if [[ -z "${ENV_FILE}" ]]; then
  ENV_FILE=".env"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Missing dependency: gh (GitHub CLI). Install it first." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Missing dependency: python3" >&2
  exit 1
fi

origin_url="$(git remote get-url origin 2>/dev/null || true)"
if [[ -z "${origin_url}" ]]; then
  echo "Cannot infer repo: git remote origin not found." >&2
  exit 1
fi

repo=""
case "${origin_url}" in
  https://github.com/*/*.git)
    repo="${origin_url#https://github.com/}"
    repo="${repo%.git}"
    ;;
  git@github.com:*/*.git)
    repo="${origin_url#git@github.com:}"
    repo="${repo%.git}"
    ;;
  *)
    echo "Unsupported origin URL format: ${origin_url}" >&2
    exit 1
    ;;
esac

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "repo=${repo}"
  echo "secret=FMA_BUNDLED_ENV_BASE64"
  echo "env_file=${ENV_FILE}"
  echo "safe_keys:"
  grep -nE '^(FLOW_TASK_ASSET_TRANSPORT|FLOW_ASSET_CDN|OSS_CDN|S3_CDN)=' "${ENV_FILE}" || true
  echo "credential_keys:"
  grep -nE '^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET)=' "${ENV_FILE}" \
    | sed -E 's/=.*$/=***REDACTED***/' \
    || true
  python3 - "${ENV_FILE}" <<'PY'
import base64, sys
path = sys.argv[1]
data = open(path, "rb").read()
print(f"raw_bytes={len(data)}")
print(f"base64_chars={len(base64.b64encode(data))}")
PY
  exit 0
fi

if grep -qE '^(AWS_SECRET_ACCESS_KEY|OSS_ACCESS_KEY_SECRET)=' "${ENV_FILE}"; then
  if [[ "${ALLOW_SECRETS}" != "1" && "${FMA_ALLOW_BUNDLED_SECRETS:-}" != "1" ]]; then
    echo "Refusing to upload secret env: detected credential keys in ${ENV_FILE}" >&2
    echo "Pass --allow-secrets (or set FMA_ALLOW_BUNDLED_SECRETS=1) if you really want to bundle credentials into the app." >&2
    exit 3
  fi
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "gh is not authenticated for github.com. Run: gh auth login" >&2
  exit 1
fi

python3 - "${ENV_FILE}" <<'PY' | gh secret set FMA_BUNDLED_ENV_BASE64 -R "${repo}"
import base64, sys
path = sys.argv[1]
data = open(path, "rb").read()
sys.stdout.write(base64.b64encode(data).decode("ascii"))
PY

echo "✅ Updated GitHub secret FMA_BUNDLED_ENV_BASE64 for ${repo}"
