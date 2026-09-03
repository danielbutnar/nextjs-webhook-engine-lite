# nextjs-webhook-engine-lite

Production reference architecture for high-throughput, secure webhook ingestion on serverless runtimes using the Next.js 15 App Router and Upstash Redis REST.

---

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


## State Machine

| Event Scenario | `webhook:lock:{id}` | `webhook:done:{id}` | HTTP Status | Response Status | System Action |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **First Delivery** | None | None | 200 OK | `"success"` | Lock acquired, handler executes, retention committed, lock evicted. |
| **Concurrent Race** | Present (`"1"`) | None | 202 Accepted | `"concurrent_request_ignored"` | Execution bypassed. Prevents duplicate side-effects. |
| **Subsequent Replay** | None | Present (`"1"`) | 200 OK | `"already_processed"` | Execution bypassed. Retains idempotency for 7 days. |
| **Handler Failure** | Present (Released) | None | 500 Error | `"Internal processing error"` | Lock purged immediately to allow upstream provider retries. |
| **Tampered Request** | Unchecked | Unchecked | 401 Unauthorized | `"Invalid cryptographic signature"` | Execution halted before JSON parsing or lock allocation. |

Quickstart
1. Installation

git clone [https://github.com/your-org/nextjs-webhook-engine-lite.git](https://github.com/your-org/nextjs-webhook-engine-lite.git)
cd nextjs-webhook-engine-lite
npm install


2. Configure Environment
Copy .env.example to .env.local:

cp .env.example .env.local

# Optional for local dev: The engine automatically falls back to an internal
# in-memory TTL store if credentials are missing or placeholders.
UPSTASH_REDIS_REST_URL="[https://example.upstash.io](https://example.upstash.io)"
UPSTASH_REDIS_REST_TOKEN="your-database-token"
WEBHOOK_SECRET="local_dev_secret_key_12345"

3. Run Development Server

npm run dev

4. Execute Multi-Stage Verification Suite
In a separate terminal, run the automated verification test harness:

npm run test:attack

## Architectural Edition Comparison

| Capability | Lite (Open Source) | Pro ($39 Commercial) |
| :--- | :--- | :--- |
| **Framework Target** | Next.js 15 App Router | Next.js 14/15, Remix, Astro, SvelteKit |
| **Runtime Model** | Node.js Serverless (`runtime = 'nodejs'`) | Edge, Node.js, and Cloudflare Workers |
| **Provider Support** | Generic HMAC SHA-256 | Stripe, Shopify, GitHub, Svix, Resend, Paddle |
| **Idempotency Store** | Upstash Redis REST / In-Memory Fallback | Upstash Redis, AWS DynamoDB, Cloudflare KV |
| **Replay Protection** | Cryptographic Digest Matching | Tolerance-Checked Timestamp Drift Windows |
| **Dead-Letter Queue** | Cloud Logging / Console Tracing | Automatic S3/SQS/Postgres Dead-Letter Archival |
| **Payload Ingestion** | Full Body Buffering | Streaming Size Bounds & Pre-Allocated Limits |
| **Licensing** | MIT | Commercial Developer License |

