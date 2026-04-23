import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractBingRedirectUrl,
  parseBingResults,
  parseBingRssResults,
  default as searchBing,
} from "../utils/searchBing.js";
import {
  parseBraveResults,
  default as searchBrave,
} from "../utils/searchBrave.js";
import {
  parseDuckDuckGoResults,
  default as searchDuckDuckGo,
} from "../utils/searchDuckDuckGo.js";
import { parseMojeekResults } from "../utils/searchMojeek.js";
import {
  parseQwantResults,
  default as searchQwant,
} from "../utils/searchQwant.js";
import {
  parseStartpageResults,
  resetStartpageRequestState,
  default as searchStartpage,
} from "../utils/searchStartpage.js";
import {
  extractYahooRedirectUrl,
  parseYahooResults,
  default as searchYahoo,
} from "../utils/searchYahoo.js";
import { getEngineRegistry } from "../utils/engineRegistry.js";
import { dedupeAndRankResults } from "../utils/index.js";

const fixture = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const originalFetch = globalThis.fetch;

function getCapturedHeader(init, name) {
  const target = String(name).toLowerCase();
  const headers = init?.headers || {};
  const entries =
    headers instanceof Headers ? headers.entries() : Object.entries(headers);

  for (const [key, value] of entries) {
    if (String(key).toLowerCase() === target) {
      return String(value);
    }
  }

  return "";
}

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

