import { env } from "../envs.js";

export function getStateKv() {
  if (env.SEARCH_STATE_KV && typeof env.SEARCH_STATE_KV.get === "function") {
    return env.SEARCH_STATE_KV;
  }

  return null;
}

export function normalizeExpirationTtl(value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}
