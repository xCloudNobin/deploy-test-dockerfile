# deploy-test-dockerfile — TaskBoard on Node/Express + SQLite

Replaces the former static Nginx shell with a real project/task board: a compact
**Express 5** app backed by persistent **SQLite**, packaged as a multi-stage,
non‑root Docker image. Projects group tasks; tasks support create/read/update/delete,
a `todo | in_progress | done` status, and search/filter. The original repo name
(`deploy-test-dockerfile`) is preserved and is the app identity.

Source is derived from [`xCloudNobin/deploy-test-express`](https://github.com/xCloudNobin/deploy-test-express)
(MIT, Copyright (c) 2026 xCloudNobin) — see [License & attribution](#license--attribution).

## Features

- Project grouping with tasks, counts, and descriptions; full CRUD via a JSON API (`/api/...`).
- Status field per task with server-side validation; search (`q`) and filters (`projectId`, `status`)
  backed by parameterized SQL.
- Real SQLite persistence (`better-sqlite3`, WAL mode), deterministic idempotent schema init and
  repeatable seed data.
- Multi-stage production image (`node:22.23.2-alpine`), non-root runtime user (uid `61000`),
  readiness-aware `HEALTHCHECK`, configurable `PORT` and `DATABASE_PATH` on a `/data` volume.
- Liveness (`/health`) and dependency-aware readiness (`/ready`) endpoints; non-sensitive
  build/release marker in the UI footer and `/api/info`.
- Client UI escapes all user data (text-based DOM, no unsafe `innerHTML` interpolation).
- No authentication/cookies by design — see [Public demo limitations](#public-demo-limitations).

## Requirements

- Node.js **>= 22** for native install/build/test (verified on `v22.23.2`).
- npm **>= 10** (lockfile v3).
- Docker **>= 24** with BuildKit for image builds.

## Install (native, for running tests)

```bash
npm ci            # clean, reproducible install from lockfile (v3)
npm test          # node:test integration suite (17 tests, ephemeral temp DBs)
npm run smoke     # production smoke + restart persistence (real process, real HTTP)
```

## Docker build & production run

The Dockerfile is the primary production path for this repo (Docker is the
intended deployment category).

```bash
# build (add --build-arg BUILD_MARKER=<label> to stamp a release marker)
docker build -t deploy-test-dockerfile .

# run with a persistent volume and a 127.0.0.1-only host port
docker volume create taskboard-data
docker run -d --name taskboard -p 127.0.0.1:8080:8080 \
  -v taskboard-data:/data deploy-test-dockerfile

# replace the container (redeploy) without losing data — the volume keeps it
docker rm -f taskboard
docker run -d --name taskboard -p 127.0.0.1:8080:8080 \
  -v taskboard-data:/data deploy-test-dockerfile
```

The healthcheck reports `healthy` only when `GET /ready` returns 200 (HTTP server
up **and** the SQLite probe succeeds).

`npm run docker-smoke` runs the full Docker-level verification (build, run,
HTTP CRUD, error paths, health, non-root UID, and persistence across container
replacement with the same volume) — see [VERIFICATION.md](VERIFICATION.md).

## Configuration

Copy `.env.example` to `.env` (or pass `-e` to `docker run`). No secrets are required.

| Variable        | Required | Image default                | Meaning                                                          |
| --------------- | -------- | ---------------------------- | ---------------------------------------------------------------- |
| `HOST`          | no       | `0.0.0.0`                    | Bind address (all interfaces so the platform can route traffic). |
| `PORT`          | no       | `8080`                       | Port to listen on (override with `-e PORT=...`).                 |
| `DATABASE_PATH` | no       | `/data/taskboard.sqlite`     | SQLite file inside the persistent `/data` volume.                |
| `BUILD_MARKER`  | no       | `local-<gitref>-<version>`   | Non-sensitive release/build label shown in UI and `/api/info`.   |
| `NODE_ENV`      | no       | `production`                 | Runtime mode.                                                    |

**Persistence (important):** the SQLite database, WAL and SHM files live under
`/data`, which is declared as a `VOLUME` and must be backed by a real volume in
production. Ephemeral release directories get wiped on redeploy — always mount a
volume over `/data` (or set `DATABASE_PATH` to a durable external path). Data is
never stored only inside the release checkout.

## Run (native, non-Docker)

```bash
DATABASE_PATH=./data/taskboard.sqlite NODE_ENV=production npm start
```

Logs go to **stdout/stderr** with no credentials. Graceful shutdown on
`SIGTERM`/`SIGINT` closes the HTTP server and the SQLite handle (10s force-exit
fallback). The single server process owns the worker pool; there are no
background jobs.

## Health / readiness

- `GET /health` — **liveness**, process-is-alive: `{ "status": "ok", "app": "deploy-test-dockerfile" }`.
- `GET /ready` — **readiness**: runs a real SQLite probe (`SELECT 1`). Returns
  `200 { "dependencies": { "database": "up" }, "build": ... }` when healthy and
  `503` with `database: "down"` when the database is unavailable. The process
  intentionally stays up on `/health` when the DB is down; liveness and readiness
  are independent. The Docker `HEALTHCHECK` uses `/ready`, so a container whose
  database cannot be opened shows `unhealthy` — no static success marker.

### Build marker

`GET /api/info` and the UI footer expose a non-sensitive `build` marker
(`BUILD_MARKER` env or a `local-<gitref>-<version>` default), letting you
distinguish which deployed revision is running.

## API

All mutations accept `application/json`; ids are validated integers; strings are
trimmed, length-capped, and parameterized. Errors set a sensible HTTP status and
a JSON `{ error, code }` body.

| Method | Path                     | Description                                     |
| ------ | ------------------------ | ----------------------------------------------- |
| GET    | `/api/projects`          | List projects with task counts.                 |
| POST   | `/api/projects`          | Create project `{ name, description? }`.        |
| GET    | `/api/projects/:id`      | Project detail including its tasks.             |
| PATCH  | `/api/projects/:id`      | Update `{ name?, description? }`.               |
| DELETE | `/api/projects/:id`      | Delete project (cascades tasks).                |
| GET    | `/api/tasks`             | List tasks. Query: `projectId`, `status`, `q`.  |
| POST   | `/api/tasks`             | Create task `{ project_id, title, status?, description? }`. |
| GET    | `/api/tasks/:id`         | Task detail.                                    |
| PATCH  | `/api/tasks/:id`         | Update `{ title?, status?, description?, project_id? }`. |
| DELETE | `/api/tasks/:id`         | Delete task.                                    |
| GET    | `/api/info`              | App/runtime/framework/version/build marker.     |

Validation → `400`; missing entities → `404`; malformed JSON → `400`; oversized
body → `413`; database down → `503`; unknown route → `404`. The UI serves at
`/` (and `/app`) with nested-route-friendly static assets.

## Schema & seeds

Idempotent `CREATE TABLE IF NOT EXISTS` with a `CHECK` constraint on `status` and
a foreign-key cascade projects → tasks:

- `projects` (`id`, `name`, `description`, `created_at`)
- `tasks` (`id`, `project_id` FK → projects ON DELETE CASCADE, `title`, `description`, `status`, `created_at`, `updated_at`)

Seed data (two example projects with tasks across all statuses) inserts **only
when the `projects` table is empty**, so reseeding is deterministic and never
duplicates user records on restart or redeploy.

## Public demo limitations

- **No authentication/authorization or CSRF protections** — mutations are
  unauthenticated by design for this public demo. Anyone who can reach the
  deployed port can create/edit/delete data. Do not expose to untrusted networks
  without adding auth. Public-demo-safe usage means binding to `127.0.0.1` (or a
  private network) and never forwarding public host ports.
- Demo data is shared by all visitors; it is intentionally ephemeral and resets
  to seed only on a fresh database.
- No rate limiting, quotas, or multi-tenant isolation. Not suitable as a public
  SaaS backend as-is.
- The DB must live on a mounted `/data` volume; the bare image default keeps data
  only as long as the container/volume does.

## License & attribution

- MIT — see [LICENSE](LICENSE). Copyright (c) 2026 xCloudNobin.
- This repository derives from `xCloudNobin/deploy-test-express` (MIT), which is
  left unmodified; the copied source retains its origin. The app name was adapted
  to `deploy-test-dockerfile` for this repository.