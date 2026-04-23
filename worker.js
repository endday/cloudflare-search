import { env, setEnv } from "./envs.js";
import { ApiError, normalizeError, toErrorPayload } from "./utils/errors.js";
import { getSearchHtml } from "./utils/getHTML.js";
import { enforceRateLimit } from "./utils/rateLimit.js";
import { searchAllWithMeta } from "./utils/searchGateway.js";

const ALLOWED_METHODS = "GET, POST, OPTIONS";

function buildCorsHeaders(request) {
  const headers = {
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers":
      request.headers.get("Access-Control-Request-Headers") ||
      env.CORS_ALLOWED_HEADERS.join(", "),
    "Access-Control-Max-Age": "86400",
  };
  const origin = request.headers.get("Origin");

  if (env.CORS_ALLOWED_ORIGINS.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }

  if (origin && env.CORS_ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }

  return headers;
}

function jsonResponse(request, payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...buildCorsHeaders(request),
      ...headers,
    },
  });
}

function getRequestId(request) {
  return request.headers.get("cf-ray") || crypto.randomUUID();
}

function buildServerTimingHeader(engineTimings) {
  return engineTimings
    .map((timing) => `${timing.engine};dur=${timing.duration_ms}`)
    .join(", ");
}

function buildSearchResponseHeaders({ requestId, durationMs, meta }) {
  const headers = {
    "X-Search-Request-Id": requestId,
    "X-Search-Duration-Ms": String(durationMs),
    "X-Search-Cache": meta.cache_status,
    "X-Search-Fallback-Path": meta.fallback_path.join(","),
  };

  if (meta.fallback_order.length > 0) {
    headers["X-Search-Fallback-Order"] = meta.fallback_order.join(",");
  }

  if (meta.engine_timings.length > 0) {
    headers["Server-Timing"] = buildServerTimingHeader(meta.engine_timings);
  }

  return headers;
}

function getBearerToken(request) {
  return request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
}

function getRequestToken(request, paramToken) {
  return getBearerToken(request) || request.headers.get("x-api-key") || paramToken;
}

function isAuthorizedToken(requestToken) {
  if (!env.TOKEN) {
    return true;
  }

  return requestToken === env.TOKEN;
}

function verifyToken(requestToken) {
  return isAuthorizedToken(requestToken);
}

function getRateLimitToken(requestToken) {
  if (!env.TOKEN) {
    return null;
  }

  return isAuthorizedToken(requestToken) ? requestToken : null;
}

async function parsePostParams(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const payload = await request.json();
      return payload && typeof payload === "object" ? payload : {};
    } catch (_) {
      throw new ApiError({
        status: 400,
        code: "INVALID_JSON",
        category: "validation",
        message: "POST body must be valid JSON",
      });
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(await request.text()));
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    return Object.fromEntries(formData.entries());
  }

  try {
    const formData = await request.formData();
    return Object.fromEntries(formData.entries());
  } catch (_) {
    return {};
  }
}

async function parseRequestParams(request, url) {
  if (request.method === "GET") {
    return Object.fromEntries(url.searchParams.entries());
  }

  return parsePostParams(request);
}

function normalizeEngineParam(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    return value.split(",").filter(Boolean);
  }

  return undefined;
}

function normalizeTimeRange(value) {
  const normalized = String(value || "").toLowerCase();
  return ["day", "week", "month", "year"].includes(normalized)
    ? normalized
    : undefined;
}

