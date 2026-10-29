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
> - `Passenger.position` keeps passengers in the order they were entered (unique per booking).
> - **Deviation:** the PNR is assigned when seats are held, not when payment confirms, because `Booking.pnr` is required. It only becomes a valid ticket once the booking is `CONFIRMED`.
> - `Payment` is one row per Razorpay order (a booking can have several if checkout is opened more than once). Status: `CREATED` → `CAPTURED`, or `REFUND_PENDING` → `REFUNDED` when the money can't be used, or `EXPIRED` if never paid. Unique `gatewayOrderId` and `gatewayPaymentId` give idempotency, instead of a separate key column.
> - `PaymentEvent` records processed webhook deliveries by Razorpay's event id, so redeliveries are skipped.
> - `OutboxMessage` (transactional outbox) holds emails owed to users (`BOOKING_CONFIRMED`, `REFUND_INITIATED`), written in the same transaction as the change they report. Status `PENDING` → `SENT`, or `FAILED` after 8 attempts.
> - `Passenger.racNumber` / `waitlistNumber` are **current queue positions** (RAC 1 is next for a berth), kept contiguous after every cancellation. `SeatInventory.waitlistBooked` (renamed from `waitlistIssued`) is the current waitlist length.
> - `Refund` holds money owed after a cancellation, written in the cancellation's transaction and paid out afterwards.
> - Tickets are not stored: the PDF is rendered from the booking on each download, so it always shows the current status.

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
| `POST` | `/bookings` | Create a temporary hold (the payment order comes from `POST /payments/orders`) |
| `POST` | `/payments/orders` | Create a gateway order for a held booking |
| `POST` | `/payments/verify` | Confirm a booking from checkout's signed result |
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

_Last updated: 2026-10-30_

| Roadmap step | Status |
|---|---|
| 1. Domain model and API contracts | Done: initial schema and migrations in `prisma/` |
| 2. Project setup | Done, except Redis/BullMQ: containers run via Docker Compose, but no client library is installed or used yet |
| 3. Authentication and authorization | Done (see 8.3) |
| 4. Stations, routes, trains, schedules | Done (see 8.4); automated test suite added |
| 5. Train search and availability | Done (see 8.7) |
| 6. Seat allocation and holds | Done (see 8.8) |
| 7. Payments | Done, **Razorpay test mode only** (see 8.9) |
| 8. Confirmation, PNR, PDF tickets | Done (see 8.10) |
| 9. Cancellations, refunds, RAC/WL promotion, chart preparation | Done (see 8.11) |
| 10. Logging, metrics, tracing, alerts | Done (see 8.12) |
| 11. Load and failure testing | Next |

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
| `20261029090011_catalog_scheduling` | `Weekday` enum; `Train.runningDays` and `Train.departureMinutes`; `FareRule` table. Hand-edited so existing trains get placeholder values (00:00, daily) before the defaults are dropped. |
| `20261029120000_catalog_fixes` | `Gender` enum, converted in place with `USING UPPER(...)` so existing rows are kept. Prisma's generated SQL dropped the column instead, so it was hand-edited. Also makes `chartPreparedAt` nullable. |
| `20261029160000_booking_passenger_position` | `Passenger.position`, unique per booking (hand-written; the table was empty) |
| `20261029180000_payments` | `PaymentStatus` enum, `Payment` and `PaymentEvent` tables (new tables only, nothing existing changes) |
| `20261030090000_notification_outbox` | `NotificationType` and `OutboxStatus` enums, `OutboxMessage` table (new table only) |
| `20261030120000_cancellations_cascade` | `Refund` table, `RefundStatus` enum, new notification types, `OutboxMessage.payload`. Hand-edited: Prisma's SQL dropped `waitlistIssued`; this **renames** it to `waitlistBooked`, renumbers existing RAC/WL passengers to contiguous positions and recomputes the counters. |

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
| Email delivery | nodemailer → Mailpit in dev; fire-and-forget with error logging | **TODO:** move auth emails onto the outbox (8.10) too, so failed ones are retried and survive restarts. Booking emails already use it. |

### 8.4 Catalog (Phase 2)

