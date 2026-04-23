import { ApiError } from "./errors.js";
import {
  fetchSearchText,
  isChallengeResponse,
  throwBlockedUpstreamError,
} from "./engineRequest.js";
import {
  ensureAbsoluteUrl,
  mapLanguage,
  resolvePageNumber,
} from "./engineUtils.js";
import { cleanText, parseHtml } from "./html.js";
import { normalizeResults } from "./index.js";

const QWANT_LANGUAGE = {
  en: "en_US",
  "en-us": "en_US",
  "en-gb": "en_GB",
  zh: "zh_CN",
  "zh-cn": "zh_CN",
  "zh-tw": "zh_TW",
  fr: "fr_FR",
  de: "de_DE",
  es: "es_ES",
  it: "it_IT",
};

const QWANT_CHALLENGE_PATTERNS = [
  /<title>\s*Service unavailable\s*<\/title>/i,
  /name=["']captcha["']/i,
  /id=["'][^"']*captcha[^"']*["']/i,
];

function isQwantChallengeResponse(source) {
  const text = String(source || "");
  const hasResultArticles = /<section\b[\s\S]*<article\b/i.test(text);

  return (
    (isChallengeResponse(text, QWANT_CHALLENGE_PATTERNS) && !hasResultArticles) ||
    ((/verify you are human/i.test(text) || /unusual traffic/i.test(text)) &&
      /<form\b/i.test(text))
  );
}

function throwQwantChallengeError() {
  throwBlockedUpstreamError({
    engine: "Qwant",
    surface: "html",
  });
}

function normalizeQwantUrl(rawUrl) {
  const value = String(rawUrl || "").trim();

  if (!value) {
    return "";
  }

  if (/^https?:\/\//i.test(value) || value.startsWith("//")) {
    return ensureAbsoluteUrl(value, "https://www.qwant.com");
  }

  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)) {
    return `https://${value}`;
  }

  return ensureAbsoluteUrl(value, "https://www.qwant.com");
}

function extractQwantResultUrl(node, linkNode) {
  const visibleUrlNode =
    node.querySelector("span.url.partner") ||
    node.querySelector(".url.partner") ||
    node.querySelector(".url");
  const visibleUrl = cleanText(
    visibleUrlNode?.innerHTML || visibleUrlNode?.text || ""
  );

  return normalizeQwantUrl(visibleUrl || linkNode.getAttribute("href"));
}

export function parseQwantResults(html) {
  if (isQwantChallengeResponse(html)) {
    throwQwantChallengeError();
  }

  const root = parseHtml(html);
  const resultNodes = root.querySelectorAll("section article");
  const results = [];

  for (const node of resultNodes) {
    if (node.querySelector("span.tooltip")) {
      continue;
    }

    const linkNode = node.querySelector("h2 a[href]") || node.querySelector("a[href]");
    if (!linkNode) {
      continue;
    }

    const descriptionNode = node.querySelector("p");

    results.push({
      title: cleanText(linkNode.innerHTML || linkNode.text),
      url: extractQwantResultUrl(node, linkNode),
      description: cleanText(
        descriptionNode?.innerHTML || descriptionNode?.text || ""
      ),
    });
  }

  const normalized = normalizeResults(results);
  if (normalized.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "Qwant parser could not find organic results",
    });
  }

  return normalized;
}

async function searchQwant(params) {
  const { query, language, time_range, pageno, signal } = params;

  if (time_range) {
    throw new ApiError({
      status: 400,
      code: "UNSUPPORTED_PARAMETER",
      category: "validation",
      message: "Qwant Lite time_range filtering is not supported",
    });
  }

  const page = resolvePageNumber(pageno);
  if (page > 4) {
    throw new ApiError({
      status: 400,
      code: "UNSUPPORTED_PARAMETER",
      category: "validation",
      message: "Qwant Lite supports at most five result pages",
    });
  }

  const locale = mapLanguage(language, QWANT_LANGUAGE, "en_US");
  const searchUrl = new URL("https://lite.qwant.com/");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("locale", locale.toLowerCase());
  searchUrl.searchParams.set("l", locale.split("_")[0]);
  searchUrl.searchParams.set("s", "1");
  searchUrl.searchParams.set("p", String(page + 1));

  const html = await fetchSearchText(searchUrl.toString(), {
    engine: "qwant",
    engineLabel: "Qwant",
    signal,
    language,
    referrer: "https://www.qwant.com/",
    blockedStatuses: [403, 429, 503],
    isBlocked: isQwantChallengeResponse,
    blockedSurface: "html",
  });

  return parseQwantResults(html);
}

export const qwantAdapter = {
  name: "qwant",
  label: "Qwant",
  priority: 85,
  supports: {
    language: true,
    time_range: false,
    pageno: true,
  },
  isAvailable: () => true,
  search: searchQwant,
};

export default searchQwant;
