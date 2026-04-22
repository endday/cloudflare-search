import { ApiError } from "./errors.js";

export const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

export function getAcceptLanguageHeader(language) {
  const normalized = String(language || "").trim().toLowerCase();

  if (!normalized) {
    return "en-US,en;q=0.9";
  }

  if (normalized.startsWith("zh")) {
    return "zh-CN,zh;q=0.9,en;q=0.8";
  }

  if (normalized.startsWith("en-gb")) {
    return "en-GB,en;q=0.9";
  }

  if (normalized.startsWith("en")) {
    return "en-US,en;q=0.9";
  }

  return `${language},en;q=0.8`;
}

export function getDefaultFetchHeaders(language, extraHeaders = {}) {
  return {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": getAcceptLanguageHeader(language),
    "user-agent": SEARCH_USER_AGENT,
    ...extraHeaders,
  };
}

export async function fetchText(
  url,
  { signal, language, headers = {}, referrer } = {}
) {
  const response = await fetch(url, {
    signal,
    redirect: "follow",
    referrer,
    headers: getDefaultFetchHeaders(language, headers),
  });

  if (!response.ok) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_BAD_STATUS",
      category: "upstream",
      message: `Upstream request failed with status ${response.status}`,
      details: {
        upstream_status: response.status,
        url,
      },
    });
  }

  return response.text();
}

export async function fetchJson(
  url,
  { signal, language, headers = {}, referrer } = {}
) {
  const response = await fetch(url, {
    signal,
    redirect: "follow",
    referrer,
    headers: getDefaultFetchHeaders(language, {
      accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
      ...headers,
    }),
  });

  if (!response.ok) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_BAD_STATUS",
      category: "upstream",
      message: `Upstream request failed with status ${response.status}`,
      details: {
        upstream_status: response.status,
        url,
      },
    });
  }

  return response.json();
}

export function ensureAbsoluteUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch (_) {
    return String(url || "").trim();
  }
}

export function mapTimeRange(timeRange, mapping) {
  if (!timeRange) {
    return "";
  }

  return mapping[String(timeRange).toLowerCase()] || "";
}

export function mapLanguage(language, mapping, fallback = "") {
  if (!language) {
    return fallback;
  }

  const normalized = String(language).toLowerCase();
  const short = normalized.split("-")[0];
  return mapping[normalized] || mapping[short] || fallback;
}

export function resolvePageNumber(value) {
  const parsed = Number.parseInt(value ?? "0", 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}
