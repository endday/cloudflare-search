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

const DUCKDUCKGO_LANGUAGE = {
  en: "us-en",
  "en-us": "us-en",
  "en-gb": "uk-en",
  zh: "cn-zh",
  "zh-cn": "cn-zh",
  "zh-tw": "tw-zh",
};

const DUCKDUCKGO_TIME_RANGE = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

function extractDuckDuckGoUrl(rawUrl) {
  const absoluteUrl = ensureAbsoluteUrl(rawUrl, "https://duckduckgo.com");

  try {
    const parsed = new URL(absoluteUrl);
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : absoluteUrl;
  } catch (_) {
    return absoluteUrl;
  }
}

export function parseDuckDuckGoResults(html) {
  const root = parseHtml(html);
  const resultNodes = root.querySelectorAll(".result");
  const results = [];

  for (const node of resultNodes) {
    const linkNode =
      node.querySelector("a.result__a[href]") || node.querySelector("a[href]");
    const snippetNode =
      node.querySelector(".result__snippet") ||
      node.querySelector(".result__body");

    if (!linkNode) {
      continue;
    }

    results.push({
      title: cleanText(linkNode.innerHTML || linkNode.text),
      url: extractDuckDuckGoUrl(linkNode.getAttribute("href")),
      description: cleanText(snippetNode?.innerHTML || snippetNode?.text || ""),
    });
  }

  if (results.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "DuckDuckGo parser could not find organic results",
    });
  }

  return normalizeResults(results);
}

async function searchDuckDuckGo(params) {
  const { query, language, time_range, pageno, signal } = params;
  const page = resolvePageNumber(pageno);

  if (page > 0) {
    throw new ApiError({
      status: 400,
      code: "UNSUPPORTED_PARAMETER",
      category: "validation",
      message: "DuckDuckGo HTML pagination is not supported",
    });
  }

  const searchUrl = new URL("https://html.duckduckgo.com/html/");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set(
    "kl",
    mapLanguage(language, DUCKDUCKGO_LANGUAGE, "wt-wt")
  );

  const timeFilter = mapTimeRange(time_range, DUCKDUCKGO_TIME_RANGE);
  if (timeFilter) {
    searchUrl.searchParams.set("df", timeFilter);
  }

  const html = await fetchText(searchUrl.toString(), {
    signal,
    language,
    headers: {
      Referer: "https://duckduckgo.com/",
    },
  });

  return parseDuckDuckGoResults(html);
}

export const duckDuckGoAdapter = {
  name: "duckduckgo",
  label: "DuckDuckGo",
  priority: 70,
  supports: {
    language: true,
    time_range: true,
    pageno: false,
  },
  isAvailable: () => true,
  search: searchDuckDuckGo,
};

export default searchDuckDuckGo;
