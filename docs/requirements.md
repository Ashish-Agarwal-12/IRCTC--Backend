# Train Reservation System — Requirements and Initial Design

## 1. Requirements

### 1.1 Functional Requirements

1. Users can register, verify their email, log in, log out, and reset their password.
2. Users can search for trains by source, destination, and travel date.
3. For each train, users can view availability by class and quota, for example:
   - `3A: AVL42`
   - `SL: RAC3`
   - `2A: WL24`
4. Users can create a booking for up to six passengers. Each passenger can specify a berth preference.
5. Seats are held for 10 minutes while the user completes payment. Expired holds are released immediately.
6. Payments are processed through a payment gateway. A booking is confirmed only after the gateway confirms successful payment.
7. When a booking is confirmed, a PNR is generated and a downloadable PDF ticket is produced.
8. Users can view their bookings and check PNR status.
9. Users can cancel a booking. Refunds are calculated according to applicable rules, and RAC/WL passengers are promoted through the cancellation cascade.
10. Chart preparation runs four hours before departure and automatically cancels remaining waitlisted bookings.
11. Administrators can manage trains, routes, schedules, and seat layouts.

### 1.2 Non-Functional Requirements

1. **Correctness:** A seat must never be allotted to two passengers, under any load.
2. **Durability:** A confirmed payment must never be lost, even if the server crashes mid-request.
3. **Performance:** Train search should respond in under 200 ms; booking should complete in under two seconds.
4. **Scalability:** The system should withstand a Tatkal rush, with thousands of booking attempts per second for one train.
5. **Security:**
   - Hash passwords securely.
   - Ensure tokens expire.
   - Validate inputs.
   - Apply rate limits to authentication and booking endpoints.
   - Never include personally identifiable information (PII) in logs.
6. **Observability:** Every request should be traceable by a request ID through logs. The system should detect failures before users report them.
7. **Resilience:** If the payment gateway is unavailable, the system should degrade gracefully without corrupting booking or payment data.

---

## 2. Where the Hard Problems Hide

Three problems will dominate the design.

### 2.1 Double-Booking Problem

**Related requirements:** Correctness and temporary seat holds.

Two requests may arrive only 3 ms apart for the last available seat. Both requests read that one seat is available, and both attempt to book it. This is a classic race condition.

**Planned solution:**
- Use PostgreSQL database transactions.
- Use row-level locking for inventory updates.
- Ensure the availability check and seat/hold allocation happen atomically.
- Add a load test that sends 500 concurrent requests for one seat and verifies that only one request can win that seat.

### 2.2 Distributed Transaction Problem

**Related requirements:** Payment confirmation and durability.

The payment happens in Razorpay's system, while the booking is stored in our database. The server could crash after Razorpay reports a successful payment but before our database records the result. Neither system can directly roll back the other system's transaction.

**Planned solution:**
- Use idempotency keys to prevent duplicate processing.
- Process and verify payment webhooks.
- Make payment and booking state transitions idempotent.
- Run a reconciliation job to detect and repair mismatches between gateway payments and local records.

This is one of the most important system-design and interview topics in the project.

### 2.3 RAC/WL Cascade Problem

**Related requirements:** Cancellation, waitlist promotion, and chart preparation.

A cancellation can affect many passenger records because RAC and waitlist positions may shift.

**Design goals:**
- Apply each cascade atomically.
- Preserve correct passenger ordering and status.
- Prevent concurrent cancellations or bookings from corrupting the queue.
- Avoid holding locks for unnecessarily long periods.
- At chart preparation, automatically cancel remaining waitlisted bookings according to the defined rules.

---

## 3. Core Entities

These are conceptual entities for the initial design, not the final database schema.

