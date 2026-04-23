import { env } from "../envs.js";
import { getCachedSearchResponse, setCachedSearchResponse } from "./cache.js";
import { ApiError, normalizeError } from "./errors.js";
import { getEngineRegistry, resolveEngineSelection } from "./engineRegistry.js";
import {
  prioritizeHealthyEngines,
  recordEngineFailure,
  recordEngineSuccess,
} from "./health.js";
import { dedupeAndRankResults } from "./index.js";

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function filterEnginesByCapabilities(
  engineNames,
  registry,
  { time_range, pageno }
) {
  const page = parseNonNegativeInt(pageno, 0);
  const enabledEngines = [];
  const skippedEngines = [];

  for (const engineName of engineNames) {
    const supports = registry[engineName]?.supports || {};

    if (time_range && supports.time_range === false) {
      skippedEngines.push({
        engine: engineName,
        reason: "unsupported_time_range",
      });
      continue;
    }

    if (page > 0 && supports.pageno === false) {
      skippedEngines.push({
        engine: engineName,
        reason: "unsupported_pageno",
      });
      continue;
    }

    enabledEngines.push(engineName);
  }

  return {
    enabledEngines,
    skippedEngines,
  };
}

function startEngineSearch(adapter, params) {
  const timeoutMs = Number.parseInt(env.DEFAULT_TIMEOUT || "4000", 10);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const promise = adapter
    .search({
      ...params,
      signal: controller.signal,
    })
    .then((results) => ({
      engine: adapter.name,
      results,
      duration_ms: Date.now() - startedAt,
    }))
    .catch((error) => ({
      engine: adapter.name,
      error: normalizeError(error, { engine: adapter.name }),
      duration_ms: Date.now() - startedAt,
    }))
    .finally(() => clearTimeout(timeoutId));

  return {
    engine: adapter.name,
    promise,
    abort: () => controller.abort(),
  };
}

function buildSearchResponse({
  query,
  enabledEngines,
  skippedEngines,
  unresponsiveEngines,
  results,
}) {
  return {
    query,
    number_of_results: results.length,
    enabled_engines: enabledEngines,
    skipped_engines: skippedEngines,
    unresponsive_engines: [...new Set(unresponsiveEngines)],
    results,
  };
}

function buildSearchMeta({
  cacheStatus,
  fallbackOrder,
  fallbackPath,
  engineTimings,
}) {
  return {
    cache_status: cacheStatus,
    fallback_order: fallbackOrder,
    fallback_path: fallbackPath,
    engine_timings: engineTimings,
  };
}

function abortActiveSearches(activeSearches) {
  for (const task of activeSearches.values()) {
    task.abort();
  }
}

async function waitForEngineOrHedge({
  activeSearches,
  canHedge,
  hedgeDelayMs,
}) {
  const completionPromises = [...activeSearches.values()].map((task) =>
    task.promise.then((outcome) => ({
      type: "complete",
      outcome,
    }))
  );

  if (!canHedge || hedgeDelayMs <= 0) {
    return Promise.race(completionPromises);
  }

  let timerId;
  const hedgePromise = new Promise((resolve) => {
    timerId = setTimeout(() => resolve({ type: "hedge" }), hedgeDelayMs);
  });
  const result = await Promise.race([...completionPromises, hedgePromise]);

  if (result.type === "complete") {
    clearTimeout(timerId);
  }

  return result;
}

