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
5. **Seed the database**: the admin account (from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`), 18 stations, 4 sample trains with coaches, fares, and 60 days of schedules. Safe to re-run:
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

## API docs (Swagger)

With the server running (any environment except production):

- **http://localhost:3000/docs**: Swagger UI. Browse every endpoint with its request and response shapes, and send real requests with **Try it out**. For protected endpoints, call `POST /auth/login`, copy `accessToken`, click **Authorize** and paste it. Use the seeded admin for `/admin/*`.
- **http://localhost:3000/openapi.json**: the raw OpenAPI 3.1 document. Import it into Postman or Insomnia, or generate a client from it.

The document is generated from code ([src/docs/](src/docs/)). Request shapes are the same Zod schemas the controllers validate with, so they can't drift. Response shapes are strict Zod schemas that the test suite checks **every real response** against (see [test/contract.ts](test/contract.ts)). A test also fails if a route exists without docs, or the docs list a route that doesn't exist. **When you add an endpoint, add it to `src/docs/operations.ts`.**

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs `src/server.ts` with tsx and restarts on file changes |
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm start` | Runs the compiled server from `dist/` |
| `npm test` | Runs the test suite once (needs Postgres running; uses a separate `irctc_test` database) |
| `npm run test:watch` | Re-runs tests on every file change |
| `npx prisma generate` | Regenerates the Prisma client after a schema change or a fresh checkout |
| `npx prisma migrate dev` | Creates and applies migrations in development |
| `npx prisma db seed` | Seeds admin, stations, trains, fares and schedules (`prisma/seed.ts`, data in `prisma/seed-data.ts`) |
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
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | `rzp_test_...` | Razorpay **test-mode** API keys. Optional; without them the payment endpoints answer 503. A live key (`rzp_live_...`) is refused at startup. |
| `RAZORPAY_WEBHOOK_SECRET` | | Secret set on the webhook in the Razorpay dashboard. Optional; needed only to receive webhooks. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | | Used only by the seed script |

## Project structure

```
prisma/
  schema.prisma          # data model
  seed.ts                # seeds admin + sample catalog (re-runnable)
  seed-data.ts           # sample stations, trains, fares
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
  modules/stations/      # station search (public) + create/update (admin)
  modules/trains/
    trains.service.ts    # trains, routes, coaches
    schedules.service.ts # dated schedules + seat inventory per class/quota
    seat-layout.ts       # berth layouts per coach class (SL, 3A, 2A, 1A, CC)
    search.service.ts    # train search between stations + per-schedule availability
    availability.ts      # pure rules: AVL / RAC / WL / REGRET status, fares (incl. Tatkal)
  modules/bookings/
    bookings.service.ts  # create (locked, idempotent), list, get by PNR
    inventory.ts         # row locks on SeatInventory + releasing expired holds
    seat-picking.ts      # pure: choose berths (preferences, keep the party together)
    hold-expiry.ts       # background sweeper that expires unpaid holds
    ticket.ts            # e-ticket: content (pure) + PDF rendering (pdfkit)
  modules/notifications/
    outbox.ts            # transactional outbox: queue emails in the DB, worker sends with retries
  modules/payments/      # Razorpay, TEST MODE ONLY
    gateway.ts           # the only code that calls Razorpay (fetch); swappable fake in tests
    signatures.ts        # HMAC checks for checkout and webhook signatures
    payments.service.ts  # create order, verify, webhook, and settlePayment (confirm or refund)
    reconciliation.ts    # job: settle orders we missed, retry refunds owed
    payments.pages.ts    # test-mode checkout page (opens Razorpay checkout)
  modules/system/        # /health and /admin/ping
  docs/
    operations.ts        # every endpoint: method, path, request schemas, responses
    responses.ts         # strict Zod schemas of every JSON response
    openapi.ts           # builds the OpenAPI document (served at /openapi.json and /docs)
  shared/
    validation.ts        # shared Zod pieces: pagination, ids, station codes, HH:mm, dates
    error.ts             # AppError and subclasses
    error-handler.ts     # 404 + central error handler
    logger.ts            # shared Pino logger with PII redaction
    mailer.ts            # nodemailer transport
    prisma.ts            # Prisma client
    middleware/
      authenticate.ts    # authenticate + requireRole(...)
      rate-limit.ts      # createRateLimiter(limit, windowMs)
    interval-job.ts      # startIntervalJob(): background jobs in the server process
  types/express.d.ts     # adds req.user to Express's Request type
  generated/prisma/      # generated Prisma client (git-ignored)
test/                    # Vitest + Supertest suites, helpers, test-DB setup, API contract checks
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
| `GET` | `/docs`, `/openapi.json` | Swagger UI and the OpenAPI document (not served in production) |
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
| `GET` | `/stations?q=del` | Station autocomplete by code, name or city (max 10; exact code first) |
| `GET` | `/trains?page=1&pageSize=20` | Paginated train list |
| `GET` | `/trains/search?from=NDLS&to=MMCT&date=2026-11-01&quota=GENERAL` | Trains from `from` to `to` boarding on `date`, with fare and availability per class (`AVL 42`, `RAC 3`, `WL 24`, `REGRET`) |
| `GET` | `/trains/:number` | Train with route (clock times + day offset) and coaches |
| `GET` | `/trains/:scheduleId/availability?from=KOTA&to=MMCT` | Every class and quota of one schedule, with fares for that part of the route (default: whole route) |
| `POST` | `/bookings` | Auth + verified email + `Idempotency-Key` header. `{ scheduleId, from, to, class, quota?, passengers: [{ name, age, gender, berthPreference? }] (1–6), contactPhone? }` → 201 booking `PENDING_PAYMENT` with a 10-minute hold; each passenger CONFIRMED (with berth), RAC n or WL n. Same key again → 200 with the same booking. 409 `REGRET` if full. |
| `GET` | `/bookings?page=1` | Auth. Your bookings, newest first |
| `GET` | `/bookings/:pnr` | Auth. One of your bookings (PNR status); someone else's PNR is a 404 |
| `GET` | `/bookings/:pnr/ticket.pdf` | Auth. Download the e-ticket (PDF) of a paid booking; 409 `TICKET_NOT_AVAILABLE` otherwise. The same PDF is emailed on confirmation (see it in Mailpit, http://localhost:8025). |
| `POST` | `/payments/orders` | Auth. `{ pnr }` → 201 Razorpay order (`orderId`, `amount`, `keyId`, `prefill` with the booking contact, `checkoutUrl`) for a held booking; 200 with the same order if one is open. 409 `ALREADY_PAID` / `HOLD_EXPIRED`, 503 if Razorpay is down. |
| `GET` | `/payments/checkout` | Test-mode HTML page: open `checkoutUrl`, choose Netbanking → any bank → **Success** (allow pop-ups). The booking's phone and email are prefilled. |
| `POST` | `/payments/verify` | `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` (what checkout returns) → 200 `{ result: CONFIRMED \| REFUND_PENDING \| REFUNDED, booking }`. No login: the signature is checked. 402 if the payment failed. |
| `POST` | `/payments/webhook` | Called by Razorpay; checked with `X-Razorpay-Signature`. Handles `payment.captured`, `order.paid`, `payment.failed`. |
| `POST` | `/admin/stations` | `{ code, name, city }` → 201; 409 if the code exists |
| `PATCH` | `/admin/stations/:id` | `{ name?, city? }` (code can't change) |
| `POST` | `/admin/trains` | `{ number, name, runningDays: ["MON", ...], departureTime: "16:55" }` → 201 |
| `PUT` | `/admin/trains/:id/route` | `{ stops: [{ stationCode, arrivalMinutes, departureMinutes, distanceKm }] }`. Whole route; times are minutes after origin departure. 409 once bookings exist. |
| `PUT` | `/admin/trains/:id/coaches` | `{ coaches: [{ code: "B1", class: "AC3" }] }`. Seats are generated from standard layouts. 409 once schedules exist. |
| `POST` | `/admin/trains/:id/schedules` | `{ from, to }` (YYYY-MM-DD, at most 120 days). Creates schedules on running days plus seat inventory; re-runnable. |
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
