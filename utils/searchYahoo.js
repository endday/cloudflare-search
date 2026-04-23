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

const YAHOO_TIME_RANGE = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

const YAHOO_LANGUAGE = {
  all: "any",
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  zh: "zh_chs",
  "zh-cn": "zh_chs",
  "zh-tw": "zh_cht",
  fr: "fr",
  de: "de",
  es: "es",
  it: "it",
  ja: "ja",
  ko: "ko",
  pt: "pt",
};

const YAHOO_REGION_DOMAIN = {
  AR: "ar.search.yahoo.com",
  BR: "br.search.yahoo.com",
  CA: "ca.search.yahoo.com",
  CL: "cl.search.yahoo.com",
  CO: "co.search.yahoo.com",
  DE: "de.search.yahoo.com",
  ES: "espanol.search.yahoo.com",
  FR: "fr.search.yahoo.com",
  GB: "uk.search.yahoo.com",
  HK: "hk.search.yahoo.com",
  IN: "in.search.yahoo.com",
  MX: "mx.search.yahoo.com",
  PE: "pe.search.yahoo.com",
  PH: "ph.search.yahoo.com",
  SG: "sg.search.yahoo.com",
  TH: "th.search.yahoo.com",
  TW: "tw.search.yahoo.com",
  UK: "uk.search.yahoo.com",
  VE: "ve.search.yahoo.com",
};

const YAHOO_LANGUAGE_DOMAIN = {
  any: "search.yahoo.com",
  en: "search.yahoo.com",
  zh_chs: "hk.search.yahoo.com",
  zh_cht: "tw.search.yahoo.com",
  bg: "search.yahoo.com",
  cs: "search.yahoo.com",
  da: "search.yahoo.com",
  el: "search.yahoo.com",
  et: "search.yahoo.com",
  he: "search.yahoo.com",
  hr: "search.yahoo.com",
  ja: "search.yahoo.com",
  ko: "search.yahoo.com",
  sk: "search.yahoo.com",
  sl: "search.yahoo.com",
};

const YAHOO_CHALLENGE_PATTERNS = [
  /name=["']captcha["']/i,
  /id=["'][^"']*captcha[^"']*["']/i,
];

function isYahooChallengeResponse(source) {
  const text = String(source || "");

  return (
    isChallengeResponse(text, YAHOO_CHALLENGE_PATTERNS) ||
    ((/verify you are human/i.test(text) || /unusual traffic/i.test(text)) &&
      /<form\b/i.test(text))
  );
}

function throwYahooChallengeError() {
  throwBlockedUpstreamError({
    engine: "Yahoo",
    surface: "html",
  });
}

function getYahooLanguageParts(language) {
  const normalized = String(language || "").trim().toLowerCase();
  const [lang = "en", region = ""] = normalized.split("-");

  return {
    lang,
    region: region.toUpperCase(),
    yahooLanguage: mapLanguage(normalized, YAHOO_LANGUAGE, "any"),
  };
}

function resolveYahooDomain(language) {
  const { lang, region, yahooLanguage } = getYahooLanguageParts(language);

  return (
    YAHOO_REGION_DOMAIN[region] ||
    YAHOO_LANGUAGE_DOMAIN[yahooLanguage] ||
    `${lang}.search.yahoo.com`
  );
}

function buildYahooCookie(language) {
  const { yahooLanguage } = getYahooLanguageParts(language);

  return [
    "v=1",
    "vm=p",
    "fl=1",
    `vl=lang_${yahooLanguage}`,
    "pn=10",
    "rw=new",
    "userset=1",
  ].join("&");
}

export function extractYahooRedirectUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  const redirectMarker = "/RU=";
  const markerIndex = value.indexOf(redirectMarker);

  if (markerIndex === -1) {
    return value;
  }

  const start = value.indexOf("http", markerIndex + redirectMarker.length);
  if (start === -1) {
    return value;
  }

  const endMarkers = ["/RS", "/RK"]
    .map((marker) => value.indexOf(marker, start))
    .filter((index) => index > start);
  const end = endMarkers.length > 0 ? Math.min(...endMarkers) : value.length;

  try {
    return decodeURIComponent(value.slice(start, end));
  } catch (_) {
    return value.slice(start, end);
  }
}

function extractYahooTitle(node, linkNode) {
  const ariaLabel = linkNode.getAttribute("aria-label");
  if (ariaLabel) {
    return cleanText(ariaLabel);
  }

  const titleNode =
    node.querySelector(".compTitle h3 a") ||
    node.querySelector(".compTitle a h3") ||
    node.querySelector("h3");

  return cleanText(titleNode?.innerHTML || titleNode?.text || linkNode.text || "");
}

export function parseYahooResults(html) {
  if (isYahooChallengeResponse(html)) {
    throwYahooChallengeError();
  }

  const root = parseHtml(html);
  const resultNodes = root.querySelectorAll("div.algo-sr");
  const results = [];

  for (const node of resultNodes) {
    const linkNode =
      node.querySelector(".compTitle h3 a[href]") ||
      node.querySelector(".compTitle a[href]");

    if (!linkNode) {
      continue;
    }

    const rawUrl = ensureAbsoluteUrl(
      linkNode.getAttribute("href"),
      "https://search.yahoo.com"
    );
    const descriptionNode = node.querySelector(".compText");

    results.push({
      title: extractYahooTitle(node, linkNode),
      url: extractYahooRedirectUrl(rawUrl),
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
      message: "Yahoo parser could not find organic results",
    });
  }

  return normalized;
}

async function searchYahoo(params) {
  const { query, language, time_range, pageno, signal } = params;
  const page = resolvePageNumber(pageno);
  const domain = resolveYahooDomain(language);
  const searchUrl = new URL(`https://${domain}/search`);
  searchUrl.searchParams.set("p", query);

  const timeFilter = mapTimeRange(time_range, YAHOO_TIME_RANGE);
  if (timeFilter) {
    searchUrl.searchParams.set("btf", timeFilter);
  }

  if (page === 0) {
    searchUrl.searchParams.set("iscqry", "");
  } else {
    searchUrl.searchParams.set("b", String((page + 1) * 7 + 1));
    searchUrl.searchParams.set("pz", "7");
    searchUrl.searchParams.set("bct", "0");
    searchUrl.searchParams.set("xargs", "0");
  }

  const html = await fetchSearchText(searchUrl.toString(), {
    engine: "yahoo",
    engineLabel: "Yahoo",
    signal,
    language,
    cookies: {
      sB: buildYahooCookie(language),
    },
    referrer: `https://${domain}/`,
    blockedStatuses: [403, 429],
    isBlocked: isYahooChallengeResponse,
    blockedSurface: "html",
  });

  return parseYahooResults(html);
}

export const yahooAdapter = {
  name: "yahoo",
  label: "Yahoo",
  priority: 75,
  supports: {
    language: true,
    time_range: true,
    pageno: true,
  },
  isAvailable: () => true,
  search: searchYahoo,
};

export default searchYahoo;
