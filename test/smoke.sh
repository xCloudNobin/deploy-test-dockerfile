#!/usr/bin/env bash
# Docker build/run smoke test for deploy-test-dockerfile.
#
# Builds the image, runs the production container on 127.0.0.1 with unique
# ports and an isolated /data volume, then verifies HTTP CRUD, error paths,
# readiness-aware health, non-root runtime, and persistence across container
# replacement with the same volume.
#
# Environment overrides:
#   SMOKE_IMAGE_TAG - image tag to build (default deploy-test-dockerfile:smoke)
#   SMOKE_BUILD_NETWORK - extra docker build flag, e.g. --network=host (useful
#                         in sandboxes whose default bridge DNS is broken)
set -euo pipefail

IMAGE_TAG="${SMOKE_IMAGE_TAG:-deploy-test-dockerfile:smoke}"
BUILD_NET_FLAG="${SMOKE_BUILD_NETWORK:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR_ROOT="$(mktemp -d /tmp/dockersmoke-XXXXXX)"
DATA_DIR="$WORKDIR_ROOT/data"
mkdir -p "$DATA_DIR"
# Container runtime user is non-root (uid 61000); the host bind mount must be
# writable by that uid. Test sandbox dirs are isolated under $WORKDIR_ROOT.
chmod 0777 "$DATA_DIR"

PASS=0
FAIL=0

note() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# Assert helper: check "$1" == "$2"; label "$3".
check_eq() {
  if [ "$1" = "$2" ]; then
    PASS=$((PASS + 1)); printf '  PASS  %s\n' "$3"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s (got %q, want %q)\n' "$3" "$1" "$2"
  fi
}
check_contains() {
  case "$1" in
    *"$2"*) PASS=$((PASS + 1)); printf '  PASS  %s\n' "$3" ;;
    *) FAIL=$((FAIL + 1)); printf '  FAIL  %s (output did not contain %q)\n' "$3" "$2" ;;
  esac
}

# Reserve a free ephemeral port on 127.0.0.1.
free_port() {
  node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'
}

http_code() { # method path [data-file]
  local method="$1" path="$2" out="$WORKDIR_ROOT/resp-$$"
  if [ $# -ge 3 ]; then
    curl -sS -o "$out" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' \
      --data-binary @"$3" "http://127.0.0.1:$HOST_PORT$path"
  else
    curl -sS -o "$out" -w '%{http_code}' -X "$method" "http://127.0.0.1:$HOST_PORT$path"
  fi
  RESPBODY="$out"
}

HOST_PORT="$(free_port)"
HOST_PORT_ALT="$(free_port)"
CNAME_PREFIX="taskboard-smoke-$$"

cleanup() {
  note "cleaning up containers and temp files"
  docker rm -f "$CNAME_PREFIX-a" "$CNAME_PREFIX-b" "$CNAME_PREFIX-env" >/dev/null 2>&1 || true
  docker image rm "$IMAGE_TAG" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR_ROOT"
  exit 0
}
trap cleanup EXIT

note "building image $IMAGE_TAG from $REPO_ROOT (build network flag: ${BUILD_NET_FLAG:-(default)})"
# shellcheck disable=SC2086
if ! docker build $BUILD_NET_FLAG -t "$IMAGE_TAG" "$REPO_ROOT" >"$WORKDIR_ROOT/build.log" 2>&1; then
  note "docker build FAILED; log follows"
  cat "$WORKDIR_ROOT/build.log"
  exit 1
fi
note "docker build OK"
docker image inspect "$IMAGE_TAG" >/dev/null

echo
note "=== 1. non-root image default user ==="
image_uid="$(docker run --rm --network=none --entrypoint id "$IMAGE_TAG" -u)"
check_eq "$image_uid" "61000" "image USER uid is 61000 (non-root)"

echo
note "=== 2. run container A on 127.0.0.1:$HOST_PORT with empty /data volume ==="
docker run -d --name "$CNAME_PREFIX-a" \
  -v "$DATA_DIR:/data" \
  -p "127.0.0.1:$HOST_PORT:8080" \
  -e BUILD_MARKER=dockersmoke-a \
  "$IMAGE_TAG" >/dev/null

# wait for readiness (healthcheck also needs the DB)
ready_ok=no
for _ in $(seq 1 60); do
  if [ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/ready" 2>/dev/null || true)" = "200" ]; then
    ready_ok=yes
    break
  fi
  sleep 1
done
check_eq "$ready_ok" "yes" "container /ready returns 200 within 60s (db up)"

echo
note "=== 3. healthcheck transitions to healthy ==="
health_state=starting
for _ in $(seq 1 40); do
  health_state="$(docker inspect -f '{{.State.Health.Status}}' "$CNAME_PREFIX-a")"
  [ "$health_state" = "healthy" ] && break
  sleep 1
done
check_eq "$health_state" "healthy" "Docker HEALTHCHECK reports healthy"

echo
note "=== 4. HTTP liveness/readiness/info ==="
c="$(curl -sS -o "$WORKDIR_ROOT/h" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/health")"
check_eq "$c" "200" "GET /health returns 200"
check_contains "$(cat "$WORKDIR_ROOT/h")" '"status":"ok"' "GET /health payload ok"
check_contains "$(cat "$WORKDIR_ROOT/h")" '"app":"deploy-test-dockerfile"' "GET /health app identity"

