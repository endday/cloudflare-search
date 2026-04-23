import { ApiError } from "./errors.js";
import {
  fetchSearchText,
  isChallengeResponse,
  throwBlockedUpstreamError,
} from "./engineRequest.js";
import {
  mapLanguage,
  resolvePageNumber,
} from "./engineUtils.js";
import { cleanText, extractBalancedSegment } from "./html.js";
import { normalizeResults } from "./index.js";

const STARTPAGE_LANGUAGE = {
  en: "english",
  zh: "chinese_simplified",
  "zh-cn": "chinese_simplified",
  "zh-tw": "chinese_traditional",
};

const STARTPAGE_CHALLENGE_PATTERNS = [
  /\/sp\/captcha\b/i,
  /name=["']captcha["']/i,
];
const STARTPAGE_SC_TTL_MS = 15 * 60 * 1000;
let cachedStartpageSc = {
  value: "",
  expiresAt: 0,
};

function isStartpageChallengeResponse(source) {
  const text = String(source || "");

  return (
    isChallengeResponse(text, STARTPAGE_CHALLENGE_PATTERNS) ||
    ((/verify you are human/i.test(text) || /unusual traffic/i.test(text)) &&
      /<form\b/i.test(text))
  );
}

function throwStartpageChallengeError(surface) {
  throwBlockedUpstreamError({
    engine: "Startpage",
    surface,
  });
}

function extractStartpageScToken(html) {
  const match =
    html.match(/<input\b[^>]*name=["']sc["'][^>]*value=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<input\b[^>]*value=["']([^"']+)["'][^>]*name=["']sc["'][^>]*>/i);

  return match?.[1]?.trim() || "";
}

function buildStartpagePreferences(languageValue) {
  const preferences = [
    ["disable_family_filter", "1"],
    ["enable_post_method", "1"],
    ["instant_answers", "0"],
    ["num_of_results", "10"],
  ];

  if (languageValue) {
    preferences.push(
      ["lang_homepage", languageValue],
      ["language", languageValue],
      ["lui", languageValue]
    );
  }

  return encodeURIComponent(
    preferences.map(([key, value]) => `${key}EEE${value}`).join("N1N")
  );
}

async function fetchStartpageScToken({ signal, language }) {
  if (cachedStartpageSc.value && cachedStartpageSc.expiresAt > Date.now()) {
    return cachedStartpageSc.value;
  }

  try {
    const html = await fetchSearchText("https://www.startpage.com/", {
      engine: "startpage",
      engineLabel: "Startpage",
      signal,
      language,
      referrer: "https://www.startpage.com/",
      blockedStatuses: [403, 429],
      isBlocked: isStartpageChallengeResponse,
      blockedSurface: "home",
    });
    const token = extractStartpageScToken(html);

    if (token) {
      cachedStartpageSc = {
        value: token,
        expiresAt: Date.now() + STARTPAGE_SC_TTL_MS,
      };
    }

    return token;
  } catch (_) {
    return "";
  }
}

export function resetStartpageRequestState() {
  cachedStartpageSc = {
    value: "",
    expiresAt: 0,
  };
}

function extractStartpageResultArray(html) {
  const markerIndex = [
    '"display_type":"web-google"',
    '"display_type":"web-results"',
    '"display_type":"web"',
  ]
    .map((marker) => html.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (typeof markerIndex !== "number") {
    return null;
  }

  const resultsMarker = '"results":';
  const resultsIndex = html.indexOf(resultsMarker, markerIndex);
  if (resultsIndex === -1) {
    return null;
  }

  const arrayStart = html.indexOf("[", resultsIndex);
  if (arrayStart === -1) {
    return null;
  }

  return JSON.parse(extractBalancedSegment(html, arrayStart));
}

export function parseStartpageResults(html) {
  if (isStartpageChallengeResponse(html)) {
    throwStartpageChallengeError("html");
  }

  const items = extractStartpageResultArray(html);

  if (!Array.isArray(items)) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "Startpage parser could not find result payload",
    });
  }

  return normalizeResults(
    items
      .filter((item) => item?.clickUrl && item?.title)
      .map((item) => ({
        title: cleanText(item.title),
        url: item.clickUrl,
        description: cleanText(item.description || ""),
      }))
  );
}

async function searchStartpage(params) {
  const { query, language, time_range, pageno, signal } = params;

  if (time_range) {
    throw new ApiError({
      status: 400,
      code: "UNSUPPORTED_PARAMETER",
      category: "validation",
      message: "Startpage time_range filtering is not supported",
    });
  }

  const page = resolvePageNumber(pageno);
  const languageValue = mapLanguage(language, STARTPAGE_LANGUAGE, "");
  const sc = await fetchStartpageScToken({ signal, language });
  const html = await fetchSearchText("https://www.startpage.com/sp/search", {
    engine: "startpage",
    engineLabel: "Startpage",
    signal,
    language,
    method: "POST",
    form: {
      query,
      cat: "web",
      segment: "startpage.udog",
      ...(page > 0 ? { page: String(page + 1) } : {}),
      ...(languageValue
        ? {
            language: languageValue,
            lui: languageValue,
          }
        : {}),
      ...(sc ? { sc } : {}),
    },
    cookies: {
      preferences: buildStartpagePreferences(languageValue),
    },
    referrer: "https://www.startpage.com/",
    origin: "https://www.startpage.com",
    blockedStatuses: [403, 429],
    isBlocked: isStartpageChallengeResponse,
    blockedSurface: "html",
  });

  return parseStartpageResults(html);
}

export const startpageAdapter = {
  name: "startpage",
  label: "Startpage",
  priority: 100,
  supports: {
    language: true,
    time_range: false,
    pageno: true,
  },
  isAvailable: () => true,
  search: searchStartpage,
};

export default searchStartpage;