| Decision | Choice | Why |
|---|---|---|
| Time model | `Train.departureMinutes` (minutes after midnight) + `RouteStop` times as minutes after origin departure | Overnight runs are plain addition, with no dates or midnight wrap in the data. The API formats them as `{ time: "08:50", day: 2 }`. |
| Running days | `Weekday[]` on `Train`; a schedule's `journeyDate` is the day it leaves the origin | Matches how Indian Railways defines a train's date. |
| Route edits | `PUT` replaces the whole stop list in one transaction; array order = sequence | No gaps or duplicate sequence numbers are possible, and readers never see a half-edited route. Cross-stop rules (times and distances increase, no repeated stations, origin/terminus shape) live in a Zod `superRefine` with per-field error paths. Locked once bookings exist. |
| Coach layouts | Admin sends `{ code, class }`; seats come from `seat-layout.ts` (SL/3A 72 in bays of 8, 2A 48, 1A 24, CC 78 at 3+2) | One source of truth for berth types, which berth preferences in booking depend on. Locked once schedules exist, because inventory was counted from them. |
| Inventory split | Per class: TATKAL 25%, LADIES 4%, SENIOR_CITIZEN 6%, GENERAL the remainder; in SL/3A/2A, 5% of GENERAL berths are held for RAC (2 passengers each) | **Simplification:** real quotas vary by train. Totals always add up to the coach berths (unit-tested). |
| Schedule generation | `createMany({ skipDuplicates })` on unique `(trainId, journeyDate)`, then inventory for schedules that have none; max 120 days per call; no past dates | Idempotent and safe if run twice at once: the unique index, not a prior check, prevents duplicates. |
| Money | `FareRule` per class, `baseFare + perKm × distance`, in paise | Integers avoid floating-point rounding. Seeded; no admin endpoint yet. |
| Admin routing | One `/admin` router with `authenticate` + `requireRole("ADMIN")` applied once | No admin route can be mounted without the guard. |
| Station search | `startsWith` on code, case-insensitive `contains` on name/city, max 10, exact code first | Good enough for a few thousand stations. Move to a `pg_trgm` index if search gets slow. |

### 8.5 Testing

- **Stack:** Vitest + Supertest, run with `npm test`. Supertest calls `buildApp()` in-process, with no port and no running server.
- **Database:** a separate `irctc_test` database, migrated once per run (`prisma migrate deploy` in `test/global-setup.ts`) and truncated before each test.
- **Isolation:** test files run serially because they share that database. Mail is mocked with `vi.mock`, so tests read tokens from the "sent" email. Rate limiters are off under `NODE_ENV=test`, except in the limiter's own test.
- **Coverage:**
  - Auth: registration, verification, login, rotation and reuse detection, concurrent refresh, reset, role guards.
  - Rate limiting.
  - Seat layouts and quota maths.
  - Search (intermediate stops, direction, boarding-date shift, quotas, cancelled schedules) and availability (AVL → RAC → WL, chart prepared, segment fares).
  - Booking: split CNF/RAC/WL parties, REGRET, berth preferences, idempotent retries (sequential and simultaneous), quota eligibility, hold expiry (sweeper and lazy release).
  - **Concurrency:** 30 simultaneous requests for the last berth → exactly 1 confirmed, WL 1–29 each issued once; GENERAL and TATKAL racing in one class never share a seat. Removing `FOR UPDATE` makes both tests fail (verified).
  - Catalog CRUD, route validation, and schedule generation (running days, idempotency, layout lock).
  - Payments, against an in-memory fake Razorpay (`setPaymentGateway`): order reuse, verify, forged signatures, a failed then successful attempt, capture of authorized payments, late payments refunded, a second paid order refunded, webhook signatures and redeliveries, reconciliation of lost callbacks, gateway outages, live keys refused.
  - **Payment races:** verify + two webhooks + reconciliation at once confirm once with no refund. A payment racing hold expiry ends either CONFIRMED with seats or EXPIRED and refunded, never confirmed without seats. Removing the booking-row `FOR UPDATE` makes that test fail (verified, 3 of 3 runs).
  - Tickets and emails: ticket content (CNF/RAC/WL notation, lakh-grouped rupees), PDF download (owner only, paid only), confirmation email with the PDF attached, refund email, retries with backoff, giving up after 8 attempts, recovery after an SMTP outage.
  - **Outbox race:** three workers delivering at once send each email exactly once. Removing `FOR UPDATE SKIP LOCKED` sends every email twice (verified, 3 of 3 runs).
  - Cancellations: refund rules (every time band, Tatkal, RAC/WL, IST departure times), the cascade (berth → RAC 1 → WL 1, positions moving up, berths back to the pool), partial cancellation, expired holds promoting the queue, unpaid cancellations, refunds surviving a Razorpay outage, no double refund after a crash, chart preparation (WL cancelled and refunded, RAC kept, booking closed, runs at the 4-hour mark, idempotent). Every scenario checks the queue invariants: positions 1..n, counters equal queue lengths, one berth per confirmed passenger.
  - Observability: the request context surviving awaits, `traceparent` parsing, per-run job ids, no field leaking between log lines, route-template labels (no PNRs), business counters, backlog gauges read from the database, the metrics token, readiness (database, healthy and stalled jobs), and the real Razorpay client against a stubbed `fetch` (auth header, body, ok / rejected / unavailable timing).
  - **Cancellation races:** 8 simultaneous cancellations leave the queues consistent, with berths going to the first in line; a double cancel refunds once; bookings racing cancellations keep the invariants. Removing the class lock from cancellation made 7 of 8 cancellations fail (verified, 3 of 3 runs).

