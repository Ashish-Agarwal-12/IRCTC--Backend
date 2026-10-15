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
