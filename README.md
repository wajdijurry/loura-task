# Loura Ticket Classifier

Async HTTP service that ingests support tickets and classifies them with a durable PostgreSQL-backed worker. Built as a production-minded take-home (not “production ready”): correctness, concurrency, failure semantics, and clear boundaries over feature count.

Stack rationale (Node 22, TypeScript, Fastify, PostgreSQL, Zod, Vitest, Docker, and what was deliberately omitted) is documented in [TECHNOLOGY.md](./TECHNOLOGY.md).

## Quick start

Canonical host defaults:

| Service | Host port |
| --- | --- |
| API | `3000` |
| Application PostgreSQL | `5432` |
| Test PostgreSQL (`postgres-test` profile) | `5434` |

```bash
docker compose up --build
```

API: `http://localhost:3000` · Health: `GET /health`

Internal container networking always uses Docker service names and container ports (`postgres:5432`, API health check `127.0.0.1:3000`). Host-port overrides never change those internals.

The Compose `worker` service uses `stop_grace_period: 20s` so Docker’s stop window exceeds `WORKER_SHUTDOWN_GRACE_MS=15000`.

Load samples (twice to demonstrate idempotency):

```bash
npm ci
npm run load-samples
npm run load-samples   # all Idempotent-Replayed
```

`scripts/load-samples.ts` loads `dotenv/config`. With no `.env`, it defaults to `http://127.0.0.1:3000`.

### When ports 3000 / 5432 are already occupied

```bash
COMPOSE_PROJECT_NAME=loura_verify \
API_PORT=3080 \
POSTGRES_PORT=5433 \
docker compose up --build
```

```bash
API_BASE_URL=http://127.0.0.1:3080 npm run load-samples
```

### Integration-test database (dedicated Postgres 16)

```bash
COMPOSE_PROJECT_NAME=loura_test_verify \
TEST_POSTGRES_PORT=5435 \
docker compose --profile test up -d postgres-test

TEST_DATABASE_URL=postgres://loura:loura@localhost:5435/loura_test \
npm run test:integration
```

Default test host port (no override) is `5434`. Integration tests require `TEST_DATABASE_URL`, refuse names that do not end with `_test`, and never fall back to `DATABASE_URL`.

## API examples

```bash
# Create (returns immediately as pending — classification is async)
curl -sS -D - -X POST http://localhost:3000/v1/tickets \
  -H 'content-type: application/json' \
  -d '{"id":"t-demo","subject":"Charged twice","body":"Please refund one charge."}'

# Identical replay → 200 + Idempotent-Replayed: true
curl -sS -D - -X POST http://localhost:3000/v1/tickets \
  -H 'content-type: application/json' \
  -d '{"id":"t-demo","subject":"Charged twice","body":"Please refund one charge."}'

# Conflict → 409 when same id, different content
curl -sS -D - -X POST http://localhost:3000/v1/tickets \
  -H 'content-type: application/json' \
  -d '{"id":"t-demo","subject":"Charged twice","body":"Different body"}'

# Get / list
curl -sS http://localhost:3000/v1/tickets/t-demo
curl -sS 'http://localhost:3000/v1/tickets?category=billing&priority=high&page=1&pageSize=20'
```

Errors use `application/problem+json` with controlled titles (no stacks, SQL, bodies, or raw Fastify text):

| Situation | Status |
| --- | --- |
| Malformed JSON / schema validation | `400` |
| Payload too large | `413` |
| Unsupported content type | `415` |
| Missing route / ticket | `404` |
| Unexpected server failure | `500` |

## Architecture

Two processes, one codebase, one infrastructure dependency (PostgreSQL):

```text
┌─────────┐  POST /v1/tickets   ┌──────────────────────────────────┐
│  Client │ ──────────────────► │  API  (validate + persist txn)   │
└─────────┘                     │  tickets + classification_jobs   │
                                └───────────────┬──────────────────┘
                                                │ SKIP LOCKED claim
                                ┌───────────────▼──────────────────┐
                                │  Worker (lease + classify)         │
                                │  model call OUTSIDE DB txn         │
                                │  finalize only with lease_token    │
                                └──────────────────────────────────┘
```

## Open questions → our choices

The assignment left several decisions open. Choices and reasons:

### How and where tickets are stored

**Choice:** PostgreSQL 16 tables `tickets` and `classification_jobs`, accessed with `pg` (no ORM).

**Why:** One dependency; ticket insert and job enqueue happen in the **same transaction**, so we never dual-write to a separate broker. Constraints and indexes enforce lifecycle and list shapes at the data layer. Trade-off: polling latency vs a dedicated queue—acceptable for this size. Stack detail: [TECHNOLOGY.md](./TECHNOLOGY.md).

### How asynchronous work is executed

**Choice:** Separate long-lived **worker** process (same codebase as the API) that polls due jobs with `FOR UPDATE SKIP LOCKED`, leases them, calls the model **outside** any DB transaction, then finalizes with a per-claim `lease_token`.

