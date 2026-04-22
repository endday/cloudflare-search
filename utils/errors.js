export class ApiError extends Error {
  constructor({
    status = 500,
    code = "INTERNAL_ERROR",
    message = "Unexpected error",
    category = "internal",
    details,
  } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.category = category;
    this.details = details;
  }
}

export function normalizeError(error, { engine } = {}) {
  if (error instanceof ApiError) {
    return error;
  }

  if (error?.name === "AbortError") {
    return new ApiError({
      status: 504,
      code: "UPSTREAM_TIMEOUT",
      category: "upstream",
      message: engine
        ? `${engine} request timed out`
        : "Upstream request timed out",
      details: engine ? { engine } : undefined,
    });
  }

  return new ApiError({
    status: 502,
    code: "UPSTREAM_ERROR",
    category: "upstream",
    message: error?.message || "Upstream request failed",
    details: engine ? { engine } : undefined,
  });
}

export function toErrorPayload(error) {
  const normalized = normalizeError(error);
  return {
    error: normalized.category,
    code: normalized.code,
    message: normalized.message,
    ...(normalized.details ? { details: normalized.details } : {}),
  };
}
