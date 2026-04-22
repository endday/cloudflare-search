import { env, setEnv } from "./envs.js";
import { ApiError, normalizeError, toErrorPayload } from "./utils/errors.js";
import { getSearchHtml } from "./utils/getHTML.js";
import { enforceRateLimit } from "./utils/rateLimit.js";
import { searchAllWithMeta } from "./utils/searchGateway.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
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

  const { response, meta } = await searchAllWithMeta({
    query,
    engines: normalizeEngineParam(params.engines),
    language: params.language || params.lang || env.DEFAULT_LANGUAGE,
    time_range: normalizeTimeRange(params.time_range || params.timeRange),
    pageno: normalizePageNumber(params.pageno || params.page),
  });

  return jsonResponse(
    response,
    200,
    buildSearchResponseHeaders({
      requestId,
      durationMs: Date.now() - startedAt,
      meta,
    })
  );
}

async function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  if (url.pathname === "/") {
    return new Response(getSearchHtml(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...CORS_HEADERS,
      },
    });
  }

  if (url.pathname !== "/search") {
    return new Response("Not Found", {
      status: 404,
      headers: CORS_HEADERS,
    });
  }

  const requestId = getRequestId(request);

  try {
    const params = await parseRequestParams(request, url);
    return await handleSearch(request, params, requestId);
  } catch (error) {
    const normalized = normalizeError(error);
    const status = normalized.status || 500;
    const headers = normalized.details?.retry_after
      ? {
          "Retry-After": String(normalized.details.retry_after),
          "X-Search-Request-Id": requestId,
        }
      : {
          "X-Search-Request-Id": requestId,
        };
    console.error("[handleRequest] Error:", normalized.code, normalized.message);
    return jsonResponse(toErrorPayload(normalized), status, headers);
  }
}

export default {
  async fetch(request, env_param) {
    setEnv(env_param);
    return handleRequest(request);
  },
};
