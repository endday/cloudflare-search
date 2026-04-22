import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractBingRedirectUrl,
  parseBingResults,
  default as searchBing,
} from "../utils/searchBing.js";
import { parseBraveResults } from "../utils/searchBrave.js";
import {
  parseDuckDuckGoResults,
  default as searchDuckDuckGo,
} from "../utils/searchDuckDuckGo.js";
import { parseMojeekResults } from "../utils/searchMojeek.js";
import {
  parseStartpageResults,
  default as searchStartpage,
} from "../utils/searchStartpage.js";
import { getEngineRegistry } from "../utils/engineRegistry.js";
import { dedupeAndRankResults } from "../utils/index.js";

const fixture = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const originalFetch = globalThis.fetch;

function installFetchCapture(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(url, init, calls.length);
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("parses Bing organic HTML", async () => {
  const results = parseBingResults(await fixture("bing.html"));
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Cloudflare Workers Guide");
  assert.equal(results[0].url, "https://example.com/workers");
});

test("extracts Bing redirect URLs safely", () => {
  const target = "https://example.com/article";
  const encoded = btoa(target);
  const redirect = `https://www.bing.com/ck/a?u=a1${encoded}`;
  assert.equal(extractBingRedirectUrl(redirect), target);
});

test("rejects unsupported Bing pagination before fetching", async () => {
  const fetchCapture = installFetchCapture(() => {
    throw new Error("fetch should not be called");
  });

  try {
    await assert.rejects(
      searchBing({
        query: "cloudflare workers",
        language: "en",
        pageno: 1,
      }),
      {
        code: "UNSUPPORTED_PARAMETER",
      }
    );
    assert.equal(fetchCapture.calls.length, 0);
  } finally {
    fetchCapture.restore();
  }
});

test("parses Brave HTML without eval", async () => {
  const results = parseBraveResults(await fixture("brave.html"));
  assert.equal(results.length, 2);
  assert.equal(results[0].description, "Deploy JavaScript at the edge.");
});

test("parses DuckDuckGo HTML redirect links", async () => {
  const results = parseDuckDuckGoResults(await fixture("duckduckgo.html"));
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/workers");
});

test("parses Startpage serialized web results", async () => {
  const results = parseStartpageResults(await fixture("startpage.html"));
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Cloudflare Workers");
});

test("uses one-based Startpage page numbers for paginated requests", async () => {
  const startpageHtml = await fixture("startpage.html");
  const fetchCapture = installFetchCapture(() =>
    new Response(startpageHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  );

  try {
    await searchStartpage({
      query: "cloudflare workers",
      pageno: 1,
    });
  } finally {
    fetchCapture.restore();
  }

  assert.match(fetchCapture.calls[0].url, /[?&]page=2(?:&|$)/);
});

test("rejects unsupported Startpage time filters before fetching", async () => {
  const fetchCapture = installFetchCapture(() => {
    throw new Error("fetch should not be called");
  });

  try {
    await assert.rejects(
      searchStartpage({
        query: "cloudflare workers",
        time_range: "month",
      }),
      {
        code: "UNSUPPORTED_PARAMETER",
      }
    );
    assert.equal(fetchCapture.calls.length, 0);
  } finally {
    fetchCapture.restore();
  }
});

test("rejects unsupported DuckDuckGo pagination before fetching", async () => {
  const fetchCapture = installFetchCapture(() => {
    throw new Error("fetch should not be called");
  });

  try {
    await assert.rejects(
      searchDuckDuckGo({
        query: "cloudflare workers",
        pageno: 1,
      }),
      {
        code: "UNSUPPORTED_PARAMETER",
      }
    );
    assert.equal(fetchCapture.calls.length, 0);
  } finally {
    fetchCapture.restore();
  }
});

test("parses Mojeek organic HTML", async () => {
  const results = parseMojeekResults(await fixture("mojeek.html"));
  assert.equal(results.length, 2);
  assert.equal(results[0].description, "Cloudflare Workers run serverless code.");
});

test("deduplicates by canonical URL and prefers higher priority engine", () => {
  const registry = getEngineRegistry();
  const results = dedupeAndRankResults({
    query: "cloudflare workers",
    registry,
    engineResults: [
      {
        engine: "startpage",
        results: [
          {
            title: "Cloudflare Workers",
            url: "https://example.com/workers?utm_source=startpage",
            description: "Startpage copy",
          },
        ],
      },
      {
        engine: "bing",
        results: [
          {
            title: "Cloudflare Workers",
            url: "https://example.com/workers",
            description: "Bing copy",
          },
        ],
      },
    ],
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].engine, "bing");
  assert.equal(results[0].url, "https://example.com/workers");
});
