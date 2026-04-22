import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractBingRedirectUrl,
  parseBingResults,
  parseBingRssResults,
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

test("parses Bing fallback result containers without b_algo class", () => {
  const html = `
    <main>
      <ol id="b_results">
        <li class="b_ans">
          <div class="answer-card">
            <h2><a href="https://example.com/weather">明日天气预报</a></h2>
            <p>查看明天的天气情况。</p>
          </div>
        </li>
      </ol>
    </main>
  `;
  const results = parseBingResults(html);

  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.com/weather");
  assert.equal(results[0].title, "明日天气预报");
});

test("parses Bing RSS fallback results", () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?>
    <rss version="2.0">
      <channel>
        <item>
          <title><![CDATA[Cloudflare Workers]]></title>
          <link>https://example.com/workers?ref=bing&amp;lang=en</link>
          <description><![CDATA[Deploy code globally.]]></description>
        </item>
      </channel>
    </rss>`;
  const results = parseBingRssResults(xml);

  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.com/workers?ref=bing&lang=en");
  assert.equal(results[0].description, "Deploy code globally.");
});

test("rejects Bing RSS payloads with only malformed items", () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?>
    <rss version="2.0">
      <channel>
        <item>
          <title></title>
          <link></link>
          <description><![CDATA[No usable fields.]]></description>
        </item>
      </channel>
    </rss>`;

  assert.throws(() => parseBingRssResults(xml), {
    code: "UPSTREAM_PARSE_ERROR",
  });
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

test("falls back to Bing RSS when HTML has no parseable results", async () => {
  const rss = `<?xml version="1.0" encoding="utf-8" ?>
    <rss version="2.0">
      <channel>
        <item>
          <title>Cloudflare Workers RSS</title>
          <link>https://example.com/rss-workers</link>
          <description>RSS fallback result.</description>
        </item>
      </channel>
    </rss>`;
  const fetchCapture = installFetchCapture((url, _init, callCount) =>
    new Response(callCount === 1 ? "<html><body>No organic results</body></html>" : rss, {
      status: 200,
      headers: {
        "content-type": callCount === 1 ? "text/html; charset=utf-8" : "application/rss+xml; charset=utf-8",
      },
    })
  );

  let results;
  try {
    results = await searchBing({
      query: "cloudflare workers",
      language: "en",
    });
  } finally {
    fetchCapture.restore();
  }

  assert.equal(fetchCapture.calls.length, 2);
  assert.match(fetchCapture.calls[1].url, /[?&]format=rss(?:&|$)/);
  assert.equal(results[0].url, "https://example.com/rss-workers");
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
  assert.equal(results[0].engine, "startpage");
  assert.equal(results[0].url, "https://example.com/workers");
});