c="$(curl -sS -o "$WORKDIR_ROOT/r" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/ready")"
check_eq "$c" "200" "GET /ready returns 200"
check_contains "$(cat "$WORKDIR_ROOT/r")" '"database":"up"' "GET /ready dependencies.database up"
check_contains "$(cat "$WORKDIR_ROOT/r")" 'dockersmoke-a' "GET /ready build marker reflected"

c="$(curl -sS -o "$WORKDIR_ROOT/i" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/api/info")"
check_eq "$c" "200" "GET /api/info returns 200"
check_contains "$(cat "$WORKDIR_ROOT/i")" '"app":"deploy-test-dockerfile"' "GET /api/info app identity"

echo
note "=== 5. HTTP CRUD round trip ==="
c="$(curl -sS -o "$WORKDIR_ROOT/idx" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/")"
check_eq "$c" "200" "GET / serves the task board UI"
check_contains "$(cat "$WORKDIR_ROOT/idx")" 'TaskBoard' "UI HTML contains TaskBoard"

c="$(curl -sS -o "$WORKDIR_ROOT/ps" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/api/projects")"
check_eq "$c" "200" "GET /api/projects returns 200"
check_contains "$(cat "$WORKDIR_ROOT/ps")" 'Website Redesign' "seed project present"

# create project
cat > "$WORKDIR_ROOT/proj.json" <<'JSON'
{"name": "Smoke Project", "description": "created by docker smoke"}
JSON
c="$(curl -sS -o "$WORKDIR_ROOT/proj-resp" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data-binary @"$WORKDIR_ROOT/proj.json" "http://127.0.0.1:$HOST_PORT/api/projects")"
check_eq "$c" "201" "POST /api/projects returns 201"
check_contains "$(cat "$WORKDIR_ROOT/proj-resp")" 'Smoke Project' "created project echoed"
PROJECT_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WORKDIR_ROOT/proj-resp','utf8')).project.id)")"

# create task
cat > "$WORKDIR_ROOT/task.json" <<JSON
{"project_id": $PROJECT_ID, "title": "persist-through-replacement", "status": "in_progress"}
JSON
c="$(curl -sS -o "$WORKDIR_ROOT/task-resp" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data-binary @"$WORKDIR_ROOT/task.json" "http://127.0.0.1:$HOST_PORT/api/tasks")"
check_eq "$c" "201" "POST /api/tasks returns 201"
check_contains "$(cat "$WORKDIR_ROOT/task-resp")" 'persist-through-replacement' "created task echoed"
TASK_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WORKDIR_ROOT/task-resp','utf8')).task.id)")"

# read task
c="$(curl -sS -o "$WORKDIR_ROOT/task-get" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/api/tasks/$TASK_ID")"
check_eq "$c" "200" "GET /api/tasks/:id returns 200"
check_contains "$(cat "$WORKDIR_ROOT/task-get")" 'in_progress' "task read by id"

