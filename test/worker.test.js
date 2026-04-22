import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";

import worker from "../worker.js";
import { resetHealthState } from "../utils/health.js";
import { resetRateLimitState } from "../utils/rateLimit.js";

const originalFetch = globalThis.fetch;

const fixture = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const fixtures = {
  bing: await fixture("bing.html"),
  startpage: await fixture("startpage.html"),
  duckduckgo: await fixture("duckduckgo.html"),
  mojeek: await fixture("mojeek.html"),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MemoryKv {
  constructor() {
    this.store = new Map();
  }

  async get(key, type) {
    const item = this.store.get(key);
    if (!item) {
      return null;
    }

    if (item.expiresAt && item.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    return type === "json" ? JSON.parse(item.value) : item.value;
  }

  async put(key, value, options = {}) {
    const expirationTtl = options.expirationTtl || 0;
    this.store.set(key, {
      value,
      expiresAt: expirationTtl > 0 ? Date.now() + expirationTtl * 1000 : 0,
    });
  }
}

function createSearchRequest(path, init = {}) {
  return new Request(`https://search.example.test${path}`, init);
}

function getEngineName(url) {
  const hostname = new URL(String(url)).hostname;

  if (hostname.includes("bing.com")) {
    return "bing";
  }

  if (hostname.includes("startpage.com")) {
    return "startpage";
  }

  if (hostname.includes("duckduckgo.com")) {
    return "duckduckgo";
  }

  if (hostname.includes("mojeek.com")) {
    return "mojeek";
  }

  throw new Error(`Unhandled fetch URL: ${url}`);
}

function installFetchStub(responses = {}) {
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const engineName = getEngineName(url);
    calls.push(engineName);

    const response = responses[engineName] ?? fixtures[engineName];
    if (response instanceof Error) {
      throw response;
    }

    if (typeof response === "function") {
      return response(url, init);
    }

    return new Response(response, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  };

  return calls;
}

function createEnv(overrides = {}) {
  return {
    DEFAULT_ENGINES: "bing",
    DEFAULT_TIMEOUT: "1000",
    FALLBACK_MIN_RESULTS: "1",
    CACHE_TTL_SECONDS: "0",
    RATE_LIMIT_MAX_REQUESTS: "0",
    ...overrides,
  };
}

beforeEach(() => {
  resetHealthState();
  resetRateLimitState();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetHealthState();
  resetRateLimitState();
});

test("handles GET /search requests", async () => {
  installFetchStub();

  const response = await worker.fetch(
    createSearchRequest("/search?q=cloudflare"),
    createEnv()
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.enabled_engines[0], "bing");
  assert.equal(payload.results[0].engine, "bing");
  assert.equal(response.headers.get("X-Search-Cache"), "miss");
  assert.equal(response.headers.get("X-Search-Fallback-Path"), "bing");
  assert.ok(response.headers.get("X-Search-Request-Id"));
  assert.ok(response.headers.get("Server-Timing")?.includes("bing;dur="));
});

test("handles JSON POST /search requests", async () => {
  installFetchStub();

  const response = await worker.fetch(
    createSearchRequest("/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        q: "cloudflare",
        engines: ["startpage"],
      }),
    }),
    createEnv()
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.enabled_engines, ["startpage"]);
  assert.equal(payload.results[0].engine, "startpage");
});

test("handles form POST /search requests", async () => {
  installFetchStub();

  const response = await worker.fetch(
    createSearchRequest("/search", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "q=cloudflare&engines=duckduckgo",
    }),
    createEnv()
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.enabled_engines, ["duckduckgo"]);
  assert.equal(payload.results[0].engine, "duckduckgo");
});

