import { Redis } from "@upstash/redis";

export type LockStatus = "ACQUIRED" | "IN_FLIGHT" | "ALREADY_COMPLETED";

interface MemoryRecord {
  value: string;
  expiresAt: number;
}

// In-memory atomic fallback store for local development environments
const inMemoryStore = new Map<string, MemoryRecord>();
let hasWarnedDevFallback = false;
let redisInstance: Redis | null = null;

function pruneMemoryStore(): void {
  const now = Date.now();
  for (const [key, record] of inMemoryStore.entries()) {
    if (record.expiresAt <= now) {
      inMemoryStore.delete(key);
    }
  }
}

function resolveRedisClient(): Redis | null {
  const rawUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const rawToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  const isConfigPlaceholder =
    !rawUrl ||
    rawUrl.includes("example.upstash.io") ||
    rawUrl.includes("your-database") ||
    rawUrl.includes("your-upstash-instance");

  if (isConfigPlaceholder || !rawToken) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "FATAL: Production deployment requires active UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN configurations."
      );
    }

    if (!hasWarnedDevFallback) {
      console.warn(
        "[idempotency] Notice: Upstash credentials unconfigured or placeholder. Activating in-memory TTL store for local development."
      );
      hasWarnedDevFallback = true;
    }
    return null;
  }

  if (!redisInstance) {
    redisInstance = new Redis({ url: rawUrl, token: rawToken });
  }
  return redisInstance;
}

/**
 * Attempts to acquire an execution lock for an incoming webhook event.
 * Enforces atomic single-flight execution and verifies completion history.
 */
export async function acquireWebhookLock(
  eventId: string,
  lockTtlSeconds = 60
): Promise<LockStatus> {
  const redis = resolveRedisClient();
  const doneKey = `webhook:done:${eventId}`;
  const lockKey = `webhook:lock:${eventId}`;

  // Production Path: Upstash Redis REST Client (Stateless HTTP)
  if (redis) {
    const isDone = await redis.exists(doneKey);
    if (isDone === 1) {
      return "ALREADY_COMPLETED";
    }

    const acquired = await redis.set(lockKey, "1", {
      nx: true,
      ex: lockTtlSeconds,
    });

    if (!acquired) {
      const racedDone = await redis.exists(doneKey);
      return racedDone === 1 ? "ALREADY_COMPLETED" : "IN_FLIGHT";
    }

    return "ACQUIRED";
  }

  // Development Path: High-Precision In-Memory Store
  pruneMemoryStore();
  const now = Date.now();

  const doneRecord = inMemoryStore.get(doneKey);
  if (doneRecord && doneRecord.expiresAt > now) {
    return "ALREADY_COMPLETED";
  }

  const lockRecord = inMemoryStore.get(lockKey);
  if (lockRecord && lockRecord.expiresAt > now) {
    return "IN_FLIGHT";
  }

  inMemoryStore.set(lockKey, {
    value: "1",
    expiresAt: now + lockTtlSeconds * 1000,
  });

  return "ACQUIRED";
}

/**
 * Atomically marks an event as completed and purges the active in-flight lock.
 */
export async function markWebhookCompleted(
  eventId: string,
  retentionTtlSeconds = 604800 // 7-day retention window
): Promise<void> {
  const redis = resolveRedisClient();
  const doneKey = `webhook:done:${eventId}`;
  const lockKey = `webhook:lock:${eventId}`;

  if (redis) {
    const pipeline = redis.pipeline();
    pipeline.set(doneKey, "1", { ex: retentionTtlSeconds });
    pipeline.del(lockKey);
    await pipeline.exec();
    return;
  }

  const now = Date.now();
  inMemoryStore.set(doneKey, {
    value: "1",
    expiresAt: now + retentionTtlSeconds * 1000,
  });
  inMemoryStore.delete(lockKey);
}

/**
 * Releases the execution lock if business logic throws, allowing upstream retries.
 */
export async function releaseWebhookLock(eventId: string): Promise<void> {
  const redis = resolveRedisClient();
  const lockKey = `webhook:lock:${eventId}`;

  if (redis) {
    await redis.del(lockKey);
    return;
  }

  inMemoryStore.delete(lockKey);
}