| Entity | Purpose / Example Fields |
|---|---|
| `User` | User account and profile |
| `Role` | User permissions, such as customer or admin |
| `Station` | Station code, name, city |
| `Train` | Train number and name |
| `Route` | Route followed by a train |
| `RouteStop` | Station sequence, arrival time, departure time |
| `TrainSchedule` | A specific train service on a specific date; the actual service users book |
| `Coach` | Coach identifier and class |
| `Seat` | Physical seat layout, such as coach B1, seat 23, lower berth |
| `SeatInventory` | Inventory by schedule, class, and quota; the record whose updates require concurrency control |
| `Booking` | PNR, status, user, total fare |
| `Passenger` | Passenger details, requested berth, allotted berth, and status/position such as CNF, RAC, or WL |
| `Payment` | Gateway order ID, payment status, idempotency key |
| `Hold` | Temporary reservation with an expiry time |

> **As implemented (see `prisma/schema.prisma`):**
> - `Role` is an enum on `User` (`USER`, `ADMIN`) rather than a separate table.
> - `Route` and `RouteStop` are merged: a train's route is its ordered list of `RouteStop` rows (`sequence`, minutes after origin departure, cumulative `distanceKm`).
> - `Hold` is not a separate table: a booking in `PENDING_PAYMENT` with a `holdExpiresAt` timestamp *is* the hold. The `(status, holdExpiresAt)` index lets the expiry worker find expired holds cheaply.
> - The allotted berth is a `SeatAllocation` row. Its unique `(scheduleId, seatId)` constraint is the database-level guarantee that a seat is never allotted twice.
> - `Passenger.gender` is an enum (`MALE`, `FEMALE`, `TRANSGENDER`) so quota rules (e.g. ladies quota) can rely on it.
> - `TrainSchedule.chartPreparedAt` is nullable; it stays null until the chart-preparation job runs.
> - **Known simplification:** inventory and seat allocation are per journey, not per segment. A seat freed after an intermediate station cannot yet be resold for the rest of the route.
> - `RefreshToken` (rotating, grouped by `familyId`) and `VerificationToken` (single-use email-verify / password-reset tokens) support auth. Both store only a SHA-256 hash of the token.
> - **Not yet modelled:** `Payment`.

---

## 4. Initial API Contract

