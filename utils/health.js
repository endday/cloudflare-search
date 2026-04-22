import { env } from "../envs.js";
import { getStateKv, normalizeExpirationTtl } from "./stateKv.js";

const HEALTH_PREFIX = "health:v2";
const memoryHealthState = new Map();

export function resetHealthState() {
  memoryHealthState.clear();
}

function createDefaultEngineState() {
  return {
    consecutiveFailures: 0,
    disabledUntil: 0,
    lastFailureAt: 0,
    lastSuccessAt: 0,
  };
}

function getHealthKey(engineName) {
  return `${HEALTH_PREFIX}:${engineName}`;
}

function getMemoryEngineState(engineName) {
  if (!memoryHealthState.has(engineName)) {
    memoryHealthState.set(engineName, createDefaultEngineState());
  }

  return memoryHealthState.get(engineName);
}

async function getKvEngineState(kv, engineName) {
  try {
    return (await kv.get(getHealthKey(engineName), "json")) || null;
  } catch (error) {
    console.warn(`[health] KV read failed for ${engineName}`, error);
    return null;
  }
}

async function persistEngineState(engineName, state) {
  const memoryState = getMemoryEngineState(engineName);
  Object.assign(memoryState, state);

  const kv = getStateKv();
  if (!kv) {
    return;
  }

  try {
    await kv.put(getHealthKey(engineName), JSON.stringify(state), {
      expirationTtl: normalizeExpirationTtl(env.HEALTH_STATE_TTL_SECONDS, 3600),
    });
  } catch (error) {
    console.warn(`[health] KV write failed for ${engineName}`, error);
  }
}

async function getEngineState(engineName) {
  const kv = getStateKv();
  const kvState = kv ? await getKvEngineState(kv, engineName) : null;

  if (kvState) {
    return {
      ...createDefaultEngineState(),
      ...kvState,
    };
  }

  return getMemoryEngineState(engineName);
}

export async function prioritizeHealthyEngines(engineNames) {
  const now = Date.now();
  const healthy = [];
  const degraded = [];
  const engineStates = await Promise.all(
    engineNames.map(async (engineName) => ({
      engineName,
      state: await getEngineState(engineName),
    }))
  );

  for (const { engineName, state } of engineStates) {
    if (state.disabledUntil > now) {
      degraded.push(engineName);
    } else {
      healthy.push(engineName);
    }
  }

  return healthy.length > 0 ? [...healthy, ...degraded] : [...engineNames];
}

export async function recordEngineSuccess(engineName) {
  const state = await getEngineState(engineName);
  state.consecutiveFailures = 0;
  state.disabledUntil = 0;
  state.lastSuccessAt = Date.now();
  await persistEngineState(engineName, state);
}

export async function recordEngineFailure(engineName) {
  const state = await getEngineState(engineName);
  const failureThreshold = Number.parseInt(
    env.HEALTH_FAILURE_THRESHOLD || "2",
    10
  );
  const cooldownMs =
    Number.parseInt(env.HEALTH_COOLDOWN_SECONDS || "180", 10) * 1000;

  state.consecutiveFailures += 1;
  state.lastFailureAt = Date.now();

  if (state.consecutiveFailures >= failureThreshold) {
    state.disabledUntil = Date.now() + cooldownMs;
  }

  await persistEngineState(engineName, state);
}
