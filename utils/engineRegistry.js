import { env } from "../envs.js";
import { bingAdapter } from "./searchBing.js";
import { braveAdapter } from "./searchBrave.js";
import { duckDuckGoAdapter } from "./searchDuckDuckGo.js";
import { mojeekAdapter } from "./searchMojeek.js";
import { startpageAdapter } from "./searchStartpage.js";

const ENGINE_REGISTRY = {
  bing: bingAdapter,
  startpage: startpageAdapter,
  mojeek: mojeekAdapter,
  duckduckgo: duckDuckGoAdapter,
  brave: braveAdapter,
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

export function resolveEngineOrder(engines) {
  const requestedEngines = normalizeEngineList(engines);
  const baseOrder = requestedEngines.length > 0 ? requestedEngines : env.DEFAULT_ENGINES;
  const supportedEngines = new Set(env.SUPPORTED_ENGINES);
  const seen = new Set();

  return baseOrder
    .map((engine) => String(engine).trim().toLowerCase())
    .filter((engine) => {
      if (!engine || seen.has(engine)) {
        return false;
      }

      const adapter = ENGINE_REGISTRY[engine];
      if (!adapter || !supportedEngines.has(engine)) {
        return false;
      }

      if (adapter.isAvailable && !adapter.isAvailable()) {
        return false;
      }

      seen.add(engine);
      return true;
    });
}
