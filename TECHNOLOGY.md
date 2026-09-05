# Technology choices

This document explains why the stack was chosen for the Loura take-home. The goal was a small, defensible service that demonstrates correctness under concurrency and failure—not a large platform.

## Runtime and language

**Node.js 22 + TypeScript (strict)**

- Node 22 matches a current LTS-oriented baseline and provides solid `AbortSignal`, `fetch`, and `Intl.Segmenter` support used by the classification deadline and summary rules.
- TypeScript with strict checking makes ticket/job state machines and fencing tokens harder to misuse than loosely typed JavaScript.
- A single language across API, worker, scripts, and tests keeps the submission small and reviewable.

## HTTP API

**Fastify 5**

- Low-overhead HTTP server with first-class schema/error hooks, suitable for a thin ingestion API.
- `inject()` enables fast API tests without binding a real port.
- Request IDs and structured logging integrate cleanly with Pino.
- Framework-level client errors (malformed JSON, payload size, media type, missing routes) are mapped to controlled `application/problem+json` responses rather than leaking raw stack or parser text.

## Persistence and job queue

**PostgreSQL 16 + `pg`**

- One infrastructure dependency: tickets and classification jobs share the same transactional boundary on create (no dual-write between a DB and an external broker).
- `FOR UPDATE SKIP LOCKED` gives safe multi-worker claiming without Redis/Kafka for this scale.
- CHECK constraints and indexes enforce lifecycle and list-query shapes at the data layer.
- Trade-off accepted deliberately: poll latency and weaker queue scalability than a dedicated broker.

**node-pg-migrate**

- Forward-only SQL migrations as versioned files, runnable in Compose, CI, and local scripts.
- Keeps schema changes reviewable (including lease tokens, failure codes, and list indexes) without an ORM migration maze.

**No ORM**

- Explicit SQL for claim/reclaim/finalize paths makes lease fencing and attempt accounting visible in review.
- Avoids hidden N+1 queries and opaque transaction semantics around `SKIP LOCKED`.

## Validation and configuration

**Zod**

- Runtime validation for request bodies/queries and model JSON after the fake provider returns a raw string.
- Same library validates process environment at startup (`MODEL_TIMEOUT_MS < JOB_LEASE_MS`, non-empty worker id defaults, etc.).
- Strict object parsing (exact keys, no coercion) matches the “never trust model output” boundary.

## Logging

**Pino**

- Structured JSON logs suitable for containers and CI.
- Child loggers carry job/ticket/worker ids without logging ticket bodies, subjects, or raw model text.

## Classification boundary

**`ModelClient` port + deterministic `FakeModelClient`**

- The application depends on a narrow generate interface, not a vendor SDK.
- A fake, content-heuristic model keeps the submission free of API keys while still exercising async classification, retries, timeouts, and prompt-injection regression (`t-1005`).
- Not a claim about real LLM quality; a production provider would plug into the same port.

## Testing and quality

**Vitest**

- Fast unit tests without Postgres; separate integration project against real PostgreSQL 16 via `TEST_DATABASE_URL`.
- Fail-closed if the test database is missing or not named `*_test`—never truncate the app DB by accident.

**ESLint + Prettier + `tsc --noEmit`**

- Consistent style and typechecking as part of `npm run verify`, matching a senior submission bar without heavyweight frameworks.

## Packaging and ops

**Docker Compose + multi-stage Dockerfile**

- Reproducible Postgres 16, migrate, API, and worker processes from one codebase.
- Host-port overrides (`API_PORT`, `POSTGRES_PORT`, `TEST_POSTGRES_PORT`) without changing container-internal ports.
- Worker `stop_grace_period` aligned above application shutdown grace so SIGTERM can drain cooperatively.

**dotenv (optional)**

- Local scripts (sample loader, Vitest) can read `.env` when present; Compose and CI supply env explicitly.
- `.env` is gitignored; `.env.example` documents canonical defaults only.

## Explicitly not chosen

| Technology | Why not |
| --- | --- |
| Redis / Kafka / SQS | Extra moving parts; PostgreSQL already provides durable enqueue + locking for this size |
| Express | Fastify’s inject/hooks and lower overhead fit the thin API better |
| Prisma / TypeORM | Claim/lease SQL needs to stay explicit for fencing and attempt semantics |
| Real LLM API | Secrets, flakiness, and cost obscure concurrency correctness |
| Frontend / auth / multi-tenant | Out of scope for the assignment |

For product behavior, failure semantics, and limitations, see [README.md](./README.md).
