# Load and failure test report

2026-10-29T22:02:59.208Z · Node v24.11.0 · win32 · server and Postgres on one machine

## 500 concurrent requests for the last seat

- All 500 sent at once; the last answer came after 38887 ms.
- requests 500 · p50 31177 ms · p95 38127 ms · p99 38686 ms · max 38818 ms · {"201":101,"409 REGRET":399}
- Database afterwards: 1 confirmed passenger, 1 berth allocated, waitlist 1–100 (100), 399 REGRET.

| Check | Result | Detail |
|---|---|---|
| exactly one request wins the berth | PASS | 1 confirmed, 1 allocated |
| waitlist numbers 1..100, each issued once | PASS | 100 issued |
| every request got a definite answer (held or REGRET) | PASS | 101 held + 399 REGRET |
| no 5xx or dropped connections | PASS | 0 errors {} |
| invariants hold | PASS | ok |

## Latency against the targets (search < 200 ms, booking < 2 s)

- Search, 20 concurrent clients for 15 s: requests 577, 38/s · p50 471 ms · p95 912 ms · p99 1073 ms · max 1137 ms · {"200":577}
- Booking across trains/classes, 20 concurrent clients for 15 s: requests 157, 10/s · p50 1986 ms · p95 2321 ms · p99 2645 ms · max 2828 ms · {"201":157}
- Rush on one train + class, 100 concurrent clients for 15 s: requests 210, 14/s · p50 8156 ms · p95 12928 ms · p99 13842 ms · max 14049 ms · {"201":210}
- Server event-loop delay during the rush: max 277 ms (Prisma 7 builds queries in JS, on the same thread).
- Search (5 clients) while 100 clients rush one train: requests 727, 48/s · p50 70 ms · p95 260 ms · p99 405 ms · max 672 ms · {"200":727}

| Check | Result | Detail |
|---|---|---|
| search p95 under 200 ms | target missed | p95 912 ms |
| booking p95 under 2 s (spread load) | target missed | p95 2321 ms |
| every spread booking held or REGRET, no errors | PASS | {"201":157} |
| booking p95 under 2 s (rush on one train) | target missed | p95 12928 ms |
| every rush booking held or REGRET, no errors | PASS | {"201":210} |
| search during a rush stays under 200 ms p95 | target missed | p95 260 ms (alone: 912 ms) |
| invariants hold after the load | PASS | ok |

## kill -9 in the middle of 200 concurrent bookings

- 25 requests answered 201 before the kill, 175 connections cut. 40 bookings exist afterwards.
- Restarted; checked every inventory row, queue and berth.

| Check | Result | Detail |
|---|---|---|
| the crash hit mid-burst (some answered, some cut) | PASS | 25 answered, 175 cut |
| every answered booking survived | PASS | 40 stored ≥ 25 answered |
| no half-written bookings; counters, queues and berths consistent | PASS | ok |

## Database frozen for 8 s under steady traffic (docker pause)

- During the freeze: requests 42 · p50 332 ms · p95 10686 ms · p99 10710 ms · max 10710 ms · {"200":21,"201":21}
- /health/ready during the freeze: 503 after 2007 ms; afterwards: 200.
- First success 0 ms after the database came back. From 3 s after: requests 144 · p50 257 ms · p95 1444 ms · p99 1992 ms · max 2070 ms · {"200":69,"201":75}

| Check | Result | Detail |
|---|---|---|
| readiness reports the outage (503) | PASS | 503 |
| the server survives and recovers on its own (no restart) | PASS | {"200":69,"201":75} |
| readiness is back to 200 | PASS | 200 |
| no corrupted data | PASS | ok |
