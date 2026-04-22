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

function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
  const resultNodes = root.querySelectorAll("li.b_algo");
  const results = [];

  for (const node of resultNodes) {
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
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "Bing parser could not find organic results",
    });
  }

  return normalizeResults(results);
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

  return parseBingResults(html);
}

export const bingAdapter = {
  name: "bing",
  label: "Bing",
  priority: 100,
  supports: {
    language: true,
    time_range: true,
    pageno: false,
  },
  isAvailable: () => true,
  search: searchBing,
};

export default searchBing;