### 8.6 API documentation

| Decision | Choice | Why |
|---|---|---|
| Format | OpenAPI 3.1, generated by `zod-openapi` from the Zod schemas; Swagger UI via `swagger-ui-express` | The docs are built from the same schemas that validate requests, so the documented input is the enforced input. |
| Source of truth | `src/docs/operations.ts` lists every endpoint (method, path, tag, auth, rate limit, request schemas, responses). Standard 400/401/403/429/500 responses are added automatically from those flags. | One place to read and update; nothing is hand-written in YAML. |
| Response shapes | `src/docs/responses.ts`, all `z.strictObject` | Strict schemas reject undocumented extra fields, so leaking a new field (e.g. a password hash) fails tests. |
| Verification | Tests wrap the app in a checker (`test/contract.ts`) that matches each response to its operation and fails the test if the status isn't documented or the body doesn't parse. `test/openapi.test.ts` compares the app's real routes, from the mount tables in `app.ts`, with the documented ones in both directions. | The docs stay correct without anyone remembering to check. Verified by deliberately breaking a schema, which made 9 tests fail. |
| Exposure | `/docs` and `/openapi.json` are served whenever `NODE_ENV !== "production"` | Production shouldn't advertise its full API surface by default. |

### 8.7 Search and availability (Phase 3)

