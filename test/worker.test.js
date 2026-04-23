import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";

import worker from "../worker.js";
import { resetHealthState } from "../utils/health.js";
import { resetRateLimitState } from "../utils/rateLimit.js";
import { resetStartpageRequestState } from "../utils/searchStartpage.js";

const originalFetch = globalThis.fetch;

const fixture = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const fixtures = {
  bing: await fixture("bing.html"),
  startpage: await fixture("startpage.html"),
  duckduckgo: await fixture("duckduckgo.html"),
  mojeek: await fixture("mojeek.html"),
  qwant: await fixture("qwant.html"),
  yahoo: await fixture("yahoo.html"),
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

function createSearchRequest(path, init = {}, cf) {
  const request = new Request(`https://search.example.test${path}`, init);

  if (cf) {
    Object.defineProperty(request, "cf", {
      value: cf,
    });
  }

  return request;
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

  if (hostname.includes("qwant.com")) {
    return "qwant";
  }

  if (hostname.includes("search.yahoo.com")) {
    return "yahoo";
  }

  throw new Error(`Unhandled fetch URL: ${url}`);
}

function installFetchStub(responses = {}) {
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const engineName = getEngineName(url);
    const requestUrl = new URL(String(url));

    if (!(engineName === "startpage" && requestUrl.pathname === "/")) {
      calls.push(engineName);
    }

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
  resetStartpageRequestState();
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

test("uses request.cf city as default auto location", async () => {
  installFetchStub();

  const response = await worker.fetch(
    createSearchRequest(
      "/search?q=%E6%98%8E%E5%A4%A9%E5%A4%A9%E6%B0%94%E5%A6%82%E4%BD%95",
      {},
      {
        city: "上海",
        region: "Shanghai",
        country: "CN",
        timezone: "Asia/Shanghai",
      }
    ),
    createEnv()
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.query, "明天天气如何");
  assert.equal(payload.effective_query, "明天天气如何 上海");
  assert.equal(payload.location, "上海");
  assert.equal(payload.location_source, "auto");
  assert.deepEqual(payload.location_context.client, {
    city: "上海",
    region: "Shanghai",
    country: "CN",
    timezone: "Asia/Shanghai",
  });
});

test("returns Cloudflare visitor geo metadata", async () => {
  const response = await worker.fetch(
    createSearchRequest(
      "/geo",
      {
        headers: {
          "cf-connecting-ip": "203.0.113.20",
        },
      },
      {
        city: "上海",
        region: "Shanghai",
        regionCode: "SH",
        country: "CN",
        continent: "AS",
        timezone: "Asia/Shanghai",
        latitude: "31.2304",
        longitude: "121.4737",
        colo: "PVG",
        asn: 64512,
        asOrganization: "Example Network",
      }
    ),
    createEnv()
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.geo.ip, "203.0.113.20");
  assert.equal(payload.geo.city, "上海");
  assert.equal(payload.geo.region_code, "SH");
  assert.equal(payload.geo.country, "CN");
  assert.equal(payload.geo.colo, "PVG");
  assert.equal(payload.geo.as_organization, "Example Network");
});

test("allows explicit location and location opt-out", async () => {
  installFetchStub();

  const explicitResponse = await worker.fetch(
    createSearchRequest("/search?q=weather&location=Hong%20Kong"),
    createEnv()
  );
  const explicitPayload = await explicitResponse.json();

  assert.equal(explicitResponse.status, 200);
  assert.equal(explicitPayload.effective_query, "weather Hong Kong");
  assert.equal(explicitPayload.location_source, "explicit");

  const disabledResponse = await worker.fetch(
    createSearchRequest(
      "/search?q=weather&location=off",
      {},
      {
        city: "上海",
      }
    ),
    createEnv()
  );
  const disabledPayload = await disabledResponse.json();

  assert.equal(disabledResponse.status, 200);
  assert.equal(disabledPayload.effective_query, "weather");
  assert.equal(disabledPayload.location, null);
  assert.equal(disabledPayload.location_source, "disabled");
});

test("returns JSON for unknown routes", async () => {
  const response = await worker.fetch(createSearchRequest("/missing"), createEnv());
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.equal(payload.code, "NOT_FOUND");
  assert.ok(response.headers.get("X-Search-Request-Id"));
});

test("supports configurable CORS preflight responses", async () => {
  const response = await worker.fetch(
    createSearchRequest("/search", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.test",
        "Access-Control-Request-Headers": "authorization,content-type,x-custom-header",
      },
    }),
    createEnv({
      CORS_ALLOWED_ORIGINS: "https://app.example.test",
    })
  );

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://app.example.test"
  );
  assert.equal(
    response.headers.get("Access-Control-Allow-Headers"),
    "authorization,content-type,x-custom-header"
  );
  assert.ok(response.headers.get("X-Search-Request-Id"));
});

