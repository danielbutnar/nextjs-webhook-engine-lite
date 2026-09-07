# nextjs-webhook-engine-lite

A small reference implementation of secure, idempotent webhook handling in the Next.js 15 App Router, backed by Upstash Redis REST.

I built this while learning how webhook endpoints break on serverless runtimes. Three failure modes kept coming up and none of them were obvious from the framework docs, so this repo is my working notes plus the code that handles them.

**Status:** learning project. The code runs and the attack script passes against it, but it has not been used in production and there is no automated test suite yet. See [Limitations](#limitations) before using any of it.

---

## The three problems

### 1. You can only read the body once

`req.json()` consumes the request's `ReadableStream`. Once it is consumed you cannot get the raw bytes back, and HMAC signatures are computed over the raw bytes.

The tempting fix is to `JSON.stringify()` the parsed object and hash that instead. It does not work. `JSON.stringify` gives no guarantee of the sender's key order or whitespace, so the reconstructed string hashes to a different digest and every signature check fails, including the legitimate ones.

The fix is to read once with `req.text()`, verify the signature against that exact string, and only then `JSON.parse()` it.

### 2. `timingSafeEqual` throws on a length mismatch

Comparing signatures with `===` leaks timing information. String comparison exits on the first differing byte, so an attacker who can measure response times can work out a valid signature one character at a time. Node's `crypto.timingSafeEqual()` exists for this.

The catch is that `timingSafeEqual` throws a `RangeError` when the two buffers have different lengths. A forged signature of the wrong length does not return `false`, it crashes the handler with an unhandled exception. Lengths have to be compared first, with an early return, before the constant-time comparison runs.

### 3. Retries land on parallel instances

Providers retry when they do not get a fast `200`, and serverless instances are stateless and independent of each other. Two retries of the same event can hit two cold instances at the same moment. Both look for a record of the event, both find nothing, and both process it. If the handler charges a card or sends an email, it happens twice.

A `SELECT` followed by an `INSERT` does not close this, because there is a window between the two statements where both instances have read "not seen". Redis `SET NX` is atomic, so exactly one instance acquires the lock. Using Upstash over REST rather than a TCP client also avoids connection pool exhaustion when a provider bursts retries at you.

---

## How a request flows

```
HTTP POST /api/webhooks
       |
       v
  req.text()                -> raw byte string preserved
       |
       v
  timing-safe HMAC check    -> mismatch: 401 Unauthorized
       | pass
       v
  JSON.parse                -> malformed or no event.id: 400 Bad Request
       | valid
       v
  Redis SET NX
       |-- webhook:done:{id} exists  -> 200 { status: "already_processed" }
       |-- webhook:lock:{id} exists  -> 202 { status: "concurrent_request_ignored" }
       |-- lock acquired (TTL 60s)
                |
                v
          run handler
                |
                |-- success -> pipeline: SET webhook:done:{id} EX 7d, DEL lock
                |              200 { status: "success" }
                |
                |-- error   -> DEL webhook:lock:{id} so the provider can retry
                               500 Internal Server Error
```

## Behaviour

| Scenario | `lock:{id}` | `done:{id}` | Status | Response | What happens |
| --- | --- | --- | --- | --- | --- |
| First delivery | none | none | 200 | `success` | Lock taken, handler runs, result recorded, lock released |
| Concurrent retry | present | none | 202 | `concurrent_request_ignored` | Handler skipped, no duplicate side effects |
| Later replay | none | present | 200 | `already_processed` | Handler skipped, remembered for 7 days |
| Handler throws | released | none | 500 | error | Lock cleared immediately so the provider retries |
| Bad signature | untouched | untouched | 401 | invalid signature | Rejected before parsing or locking |

---

## Running it

```bash
git clone https://github.com/danielbutnar/nextjs-webhook-engine-lite.git
cd nextjs-webhook-engine-lite
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

```
UPSTASH_REDIS_REST_URL="https://your-db.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-database-token"
WEBHOOK_SECRET="local_dev_secret_key_12345"
```

If the Upstash values are missing or left as placeholders, the engine falls back to an in-memory TTL store. That is fine for local development and useless in production, for the reason described in the limitations below.

```bash
npm run dev
```

Then, in a second terminal, fire the checks against the running server:

```bash
npm run test:attack
```

This sends a valid signed request, a tampered one, a wrong-length signature, and two identical events back to back, and prints what came back.

---

## Limitations

Worth being explicit about what this does not do:

- **No automated tests.** `test:attack` is a manual script that needs a dev server already running. The verification and locking logic is not covered by anything you can run in CI.
- **Generic HMAC SHA-256 only.** Real providers differ. Stripe and Svix sign a timestamp along with the payload and expect you to reject anything outside a short replay window. That check is not implemented here, so a captured valid request stays replayable until its idempotency key expires.
- **One static secret.** Rotating it means a window where in-flight webhooks fail.
- **The in-memory fallback gives no real guarantee.** It is per-instance, and the whole point of the Redis lock is coordinating across instances. It exists so the repo runs without credentials, nothing more.
- **Fixed 60 second lock TTL.** A handler that runs longer can have its lock expire while it is still working, which reopens the duplicate-processing window it was meant to close.
- **Redis failures are not handled.** If Upstash is unreachable the request fails rather than degrading in any considered way.

## What I would change next

- Tests around the signature and lock logic with Vitest, so the guarantees above are checkable instead of just claimed.
- Timestamp validation with a replay window.
- A configurable lock TTL that a long-running handler can renew while it works.
- A decision on what should happen when Redis is down, rather than the current accident.

---

## License

MIT.
