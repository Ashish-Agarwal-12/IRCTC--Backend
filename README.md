# IRCTC Backend

A train reservation backend modelled on IRCTC: train search, class and quota availability, seat holds, payments, PNRs, cancellations and RAC/WL promotion. The focus is on the hard parts: never double-booking a seat, never losing a confirmed payment, and keeping the waitlist cascade correct.

Requirements, design and implementation status are in [docs/requirements.md](docs/requirements.md).

## Tech stack

TypeScript · Express 5 · PostgreSQL 16 · Prisma 7 (with `@prisma/adapter-pg`) · Zod · Pino · Redis 7 (BullMQ planned)

## Getting started

**Prerequisites:** Node.js and Docker Desktop.

1. **Install dependencies.** This also generates the Prisma client into `src/generated/prisma`:
   ```bash
   npm install
   ```
2. **Create your env file** by copying `.env.example` to `.env`. The defaults match `docker-compose.yml`.
3. **Start Postgres and Redis:**
   ```bash
   docker compose up -d
   ```
4. **Apply database migrations:**
   ```bash
   npx prisma migrate dev
   ```
5. **Run the server:**
   ```bash
   npm run dev
   ```
6. **Check it's up:**
   ```bash
   curl http://localhost:3000/health
   ```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs `src/server.ts` with tsx and restarts on file changes |
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm start` | Runs the compiled server from `dist/` |
| `npx prisma generate` | Regenerates the Prisma client after a schema change or a fresh checkout |
| `npx prisma migrate dev` | Creates and applies migrations in development |
| `npx prisma studio` | Opens a browser UI for the database |

## Environment variables

Validated at startup by [src/config/env.ts](src/config/env.ts). The server refuses to start if any are missing or invalid.

| Variable | Example | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` (controls log format) |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgresql://irctc:irctc@localhost:5432/irctc` | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |

## Project structure

```
prisma/
  schema.prisma          # data model
  migrations/            # SQL migrations (review before applying!)
prisma.config.ts         # Prisma 7 CLI config
src/
  server.ts              # entry point: starts HTTP server, graceful shutdown
  app.ts                 # Express app: request IDs, logging, routes, error handlers
  config/env.ts          # Zod-validated environment
  shared/
    error.ts             # AppError and subclasses
    error-handler.ts     # 404 + central error handler
    logger.ts            # shared Pino logger with PII redaction
    prisma.ts            # Prisma client
  generated/prisma/      # generated Prisma client (git-ignored)
docs/requirements.md     # requirements, design, roadmap, status
```

## API conventions

- **Errors** always have this shape:
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [] } }
  ```
  Codes so far: `VALIDATION_ERROR` (400), `INVALID_JSON` (400), `NOT_FOUND` (404), `CONFLICT` (409), `INTERNAL_ERROR` (500, includes `requestId`).
- **Request IDs:** every response carries an `x-request-id` header. Send your own to correlate client and server logs; otherwise one is generated.

## Endpoints

| Method | Path | Status |
|---|---|---|
| `GET` | `/health` | Available |

The planned API is listed in [docs/requirements.md §4](docs/requirements.md#4-initial-api-contract).
