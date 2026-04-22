type ResultItem = {
  title: string;
  description: string;
  url: string;
};

type TimeRange = "day" | "week" | "month" | "year";

export type subSearch = (params: {
  query: string;
  language?: string;
  time_range?: TimeRange;
  pageno?: number;
  signal?: AbortSignal;
}) => Promise<Array<ResultItem>>;

export type searchAll = (params: {
  query: string;
  engines?: string[];
  language?: string;
  time_range?: TimeRange;
  pageno?: number;
}) => Promise<{
  query: string;
  number_of_results: number;
  enabled_engines: string[];
  unresponsive_engines: string[];
  results: Array<ResultItem & { engine: string }>;
}>;

export type searchAllWithMeta = (params: {
  query: string;
  engines?: string[];
  language?: string;
  time_range?: TimeRange;
  pageno?: number;
}) => Promise<{
  response: Awaited<ReturnType<searchAll>>;
  meta: {
    cache_status: "hit" | "miss" | "revalidated" | "stale-if-error";
    fallback_order: string[];
    fallback_path: string[];
    engine_timings: Array<{
      engine: string;
      duration_ms: number;
      status: string;
      result_count: number;
    }>;
  };
}>;

export interface Env {
  DEFAULT_TIMEOUT?: string;
  HEDGED_FALLBACK_DELAY_MS?: string;
  SUPPORTED_ENGINES?: string[];
  DEFAULT_ENGINES?: string[];
  DEFAULT_LANGUAGE?: string;
  FALLBACK_MIN_RESULTS?: string;
  FALLBACK_MIN_CONTRIBUTING_ENGINES?: string;
  CACHE_TTL_SECONDS?: string;
  STALE_CACHE_TTL_SECONDS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  RATE_LIMIT_MAX_REQUESTS?: string;
  HEALTH_FAILURE_THRESHOLD?: string;
  HEALTH_COOLDOWN_SECONDS?: string;
  HEALTH_STATE_TTL_SECONDS?: string;
  TOKEN?: string;
  SEARCH_KV?: unknown;
  SEARCH_STATE_KV?: unknown;
}