test("rejects requests without configured token", async () => {
  installFetchStub();

  const response = await worker.fetch(
    createSearchRequest("/search?q=cloudflare"),
    createEnv({
      TOKEN: "secret",
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.code, "UNAUTHORIZED");
});

test("rate limits unauthorized requests by IP", async () => {
  installFetchStub();

  const env = createEnv({
    TOKEN: "secret",
    RATE_LIMIT_MAX_REQUESTS: "1",
    RATE_LIMIT_WINDOW_SECONDS: "60",
    SEARCH_STATE_KV: new MemoryKv(),
  });
  const firstResponse = await worker.fetch(
    createSearchRequest("/search?q=cloudflare", {
      headers: {
        Authorization: "Bearer wrong-token-1",
        "cf-connecting-ip": "203.0.113.15",
      },
    }),
    env
  );
  const secondResponse = await worker.fetch(
    createSearchRequest("/search?q=workers", {
      headers: {
        Authorization: "Bearer wrong-token-2",
        "cf-connecting-ip": "203.0.113.15",
      },
    }),
    env
  );
  const firstPayload = await firstResponse.json();
  const secondPayload = await secondResponse.json();

  assert.equal(firstResponse.status, 401);
  assert.equal(firstPayload.code, "UNAUTHORIZED");
  assert.equal(secondResponse.status, 429);
  assert.equal(secondPayload.code, "RATE_LIMITED");
});

test("uses KV-backed response cache", async () => {
  const calls = installFetchStub();
  const searchKv = new MemoryKv();
  const env = createEnv({
    CACHE_TTL_SECONDS: "60",
    SEARCH_KV: searchKv,
  });

  const firstResponse = await worker.fetch(
    createSearchRequest("/search?q=cloudflare"),
    env
  );
  const secondResponse = await worker.fetch(
    createSearchRequest("/search?q=cloudflare"),
    env
  );

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(secondResponse.headers.get("X-Search-Cache"), "hit");
});

test("enforces KV-backed rate limit", async () => {
  installFetchStub();

  const env = createEnv({
    RATE_LIMIT_MAX_REQUESTS: "1",
    RATE_LIMIT_WINDOW_SECONDS: "60",
    SEARCH_STATE_KV: new MemoryKv(),
  });
  const firstResponse = await worker.fetch(
    createSearchRequest("/search?q=cloudflare", {
      headers: {
        "cf-connecting-ip": "203.0.113.10",
      },
    }),
    env
  );
  const secondResponse = await worker.fetch(
    createSearchRequest("/search?q=workers", {
      headers: {
        "cf-connecting-ip": "203.0.113.10",
      },
    }),
    env
  );
  const payload = await secondResponse.json();

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 429);
  assert.equal(payload.code, "RATE_LIMITED");
  assert.ok(Number(secondResponse.headers.get("Retry-After")) > 0);
  assert.ok(secondResponse.headers.get("X-Search-Request-Id"));
});

test("falls back after an engine parser failure", async () => {
  installFetchStub({
    bing: "<html><body>No organic results</body></html>",
  });

  const response = await worker.fetch(
    createSearchRequest("/search?q=cloudflare&engines=bing,startpage"),
    createEnv()
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.unresponsive_engines, ["bing"]);
  assert.equal(payload.results[0].engine, "startpage");
});

test("continues fallback until multiple engines contribute by default", async () => {
  const calls = installFetchStub();

  const response = await worker.fetch(
    createSearchRequest("/search?q=cloudflare&engines=bing,startpage"),
    createEnv({
      FALLBACK_MIN_RESULTS: "1",
      HEDGED_FALLBACK_DELAY_MS: "1000",
    })
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["bing", "startpage"]);
  assert.equal(
    response.headers.get("X-Search-Fallback-Path"),
    "bing,startpage"
  );
});

test("skips engines that do not support requested time filters", async () => {
  const calls = installFetchStub();

  const response = await worker.fetch(
    createSearchRequest("/search?q=cloudflare&time_range=month"),
    createEnv({
      DEFAULT_ENGINES: "startpage,bing",
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["bing"]);
  assert.deepEqual(payload.enabled_engines, ["bing"]);
});

test("skips engines that do not support requested pages", async () => {
  const calls = installFetchStub();

  const response = await worker.fetch(
    createSearchRequest("/search?q=cloudflare&pageno=1"),
    createEnv({
      DEFAULT_ENGINES: "bing,duckduckgo,mojeek",
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["mojeek"]);
  assert.deepEqual(payload.enabled_engines, ["mojeek"]);
});

test("moves unhealthy engines behind healthy fallbacks with KV state", async () => {
  const calls = installFetchStub({
    bing: "<html><body>No organic results</body></html>",
  });
  const env = createEnv({
    DEFAULT_ENGINES: "bing,startpage",
    HEALTH_FAILURE_THRESHOLD: "1",
    HEALTH_COOLDOWN_SECONDS: "120",
    SEARCH_STATE_KV: new MemoryKv(),
  });

  await worker.fetch(createSearchRequest("/search?q=cloudflare"), env);
  calls.length = 0;

  const response = await worker.fetch(
    createSearchRequest("/search?q=workers"),
    env
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["startpage"]);
  assert.equal(payload.results[0].engine, "startpage");
});

test("returns stale cache when fresh search fails", async () => {
  const searchKv = new MemoryKv();
  installFetchStub();

  const env = createEnv({
    CACHE_TTL_SECONDS: "60",
    STALE_CACHE_TTL_SECONDS: "300",
    SEARCH_KV: searchKv,
    DEFAULT_ENGINES: "bing",
  });

  const initialResponse = await worker.fetch(
    createSearchRequest("/search?q=cloudflare"),
    env
  );
  assert.equal(initialResponse.status, 200);

  for (const item of searchKv.store.values()) {
    const entry = JSON.parse(item.value);
    entry.freshUntil = Date.now() - 1000;
    entry.staleUntil = Date.now() + 60_000;
    item.value = JSON.stringify(entry);
  }

  installFetchStub({
    bing: "<html><body>No organic results</body></html>",
  });

  const staleResponse = await worker.fetch(
    createSearchRequest("/search?q=cloudflare"),
    env
  );
  const payload = await staleResponse.json();

  assert.equal(staleResponse.status, 200);
  assert.equal(staleResponse.headers.get("X-Search-Cache"), "stale-if-error");
  assert.equal(payload.results[0].engine, "bing");
});

test("starts fallback early when primary is slow", async () => {
  const calls = installFetchStub({
    bing: async () => {
      await sleep(50);
      return new Response(fixtures.bing, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    },
    startpage: async () =>
      new Response(fixtures.startpage, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      }),
  });

  const response = await worker.fetch(
    createSearchRequest("/search?q=cloudflare&engines=bing,startpage"),
    createEnv({
      HEDGED_FALLBACK_DELAY_MS: "10",
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["bing", "startpage"]);
  assert.equal(payload.results[0].engine, "startpage");
  assert.equal(
    response.headers.get("X-Search-Fallback-Path"),
    "bing,startpage"
  );
  assert.ok(response.headers.get("Server-Timing")?.includes("startpage;dur="));
});
