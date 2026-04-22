import { env } from "../envs.js";
import { sha256Hex } from "./crypto.js";
import { ApiError } from "./errors.js";
import { getStateKv } from "./stateKv.js";

const RATE_LIMIT_PREFIX = "rate:v2";
const rateLimitStore = new Map();

export function resetRateLimitState() {
  rateLimitStore.clear();
}

function pruneExpiredEntries(now) {
  if (rateLimitStore.size < 1000) {
    return;
  }

  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.expiresAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

export function getRateLimitClientKey(request, token) {
  const clientIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "anonymous";

  return token ? `token:${token}` : `ip:${clientIp}`;
}

async function getRateLimitBucketKey(request, token, bucket) {
  const clientKey = getRateLimitClientKey(request, token);
  const clientHash = await sha256Hex(clientKey);
  return `${RATE_LIMIT_PREFIX}:${bucket}:${clientHash}`;
}

function createRateLimitError({ maxRequests, windowSeconds, retryAfter }) {
  return new ApiError({
    status: 429,
    code: "RATE_LIMITED",
    category: "rate_limit",
    message: "Rate limit exceeded",
    details: {
      limit: maxRequests,
      window_seconds: windowSeconds,
      retry_after: retryAfter,
    },
  });
}

function getRetryAfter(expiresAt, now) {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

function incrementMemoryBucket(key, expiresAt) {
  const record = rateLimitStore.get(key) || { count: 0, expiresAt };
  record.count += 1;
  rateLimitStore.set(key, record);
  return record.count;
}

async function incrementKvBucket({ kv, key, expiresAt, windowSeconds }) {
  const record = (await kv.get(key, "json")) || { count: 0, expiresAt };
  const count = Number.parseInt(record.count || "0", 10) + 1;

  await kv.put(
    key,
    JSON.stringify({
      count,
      expiresAt,
    }),
    {
      expirationTtl: windowSeconds + 5,
    }
  );

  return count;
}

export async function enforceRateLimit(request, token) {
  const maxRequests = Number.parseInt(env.RATE_LIMIT_MAX_REQUESTS || "0", 10);
  const windowSeconds = Number.parseInt(
    env.RATE_LIMIT_WINDOW_SECONDS || "60",
    10
  );

  if (maxRequests <= 0 || windowSeconds <= 0) {
    return;
  }

  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const bucket = Math.floor(now / windowMs);
  const expiresAt = (bucket + 1) * windowMs;
  const clientKey = await getRateLimitBucketKey(request, token, bucket);
  const kv = getStateKv();

  if (kv) {
    try {
      const count = await incrementKvBucket({
        kv,
        key: clientKey,
        expiresAt,
        windowSeconds,
      });

      if (count > maxRequests) {
        throw createRateLimitError({
          maxRequests,
          windowSeconds,
          retryAfter: getRetryAfter(expiresAt, now),
        });
      }

      return;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      console.warn("[rateLimit] KV unavailable, falling back to memory", error);
    }
  }

  pruneExpiredEntries(now);

  const count = incrementMemoryBucket(clientKey, expiresAt);

  if (count > maxRequests) {
    throw createRateLimitError({
      maxRequests,
      windowSeconds,
      retryAfter: getRetryAfter(expiresAt, now),
    });
  }
}