test("rejects Bing bot-detection challenge pages", () => {
  const html = `
    <html>
      <body>
        <form id="b_captcha">
          <p>Verify you are human</p>
        </form>
      </body>
    </html>
  `;

  assert.throws(() => parseBingResults(html), {
    code: "UPSTREAM_BLOCKED",
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

test("does not retry Bing RSS after a bot-detection challenge", async () => {
  const fetchCapture = installFetchCapture(() =>
    new Response("<html><body>Verify you are human</body></html>", {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  );

  try {
    await assert.rejects(
      searchBing({
        query: "cloudflare workers",
        language: "en",
      }),
      {
        code: "UPSTREAM_BLOCKED",
      }
    );
  } finally {
    fetchCapture.restore();
  }

  assert.equal(fetchCapture.calls.length, 1);
});

test("parses Brave HTML without eval", async () => {
  const results = parseBraveResults(await fixture("brave.html"));
  assert.equal(results.length, 2);
  assert.equal(results[0].description, "Deploy JavaScript at the edge.");
});

test("rejects Brave bot-detection challenge pages", () => {
  const html = `
    <html>
      <body>
        <form id="captcha-form">
          <p>Verify you are human</p>
        </form>
      </body>
    </html>
  `;

  assert.throws(() => parseBraveResults(html), {
    code: "UPSTREAM_BLOCKED",
  });
});

test("parses DuckDuckGo HTML redirect links", async () => {
  const results = parseDuckDuckGoResults(await fixture("duckduckgo.html"));
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/workers");
});

test("rejects DuckDuckGo bot-detection challenge pages", () => {
  const html = `
    <html>
      <body>
        <script src="/dist/anomaly.js"></script>
        <p>Unfortunately, bots use DuckDuckGo too.</p>
      </body>
    </html>
  `;

  assert.throws(() => parseDuckDuckGoResults(html), {
    code: "UPSTREAM_BLOCKED",
  });
});

test("parses Startpage serialized web results", async () => {
  const results = parseStartpageResults(await fixture("startpage.html"));
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Cloudflare Workers");
});

test("rejects Startpage bot-detection challenge pages", () => {
  const html = `
    <html>
      <body>
        <form action="/sp/captcha">
          <p>Verify you are human</p>
        </form>
      </body>
    </html>
  `;

  assert.throws(() => parseStartpageResults(html), {
    code: "UPSTREAM_BLOCKED",
  });
});

test("uses one-based Startpage page numbers for paginated requests", async () => {
  const startpageHtml = await fixture("startpage.html");
  resetStartpageRequestState();
  const fetchCapture = installFetchCapture((_url, _init, callCount) =>
    new Response(
      callCount === 1
        ? '<html><body><form><input name="sc" value="sp-token"></form></body></html>'
        : startpageHtml,
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      }
    )
  );

  try {
    await searchStartpage({
      query: "cloudflare workers",
      pageno: 1,
    });
  } finally {
    fetchCapture.restore();
  }

  const searchCall = fetchCapture.calls.find((call) =>
    call.url.includes("/sp/search")
  );
  assert.ok(searchCall);
  assert.equal(searchCall.init.method, "POST");
  assert.equal(
    new URLSearchParams(searchCall.init.body).get("page"),
    "2"
  );
});

test("submits Startpage searches as form requests with preferences", async () => {
  const startpageHtml = await fixture("startpage.html");
  resetStartpageRequestState();
  const fetchCapture = installFetchCapture((_url, _init, callCount) =>
    new Response(
      callCount === 1
        ? '<html><body><input name="sc" value="sp-token-123"></body></html>'
        : startpageHtml,
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      }
    )
  );

  try {
    await searchStartpage({
      query: "cloudflare workers",
      language: "zh-cn",
      pageno: 1,
    });
  } finally {
    fetchCapture.restore();
  }

  assert.equal(fetchCapture.calls.length, 2);
  const searchCall = fetchCapture.calls[1];
  const body = new URLSearchParams(searchCall.init.body);
  assert.equal(searchCall.init.method, "POST");
  assert.equal(searchCall.init.referrer, "https://www.startpage.com/");
  assert.equal(body.get("query"), "cloudflare workers");
  assert.equal(body.get("page"), "2");
  assert.equal(body.get("language"), "chinese_simplified");
  assert.equal(body.get("lui"), "chinese_simplified");
  assert.equal(body.get("sc"), "sp-token-123");
  assert.match(getCapturedHeader(searchCall.init, "cookie"), /preferences=/);
});

test("falls back gracefully when Startpage sc token is unavailable", async () => {
  const startpageHtml = await fixture("startpage.html");
  resetStartpageRequestState();
  const fetchCapture = installFetchCapture((_url, _init, callCount) =>
    new Response(
      callCount === 1 ? "<html><body>No token</body></html>" : startpageHtml,
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      }
    )
  );

  try {
    await searchStartpage({
      query: "cloudflare workers",
      language: "en",
    });
  } finally {
    fetchCapture.restore();
  }

  const searchCall = fetchCapture.calls.find((call) =>
    call.url.includes("/sp/search")
  );
  assert.ok(searchCall);
  assert.equal(new URLSearchParams(searchCall.init.body).get("sc"), null);
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

test("submits DuckDuckGo searches as form requests", async () => {
  const duckHtml = await fixture("duckduckgo.html");
  const fetchCapture = installFetchCapture(() =>
    new Response(duckHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  );

  try {
    await searchDuckDuckGo({
      query: "cloudflare workers",
      language: "en-gb",
      time_range: "month",
    });
  } finally {
    fetchCapture.restore();
  }

  const call = fetchCapture.calls[0];
  const body = new URLSearchParams(call.init.body);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.referrer, "https://html.duckduckgo.com/");
  assert.equal(getCapturedHeader(call.init, "origin"), "https://html.duckduckgo.com");
  assert.equal(body.get("q"), "cloudflare workers");
  assert.equal(body.get("kl"), "uk-en");
  assert.equal(body.get("df"), "m");
  assert.equal(getCapturedHeader(call.init, "cookie"), "kl=uk-en; df=m");
});

test("sends Brave locale cookies with requests", async () => {
  const braveHtml = await fixture("brave.html");
  const fetchCapture = installFetchCapture(() =>
    new Response(braveHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  );

  try {
    await searchBrave({
      query: "cloudflare workers",
      language: "en-gb",
      time_range: "week",
    });
  } finally {
    fetchCapture.restore();
  }

  const call = fetchCapture.calls[0];
  assert.match(call.url, /[?&]tf=pw(?:&|$)/);
  assert.equal(call.init.referrer, "https://search.brave.com/");
  assert.equal(
    getCapturedHeader(call.init, "cookie"),
    "country=gb; ui_lang=en-gb; useLocation=0; summarizer=0; safesearch=off"
  );
});

test("sends Bing locale cookies with requests", async () => {
  const bingHtml = await fixture("bing.html");
  const fetchCapture = installFetchCapture(() =>
    new Response(bingHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  );

  try {
    await searchBing({
      query: "cloudflare workers",
      language: "zh-cn",
    });
  } finally {
    fetchCapture.restore();
  }

  const call = fetchCapture.calls[0];
  assert.match(call.url, /[?&]pq=cloudflare\+workers(?:&|$)/);
  assert.match(getCapturedHeader(call.init, "cookie"), /_EDGE_CD=m=zh-CN&u=zh-CN/);
  assert.match(getCapturedHeader(call.init, "cookie"), /_EDGE_S=mkt=zh-CN&ui=zh-Hans/);
  assert.equal(
    getCapturedHeader(call.init, "accept-language"),
    "zh-CN,zh;q=0.9,en;q=0.8"
  );
});

test("parses Mojeek organic HTML", async () => {
  const results = parseMojeekResults(await fixture("mojeek.html"));
  assert.equal(results.length, 2);
  assert.equal(results[0].description, "Cloudflare Workers run serverless code.");
});

test("parses Qwant Lite organic HTML", async () => {
  const results = parseQwantResults(await fixture("qwant.html"));

  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Cloudflare Workers");
  assert.equal(results[0].url, "https://example.com/workers");
  assert.equal(results[1].url, "https://example.com/pages");
});

test("rejects Qwant unavailable pages", () => {
  const html = `<!doctype html>
    <html>
      <head><title>Service unavailable</title></head>
      <body>Unfortunately we are not yet available in your country.</body>
    </html>`;

  assert.throws(() => parseQwantResults(html), {
    code: "UPSTREAM_BLOCKED",
  });
});

test("requests Qwant Lite with locale and page parameters", async () => {
  const qwantHtml = await fixture("qwant.html");
  const fetchCapture = installFetchCapture(() =>
    new Response(qwantHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  );

  try {
    await searchQwant({
      query: "cloudflare workers",
      language: "en-gb",
      pageno: 1,
    });
  } finally {
    fetchCapture.restore();
  }

  const call = fetchCapture.calls[0];
  const url = new URL(call.url);
  assert.equal(url.hostname, "lite.qwant.com");
  assert.equal(url.searchParams.get("q"), "cloudflare workers");
  assert.equal(url.searchParams.get("locale"), "en_gb");
  assert.equal(url.searchParams.get("l"), "en");
  assert.equal(url.searchParams.get("p"), "2");
  assert.equal(call.init.referrer, "https://www.qwant.com/");
});

test("rejects unsupported Qwant time filters before fetching", async () => {
  const fetchCapture = installFetchCapture(() => {
    throw new Error("fetch should not be called");
  });

  try {
    await assert.rejects(
      searchQwant({
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

test("parses Yahoo organic HTML and redirect URLs", async () => {
  const results = parseYahooResults(await fixture("yahoo.html"));

  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Cloudflare Workers");
  assert.equal(results[0].url, "https://example.com/workers");
  assert.equal(results[1].title, "Workers KV");
  assert.equal(results[1].url, "https://example.com/kv");
});

test("extracts Yahoo redirect URLs safely", () => {
  const redirect =
    "https://r.search.yahoo.com/_ylt=x/RV=2/RU=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1/RK=2/RS=x";

  assert.equal(
    extractYahooRedirectUrl(redirect),
    "https://example.com/docs?a=1"
  );
});

test("rejects Yahoo bot-detection challenge pages", () => {
  const html = `
    <html>
      <body>
        <form id="captcha-form">
          <p>Verify you are human</p>
        </form>
      </body>
    </html>
  `;

  assert.throws(() => parseYahooResults(html), {
    code: "UPSTREAM_BLOCKED",
  });
});

test("requests Yahoo with domain, time, page, and cookie preferences", async () => {
  const yahooHtml = await fixture("yahoo.html");
  const fetchCapture = installFetchCapture(() =>
    new Response(yahooHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  );

  try {
    await searchYahoo({
      query: "cloudflare workers",
      language: "en-gb",
      time_range: "month",
      pageno: 1,
    });
  } finally {
    fetchCapture.restore();
  }

  const call = fetchCapture.calls[0];
  const url = new URL(call.url);
  assert.equal(url.hostname, "uk.search.yahoo.com");
  assert.equal(url.searchParams.get("p"), "cloudflare workers");
  assert.equal(url.searchParams.get("btf"), "m");
  assert.equal(url.searchParams.get("b"), "15");
  assert.equal(url.searchParams.get("pz"), "7");
  assert.equal(call.init.referrer, "https://uk.search.yahoo.com/");
  assert.match(getCapturedHeader(call.init, "cookie"), /sB=v=1&vm=p&fl=1&vl=lang_en/);
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
