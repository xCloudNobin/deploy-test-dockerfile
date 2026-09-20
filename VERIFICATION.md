# Verification

Status: **local-verified**. Live xCloud deployment **NOT RUN** in this session.
Date: 2026-09-20. Repo: `xCloudNobin/deploy-test-dockerfile`, branch `feat/compatibility-app`.

## Environment (local)

- Node.js `v22.23.2`, npm `10.9.8`, Docker client/server `29.2.0`, x86_64 Linux container workspace.
- express `5.2.1`, better-sqlite3 `13.0.3` (compiled for Alpine/musl in the deps build stage).
- All tests/smoke use unique ephemeral ports on `127.0.0.1` and isolated temp SQLite paths / temp data
  volumes. No public host ports, no privileged containers, no host `apt`/global runtime changes.
- **Docker build network note:** the sandbox's default bridge DNS is broken (see
  [Environment blockers](#environment-blockers-and-workarounds)); image builds during this session
  used `docker build --network=host` **as an isolated workaround only**. It is **not** baked into the
  `Dockerfile`.

## Commands and results

### 1. Clean-checkout production install/build/test (from a clean `git clone` of the candidate commit)

```
$ git clone <committed repo> /tmp/cc-verify ; cd /tmp/cc-verify
$ npm ci --no-audit --no-fund
# added 70 packages in 1s

$ npm test
# tests 17
# pass 17
# fail 0
# duration_ms 504.14

$ npm run smoke
=== result: ALL CHECKS PASSED (47 total) ===
```

### 2. Automated native test suite (`npm test` — 17 tests)

Covered behaviors (all pass): home page UI served; `/health` compatible payload
`{status:ok,app:deploy-test-dockerfile}`; `/ready` ok with live DB; idempotent seed present; project
CRUD; task CRUD with status; project-delete cascades tasks; search (`q`) and status/project filters;
validation errors → 400 (blank/missing title, invalid status, missing/bad `project_id`, bad query
status, non-object body); malformed JSON → 400; not-found → 404 (unknown route, unknown entity ids);
readiness + API degraded (`/ready` 503, `/api/*` 503) when the store is unavailable while `/health`
stays 200; data persists across a store reopen on the same file; seed does not duplicate on reopen.

### 3. Native production smoke (`npm run smoke` — real process, real HTTP) — 47 checks, all pass

The script copies the app to an isolated temp checkout, runs `npm ci`, boots the **actual production
process** (`node server.js`) on a free port, and asserts:
- **Boot A (fresh temp DB):** `/ready` 200 with `dependencies.database=up` and build marker; `/health`
  compatible; seeds present; project create (201); task create (201); read by id; project detail
  groups tasks; search/filters; PATCH; UI page 200; `/api/info` build marker.
- **Negative:** malformed JSON → 400; non-object body → 400; blank/missing title → 400; invalid status
  → 400; unknown project_id → 404; unknown task/project ids → 404; unknown routes/pages → 404.
- **Clean shutdown:** SIGTERM → exit code 0.
- **Persistence (Boot B):** same `DATABASE_PATH`, fresh process → task title + `done` status survive;
  exactly one persisted record (seed not duplicated); project survives; build marker reflects new boot.
- **Dependency-aware readiness:** un-openable `DATABASE_PATH` → process stays alive (`/health` 200),
  `/ready` 503 with `database: down`, `/api/projects` 503, clean shutdown.

### 4. Docker build + Docker smoke (`npm run docker-smoke` = `bash test/smoke.sh`) — 48 checks, all pass

Image facts (`docker image inspect`, base `node:22.23.2-alpine`, node `v22.23.2` inside):
- Size ≈ 73 MB; `USER app` → uid `61000`; `EXPOSE 8080`; `VOLUME ["/data"]`; `CMD ["node","server.js"]`.
- `HEALTHCHECK` runs `GET http://127.0.0.1:8080/ready` (readiness-aware, DB-required).

Smoke assertions (all `PASS`):
- **Build:** multi-stage `docker build` succeeds; image inspects cleanly.
- **Non-root:** image default `id -u` = `61000`; running container process uid = `61000`.
- **Healthy:** container `/ready` 200 within 60s; Docker `HEALTHCHECK` reaches `healthy`.
- **HTTP:** `/health` 200 `{status:ok,app:deploy-test-dockerfile}`; `/ready` 200 `database:up` with
  build marker; `/api/info` app identity; `/` serves the TaskBoard UI; seed projects present.
- **CRUD:** create project (201), create task (201), read by id, search (`q`), status+project filter,
  PATCH task status, PATCH project name — all correct.
- **Error paths:** malformed JSON → 400; blank title → 400; invalid status → 400; unknown project_id
  → 404; unknown task id → 404; unknown API route → 404; unknown page → 404.
- **Volume:** `/data` contains SQLite (db+wal) files after writes.
- **Persistence across container replacement:** `docker rm -f` container A, start container B with the
  **same `/data` volume** → persisted task title+status survive, persisted project name survives, and
  seed is not duplicated.
- **Configurable PORT / DATABASE_PATH:** container with `-e PORT=8081 -e DATABASE_PATH=/data/custom.sqlite`
  serves `/ready` on the overridden port and creates `/data/custom.sqlite`.

### 5. Manual container round trip

```
$ docker volume create taskboard-data
$ docker run -d --name tb -p 127.0.0.1:PORT:8080 -v taskboard-data:/data deploy-test-dockerfile
# /health, /ready, CRUD via curl observed; container replaced with same volume keeps data
```

## Schema / persistence notes

- Idempotent `CREATE TABLE IF NOT EXISTS` for `projects`/`tasks`, FK `ON DELETE CASCADE`, `CHECK` on
  `status`, WAL mode; parameterized queries throughout; UI escapes user data (text-based DOM).
- Seed runs only when `projects` is empty → deterministic, repeatable, no duplication on restart/redeploy.
- Production data path is `/data` (image `ENV DATABASE_PATH=/data/taskboard.sqlite` + declared
  `VOLUME`); deployments must mount a real volume over `/data`. Verified persistence across container
  replacement in the Docker smoke above.

## Security / licensing

- MIT license added; source derived from `xCloudNobin/deploy-test-express` (MIT, Copyright (c) 2026
  xCloudNobin) and left unmodified upstream. Attribution in README; app identity renamed to
  `deploy-test-dockerfile`.
- No credentials or secrets committed; `.env.example` uses safe placeholders; logs carry no credentials.
- No cookies/auth in this demo, so CSRF is not applicable; unauthenticated public-demo nature and
  safe-public-usage (bind `127.0.0.1`, no public port forwarding) are documented in README.

## Environment blockers and workarounds

- **Default bridge-network DNS is broken in this sandbox:** `docker build` on the default network
  fails inside the `deps` stage — `apk add` reports
  `WARNING: fetching https://dl-cdn.alpinelinux.org/.../APKINDEX.tar.gz: DNS: transient error` /
  `ERROR: unable to select packages`, and `npm ci` reports
  `request to https://registry.npmjs.org/better-sqlite3 failed, reason: getaddrinfo EAI_AGAIN`.
  The **host** network resolves and fetches registry/alpine mirrors fine.
- **Workaround applied for this session only:** `docker build --network=host` (all Docker smoke runs
  above used `SMOKE_BUILD_NETWORK="--network=host"`). This is **not** encoded in the `Dockerfile`;
  on a network with working bridge DNS a plain `docker build .` is expected to pass. The
  `test/smoke.sh` script supports `SMOKE_BUILD_NETWORK` for environments that need it.
- Running app containers use the **default bridge network** with only `127.0.0.1:port:8080`
  bindings — no host networking, no public binds.

## Limitations / not done

- **Live xCloud deployment: NOT RUN.** Status is `local-verified`; `deployment_verified` is NOT
  claimed. Live qualification on the intended xCloud category at this exact commit, plus external
  readiness/health checks and a redeploy-persistence check, are required before marking
  `deployment-verified`.
- No external reviewer sign-off recorded yet (agent self-report only).
- Default-network Docker build was not verified in this sandbox (blocked by environment DNS); the
  build itself is identical regardless of the `--network=host` flag, which only changes where npm/apk
  resolve during the dependency stage.