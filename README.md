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
3. **Start Postgres, Redis and Mailpit.** Mailpit is a fake email server: every email the app sends shows up at http://localhost:8025.
   ```bash
   docker compose up -d
   ```
4. **Apply database migrations:**
   ```bash
   npx prisma migrate dev
   ```
5. **Create the admin account** from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`:
   ```bash
   npx prisma db seed
   ```
6. **Run the server:**
   ```bash
   npm run dev
   ```
7. **Check it's up:**
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
| `npx prisma db seed` | Creates or updates the admin user (`prisma/seed.ts`) |
| `npx prisma studio` | Opens a browser UI for the database |

## Environment variables

Validated at startup by [src/config/env.ts](src/config/env.ts). The server refuses to start if any are missing or invalid.

| Variable | Example | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` (controls log format) |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgresql://irctc:irctc@localhost:5432/irctc` | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `JWT_ACCESS_SECRET` | 48+ random chars | Signs access tokens; must be at least 32 characters |
| `ACCESS_TOKEN_TTL_MINUTES` | `15` | Access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | Refresh token lifetime |
| `APP_URL` | `http://localhost:3000` | Base URL used in email links |
| `SMTP_HOST` / `SMTP_PORT` | `localhost` / `1025` | Mail server (Mailpit in development) |
| `MAIL_FROM` | `IRCTC <no-reply@irctc.local>` | Sender address |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | | Used only by the seed script |

## Project structure

```
prisma/
  schema.prisma          # data model
  seed.ts                # creates the admin user
  migrations/            # SQL migrations (review before applying!)
prisma.config.ts         # Prisma 7 CLI config
src/
  server.ts              # entry point: starts HTTP server, graceful shutdown
  app.ts                 # Express app: request IDs, logging, routes, error handlers
  config/env.ts          # Zod-validated environment
  modules/auth/
    auth.routes.ts       # URL → middlewares → handler
    auth.controller.ts   # HTTP layer: validate input, call service, send response
    auth.service.ts      # business logic (no Express here)
    auth.schemas.ts      # Zod request schemas + inferred types
    tokens.ts            # JWT sign/verify, random tokens, token hashing
    auth.pages.ts        # HTML pages opened from email links (stand-in for a frontend)
  shared/
    error.ts             # AppError and subclasses
    error-handler.ts     # 404 + central error handler
    logger.ts            # shared Pino logger with PII redaction
    mailer.ts            # nodemailer transport
    prisma.ts            # Prisma client
    middleware/
      authenticate.ts    # authenticate + requireRole(...)
      rate-limit.ts      # createRateLimiter(limit, windowMs)
  types/express.d.ts     # adds req.user to Express's Request type
  generated/prisma/      # generated Prisma client (git-ignored)
docs/requirements.md     # requirements, design, roadmap, status
```

## API conventions

- **Errors** always have this shape:
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [] } }
  ```
  Codes so far: `VALIDATION_ERROR` (400), `INVALID_JSON` (400), `INVALID_TOKEN` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `EMAIL_NOT_VERIFIED` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500, includes `requestId`).
- **Authentication:** send `Authorization: Bearer <accessToken>`. Access tokens last 15 minutes; get a new pair from `POST /auth/refresh`. Refresh tokens are single-use: each refresh returns a new one, and reusing an old one logs out that whole session.
- **Request IDs:** every response carries an `x-request-id` header. Send your own to correlate client and server logs; otherwise one is generated.

## Endpoints

| Method | Path | Status |
|---|---|---|
| `GET` | `/health` | Available |
| `POST` | `/auth/register` | `{ email, password, firstName, lastName, phone? }` → 201 `{ user }`, sends verification email |
| `POST` | `/auth/verify-email` | `{ token }` → 204 |
| `POST` | `/auth/resend-verification` | `{ email }` → 202 (always) |
| `POST` | `/auth/login` | `{ email, password }` → 200 `{ accessToken, refreshToken, expiresIn }`; 403 if email unverified |
| `POST` | `/auth/refresh` | `{ refreshToken }` → 200 new token pair |
| `POST` | `/auth/logout` | `{ refreshToken }` → 204 |
| `POST` | `/auth/forgot-password` | `{ email }` → 202 (always), sends reset email |
| `POST` | `/auth/reset-password` | `{ token, password }` → 204, revokes all sessions |
| `GET` | `/auth/me` | Auth required → 200 `{ user }` |
| `GET` | `/admin/ping` | Admin only; placeholder to check role guards |
| `GET` | `/verify-email`, `/reset-password` | HTML pages opened from email links (`#token=...`); a button or form on the page calls the API |

### Trying the API from Windows PowerShell

In Windows PowerShell, `curl` is an alias for `Invoke-WebRequest` and does not accept curl's flags. Use `Invoke-RestMethod`, with the JSON in single quotes:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/auth/register -ContentType "application/json" -Body '{"email":"me@example.test","password":"password123","firstName":"Me","lastName":"Test"}'
```

Then open the email in Mailpit (http://localhost:8025) and click its link to verify. Log in and keep the response:

```powershell
$session = Invoke-RestMethod -Method Post -Uri http://localhost:3000/auth/login -ContentType "application/json" -Body '{"email":"me@example.test","password":"password123"}'
```

```powershell
Invoke-RestMethod -Uri http://localhost:3000/auth/me -Headers @{ Authorization = "Bearer $($session.accessToken)" }
```

The planned API is listed in [docs/requirements.md §4](docs/requirements.md#4-initial-api-contract).