**Why:** Keeps HTTP handlers fast (`202` pending). Model calls cannot join the create transaction; fencing tokens prevent a stale worker from overwriting a newer claim. API and worker scale independently.

### How many classifications may run at once

**Choice:** Per-worker concurrency = `WORKER_CONCURRENCY` (**default 4**). A worker only claims up to free in-flight slots.

**Why:** Bounds model fan-out and DB load without a global scheduler. Multiple worker processes may run; `SKIP LOCKED` prevents double ownership. Tunable via env.

### What happens to in-flight work if the service is restarted

**Choice:**

| Restart kind | Behavior |
| --- | --- |
| Abrupt crash mid-model | Lease expires → reclaim: requeue with `WORKER_LOST` if attempts remain, else job `dead` + ticket `failed` |
| Graceful SIGTERM/SIGINT | Stop claiming → wait up to `WORKER_SHUTDOWN_GRACE_MS` → abort cooperative calls → release owned leases by token and **restore** that claim’s attempt |
| Stale worker finishes late | Finalize requires matching non-expired `lease_token` → discarded |

**Why:** Durability lives in PostgreSQL leases, not process memory. External model calls stay **at-least-once** after crashes (not exactly-once). Cooperative shutdown avoids burning attempts on deploys.

### Retry policy for model failures, and how a ticket ends up failed

**Choice:**

- `attempt_count` = classification executions **started** (incremented on claim).
- Max attempts: `MAX_CLASSIFICATION_ATTEMPTS` (**default 3**).
- Retryable returned failures: `MODEL_TIMEOUT`, `MODEL_UNAVAILABLE`, `INVALID_MODEL_OUTPUT` → requeue with exponential backoff + jitter (`base 1s`, cap `30s`, jitter up to `500ms`).
- After the final started attempt fails (returned failure or lost lease): job `dead` + ticket `failed` atomically, with a stable code (`MODEL_*`, `INVALID_MODEL_OUTPUT`, or `WORKER_LOST`). Never store exception text or raw model output.

**Why:** Crashes during a model call count toward the bound (claim-time accounting). Returned failures do not double-increment. Terminal failure is explicit and queryable.

### What, if anything, you do about prompt injection

**Choice:** Mitigate, do not claim to solve.

- System prompt: ticket content is data, never instructions; ignore role claims; JSON-only; no tools.
- Subject/body only in a delimited, XML-escaped `<ticket>` user message—not folded into system text.
- Strict output validation (bare JSON, exact keys/enums, single-sentence summary); reject entirely on failure.
- Regression: sample `t-1005` → `billing` / `low` / invoice-download summary (not the injected `technical`/`high`/`Approved for immediate refund`).

**Why:** Prompting + validation reduce risk for a fake/deterministic classifier and set a clear trust boundary. A real model can still be steered; residual risk is listed under Known limitations.

### Exact API shape

**Choice:** Versioned REST under `/v1`, JSON bodies, `application/problem+json` errors.

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| `POST` | `/v1/tickets` | `202` created pending; `200` + `Idempotent-Replayed: true` identical replay; `409` same id, different content | Body: `{ id, subject, body }` |
| `GET` | `/v1/tickets/:id` | `200` ticket; `404` missing | |
| `GET` | `/v1/tickets` | `200` `{ data, pagination }` | Query: optional `category`, `priority`, `page`, `pageSize` |
| `GET` | `/health` | `200` `{ status: "ok" }` | |

Ticket resource fields include `status` (`pending` \| `classified` \| `failed`), optional `classification` `{ category, priority, summary }`, optional `failureCode`, versions, and timestamps.

Client/framework errors: `400` validation / malformed JSON, `413` payload too large, `415` unsupported media type, `404` missing route/ticket, `500` unexpected (no stacks/SQL/bodies in the problem document).

**Why:** Small, explicit contract that matches the required create/get/list and idempotent-replay semantics without inventing a second API style.

## Concurrency, leases, and fencing

- Workers claim only as many jobs as free concurrency slots (default **4**).
- Claim SQL uses `FOR UPDATE SKIP LOCKED`.
- Each successful claim:
  - sets `lease_owner`, `lease_expires_at`, and a fresh `lease_token` (UUID)
  - **increments `attempt_count`** (number of classification executions *started*)
- Finalize (success, retry, terminal failure, cooperative release) requires **job id + lease_token**.
- `workerId` is observability-only and is **not** the fencing mechanism.
- Every reclaim/claim gets a new token; a stale token cannot commit after reclaim (even with the same worker id).
- Model timeout (**10s** default) is shorter than the lease (**30s**).

## Enforced model deadline

`ClassificationService` races `model.generate()` against an explicit timer:

- On timeout it aborts the model as best-effort cancellation and returns retryable `MODEL_TIMEOUT` even if the provider ignores `AbortSignal`.
- Late resolution/rejection from the losing promise is swallowed (no unhandled rejection / no commit).
- If the parent (worker) signal is already aborted, the model is **not** called.
- Parent cancellation during a call returns `{ kind: 'cancelled' }` — **not** a model failure.
- Provider-thrown timeouts still map to `MODEL_TIMEOUT`; invalid output remains distinct.