| Decision | Choice | Why |
|---|---|---|
| Search date | `date` is the day the passenger **boards at `from`**. The schedule looked up is `date − dayOfRun`, where `dayOfRun = floor((train departure + stop departure) / 1440)`. | A passenger boarding at Ratlam at 01:33 thinks of "the 1st", even though that train left Delhi on the 31st. |
| Direction | A train matches only if its stop at `to` has a higher `sequence` than its stop at `from` | The same train stops at both stations in both directions' searches; only one is correct. |
| Query shape | 3 queries per search regardless of results: stations, `RouteStop` at `from` (with the train's stop at `to`), then schedules + quota inventory and fare rules in parallel | No N+1 queries. Uses the existing `RouteStop(stationId)` and `TrainSchedule(trainId, journeyDate)` indexes. Measured 10–26 ms warm on the seed data, against the 200 ms target. |
| Availability status | Pure function in `availability.ts`: `AVAILABLE` while berths remain, then `RAC n` (next RAC number) while `racBooked < racCapacity`, then `WL n` up to `WAITLIST_LIMIT` (100), then `REGRET`; `BOOKING_CLOSED` once the chart is prepared or the date has passed | The same order Phase 4 booking will allocate in; keeping it one function means search and booking can't disagree. |
| Fares | `baseFare + perKm × segment km`, Tatkal +30%, rounded **up** to a whole rupee; integer maths only | Integer paise avoid float drift (`10000 × 1.3 = 13000.000000000002`). **Simplification:** no reservation charge, GST, Tatkal min/max, or concessions. |
| Quotas | Search shows one quota (`quota`, default GENERAL); availability shows every quota of every class | Matches the IRCTC flow: list first, details per train. |
| Caching | **None yet.** Search reads Postgres directly. | Availability changes with every booking, and queries are already well under target. Redis caching (short TTL on the timetable part) is worth adding only once load tests show a need; cached counts must never be used to allocate (principle 6.2). |
| Not yet | Station-to-city search (all Delhi stations), Tatkal opening window, segment-wise inventory | Listed simplifications; see Section 3 for per-journey inventory. |

### 8.8 Seat allocation and holds (Phase 4)

| Decision | Choice | Why |
|---|---|---|
| Locking | `SELECT … FROM "SeatInventory" WHERE scheduleId, class ORDER BY quota FOR UPDATE` (raw SQL; Prisma has no `FOR UPDATE`), then read counters, allot, write, insert, all in one READ COMMITTED transaction | Bookings for one class of one train run one after another, so two can't read the same counter or the same free seat. **All quotas** of the class are locked because they share physical seats. `ORDER BY` fixes the lock order, which rules out deadlocks. |
| Last line of defence | Unique `(scheduleId, seatId)` on `SeatAllocation` | Even a locking bug can't put two passengers on one berth; the database refuses it. |
| Allotment | `allotPassengers()` in `availability.ts`, the same rule search displays: berth → RAC → waitlist, per passenger; whole booking refused (`REGRET`) if not everyone fits | One function, so search and booking never disagree. A party can be split (2 CNF + 1 RAC), as on IRCTC. |
| Seats | Only CONFIRMED passengers get a berth now: berth preference first, then the party kept in one coach. RAC/WL get numbers; berths come at cancellation or chart time (Phase 9). | Two RAC passengers share one berth, which `SeatAllocation` (one passenger per seat) doesn't model yet. |
| Quota rules | LADIES: women only. SENIOR_CITIZEN: men 60+, women and transgender 58+. TATKAL: max 4 passengers. All bookings max 6. | Validated in Zod with per-passenger error paths. **Simplification:** no Tatkal opening window, no child/infant fares. |
| Idempotency | Required `Idempotency-Key` header, stored as `userId:key` in the unique `Booking.idempotencyKey`. A repeat returns the original booking with 200. Simultaneous repeats: the loser's insert fails on the unique index, its transaction rolls back (no seats taken), and it returns the winner's booking. | A client that times out and retries can't book (and pay) twice. **Not yet:** rejecting a reused key with a *different* body (422). |
| Hold | `PENDING_PAYMENT` with `holdExpiresAt = now + 10 min` | The database timestamp is the source of truth; nothing is lost on restart. |
| Expiry | (1) **Lazy:** each booking first releases expired holds in the class it has locked. (2) **Sweeper:** `setInterval` every 15 s in the server process (`hold-expiry.ts`), one short transaction per schedule + class. Both use a conditional `updateMany(status = PENDING_PAYMENT)`, so only one of sweeper / payment / another instance wins. | Nobody is refused a seat an expired hold still sits on; search catches up within 15 s. Several instances can sweep at once safely. **TODO (BullMQ):** a delayed job per hold would make search exact too. |
| Release | Through the same cascade as cancellations (see 8.11): freed berths go to RAC 1 / WL 1 first, and only then back to `availableSeats`. | **Fixed in Phase 9:** previously freed berths went to the pool ahead of waiting passengers. |
| Rate limit | `POST /bookings`: 20 per minute per IP | Slows bots in a Tatkal rush; per-IP, in memory (move to Redis with several instances). |
| Performance | 60–100 ms per booking warm, on the seed data | Target is under 2 s. Load testing with hundreds of concurrent requests is roadmap step 11. |

### 8.9 Payments (Phase 5, Razorpay test mode only)

| Decision | Choice | Why |
|---|---|---|
| Test mode only | `RAZORPAY_KEY_ID` must start with `rzp_test_` or the server won't start. Keys are optional; without them payment endpoints answer 503 `PAYMENTS_NOT_CONFIGURED`. | No code path in this build can charge a real card. Going live later means deliberately relaxing one regex. |
| Gateway client | Plain `fetch` to Razorpay's REST API in `gateway.ts` (5 calls, 10 s timeout), behind a `PaymentGateway` interface | No SDK dependency; tests swap in a fake and never touch the network. Network errors and 5xx become 503 `PAYMENT_GATEWAY_UNAVAILABLE`, 4xx become 502. |
| Flow | `POST /bookings` holds seats → `POST /payments/orders` creates the order → checkout → `POST /payments/verify` | Ordering is a separate call, so a Razorpay outage never fails or rolls back a hold (resilience requirement), and no network call happens while seat locks are held. |
| One rule, three paths | Browser verify, webhook and reconciliation job all end in `settlePayment()` | The distributed-transaction problem (2.2): Razorpay can't be rolled back, so every step is repeatable and all paths reach the same result. |
| Authentication | Verify and webhook need no login; they're checked by HMAC-SHA256 signatures (key secret over `order_id|payment_id`; webhook secret over the **raw** body), compared in constant time | Only Razorpay knows those secrets. `express.json({ verify })` keeps the raw body, because re-serialised JSON wouldn't match. |
| Trusting the result | After the signature check, the payment is fetched from Razorpay; `authorized` payments are captured **before** the booking is confirmed | A signature proves Razorpay saw the payment, not that the money is ours. Capturing first means a booking is never confirmed without money. |
| Confirming | One transaction: `SELECT … FROM "Booking" … FOR UPDATE`; if still `PENDING_PAYMENT` and the amount matches: booking → `CONFIRMED`, payment → `CAPTURED`, other open orders → `EXPIRED` | The row lock makes a payment and the hold sweeper take turns. Only the booking row is locked (never inventory), so it can't deadlock with the sweeper. A hold past its time but not yet released still counts as held (at most ~15 s). |
| Money with nowhere to go | Hold already released, booking already paid, or wrong amount → payment `REFUND_PENDING` (in the same transaction), then a refund call after commit → `REFUNDED` | The debt is recorded before the network call, so a crash can't lose it. Razorpay's `amount_refunded` is checked first, and Razorpay refuses over-refunds, so nothing is refunded twice. |
| Webhook dedupe | `PaymentEvent` keyed by `x-razorpay-event-id`, written **after** handling | Saves repeat work; handling is idempotent anyway, and recording afterwards means a failed attempt (500) is retried rather than skipped. |
| Reconciliation | Every 60 s (`reconciliation.ts`): `CREATED` orders older than 1 minute are checked with Razorpay and settled if paid, or marked `EXPIRED` once their booking is gone; `REFUND_PENDING` refunds are retried. Batches of 50. | Covers a closed browser, a lost webhook (Razorpay can't reach localhost without a tunnel) and crashes mid-flow. |
| Duplicate orders | Re-opening checkout reuses the open order; two simultaneous requests may create two orders | Harmless: only one payment can confirm the booking; money on the other is refunded. |
| Not yet | Live mode; refunds on user cancellation (Phase 9); partial refunds; tying Razorpay order expiry to the hold; moving the jobs to BullMQ; webhook IP allow-listing | Out of scope for test mode. |

### 8.10 Tickets and confirmation emails (roadmap step 8)

| Decision | Choice | Why |
|---|---|---|
| PNR | Unchanged: assigned when seats are held (see Section 3); becomes a valid ticket on `CONFIRMED` | Already unique and stable; changing it at payment time would break links and emails sent earlier. |
| Ticket | `GET /bookings/:pnr/ticket.pdf`, rendered on each request with pdfkit from the current booking; owner only, `CONFIRMED` only (409 `TICKET_NOT_AVAILABLE`) | No stored files to keep in sync: after a cancellation or RAC/WL promotion (Phase 9) the next download is already right. Renders in a few milliseconds (~2.6 KB). |
| Content vs layout | `ticketContent()` (pure: labels, CNF/RAC/WL notation, `Rs. 1,23,456.78`) is separate from `renderTicketPdf()` | The content is checked directly in tests; the PDF test only checks it's a valid PDF. Built-in PDF fonts have no ₹ glyph, hence "Rs.". |
| Headers | `Content-Disposition: attachment`, `Cache-Control: private, no-store` | Downloads rather than opens; personal data never sits in a shared cache, and a stale status is never served. |
| Email reliability | **Transactional outbox**: an `OutboxMessage` row is written inside the transaction that confirms the booking (or records the refund). A worker every 10 s sends due rows. | Confirming (DB) and emailing (SMTP) can't be atomic. With the outbox, both commit or neither does, so a paid booking can never miss its ticket email, and an email is never sent for a confirmation that rolled back. |
| Claiming | One `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, which bumps `attempts` and sets a 5-minute lease in `nextAttemptAt` | Several instances can run the worker; each skips rows another has locked. The claim commits at once, so no transaction stays open during SMTP. If a worker dies mid-send, the lease runs out and another retries. |
| Retries | Backoff 30 s, 1 min, 2 min … capped at 1 h; `FAILED` after 8 attempts (logged as an error) | Rides out an SMTP outage without hammering the server; a permanently failing email is surfaced instead of retried forever. |
| Delivery guarantee | At-least-once | A crash between "SMTP accepted" and "marked SENT" resends the email. A duplicate ticket email is far less harmful than a missing one. |
| Email content | Built at send time from the current booking | A retry an hour later still sends correct details. A confirmation for a booking that's no longer `CONFIRMED` is skipped. |
| Refund email | Queued only when a late payment is refunded because the hold had ended | A duplicate payment on an already-confirmed booking is refunded quietly: the user already has a ticket. |
| PII | Logs carry message ids and errors, never addresses | Security requirement: no PII in logs. |
| Why not BullMQ (yet) | The outbox lives in Postgres | Enqueuing to Redis after the commit could still be lost in a crash between the two; the outbox can't. BullMQ can later be fed *from* the outbox if throughput needs it. |
| Not yet | QR code on the ticket; SMS; moving auth emails to the outbox; a "resend ticket" endpoint | Not needed for the core flow. |

### 8.11 Cancellations, refunds, RAC/WL promotion, chart preparation (roadmap step 9)

| Decision | Choice | Why |
|---|---|---|
| Queue numbers | `racNumber` / `waitlistNumber` are current positions, kept 1..n by one set-based `UPDATE … ROW_NUMBER() OVER (ORDER BY …)` after each change | IRCTC shows current status ("WL 3" means three ahead of you). One statement renumbers the whole queue, however many passengers moved, so the lock is held briefly (design goal in 2.3). |
| The cascade | `releasePassengers()` in `inventory.ts`, under the class lock: each freed berth → RAC 1 (else WL 1, else the pool); each freed RAC place → WL 1; then renumber and set the counters to the queue lengths | One function for user cancellations, expired holds and chart preparation, so the rules can't drift apart. It runs in the caller's transaction, so a cascade commits whole or not at all. |
| Concurrency | Cancellation takes the same class lock as booking, then the booking row (the row the payment path locks) | Bookings, cancellations and expiries for one class take turns, so no passenger is promoted twice and no berth handed out twice. The fixed order (class, then booking) rules out deadlocks; payments only lock the booking row. |
| Who moves up | Strictly by queue order within the same quota; unpaid (held) bookings keep their place | Same rule as IRCTC. Quotas have separate queues. |
| Promoted berth | Chosen with `pickSeats()` honouring the passenger's berth preference | Same seat-picking rule as at booking time. |
| Refund rules | `refund-rules.ts`, per passenger, by status at the moment of cancelling, from the **boarding station's** departure: RAC/WL fare − Rs. 60 clerkage (until 30 min before); confirmed: flat charge per class (> 48 h), 25% (12–48 h), 50% (4–12 h), nothing after; confirmed Tatkal nothing | Modelled on Indian Railways' e-ticket rules. **Simplified:** no GST on charges, no TDR claims, the same rules for every train type. |
| Time zone | Timetable times are IST (UTC+05:30); `departureInstant()` turns them into absolute times | "48 h before departure" needs the real instant, not a calendar date. |
| Partial cancellation | `DELETE /bookings/:pnr?passengers=2,3` for paid bookings; the booking becomes `CANCELLED` when nobody is left | Families often drop one member. An unpaid booking is cancelled whole, because its open payment order is for the whole party. |
| Refund durability | A `Refund` row (amount, reason) is written in the cancellation's transaction; paid out right after commit; retried by the reconciliation job | Same pattern as the outbox: the debt is recorded before any network call, so a crash can't lose it. |
| No double refunds | Each Razorpay refund carries our Refund id in `notes`; before refunding, the payment's refunds are listed and matched on it | If we crash after Razorpay refunded but before saving it, the retry finds the earlier refund instead of refunding again (tested). |
| Chart preparation | A job every minute prepares charts due 4 h before the train leaves its **origin**: (1) conditional `SCHEDULED → CHART_PREPARED`, (2) per class, under the class lock, cancel every waitlisted passenger with refund. Also `POST /admin/schedules/:id/chart`. | Booking re-checks the schedule status after taking the class lock, so a booking either ran before its class was cleared (and is cleared with it) or is refused: nobody can join a cleared waitlist. One short transaction per class. |
| After the chart | RAC passengers stay on the chart; a confirmed passenger cancelling still upgrades RAC 1 (refund per the rules, which give nothing in the last 4 h) | Matches the railway: vacated berths go to RAC passengers on board. |
| Emails | `BOOKING_CANCELLED` (per-passenger refund breakdown, in the outbox payload) and `STATUS_CHANGED` (passengers promoted WL → RAC or RAC → CNF, with a fresh ticket), both via the outbox | Users learn about promotions without polling. Unpaid bookings get no email (nothing paid, and the confirmation will show the status). |
| RAC berths | RAC passengers still have no berth number | Two RAC passengers share one side-lower, which `SeatAllocation` (one passenger per seat) doesn't model. **Not yet.** |
| Not yet | Segment-wise vacancy (a berth freed after an intermediate station), TDR, GST on charges, concessions | Listed simplifications. |

### 8.12 Observability: logs, metrics, tracing, alerts (roadmap step 10)

| Decision | Choice | Why |
|---|---|---|
| Request context | `AsyncLocalStorage` (`context.ts`), entered right after pino-http assigns the request id; the logger's `mixin` adds `requestId` + `traceId` to every line | Previously only pino-http's own "request completed" line had the id; warnings logged inside services (refresh-token reuse, refunds failing) didn't, so they couldn't be tied to a request. Now one id finds everything. |
| Mixin copy | `logFields()` returns a fresh object each time | Found in the live check: pino merges each call's fields into the mixin's result, so returning the stored context leaked one warning's `userId` into every later line of that request. Covered by a test. |
| Tracing | W3C `traceparent`: an incoming trace id is continued (echoed with a new span id), otherwise one is created; it's on every log line | Joins our logs with a load balancer's or frontend's trace. **Not** full distributed tracing: no spans exported. OpenTelemetry (SDK + collector + Jaeger/Tempo) is the next step if per-query timing across services is needed; with one service, request ids plus metrics cover most of it. |
| Background jobs | Each run has `job` + a fresh `runId` in its log context, is timed and counted, and records its last success | A failing or stalled job is visible in logs, metrics and `/health/ready`. |
| Metrics | `prom-client`, all defined in `metrics.ts`, served at `GET /metrics` | Prometheus is the standard pull model: nothing to push, and Prometheus itself detects a dead instance (`up == 0`). |
| Labels | Route **templates** (`/bookings/:pnr`), status codes, outcomes; never PNRs, user ids or URLs. Job label is `task` | Each label value is a separate time series, so unbounded values would exhaust Prometheus. Found in the live check: a label named `job` collides with Prometheus' own target label and is renamed `exported_job`, which would have broken the job alerts. |
| What's measured | HTTP latency/status per route; error codes; bookings held/replayed; passengers allotted, promoted, cancelled; payments settled; refunds; emails; charts; Razorpay call latency by operation and outcome (ok / rejected / unavailable); job runs, duration, last success; process CPU, memory, event-loop lag | Covers the four golden signals (latency, traffic, errors, saturation) plus the business flows that must never silently stop. |
| Backlog gauges | Pending/failed emails, oldest pending email, refunds owed (cancellation and unusable-payment), oldest refund owed: read from Postgres at scrape time | Always current and survive restarts, unlike in-memory counters. A failed read keeps the last value instead of breaking the scrape. |
| Metrics access | `METRICS_TOKEN` bearer (constant-time compare); open in dev/test; not served in production without a token | Metrics reveal traffic and business volume. |
| Health | `/health` liveness (no dependencies); `/health/ready` checks the database (2 s timeout, 503 if down) and reports jobs that haven't succeeded for 3 intervals as `degraded` | A restart can't fix a database outage, so liveness ignores it; readiness takes the instance out of the load balancer instead. |
| Alerts | 10 rules in `ops/prometheus/alerts.yml` (validated with `promtool`): ApiDown, HighErrorRate (> 2% 5xx), SlowBookings (p95 > 2 s), SlowSearch (p95 > 200 ms), PaymentGatewayErrors (> 10%), RefundsStuck (> 30 min), EmailsFailed, EmailBacklog (> 10 min), JobFailing, JobStale (> 5 min) | Each maps to a requirement (performance targets, durability of money, notification delivery). Latency alerts need a minimum rate (found live: with ~30 requests, one cold-start request decided the p95). Verified live: stopping the API made ApiDown fire after ~90 s. |
| Local stack | `prometheus` service in docker-compose (`prom/prometheus:v3.5.0`) scraping `host.docker.internal:3000` | See alerts work end to end on a laptop. **Not yet:** Alertmanager (routing to email/Slack/PagerDuty) and Grafana dashboards. |
| Metric accuracy note | Promotions are counted inside the cascade's transaction, so they can overcount if it rolls back; everything else is counted after commit | Rare, and only affects a counter, never data. |