function normalizePageNumber(value) {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

function normalizeLocationValue(value) {
  const normalized = String(value || "").trim();

  return normalized || "auto";
}

function isLocationDisabled(value) {
  return ["0", "false", "none", "off", "disable", "disabled"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function getClientLocation(request) {
  const cf = request.cf || {};

  return {
    city: String(cf.city || "").trim(),
    region: String(cf.region || "").trim(),
    country: String(cf.country || "").trim(),
    timezone: String(cf.timezone || "").trim(),
  };
}

function resolveLocationContext(request, params) {
  const locationValue = normalizeLocationValue(params.location);

  if (isLocationDisabled(locationValue)) {
    return {
      value: "",
      source: "disabled",
      mode: locationValue,
      client: getClientLocation(request),
    };
  }

  if (locationValue.toLowerCase() !== "auto") {
    return {
      value: locationValue,
      source: "explicit",
      mode: "explicit",
      client: getClientLocation(request),
    };
  }

  const client = getClientLocation(request);
  const value = client.city || client.region;

  return {
    value,
    source: value ? "auto" : "unavailable",
    mode: "auto",
    client,
  };
}

function appendLocationToQuery(query, location) {
  if (!location) {
    return query;
  }

  const normalizedQuery = String(query || "").trim();
  const normalizedLocation = String(location || "").trim();

  if (
    normalizedQuery
      .toLowerCase()
      .includes(normalizedLocation.toLowerCase())
  ) {
    return normalizedQuery;
  }

  return `${normalizedQuery} ${normalizedLocation}`;
}

function inferLanguageFromQuery(query, fallbackLanguage) {
  const normalizedQuery = String(query || "");

  if (/[\u3040-\u30ff]/u.test(normalizedQuery)) {
    return "ja-JP";
  }

  if (/[\uac00-\ud7af]/u.test(normalizedQuery)) {
    return "ko-KR";
  }

  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(normalizedQuery)) {
    return "zh-CN";
  }

  return fallbackLanguage;
}

function resolveSearchLanguage(params, query) {
  return (
    params.language ||
    params.lang ||
    inferLanguageFromQuery(query, env.DEFAULT_LANGUAGE)
  );
}

async function handleAuthVerify(request, params, requestId) {
  const requestToken = getRequestToken(request, params.token);

  await enforceRateLimit(request, getRateLimitToken(requestToken));

  if (!verifyToken(requestToken)) {
    throw new ApiError({
      status: 401,
      code: "UNAUTHORIZED",
      category: "auth",
      message: "Invalid or missing authentication token",
    });
  }

  return jsonResponse(
    request,
    {
      authorized: true,
      token_required: !!env.TOKEN,
    },
    200,
    {
      "X-Search-Request-Id": requestId,
    }
  );
}

async function handleSearch(request, params, requestId) {
  const query = String(params.q || params.query || "").trim();
  const requestToken = getRequestToken(request, params.token);
  const startedAt = Date.now();

  if (!query) {
    throw new ApiError({
      status: 400,
      code: "MISSING_QUERY",
      category: "validation",
      message: "Please provide 'q' or 'query' parameter",
    });
  }

  await enforceRateLimit(request, getRateLimitToken(requestToken));

  if (!verifyToken(requestToken)) {
    throw new ApiError({
      status: 401,
      code: "UNAUTHORIZED",
      category: "auth",
      message: "Invalid or missing authentication token",
    });
  }

  const locationContext = resolveLocationContext(request, params);
  const effectiveQuery = appendLocationToQuery(query, locationContext.value);

  const { response, meta } = await searchAllWithMeta({
    query: effectiveQuery,
    engines: normalizeEngineParam(params.engines),
    language: resolveSearchLanguage(params, query),
    time_range: normalizeTimeRange(params.time_range || params.timeRange),
    pageno: normalizePageNumber(params.pageno || params.page),
  });
  const responsePayload = {
    ...response,
    query,
    effective_query: effectiveQuery,
    location: locationContext.value || null,
    location_source: locationContext.source,
    location_context: locationContext,
  };

  return jsonResponse(
    request,
    responsePayload,
    200,
    buildSearchResponseHeaders({
      requestId,
      durationMs: Date.now() - startedAt,
      meta,
    })
  );
}

function createErrorResponse(request, requestId, error) {
  const normalized = normalizeError(error);
  const status = normalized.status || 500;
  const headers = {
    "X-Search-Request-Id": requestId,
  };

  if (normalized.details?.retry_after) {
    headers["Retry-After"] = String(normalized.details.retry_after);
  }

  return jsonResponse(request, toErrorPayload(normalized), status, headers);
}

async function handleRequest(request) {
  const requestId = getRequestId(request);
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...buildCorsHeaders(request),
        "X-Search-Request-Id": requestId,
      },
    });
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return createErrorResponse(
      request,
      requestId,
      new ApiError({
        status: 405,
        code: "METHOD_NOT_ALLOWED",
        category: "request",
        message: "Method Not Allowed",
      })
    );
  }

  if (url.pathname === "/") {
    return new Response(getSearchHtml(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...buildCorsHeaders(request),
        "X-Search-Request-Id": requestId,
      },
    });
  }

  if (url.pathname === "/auth/verify") {
    try {
      const params = await parseRequestParams(request, url);
      return await handleAuthVerify(request, params, requestId);
    } catch (error) {
      const normalized = normalizeError(error);
      console.error(
        "[handleAuthVerify] Error:",
        normalized.code,
        normalized.message
      );
      return createErrorResponse(request, requestId, normalized);
    }
  }

  if (url.pathname !== "/search") {
    return createErrorResponse(
      request,
      requestId,
      new ApiError({
        status: 404,
        code: "NOT_FOUND",
        category: "request",
        message: "Not Found",
      })
    );
  }

  try {
    const params = await parseRequestParams(request, url);
    return await handleSearch(request, params, requestId);
  } catch (error) {
    const normalized = normalizeError(error);
    console.error("[handleRequest] Error:", normalized.code, normalized.message);
    return createErrorResponse(request, requestId, normalized);
  }
}

export default {
  async fetch(request, env_param) {
    setEnv(env_param);
    return handleRequest(request);
  },
};