test("renders token input on homepage when auth is enabled", async () => {
  const response = await worker.fetch(
    createSearchRequest("/"),
    createEnv({
      TOKEN: "secret",
    })
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /id="tokenInput"/);
  assert.match(html, /\/auth\/verify/);
  assert.match(html, /id="geoSummary"/);
  assert.match(html, /\/geo/);
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

test("handles newly added Qwant and Yahoo engines", async () => {
  const calls = installFetchStub();

  const response = await worker.fetch(
    createSearchRequest("/search?q=cloudflare&engines=qwant,yahoo"),
    createEnv({
      FALLBACK_MIN_RESULTS: "1",
      HEDGED_FALLBACK_DELAY_MS: "1000",
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.enabled_engines, ["qwant", "yahoo"]);
  assert.deepEqual(calls, ["qwant", "yahoo"]);
  assert.equal(response.headers.get("X-Search-Fallback-Path"), "qwant,yahoo");
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

test("verifies valid token through auth endpoint", async () => {
  const response = await worker.fetch(
    createSearchRequest("/auth/verify", {
      headers: {
        Authorization: "Bearer secret",
      },
    }),
    createEnv({
      TOKEN: "secret",
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.authorized, true);
  assert.equal(payload.token_required, true);
});

test("returns normal auth error when token is missing on verify endpoint", async () => {
  const response = await worker.fetch(
    createSearchRequest("/auth/verify"),
    createEnv({
      TOKEN: "secret",
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.code, "UNAUTHORIZED");
  assert.equal(payload.message, "Invalid or missing authentication token");
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
  assert.deepEqual(payload.skipped_engines, [
    {
      engine: "startpage",
      reason: "unsupported_time_range",
    },
  ]);
});

test("infers zh-CN for Han queries when language is omitted", async () => {
  let observedUrl = "";
  installFetchStub({
    bing: (url) => {
      observedUrl = String(url);
      return new Response(fixtures.bing, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    },
  });

  const response = await worker.fetch(
    createSearchRequest("/search?q=%E6%98%8E%E6%97%A5%E5%A4%A9%E6%B0%94&engines=bing"),
    createEnv({
      DEFAULT_LANGUAGE: "en",
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.results[0].engine, "bing");
  assert.match(observedUrl, /[?&]setlang=zh-Hans(?:&|$)/);
  assert.match(observedUrl, /[?&]mkt=zh-CN(?:&|$)/);
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
  assert.deepEqual(payload.skipped_engines, [
    {
      engine: "bing",
      reason: "unsupported_pageno",
    },
    {
      engine: "duckduckgo",
      reason: "unsupported_pageno",
    },
  ]);
});

test("reports unsupported requested engines", async () => {
  const calls = installFetchStub();

  const response = await worker.fetch(
    createSearchRequest("/search?q=cloudflare&engines=bing,unknown"),
    createEnv()
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["bing"]);
  assert.deepEqual(payload.enabled_engines, ["bing"]);
  assert.deepEqual(payload.skipped_engines, [
    {
      engine: "unknown",
      reason: "unsupported_engine",
    },
  ]);
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
