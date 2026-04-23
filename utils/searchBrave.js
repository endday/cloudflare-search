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
} from "./engineUtils.js";
import { cleanText, parseHtml } from "./html.js";
import { normalizeResults } from "./index.js";

const BRAVE_TIME_RANGE = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

const BRAVE_LANGUAGE = {
  en: "en-us",
  "en-us": "en-us",
  "en-gb": "en-gb",
  zh: "zh-hans",
  "zh-cn": "zh-hans",
  "zh-tw": "zh-hant",
};

const BRAVE_COUNTRY = {
  en: "us",
  "en-us": "us",
  "en-gb": "gb",
  zh: "cn",
  "zh-cn": "cn",
  "zh-tw": "tw",
};

const BRAVE_CHALLENGE_PATTERNS = [
  /name=["']captcha["']/i,
  /id=["'][^"']*captcha[^"']*["']/i,
];

function isBraveChallengeResponse(source) {
  const text = String(source || "");

  return (
    isChallengeResponse(text, BRAVE_CHALLENGE_PATTERNS) ||
    ((/verify you are human/i.test(text) || /unusual traffic/i.test(text)) &&
      /<form\b/i.test(text))
  );
}

function throwBraveChallengeError() {
  throwBlockedUpstreamError({
    engine: "Brave",
    surface: "html",
  });
}

export function parseBraveResults(html) {
  if (isBraveChallengeResponse(html)) {
    throwBraveChallengeError();
  }

  const root = parseHtml(html);
  const resultNodes = root
    .querySelectorAll(".snippet")
    .filter((node) => node.getAttribute("data-type") === "web");
  const results = [];

  for (const node of resultNodes) {
    const linkNode =
      node.querySelector("a.l1[href]") || node.querySelector("a[href]");
    const titleNode =
      node.querySelector(".title") || node.querySelector(".search-snippet-title");
    const descriptionNode =
      node.querySelector(".generic-snippet .content") ||
      node.querySelector(".content");

    if (!linkNode || !titleNode) {
      continue;
    }

    results.push({
      title: cleanText(titleNode.innerHTML || titleNode.text),
      url: ensureAbsoluteUrl(
        linkNode.getAttribute("href"),
        "https://search.brave.com"
      ),
      description: cleanText(
        descriptionNode?.innerHTML || descriptionNode?.text || ""
      ),
    });
  }

  if (results.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "Brave parser could not find organic results",
    });
  }

  return normalizeResults(results);
}

async function searchBrave(params) {
  const { query, language, time_range, signal } = params;
  const searchUrl = new URL("https://search.brave.com/search");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("spellcheck", "0");
  searchUrl.searchParams.set("source", "web");
  searchUrl.searchParams.set("summary", "0");

  const timeFilter = mapTimeRange(time_range, BRAVE_TIME_RANGE);
  if (timeFilter) {
    searchUrl.searchParams.set("tf", timeFilter);
  }

  const html = await fetchSearchText(searchUrl.toString(), {
    engine: "brave",
    engineLabel: "Brave",
    signal,
    language,
    cookies: {
      country: mapLanguage(language, BRAVE_COUNTRY, "us"),
      ui_lang: mapLanguage(language, BRAVE_LANGUAGE, "en-us"),
      useLocation: "0",
      summarizer: "0",
      safesearch: "off",
    },
    referrer: "https://search.brave.com/",
    blockedStatuses: [403, 429],
    isBlocked: isBraveChallengeResponse,
    blockedSurface: "html",
  });

  return parseBraveResults(html);
}

export const braveAdapter = {
  name: "brave",
  label: "Brave",
  priority: 90,
  supports: {
    language: true,
    time_range: true,
    pageno: false,
  },
  isAvailable: () => true,
  search: searchBrave,
};

export default searchBrave;