The following endpoints are the first draft and can be refined as the design develops.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/auth/register` | Register a user |
| `POST` | `/auth/login` | Log in |
| `POST` | `/auth/refresh` | Refresh an access token |
| `GET` | `/stations?q=del` | Search stations by query |
| `GET` | `/trains/search?from=NDLS&to=BCT&date=2026-11-01` | Search trains by source, destination, and date |
| `GET` | `/trains/:scheduleId/availability` | Get availability for a train schedule by class and quota |
| `POST` | `/bookings` | Create a temporary hold and return payment-order details |
| `POST` | `/payments/webhook` | Receive payment status updates from the gateway |
| `GET` | `/bookings` | List the current user's bookings |
| `GET` | `/bookings/:pnr` | Get booking details and PNR status |
| `DELETE` | `/bookings/:pnr` | Cancel a booking |
| `GET` | `/bookings/:pnr/ticket.pdf` | Download the ticket as a PDF |

**API-first principle:** Define the API contract before implementing the backend. This allows frontend developers to build against the contract while backend implementation continues.

---

## 5. Technology Stack and Rationale

| Technology | Planned Use | Why |
|---|---|---|
| **TypeScript** | Backend language | Static typing catches many errors at compile time and improves maintainability. |
| **Express** | HTTP API framework | Mature, well documented, and supported by a large ecosystem. The application could be migrated to Fastify later if needed. |
| **PostgreSQL** | Primary database | Transactions and row-level locks support safe inventory allocation and booking consistency. |
| **Prisma** | ORM and database access | Type-safe queries for most application operations; raw SQL can be used for critical locking operations where needed. |
| **Redis** | Caching, rate limiting, and hold-expiry support | Fast access to cached search data and useful primitives for rate limiting and expiry coordination. PostgreSQL remains the source of truth for seat allocation. |
| **BullMQ** | Background job queue, backed by Redis | Process emails, PDF generation, chart preparation, and other asynchronous jobs. |
| **Zod** | Request validation | Validate incoming data before it reaches business logic. |

---

## 6. Key Design Principles

1. **PostgreSQL is the source of truth** for bookings, payments, and seat allocation.
2. **Do not rely on cached availability to allocate seats.** Cached counts may be stale; allocation must be checked and performed atomically against authoritative database state.
3. **Treat payment webhooks as repeatable.** The same event may arrive more than once, so processing must be idempotent.
4. **Use background jobs for work that does not need to block the request**, such as email delivery and PDF generation.
5. **Make hold expiration recoverable.** Redis TTL can help trigger work, but a durable database expiry timestamp and a worker/recovery process should ensure expired holds are eventually released even if a worker is unavailable.
6. **Test concurrency early.** Prove that concurrent requests cannot allocate the same seat before optimizing for peak traffic.
7. **Keep state transitions explicit.** Define valid transitions for holds, bookings, passengers, and payments to prevent inconsistent states.

---

## 7. Initial Implementation Roadmap

1. Finalize the domain model and API contracts.
2. Set up the TypeScript, Express, Prisma, PostgreSQL, Redis, BullMQ, and Zod project.
3. Implement authentication and role-based authorization.
4. Implement stations, routes, trains, and schedules.
5. Implement train search and availability queries.
6. Implement atomic seat inventory allocation and 10-minute holds.
7. Integrate Razorpay orders, verified webhooks, idempotency, and payment reconciliation.
8. Implement booking confirmation, PNR generation, and PDF tickets.
9. Implement cancellations, refund rules, RAC/WL promotion, and chart preparation.
10. Add structured logging, request IDs, metrics, tracing, and alerts.
11. Run concurrency, load, failure-recovery, and performance tests.

> **Important:** The 200 ms search and two-second booking targets are measurable goals, not guarantees from the stack alone. Validate them with realistic data, indexes, load tests, and production-like infrastructure.

---

## 8. Implementation Status

_Last updated: 2026-10-29_

| Roadmap step | Status |
|---|---|
| 1. Domain model and API contracts | Done: initial schema and migrations in `prisma/` |
| 2. Project setup | Done, except Redis/BullMQ: containers run via Docker Compose, but no client library is installed or used yet |
| 3. Authentication and authorization | Done (see 8.3) |
| 4. Stations, routes, trains, schedules | Next |
| 5–11 | Not started |

### 8.1 Foundations in place (Phase 0)

| Area | Implementation | Why |
|---|---|---|
| Config validation | `src/config/env.ts` parses `process.env` with Zod at startup | A bad deploy fails immediately with a clear message instead of failing later on first use. |
| Error handling | `src/shared/error.ts` (`AppError`, `NotFoundError`, `ConflictError`) and `src/shared/error-handler.ts`, registered last in `src/app.ts` | One consistent error shape: `{ error: { code, message, details? } }`. Zod errors → 400 `VALIDATION_ERROR`, malformed JSON → 400 `INVALID_JSON`, unknown routes → 404 `NOT_FOUND`, anything unexpected → 500 `INTERNAL_ERROR` with a `requestId` and no internals leaked. |
| Logging | `src/shared/logger.ts`: one shared Pino logger (pretty in development, JSON otherwise, silent in tests) | Same format everywhere. Passwords, tokens, auth headers, cookies, email and phone are redacted (security requirement: no PII in logs). |
| Request tracing | `pino-http` with `genReqId` in `src/app.ts`: reuses an incoming `x-request-id` (max 128 chars) or generates a UUID, and echoes it in the response | Observability requirement: every request is traceable through the logs by its ID. |
| Graceful shutdown | `src/server.ts` handles `SIGTERM`/`SIGINT`: stops accepting connections, lets in-flight requests finish, disconnects Prisma; forced exit after 10 s | Deploys and restarts must not cut off a request mid-transaction. |
| Prisma client | Generated into `src/generated/prisma` (git-ignored) and used through the `@prisma/adapter-pg` driver adapter in `src/shared/prisma.ts`; config in `prisma.config.ts` | It must live under `src/` because `tsconfig.json` has `rootDir: "src"`. `prisma.config.ts` is the file name Prisma 7 picks up by default. |

### 8.2 Migrations

| Migration | Contents |
|---|---|
| `20261016115023_init_catalog` | Users, stations, trains, route stops, schedules |
| `20261016124540_init_catalog` | Coaches, seats, seat inventory, bookings, passengers, seat allocations |
| `20261029082133_auth_tokens` | `TokenPurpose` enum, `RefreshToken` and `VerificationToken` tables |
| `20261029120000_catalog_fixes` | `Gender` enum, converted in place with `USING UPPER(...)` so existing rows are kept. Prisma's generated SQL dropped the column instead, so it was hand-edited. Also makes `chartPreparedAt` nullable. |

> Always read generated migration SQL before applying it: a column type change can be generated as drop-and-recreate, which deletes data.

### 8.3 Authentication (Phase 1)

| Decision | Choice | Why |
|---|---|---|
| Password hashing | argon2id | Deliberately slow and memory-hard, so stolen hashes are expensive to brute-force. Passwords are capped at 128 characters so huge inputs can't tie up the CPU. |
| Access token | HS256 JWT, 15 min, `{ sub: userId, role }`, algorithm pinned on verify | Checked without a database lookup. It can't be revoked, so it is kept short-lived. |
| Refresh token | Random 256-bit opaque token, 7 days, returned in the JSON body, stored as SHA-256 hash | Always checked against the database, so it can be revoked. Hashing means a database leak doesn't leak usable tokens. |
| Rotation + reuse detection | Each refresh revokes the old token (`updateMany ... where revokedAt is null`) and issues a new one in the same `familyId`. Presenting a revoked token revokes the whole family. | A stolen refresh token stops working as soon as either party uses it twice. The conditional update makes concurrent refreshes safe: only one wins. **Tradeoff:** the losers of a concurrent refresh count as reuse and end the session too. That is strict but safe; a short grace window could be added if clients double-refresh. |
| Email verification | Required before login (403 `EMAIL_NOT_VERIFIED`). Single-use token, 24 h. | Bookings send tickets and refunds to this address, so it must be real. |
| Password reset | Single-use token, 30 min. Revokes all refresh tokens and marks the email verified. | Resetting after a compromise must also log the attacker out. |
| Account enumeration | Same 401 for unknown email and wrong password; dummy argon2 verify for unknown emails; forgot-password and resend-verification always return 202 and send email in the background | Attackers can't use responses or timing to learn who has an account. Register still returns 409 for duplicates, an accepted tradeoff for usable sign-up. |
| Duplicate sign-ups | The unique index decides (Prisma `P2002` → 409); no check-then-insert | A check-then-insert has a race window. |
| Rate limits | Login 5/min/IP; register, resend and forgot-password 5/15 min/IP; others 30/min/IP. In memory for now. | Brute-force and email-spam protection. Moves to Redis when there are multiple instances. |
| Roles | `requireRole(...)` middleware reads the role from the JWT | No DB lookup per request. A role change takes effect within 15 minutes, when the token expires. |
| Admin creation | `npx prisma db seed` from `ADMIN_EMAIL` / `ADMIN_PASSWORD` | There is no API to become an admin. |
| Email links | Link to `/verify-email#token=…` or `/reset-password#token=…`. A static page reads the token from the fragment, removes it from the address bar, and POSTs it only when the user clicks or submits. Pages send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. | The fragment never reaches the server, so tokens can't land in access logs, proxies or Referer headers. Email scanners that pre-open links can't use up the token, because opening the page does nothing on its own. A real frontend would replace these pages. |
| Secrets in logs | Pino redacts auth and cookie headers, `referer`, `req.query.token` and body-like `*.token` / `*.password` fields; `redactUrl` scrubs `?token=` from logged URLs | Defense in depth for old-style or hand-typed links. |
| Email delivery | nodemailer → Mailpit in dev; fire-and-forget with error logging | **TODO (BullMQ phase):** move to a queue so failed emails are retried and survive restarts. |
