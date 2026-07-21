#!/bin/sh
set -eu
base_url="${BASE_URL:-http://127.0.0.1:18080}"
home=$(curl -fsS "$base_url/")
health=$(curl -fsS "$base_url/health.html")
printf '%s' "$home" | grep -q 'Hello from deploy-test-dockerfile'
printf '%s' "$health" | grep -q 'ok'
echo 'Dockerfile smoke test passed'
