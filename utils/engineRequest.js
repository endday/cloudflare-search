import { ApiError } from "./errors.js";
import {
  SEARCH_USER_AGENT,
  getAcceptLanguageHeader,
} from "./engineUtils.js";

function appendParam(target, key, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => appendParam(target, key, item));
    return;
  }

  target.append(key, String(value));
}

function applyParams(target, params) {
  if (!params) {
    return;
  }

  if (params instanceof URLSearchParams) {
    for (const [key, value] of params.entries()) {
      appendParam(target, key, value);
    }
    return;
  }

  for (const [key, value] of Object.entries(params)) {
    appendParam(target, key, value);
  }
}

function normalizeHeaders(headers = {}) {
  const normalized = {};
  const entries =
    headers instanceof Headers ? headers.entries() : Object.entries(headers);

  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    normalized[String(key).toLowerCase()] = String(value);
  }

  return normalized;
}

function toFormBody(form) {
  const params = new URLSearchParams();
  applyParams(params, form);
  return params.toString();
}

export function buildCookieHeader(cookies) {
  if (!cookies) {
    return "";
  }

  if (typeof cookies === "string") {
    return cookies.trim();
  }

  const parts = [];
  const entries = Array.isArray(cookies) ? cookies : Object.entries(cookies);

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }

    const [key, value] = entry;
    if (!key || value === undefined || value === null || value === "") {
      continue;
    }

    parts.push(`${String(key).trim()}=${String(value).trim()}`);
  }

  return parts.join("; ");
}

export function isChallengeResponse(source, patterns = []) {
  const text = String(source || "");

  return patterns.some((pattern) => {
    if (!pattern) {
      return false;
    }

    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      return pattern.test(text);
    }

    return text.includes(String(pattern));
  });
}

export function createBlockedUpstreamError({
  engine = "Upstream",
  surface = "response",
  message,
  details,
} = {}) {
  return new ApiError({
    status: 502,
    code: "UPSTREAM_BLOCKED",
    category: "upstream",
    message: message || `${engine} returned a bot-detection challenge (${surface})`,
    details,
  });
}

export function throwBlockedUpstreamError(options = {}) {
  throw createBlockedUpstreamError(options);
}

export function buildEngineRequest(
  url,
  {
    signal,
    language,
    method,
    searchParams,
    form,
    body,
    headers = {},
    cookies,
    referrer,
    accept,
    acceptLanguage,
    userAgent,
    origin,
  } = {}
) {
  const requestUrl = new URL(url);
  const requestMethod = String(method || (form ? "POST" : "GET")).toUpperCase();
  const requestHeaders = normalizeHeaders({
    accept:
      accept ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": acceptLanguage || getAcceptLanguageHeader(language),
    "user-agent": userAgent || SEARCH_USER_AGENT,
    ...normalizeHeaders(headers),
  });
  const cookieHeader = buildCookieHeader(cookies);

  if (cookieHeader) {
    requestHeaders.cookie = cookieHeader;
  }

  if (origin) {
    requestHeaders.origin = origin;
  }

  applyParams(requestUrl.searchParams, searchParams);

  let requestBody = body;
  if (form && requestBody === undefined) {
    requestBody = toFormBody(form);
    if (!requestHeaders["content-type"]) {
      requestHeaders["content-type"] =
        "application/x-www-form-urlencoded; charset=UTF-8";
    }
  }

  const init = {
    method: requestMethod,
    signal,
    redirect: "follow",
    referrer,
    headers: requestHeaders,
  };

  if (requestBody !== undefined && requestMethod !== "GET") {
    init.body = requestBody;
  }

  return {
    url: requestUrl.toString(),
    init,
  };
}

export async function fetchSearchText(
  url,
  {
    engine,
    engineLabel,
    blockedStatuses = [],
    isBlocked,
    blockedSurface = "response",
    ...requestOptions
  } = {}
) {
  const { url: requestUrl, init } = buildEngineRequest(url, requestOptions);
  const response = await fetch(requestUrl, init);
  const details = {
    engine,
    upstream_status: response.status,
    url: requestUrl,
  };

  if (blockedStatuses.includes(response.status)) {
    throw createBlockedUpstreamError({
      engine: engineLabel || engine || "Upstream",
      surface: `status ${response.status}`,
      details,
    });
  }

  if (!response.ok) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_BAD_STATUS",
      category: "upstream",
      message: `Upstream request failed with status ${response.status}`,
      details,
    });
  }

  const text = await response.text();

  if (typeof isBlocked === "function" && isBlocked(text, response)) {
    throw createBlockedUpstreamError({
      engine: engineLabel || engine || "Upstream",
      surface: blockedSurface,
      details,
    });
  }

  return text;
}