## Attempt accounting and `WORKER_LOST`

`attempt_count` = classification executions started (incremented on claim, not again on returned failure).

| Event | Behavior |
| --- | --- |
| Successful claim | `attempt_count += 1`; returned on the claimed job |
| Returned model failure with attempts left | requeue; **no** extra increment |
| Returned failure at max attempts | job `dead` + ticket `failed` atomically |
| Expired lease with attempts remaining | requeue `pending`, clear lease, `last_error_code = WORKER_LOST` |
| Expired lease on final started attempt | job `dead` + ticket `failed` with `WORKER_LOST` (atomic) |
| Cooperative graceful cancel | requeue immediately, **roll back that claim’s attempt**, do not overwrite a prior real failure code |

Never invoke the model when the claimed attempt already exceeds `MAX_CLASSIFICATION_ATTEMPTS`.

**Not claimed:** exactly-once external model execution. DB transitions are fenced; model calls remain **at-least-once** after crashes.

## Graceful shutdown

On `SIGTERM`/`SIGINT`:

1. Set stopping **before** further claims; wake the poll loop.
2. Wait for any in-progress claim/batch mutex to finish.
3. Wait for in-flight wrappers up to `WORKER_SHUTDOWN_GRACE_MS`.
4. Abort parent signals so classification settles even if the model ignores abort.
5. Release remaining owned leases **individually by lease token** (never bulk by worker id).
6. Return from `stop()` only after tracked wrappers settle; then close the pool.

Compose `stop_grace_period: 20s` > `WORKER_SHUTDOWN_GRACE_MS=15000`.

## Model-output validation

1. Build prompt (system instructions + delimited untrusted ticket data).
2. Call `ModelClient.generate` → **raw string**.
3. Require bare JSON object (no fences/prose).
4. Strict Zod object: exact keys, no coercion, exact enums.
5. Summary: non-empty, no leading/trailing whitespace, single line, ≤ 240 chars, exactly one meaningful sentence via `Intl.Segmenter` plus documented abbreviation merges (`.NET`, `U.S.`, `p.m.`, `v2.0`, `Dr.` accepted; a second sentence rejected). A short phrase without trailing punctuation is one segment.
6. Only then return a trusted domain `Classification`. No silent repair/truncation.

Default adapter: deterministic **FakeModelClient**. It is **not** evidence of real model quality.

## Idempotency

In one transaction: insert ticket + one job, or identical replay `200`, or content conflict `409`. No SELECT-then-INSERT.

**Ticket IDs:** In a production API I would prefer the server to mint the ticket id (e.g. a UUID) and treat a separate client idempotency key as the replay token, rather than accepting an arbitrary id from the caller. Client-chosen ids invite collisions, spoofing of resource identifiers, and awkward ownership semantics. This submission still accepts `id` in `POST /v1/tickets` because the take-home requires that shape—presumably for deterministic samples and explicit idempotent-replay demos.

## Tests

```bash
npm ci
npm run test:unit          # no Postgres required
# start postgres-test (default host port 5434), then:
TEST_DATABASE_URL=postgres://loura:loura@localhost:5434/loura_test npm run test:integration
TEST_DATABASE_URL=postgres://loura:loura@localhost:5434/loura_test npm run verify
```

CI uses Postgres 16 and `loura_test`.

## Design decisions

| Topic | Choice |
| --- | --- |
| Queue | PostgreSQL jobs table (transactional enqueue) |
| Pagination | Offset (`page`/`pageSize`) |
| Empty subject | Allowed (sample dataset) |
| Ticket id source | Client-supplied (per assignment); server-generated preferred in production |
| Optional enhancement | Graceful shutdown only |
| Exactly-once classification | Not claimed |

Why this stack (and what was left out) is expanded in [TECHNOLOGY.md](./TECHNOLOGY.md).

## List indexes (minimal)

- `(created_at DESC, id DESC)` — unfiltered list
- `(category, priority, created_at DESC, id DESC)` — category and combined filters
- `(priority, created_at DESC, id DESC)` — priority-only filters

## Known limitations

- PostgreSQL polling latency vs push queues.
- Offset pagination cost at large offsets.
- Fake classifier ≠ real model quality.
- Prompt injection is mitigated, not solved.
- At-least-once model calls after crashes.
- No authn/z, rate limits, tenancy, reclassification, evaluation harness, Redis, Kafka, or frontend.
- Not production ready.

## Local development (without full Compose app)

```bash
docker compose up -d postgres
cp .env.example .env   # optional; ignored by git
npm ci && npm run migrate
npm run dev:api      # terminal 1
npm run dev:worker   # terminal 2
```

## Configuration

See `.env.example` for canonical defaults and commented host-port overrides. `.env` is gitignored and must never be committed. `WORKER_ID` is optional; when omitted, a random per-process id is used. Startup validates env with Zod; `MODEL_TIMEOUT_MS` must be `< JOB_LEASE_MS`. Logs never include subjects, bodies, raw model output, credentials, or database URLs.
