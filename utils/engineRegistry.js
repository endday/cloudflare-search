import { env } from "../envs.js";
import { bingAdapter } from "./searchBing.js";
import { braveAdapter } from "./searchBrave.js";
import { duckDuckGoAdapter } from "./searchDuckDuckGo.js";
import { mojeekAdapter } from "./searchMojeek.js";
import { qwantAdapter } from "./searchQwant.js";
import { startpageAdapter } from "./searchStartpage.js";
import { yahooAdapter } from "./searchYahoo.js";

const ENGINE_REGISTRY = {
  bing: bingAdapter,
  startpage: startpageAdapter,
  mojeek: mojeekAdapter,
  duckduckgo: duckDuckGoAdapter,
  brave: braveAdapter,
  qwant: qwantAdapter,
  yahoo: yahooAdapter,
};

export function getEngineRegistry() {
  return ENGINE_REGISTRY;
}

function normalizeEngineList(engines) {
  if (!engines) {
    return [];
  }

  if (Array.isArray(engines)) {
    return engines;
  }

  return String(engines).split(",");
}

export function normalizeRequestedEngines(engines) {
  return normalizeEngineList(engines)
    .map((engine) => String(engine).trim().toLowerCase())
    .filter(Boolean);
}

export function resolveEngineSelection(engines) {
  const requestedEngines = normalizeRequestedEngines(engines);
  const baseOrder =
    requestedEngines.length > 0
      ? requestedEngines
      : normalizeRequestedEngines(env.DEFAULT_ENGINES);
  const supportedEngines = new Set(env.SUPPORTED_ENGINES);
  const seen = new Set();
  const enabledEngines = [];
  const skippedEngines = [];

  for (const engine of baseOrder) {
    if (seen.has(engine)) {
      continue;
    }

    seen.add(engine);

    const adapter = ENGINE_REGISTRY[engine];
    if (!adapter || !supportedEngines.has(engine)) {
      skippedEngines.push({
        engine,
        reason: "unsupported_engine",
      });
      continue;
    }

    if (adapter.isAvailable && !adapter.isAvailable()) {
      skippedEngines.push({
        engine,
        reason: "unavailable_engine",
      });
      continue;
    }

    enabledEngines.push(engine);
  }

  return {
    requestedEngines: baseOrder,
    enabledEngines,
    skippedEngines,
  };
}

export function resolveEngineOrder(engines) {
  return resolveEngineSelection(engines).enabledEngines;
}
