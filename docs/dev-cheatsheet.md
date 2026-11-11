# Dev Cheatsheet

Daily commands for running HospitalityIQ locally. Run everything from the repo root:

```bash
cd ~/Code/hospitalityiq
```

## What runs where

| Service | Container | Host port | Data | Started by |
|---|---|---|---|---|
| Postgres (dev) | `hiq-postgres` | `127.0.0.1:5433` | named volume `hiq_pgdata` (persists) | `docker compose` |
| Postgres (test) | `hiq-postgres-test` | `127.0.0.1:5434` | in memory (wiped on every restart) | `docker compose` |
| Qdrant | `qdrant` | `6333` (REST), `6334` (gRPC) | `./qdrant_storage/` (persists) | `docker run` (not in compose yet) |
| Next.js dev server | n/a | `3000` | n/a | `npm run dev` |

Postgres uses 5433 and 5434 because 5432 is often taken by another local Postgres.

> **Qdrant note:** `docker-compose.yml` says "Qdrant is still started separately for now". The `docker run`
> command below is the standard one with `qdrant_storage/` mounted. If you originally started it with a
> different container name, check `docker ps -a` and adjust.

---

## Morning startup

```bash
# 1. Start Docker Desktop and wait for the daemon
open -a Docker
until docker info >/dev/null 2>&1; do sleep 2; done

# 2. Postgres (dev + test); --wait blocks until both are healthy
docker compose up -d --wait

# 3. Qdrant (starts the existing container, or creates it the first time)
docker start qdrant 2>/dev/null || docker run -d --name qdrant \
  -p 6333:6333 -p 6334:6334 \
  -v "$PWD/qdrant_storage:/qdrant/storage" \
  qdrant/qdrant

# 4. Dev server
npm run dev
```

Health checks:

```bash
docker ps                              # hiq-postgres, hiq-postgres-test, qdrant all "Up"
curl -s localhost:6333/collections     # Qdrant answers with JSON
docker exec hiq-postgres pg_isready -U hiq_migrator -d hiq
```

## End of day

```bash
docker compose stop      # keeps the Postgres volume
docker stop qdrant
```

Quitting Docker Desktop also stops everything. All data survives except the test Postgres, which is in memory.

---

## After pulling new code

```bash
npm install              # if package.json / lockfile changed
npm run db:migrate       # apply any new migrations
npm test                 # needs hiq-postgres-test (5434) running
```

## First-time or after a reset

```bash
cp .env.example .env.local        # then fill in keys (OpenAI, Qdrant, DB URLs)
npm install
docker compose up -d --wait
# start Qdrant (step 3 above)
npm run db:migrate                # create schema
npm run db:setup                  # create roles/grants (admin, readonly)
npm run ingest                    # load data into Postgres/Qdrant
```

---

## npm scripts

All scripts except `dev`, `build`, `start`, `lint` and `test` load `.env.local` automatically.

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server on :3000 |
| `npm run build` / `npm start` | Production build / serve it |
| `npm run lint` | ESLint |
| `npm test` | Vitest (`vitest run`) |
| `npm run db:migrate` | Apply Postgres migrations |
| `npm run db:setup` | Create DB roles and grants |
| `npm run ingest` | Ingest reviews into the stores |
| `npm run search` | Try a search against Qdrant |
| `npm run ask` | Ask a question end to end |
| `npm run eval` | Run the eval suite (uses the LLM judge) |
| `npm run reconcile` | Compare Postgres and Qdrant for drift |
| `npm run reindex` | Rebuild the Qdrant index from Postgres |
| `npm run tags:load` | Load tags |
| `npm run seed:synthetic` | Seed synthetic data |
| `npm run stats` | Print statistics (uses the read-only DB user) |

Suggested order when something looks off: `reconcile` first, then `reindex` if it reports drift.

## Environment (.env.local)

Never commit `.env.local`. Key variables (see `.env.example` for the full list):

- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_CHAT_MODEL`
- `QDRANT_URL` (`http://localhost:6333` locally), `QDRANT_COLLECTION`, `QDRANT_API_KEY` (cloud only)
- `DATABASE_URL_ADMIN` → `localhost:5433/hiq` (migrations, imports)
- `DATABASE_URL_READONLY` → `localhost:5433/hiq` (stats queries)
- `DATABASE_URL_TEST` → `localhost:5434/hiq_test` (integration tests)

The compose admin password defaults to `hiq_dev_admin` and can be overridden with `HIQ_ADMIN_PASSWORD`.
It is a throwaway local value; don't reuse it elsewhere.

---

## Troubleshooting

```bash
# Logs
docker compose logs -f postgres
docker logs -f qdrant

# Restart one service
docker compose restart postgres
docker restart qdrant

# SQL shell
docker exec -it hiq-postgres psql -U hiq_migrator -d hiq

# Who is using a port?
lsof -i :5433        # also :5434, :6333, :3000

# Clear a stuck Next.js cache
rm -rf .next
```

| Symptom | Likely cause / fix |
|---|---|
| `failed to connect to the docker API` | Docker Desktop isn't running. `open -a Docker` and wait. |
| `port is already allocated` | Another process holds the port. Check with `lsof -i :<port>`. |
| `ECONNREFUSED` on 5433 / 5434 / 6333 | The service isn't up. Run the startup steps and `docker ps`. |
| Tests fail to connect | `hiq-postgres-test` isn't running, or `DATABASE_URL_TEST` is wrong. |
| `docker start qdrant` says no such container | It was never created, or has another name. Run the `docker run` command, or check `docker ps -a`. |
| Postgres and Qdrant disagree | `npm run reconcile`, then `npm run reindex`. |
| Test DB is empty after restart | Expected: it lives in memory. |

## Housekeeping

```bash
docker system df          # disk usage
docker image prune        # remove dangling images (safe)
docker volume ls          # you should see hiq_pgdata
```

## Destructive commands (these delete data)

```bash
docker compose down -v    # deletes hiq_pgdata: all dev Postgres data is lost
                          # recover: docker compose up -d --wait && npm run db:migrate && npm run db:setup
rm -rf qdrant_storage     # wipes all vectors: re-run `npm run ingest` / `npm run reindex`
docker volume prune       # removes ALL unused volumes, not just this project's
```

`docker compose down` (without `-v`) is safe: it removes the containers but keeps the data.

## Related docs

- `docs/project-scope.md` for what the project is
- `docs/sql-plan.md` for the Postgres design
- `docs/routing-plan.md` for query routing
- `docs/ui-plan.md` for the UI
- `docs/gbp-api-access.md` for the Google Business Profile API
- `AGENTS.md`: this Next.js version has breaking changes, so read `node_modules/next/dist/docs/` before writing Next code
