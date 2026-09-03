# nextjs-webhook-engine-lite

> ⚡ **Need turnkey Stripe, Lemon Squeezy, and Clerk integration?**  
> Check out [**Next.js Webhook Engine Pro ($39)**](YOUR_LEMON_SQUEEZY_PRODUCT_URL) — Instant `.zip` download with dynamic multi-provider routing (`/api/webhooks/[provider]`), zero-downtime secret rotation, Prisma SQL + Redis distributed locking, and the automated CLI attack simulator.

---

Production reference architecture for high-throughput, secure webhook ingestion on serverless runtimes using the Next.js 15 App Router and Upstash Redis REST.

## Architectural Problem Statement

Serverless webhook handlers encounter three recurring failure modes:
1. **Stream Lockout:** Calling `req.json()` locks the incoming `ReadableStream`. Re-serializing parsed objects mutates key order and whitespace, causing HMAC digest mismatches.
2. **Timing Attacks & Buffer Panics:** Standard string equality (`a === b`) leaks character matching times. Calling `crypto.timingSafeEqual()` on mismatched buffer lengths throws an unhandled `RangeError` in Node.js, crashing the worker.
3. **Lambda Concurrency Collisions:** Rapid provider retries dispatch identical event IDs across independent, stateless Lambda instances. Traditional relational databases and stateful TCP connection pools face connection exhaustion during sudden traffic spikes.

`nextjs-webhook-engine-lite` resolves these vectors through single-pass raw streaming, byte-length-guarded constant-time verification, and stateless HTTP Redis idempotency primitives.

---

## Data Flow Pipeline

```text
HTTP POST /api/webhooks
       │
       ▼
[req.text() Stream Ingestion] ────────► Raw Byte Stream Preserved
       │
       ▼
[Timing-Safe HMAC Check]      ────────► Mismatch / Forgery: 401 Unauthorized
       │ (Pass)
       ▼
[Safe JSON Deserialization]   ────────► Malformed JSON / Missing ID: 400 Bad Request
       │ (Valid event.id)
       ▼
[Redis SET NX Lock Boundary]
       ├──► Key "webhook:done:{id}" exists ───► 200 OK ({ status: "already_processed" })
       ├──► Key "webhook:lock:{id}" exists ───► 202 Accepted ({ status: "concurrent_request_ignored" })
       └──► Lock Acquired (TTL 60s)
                 │
                 ▼
       [Execute Business Logic]
                 │
                 ├──► [Success] ──► Atomic Redis Pipeline:
                 │                    - SET webhook:done:{id} (EX 7 Days)
                 │                    - DEL webhook:lock:{id}
                 │                  Return 200 OK ({ status: "success" })
                 │
                 └──► [Error]   ──► DEL webhook:lock:{id} (Unblock Provider Retries)
                                    Return 500 Internal Server Error
```

---

## State Machine

| Event Scenario | `webhook:lock:{id}` | `webhook:done:{id}` | HTTP Status | Response Status | System Action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **First Delivery** | None | None | 200 OK | `"success"` | Lock acquired, handler executes, retention committed, lock evicted. |
| **Concurrent Race** | Present (`"1"`) | None | 202 Accepted | `"concurrent_request_ignored"` | Execution bypassed. Prevents duplicate side-effects. |
| **Subsequent Replay** | None | Present (`"1"`) | 200 OK | `"already_processed"` | Execution bypassed. Retains idempotency for 7 days. |
| **Handler Failure** | Present (Released) | None | 500 Error | `"Internal processing error"` | Lock purged immediately to allow upstream provider retries. |
| **Tampered Request** | Unchecked | Unchecked | 401 Unauthorized | `"Invalid cryptographic signature"` | Execution halted before JSON parsing or lock allocation. |

---

## Quickstart

### 1. Installation

```bash
git clone [https://github.com/your-org/nextjs-webhook-engine-lite.git](https://github.com/your-org/nextjs-webhook-engine-lite.git)
cd nextjs-webhook-engine-lite
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env.local
```

```env
# Optional for local dev: The engine automatically falls back to an internal
# in-memory TTL store if credentials are missing or placeholders.
UPSTASH_REDIS_REST_URL="[https://example.upstash.io](https://example.upstash.io)"
UPSTASH_REDIS_REST_TOKEN="your-database-token"
WEBHOOK_SECRET="local_dev_secret_key_12345"
```

### 3. Run Development Server

```bash
npm run dev
```

### 4. Execute Multi-Stage Verification Suite

In a separate terminal, test the cryptographic and concurrency boundaries:

```bash
npm run test:attack
```

---

## Architectural Edition Comparison

| Capability | Lite (Open Source) | Pro ($39 Commercial Bundle) |
| :--- | :--- | :--- |
| **Target Framework** | Next.js 14/15 App Router | Next.js 14/15 App Router |
| **Routing Architecture** | Single manual route (`/api/webhooks`) | Dynamic Catch-All (`/api/webhooks/[provider]`) |
| **Supported Providers** | Generic HMAC SHA-256 implementation | **Stripe, Lemon Squeezy, Clerk (Svix)** |
| **Key Management** | Single static secret key | **Zero-Downtime Comma-Delimited Secret Rotation** |
| **Idempotency Adapters**| Upstash Redis REST + Memory Fallback | **Upstash Redis REST + Prisma ORM (PostgreSQL, SQLite, MySQL) + Memory** |
| **Testing Harness** | Single-endpoint attack simulation | **Automated Multi-Provider CLI Attack Simulator (`scripts/test-webhook.ts`)** |
| **Delivery Model** | Public Git Repository | **Production `.zip` Archive + Drop-in Ready Source** |
| **License** | MIT | Commercial Developer License (Unlimited Personal & Client Projects) |

👉 **[Upgrade to Next.js Webhook Engine Pro ($39) — Instant .ZIP Access](YOUR_LEMON_SQUEEZY_PRODUCT_URL)**
