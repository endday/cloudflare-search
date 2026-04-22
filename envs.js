const createDefaultEnv = () => ({
  DEFAULT_TIMEOUT: "4000",
  HEDGED_FALLBACK_DELAY_MS: "400",
  SUPPORTED_ENGINES: [
    "startpage",
    "duckduckgo",
    "brave",
    "mojeek",
    "bing",
  ],
  DEFAULT_ENGINES: ["startpage", "duckduckgo", "brave", "mojeek", "bing"],
  DEFAULT_LANGUAGE: "en",
  FALLBACK_MIN_RESULTS: "6",
  FALLBACK_MIN_CONTRIBUTING_ENGINES: "2",
  CACHE_TTL_SECONDS: "300",
  STALE_CACHE_TTL_SECONDS: "1800",
  RATE_LIMIT_WINDOW_SECONDS: "60",
  RATE_LIMIT_MAX_REQUESTS: "60",
  HEALTH_FAILURE_THRESHOLD: "2",
  HEALTH_COOLDOWN_SECONDS: "180",
  HEALTH_STATE_TTL_SECONDS: "3600",
  TOKEN: null,
  SEARCH_KV: null,
  SEARCH_STATE_KV: null,
});

function normalizeStringArray(value, fallback) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [...fallback];
    }

    if (trimmed.startsWith("[")) {
      try {
        return normalizeStringArray(JSON.parse(trimmed), fallback);
      } catch (_) {
        return [...fallback];
      }
    }

    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [...fallback];
}

function resetEnv(target) {
  const defaults = createDefaultEnv();
  Object.keys(target).forEach((key) => {
    delete target[key];
  });
  Object.assign(target, defaults);
}

export const env = createDefaultEnv();

export const setEnv = (newEnv = {}) => {
  resetEnv(env);
  Object.assign(env, newEnv);
  env.SUPPORTED_ENGINES = normalizeStringArray(
    env.SUPPORTED_ENGINES,
    createDefaultEnv().SUPPORTED_ENGINES
  );
  env.DEFAULT_ENGINES = normalizeStringArray(
    env.DEFAULT_ENGINES,
    createDefaultEnv().DEFAULT_ENGINES
  );
};