# search + filter
c="$(curl -sS -o "$WORKDIR_ROOT/search" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/api/tasks?q=replacement")"
check_eq "$c" "200" "GET /api/tasks?q=... returns 200"
check_contains "$(cat "$WORKDIR_ROOT/search")" 'persist-through-replacement' "search finds created task"
c="$(curl -sS -o "$WORKDIR_ROOT/filter" -w '%{http_code}' \
  "http://127.0.0.1:$HOST_PORT/api/tasks?status=in_progress&projectId=$PROJECT_ID")"
check_eq "$c" "200" "GET /api/tasks?status=...&projectId=... returns 200"
check_contains "$(cat "$WORKDIR_ROOT/filter")" 'persist-through-replacement' "status+project filter finds task"

# update task
cat > "$WORKDIR_ROOT/task-update.json" <<'JSON'
{"status": "done", "title": "persist-through-replacement (done)"}
JSON
c="$(curl -sS -o "$WORKDIR_ROOT/task-updated" -w '%{http_code}' -X PATCH -H 'Content-Type: application/json' \
  --data-binary @"$WORKDIR_ROOT/task-update.json" "http://127.0.0.1:$HOST_PORT/api/tasks/$TASK_ID")"
check_eq "$c" "200" "PATCH /api/tasks/:id returns 200"
check_contains "$(cat "$WORKDIR_ROOT/task-updated")" '"status":"done"' "task status updated to done"

# update project
cat > "$WORKDIR_ROOT/proj-update.json" <<'JSON'
{"name": "Smoke Project v2"}
JSON
c="$(curl -sS -o "$WORKDIR_ROOT/proj-updated" -w '%{http_code}' -X PATCH -H 'Content-Type: application/json' \
  --data-binary @"$WORKDIR_ROOT/proj-update.json" "http://127.0.0.1:$HOST_PORT/api/projects/$PROJECT_ID")"
check_eq "$c" "200" "PATCH /api/projects/:id returns 200"
check_contains "$(cat "$WORKDIR_ROOT/proj-updated")" 'Smoke Project v2' "project name updated"

echo
note "=== 6. error paths ==="
printf '{not json' > "$WORKDIR_ROOT/badjson.json"
c="$(curl -sS -o "$WORKDIR_ROOT/out" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data-binary @"$WORKDIR_ROOT/badjson.json" "http://127.0.0.1:$HOST_PORT/api/projects")"
check_eq "$c" "400" "malformed JSON body -> 400"
check_contains "$(cat "$WORKDIR_ROOT/out")" 'invalid JSON' "malformed JSON error message"

cat > "$WORKDIR_ROOT/blank.json" <<'JSON'
{"project_id": 1, "title": "   "}
JSON
c="$(curl -sS -o "$WORKDIR_ROOT/out" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data-binary @"$WORKDIR_ROOT/blank.json" "http://127.0.0.1:$HOST_PORT/api/tasks")"
check_eq "$c" "400" "blank task title -> 400"

cat > "$WORKDIR_ROOT/badstatus.json" <<'JSON'
{"project_id": 1, "title": "x", "status": "shipped"}
JSON
c="$(curl -sS -o "$WORKDIR_ROOT/out" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data-binary @"$WORKDIR_ROOT/badstatus.json" "http://127.0.0.1:$HOST_PORT/api/tasks")"
check_eq "$c" "400" "invalid status -> 400"

cat > "$WORKDIR_ROOT/nopid.json" <<'JSON'
{"project_id": 999999, "title": "orphan"}
JSON
c="$(curl -sS -o "$WORKDIR_ROOT/out" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data-binary @"$WORKDIR_ROOT/nopid.json" "http://127.0.0.1:$HOST_PORT/api/tasks")"
check_eq "$c" "404" "unknown project_id -> 404"

c="$(curl -sS -o "$WORKDIR_ROOT/out" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/api/tasks/999999")"
check_eq "$c" "404" "unknown task id -> 404"

c="$(curl -sS -o "$WORKDIR_ROOT/out" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/api/nope")"
check_eq "$c" "404" "unknown api route -> 404"

