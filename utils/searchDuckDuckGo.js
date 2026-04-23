import { ApiError } from "./errors.js";
import {
  fetchSearchText,
  isChallengeResponse,
  throwBlockedUpstreamError,
} from "./engineRequest.js";
import {
  ensureAbsoluteUrl,
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

const DUCKDUCKGO_CHALLENGE_PATTERNS = [
  /anomaly\.js/i,
  /bots use DuckDuckGo too/i,
  /automated requests/i,
];

function isDuckDuckGoChallengeResponse(source) {
  const text = String(source || "");

  return (
    isChallengeResponse(text, DUCKDUCKGO_CHALLENGE_PATTERNS) ||
    (/verify you are human/i.test(text) && /<form\b/i.test(text))
  );
}

function throwDuckDuckGoChallengeError() {
  throwBlockedUpstreamError({
    engine: "DuckDuckGo",
    surface: "html",
  });
}

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
  if (isDuckDuckGoChallengeResponse(html)) {
    throwDuckDuckGoChallengeError();
  }

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
  const locale = mapLanguage(language, DUCKDUCKGO_LANGUAGE, "wt-wt");

  if (page > 0) {
    throw new ApiError({
      status: 400,
      code: "UNSUPPORTED_PARAMETER",
      category: "validation",
      message: "DuckDuckGo HTML pagination is not supported",
    });
  }

  const timeFilter = mapTimeRange(time_range, DUCKDUCKGO_TIME_RANGE);
  const html = await fetchSearchText("https://html.duckduckgo.com/html/", {
    engine: "duckduckgo",
    engineLabel: "DuckDuckGo",
    signal,
    language,
    method: "POST",
    form: {
      q: query,
      kl: locale,
      ...(timeFilter ? { df: timeFilter } : {}),
    },
    cookies: {
      kl: locale,
      ...(timeFilter ? { df: timeFilter } : {}),
    },
    referrer: "https://html.duckduckgo.com/",
    origin: "https://html.duckduckgo.com",
    blockedStatuses: [403, 429],
    isBlocked: isDuckDuckGoChallengeResponse,
    blockedSurface: "html",
  });

  return parseDuckDuckGoResults(html);
}

export const duckDuckGoAdapter = {
  name: "duckduckgo",
  label: "DuckDuckGo",
  priority: 95,
  supports: {
    language: true,
    time_range: true,
    pageno: false,
  },
  isAvailable: () => true,
  search: searchDuckDuckGo,
};

export default searchDuckDuckGo;