async function runFallbackSearch({
  registry,
  fallbackOrder,
  primaryEngine,
  query,
  language,
  time_range,
  pageno,
}) {
  const minResults = Math.max(
    1,
    Number.parseInt(env.FALLBACK_MIN_RESULTS || "6", 10)
  );
  const hedgeDelayMs = parseNonNegativeInt(env.HEDGED_FALLBACK_DELAY_MS, 400);
  const minContributingEngines = Math.min(
    fallbackOrder.length,
    parsePositiveInt(env.FALLBACK_MIN_CONTRIBUTING_ENGINES, 2)
  );
  const activeSearches = new Map();
  const engineResults = [];
  const unresponsiveEngines = [];
  const fallbackPath = [];
  const engineTimings = [];
  let aggregatedResults = [];
  let nextEngineIndex = 0;

  const startNextEngine = () => {
    const engineName = fallbackOrder[nextEngineIndex];
    nextEngineIndex += 1;
    fallbackPath.push(engineName);
    activeSearches.set(
      engineName,
      startEngineSearch(registry[engineName], {
        query,
        language,
        time_range,
        pageno,
      })
    );
  };

  const hasSecondaryContribution = () =>
    engineResults.some(({ engine }) => engine !== primaryEngine);
  const hasEnoughContributors = () =>
    engineResults.length >= minContributingEngines || hasSecondaryContribution();
  const hasEnoughResults = () =>
    aggregatedResults.length >= minResults && hasEnoughContributors();

  while (
    !hasEnoughResults() &&
    (activeSearches.size > 0 || nextEngineIndex < fallbackOrder.length)
  ) {
    if (activeSearches.size === 0) {
      startNextEngine();
    }

    const result = await waitForEngineOrHedge({
      activeSearches,
      canHedge: nextEngineIndex < fallbackOrder.length,
      hedgeDelayMs,
    });

    if (result.type === "hedge") {
      startNextEngine();
      continue;
    }

    const { outcome } = result;
    activeSearches.delete(outcome.engine);
    engineTimings.push({
      engine: outcome.engine,
      duration_ms: outcome.duration_ms,
      status: outcome.error ? outcome.error.code : "ok",
      result_count: outcome.results?.length || 0,
    });

    if (outcome.error) {
      console.warn(`[${outcome.engine}] ${outcome.error.code}: ${outcome.error.message}`);
      await recordEngineFailure(outcome.engine);
      unresponsiveEngines.push(outcome.engine);
      continue;
    }

    await recordEngineSuccess(outcome.engine);

    if (outcome.results.length > 0) {
      engineResults.push({
        engine: outcome.engine,
        results: outcome.results,
      });
    }

    aggregatedResults = dedupeAndRankResults({
      engineResults,
      query,
      registry,
    });
  }

  if (hasEnoughResults()) {
    abortActiveSearches(activeSearches);
  }

  return {
    results: aggregatedResults,
    unresponsiveEngines,
    meta: {
      fallbackPath,
      engineTimings,
    },
  };
}

export async function searchAllWithMeta({
  query,
  engines,
  language,
  time_range,
  pageno,
}) {
  const registry = getEngineRegistry();
  const engineSelection = resolveEngineSelection(engines);
  const capabilitySelection = filterEnginesByCapabilities(
    engineSelection.enabledEngines,
    registry,
    {
      time_range,
      pageno,
    }
  );
  const enabledEngines = capabilitySelection.enabledEngines;
  const skippedEngines = [
    ...engineSelection.skippedEngines,
    ...capabilitySelection.skippedEngines,
  ];

  if (enabledEngines.length === 0) {
    throw new ApiError({
      status: 400,
      code: "NO_ENGINES_AVAILABLE",
      category: "validation",
      message: "No requested search engines are available for these parameters",
    });
  }

  const cacheParams = {
    query,
    requested_engines: engineSelection.requestedEngines,
    engines: enabledEngines,
    language,
    time_range,
    pageno,
  };
  const cachedResponse = await getCachedSearchResponse(cacheParams);
  if (cachedResponse?.state === "hit") {
    return {
      response: cachedResponse.response,
      meta: buildSearchMeta({
        cacheStatus: "hit",
        fallbackOrder: enabledEngines,
        fallbackPath: [],
        engineTimings: [],
      }),
    };
  }

  const fallbackOrder = await prioritizeHealthyEngines(enabledEngines);
  const searchOutcome = await runFallbackSearch({
    registry,
    fallbackOrder,
    primaryEngine: enabledEngines[0],
    query,
    language,
    time_range,
    pageno,
  });

  if (
    searchOutcome.results.length === 0 &&
    searchOutcome.unresponsiveEngines.length > 0 &&
    cachedResponse?.state === "stale"
  ) {
    return {
      response: cachedResponse.response,
      meta: buildSearchMeta({
        cacheStatus: "stale-if-error",
        fallbackOrder,
        fallbackPath: searchOutcome.meta.fallbackPath,
        engineTimings: searchOutcome.meta.engineTimings,
      }),
    };
  }

  const response = buildSearchResponse({
    query,
    enabledEngines,
    skippedEngines,
    unresponsiveEngines: searchOutcome.unresponsiveEngines,
    results: searchOutcome.results,
  });

  await setCachedSearchResponse(cacheParams, response);
  return {
    response,
    meta: buildSearchMeta({
      cacheStatus: cachedResponse?.state === "stale" ? "revalidated" : "miss",
      fallbackOrder,
      fallbackPath: searchOutcome.meta.fallbackPath,
      engineTimings: searchOutcome.meta.engineTimings,
    }),
  };
}

export async function searchAll(params) {
  const { response } = await searchAllWithMeta(params);
  return response;
}
