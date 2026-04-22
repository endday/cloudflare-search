export const normalizeResults = (results) =>
  results
    .map((result) => ({
      title: String(result.title || result.name || "").trim(),
      url: String(result.url || result.link || result.href || "").trim(),
      description: String(
        result.description || result.content || result.snippet || ""
      ).trim(),
    }))
    .filter((result) => result.url && result.title);

const TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "srsltid",
]);

function normalizeUrlPath(pathname) {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

export function canonicalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = normalizeUrlPath(url.pathname);

    [...url.searchParams.keys()].forEach((key) => {
      if (key.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(key)) {
        url.searchParams.delete(key);
      }
    });

    return url.toString();
  } catch (_) {
    return String(rawUrl || "").trim();
  }
}

function tokenizeQuery(query) {
  return String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function calculateResultScore({
  queryTokens,
  title,
  description,
  enginePriority,
  position,
}) {
  const normalizedTitle = title.toLowerCase();
  const normalizedDescription = description.toLowerCase();
  const titleMatches = queryTokens.filter((token) =>
    normalizedTitle.includes(token)
  ).length;
  const descriptionMatches = queryTokens.filter((token) =>
    normalizedDescription.includes(token)
  ).length;

  return (
    enginePriority +
    Math.max(0, 30 - position * 2) +
    titleMatches * 6 +
    descriptionMatches * 2
  );
}

export function dedupeAndRankResults({ engineResults, query, registry }) {
  const queryTokens = tokenizeQuery(query);
  const deduped = new Map();

  for (const { engine, results } of engineResults) {
    const enginePriority = registry[engine]?.priority || 0;

    normalizeResults(results).forEach((result, index) => {
      const canonicalUrl = canonicalizeUrl(result.url);
      const candidate = {
        ...result,
        url: canonicalUrl,
        engine,
        score: calculateResultScore({
          queryTokens,
          title: result.title,
          description: result.description,
          enginePriority,
          position: index,
        }),
      };

      const existing = deduped.get(canonicalUrl);
      if (!existing || candidate.score > existing.score) {
        deduped.set(canonicalUrl, candidate);
      } else if (!existing.description && candidate.description) {
        existing.description = candidate.description;
      }
    });
  }

  return [...deduped.values()]
    .sort((left, right) => right.score - left.score)
    .map(({ score, ...result }) => result);
}
