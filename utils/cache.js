import { env } from "../envs.js";
import { sha256Hex } from "./crypto.js";

const CACHE_PREFIX = "search:v3";

function isKvAvailable() {
  return !!env.SEARCH_KV && typeof env.SEARCH_KV.get === "function";
}

async function getCacheKey({ query, engines, language, time_range, pageno }) {
  const payload = JSON.stringify({
    query,
    engines,
    language,
    time_range,
    pageno,
  });
  const hash = await sha256Hex(payload);
  return `${CACHE_PREFIX}:${hash}`;
}

export async function getCachedSearchResponse(searchParams) {
  const ttl = Number.parseInt(env.CACHE_TTL_SECONDS || "0", 10);
  if (!isKvAvailable() || ttl <= 0) {
    return null;
  }

  const key = await getCacheKey(searchParams);
  const entry = await env.SEARCH_KV.get(key, "json");
  if (!entry?.response) {
    return null;
  }

  const now = Date.now();
  if (entry.freshUntil > now) {
    return {
      response: entry.response,
      state: "hit",
    };
  }

  if (entry.staleUntil > now) {
    return {
      response: entry.response,
      state: "stale",
    };
  }

  return null;
}

export async function setCachedSearchResponse(searchParams, response) {
  const ttl = Number.parseInt(env.CACHE_TTL_SECONDS || "0", 10);
  if (!isKvAvailable() || ttl <= 0) {
    return;
  }

  const staleTtl = Math.max(
    0,
    Number.parseInt(env.STALE_CACHE_TTL_SECONDS || "0", 10)
  );
  const now = Date.now();
  const freshUntil = now + ttl * 1000;
  const staleUntil = freshUntil + staleTtl * 1000;
  const key = await getCacheKey(searchParams);
  await env.SEARCH_KV.put(
    key,
    JSON.stringify({
      response,
      freshUntil,
      staleUntil,
    }),
    {
      expirationTtl: ttl + staleTtl,
    }
  );
}
