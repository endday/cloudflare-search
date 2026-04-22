import { ApiError } from "./errors.js";
import {
  ensureAbsoluteUrl,
  fetchText,
  mapLanguage,
  mapTimeRange,
  resolvePageNumber,
} from "./engineUtils.js";
import { cleanText, parseHtml } from "./html.js";
import { normalizeResults } from "./index.js";

const BING_TIME_RANGE = {
  day: '+filterui:age-lt1440',
  week: '+filterui:age-lt10080',
  month: '+filterui:age-lt43200',
  year: '+filterui:age-lt525600',
};

const BING_LANGUAGE = {
  en: { setlang: "en-US", cc: "us", mkt: "en-US" },
  "en-us": { setlang: "en-US", cc: "us", mkt: "en-US" },
  "en-gb": { setlang: "en-GB", cc: "gb", mkt: "en-GB" },
  zh: { setlang: "zh-Hans", cc: "cn", mkt: "zh-CN" },
  "zh-cn": { setlang: "zh-Hans", cc: "cn", mkt: "zh-CN" },
  "zh-tw": { setlang: "zh-Hant", cc: "tw", mkt: "zh-TW" },
};

const XML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeXmlEntities(value) {
  return String(value || "").replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (match, entity) => {
      const normalized = entity.toLowerCase();

      if (normalized.startsWith("#")) {
        const isHex = normalized[1] === "x";
        const codePoint = Number.parseInt(
          normalized.slice(isHex ? 2 : 1),
          isHex ? 16 : 10
        );

        if (Number.isNaN(codePoint)) {
          return match;
        }

        try {
          return String.fromCodePoint(codePoint);
        } catch (_) {
          return match;
        }
      }

      return XML_ENTITIES[normalized] || match;
    }
  );
}

export function extractBingRedirectUrl(bingUrl) {
  if (!bingUrl || !bingUrl.includes("bing.com/ck/a?")) {
    return bingUrl;
  }

  try {
    const decodedUrl = bingUrl.replace(/&amp;/g, "&");
    const url = new URL(decodedUrl);
    const uParam = url.searchParams.get("u");

    if (!uParam?.startsWith("a1")) {
      return bingUrl;
    }

    return decodeBase64(uParam.slice(2));
  } catch (_) {
    return bingUrl;
  }
}

export function parseBingResults(html) {
  const root = parseHtml(html);
  const candidateNodes = collectBingResultNodes(root);
  const results = [];

  for (const node of candidateNodes) {
    const linkNode = node.querySelector("h2 a[href]");
    if (!linkNode) {
      continue;
    }

    const title = cleanText(linkNode.innerHTML || linkNode.text);
    const rawUrl = ensureAbsoluteUrl(
      linkNode.getAttribute("href"),
      "https://www.bing.com"
    );
    const url = extractBingRedirectUrl(rawUrl);
    const descriptionNode =
      node.querySelector(".b_caption p") ||
      node.querySelector(".b_snippet") ||
      node.querySelector("p");
    const description = cleanText(
      descriptionNode?.innerHTML || descriptionNode?.text || ""
    );

    results.push({
      title,
      url,
      description,
    });
  }

  if (results.length === 0) {
    const fallbackLinkCount = root.querySelectorAll("main h2 a[href]").length;
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: `Bing parser could not find organic results (h2_links=${fallbackLinkCount})`,
    });
  }

  return normalizeResults(results);
}

function extractXmlTagContent(source, tagName) {
  const match = source.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
  if (!match) {
    return "";
  }

  return match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .trim();
}

export function parseBingRssResults(xml) {
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  const results = normalizeResults(
    items.map((item) => {
      const source = item[1];

      return {
        title: cleanText(extractXmlTagContent(source, "title")),
        url: extractBingRedirectUrl(
          decodeXmlEntities(extractXmlTagContent(source, "link"))
        ),
        description: cleanText(extractXmlTagContent(source, "description")),
      };
    })
  );

  if (items.length === 0 || results.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: `Bing RSS parser could not find valid results (items=${items.length}, normalized=${results.length})`,
    });
  }

  return results;
}