c="$(curl -sS -o "$WORKDIR_ROOT/out" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/no-such-page")"
check_eq "$c" "404" "unknown page -> 404"

echo
note "=== 7. DATABASE_PATH on /data volume is real ==="
docker exec "$CNAME_PREFIX-a" id -u > "$WORKDIR_ROOT/uid"
check_eq "$(cat "$WORKDIR_ROOT/uid")" "61000" "container process runs as uid 61000"
sq="$(docker exec "$CNAME_PREFIX-a" sh -c 'test -n "$(ls -A /data)" && echo NONEMPTY || echo EMPTY')"
check_eq "$sq" "NONEMPTY" "/data volume contains database files after writes"

echo
note "=== 8. persistence across container replacement (same /data volume) ==="
docker rm -f "$CNAME_PREFIX-a" >/dev/null

HOST_PORT_ALT="$(free_port)"
note "running replacement container B on 127.0.0.1:$HOST_PORT_ALT with the SAME /data volume"
docker run -d --name "$CNAME_PREFIX-b" \
  -v "$DATA_DIR:/data" \
  -p "127.0.0.1:$HOST_PORT_ALT:8080" \
  -e BUILD_MARKER=dockersmoke-b \
  "$IMAGE_TAG" >/dev/null

ready_ok=no
for _ in $(seq 1 60); do
  if [ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HOST_PORT_ALT/ready" 2>/dev/null || true)" = "200" ]; then
    ready_ok=yes
    break
  fi
  sleep 1
done
check_eq "$ready_ok" "yes" "replacement container /ready returns 200"

c="$(curl -sS -o "$WORKDIR_ROOT/prev" -w '%{http_code}' \
  "http://127.0.0.1:$HOST_PORT_ALT/api/tasks?q=replacement")"
check_eq "$c" "200" "GET /api/tasks?q=replacement on replacement container"
check_contains "$(cat "$WORKDIR_ROOT/prev")" 'persist-through-replacement (done)' "persisted task survived container replacement"
check_contains "$(cat "$WORKDIR_ROOT/prev")" '"status":"done"' "persisted task status survived replacement"

# verify seed not duplicated (projects seeding is idempotent)
seed_count="$(curl -sS "http://127.0.0.1:$HOST_PORT_ALT/api/projects" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const ps=JSON.parse(d).projects.filter(p=>p.name==='Website Redesign');console.log(ps.length)})")"
check_eq "$seed_count" "1" "seed project not duplicated after replacement"

# project updated in A survived too
c="$(curl -sS -o "$WORKDIR_ROOT/pr" -w '%{http_code}' "http://127.0.0.1:$HOST_PORT_ALT/api/projects/$PROJECT_ID")"
check_eq "$c" "200" "persisted project readable after replacement"
check_contains "$(cat "$WORKDIR_ROOT/pr")" 'Smoke Project v2' "persisted project name survived replacement"

echo
note "=== 9. configurable PORT and DATABASE_PATH overrides ==="
HOST_PORT_ENV="$(free_port)"
note "running container with -e PORT=8081 -e DATABASE_PATH=/data/custom.sqlite on 127.0.0.1:$HOST_PORT_ENV"
docker run -d --name "$CNAME_PREFIX-env" \
  -v "$DATA_DIR:/data" \
  -p "127.0.0.1:$HOST_PORT_ENV:8081" \
  -e PORT=8081 \
  -e DATABASE_PATH=/data/custom.sqlite \
  "$IMAGE_TAG" >/dev/null
env_ok=no
for _ in $(seq 1 40); do
  if [ "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HOST_PORT_ENV/ready" 2>/dev/null || true)" = "200" ]; then
    env_ok=yes
    break
  fi
  sleep 1
done
check_eq "$env_ok" "yes" "PORT override honored (8081 inside container)"
custom_db="$(docker exec "$CNAME_PREFIX-env" sh -c 'test -f /data/custom.sqlite && echo FOUND || echo MISSING')"
check_eq "$custom_db" "FOUND" "DATABASE_PATH override created /data/custom.sqlite"

echo
note "=== result: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
echo "Docker smoke test passed"