function isBingNoiseNode(node) {
  let current = node;

  while (current) {
    const id = current.getAttribute?.("id") || "";
    const className = current.getAttribute?.("class") || "";
    const classList = className.split(/\s+/).filter(Boolean);

    if (
      id === "b_context" ||
      id === "b_pole" ||
      classList.includes("b_pag") ||
      classList.includes("b_ad")
    ) {
      return true;
    }

    current = current.parentNode;
  }

  return false;
}

function findBingResultContainer(node) {
  let current = node;
  let nearestContainer = node.parentNode || node;

  while (current) {
    if (["li", "div", "article", "section"].includes(current.rawTagName)) {
      nearestContainer = current;
    }

    const id = current.getAttribute?.("id") || "";
    if (id === "b_results" || current.rawTagName === "main") {
      return nearestContainer;
    }

    current = current.parentNode;
  }

  return nearestContainer;
}

function collectBingResultNodes(root) {
  const selectors = ["li.b_algo", "div.b_algo", "#b_results h2 a[href]", "main h2 a[href]"];
  const seenNodes = new Set();
  const resultNodes = [];

  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) {
      const linkNode = node.rawTagName === "a" ? node : node.querySelector("h2 a[href]");
      if (!linkNode || isBingNoiseNode(linkNode)) {
        continue;
      }

      const href = ensureAbsoluteUrl(linkNode.getAttribute("href"), "https://www.bing.com");
      if (!href || href.startsWith("https://www.bing.com/search?")) {
        continue;
      }

      const container = node.rawTagName === "a" ? findBingResultContainer(node) : node;
      if (!container || seenNodes.has(container)) {
        continue;
      }

      seenNodes.add(container);
      resultNodes.push(container);
    }
  }

  return resultNodes;
}

function buildBingSearchUrl({ query, language, time_range }) {
  const searchUrl = new URL("https://www.bing.com/search");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("form", "QBLH");

  const timeFilter = mapTimeRange(time_range, BING_TIME_RANGE);
  if (timeFilter) {
    searchUrl.searchParams.set("qft", timeFilter);
  }

  const languageConfig = mapLanguage(language, BING_LANGUAGE, null);
  if (languageConfig) {
    searchUrl.searchParams.set("setlang", languageConfig.setlang);
    searchUrl.searchParams.set("cc", languageConfig.cc);
    searchUrl.searchParams.set("mkt", languageConfig.mkt);
  }

  return searchUrl;
}

function buildBingRssUrl({ query, language, time_range }) {
  const searchUrl = buildBingSearchUrl({ query, language, time_range });
  searchUrl.searchParams.set("format", "rss");
  return searchUrl;
}

async function fetchBingHtml(searchUrl, { signal, language }) {
  const html = await fetchText(searchUrl.toString(), {
    signal,
    language,
    headers: {
      priority: "u=0, i",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "upgrade-insecure-requests": "1",
    },
  });

  return html;
}

async function fetchBingRss(searchUrl, { signal, language }) {
  return fetchText(searchUrl.toString(), {
    signal,
    language,
    headers: {
      accept: "application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.7",
    },
  });
}

async function searchBing(params) {
  const { query, language, time_range, pageno, signal } = params;
  const page = resolvePageNumber(pageno);

  if (page > 0) {
    throw new ApiError({
      status: 400,
      code: "UNSUPPORTED_PARAMETER",
      category: "validation",
      message: "Bing pagination is not supported",
    });
  }

  const searchUrl = buildBingSearchUrl({
    query,
    language,
    time_range,
  });
  const html = await fetchBingHtml(searchUrl, { signal, language });
  try {
    return parseBingResults(html);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "UPSTREAM_PARSE_ERROR") {
      throw error;
    }

    const rssUrl = buildBingRssUrl({
      query,
      language,
      time_range,
    });
    const rss = await fetchBingRss(rssUrl, { signal, language });
    return parseBingRssResults(rss);
  }
}

export const bingAdapter = {
  name: "bing",
  label: "Bing",
  priority: 50,
  supports: {
    language: true,
    time_range: true,
    pageno: false,
  },
  isAvailable: () => true,
  search: searchBing,
};

export default searchBing;
