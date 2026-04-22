import { ApiError } from "./errors.js";
import {
  ensureAbsoluteUrl,
  fetchText,
  mapTimeRange,
} from "./engineUtils.js";
import { cleanText, parseHtml } from "./html.js";
import { normalizeResults } from "./index.js";

const BRAVE_TIME_RANGE = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

export function parseBraveResults(html) {
  const root = parseHtml(html);
  const resultNodes = root
    .querySelectorAll(".snippet")
    .filter((node) => node.getAttribute("data-type") === "web");
  const results = [];

  for (const node of resultNodes) {
    const linkNode =
      node.querySelector("a.l1[href]") || node.querySelector("a[href]");
    const titleNode =
      node.querySelector(".title") || node.querySelector(".search-snippet-title");
    const descriptionNode =
      node.querySelector(".generic-snippet .content") ||
      node.querySelector(".content");

    if (!linkNode || !titleNode) {
      continue;
    }

    results.push({
      title: cleanText(titleNode.innerHTML || titleNode.text),
      url: ensureAbsoluteUrl(
        linkNode.getAttribute("href"),
        "https://search.brave.com"
      ),
      description: cleanText(
        descriptionNode?.innerHTML || descriptionNode?.text || ""
      ),
    });
  }

  if (results.length === 0) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "Brave parser could not find organic results",
    });
  }

  return normalizeResults(results);
}

async function searchBrave(params) {
  const { query, language, time_range, signal } = params;
  const searchUrl = new URL("https://search.brave.com/search");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("spellcheck", "0");
  searchUrl.searchParams.set("source", "web");
  searchUrl.searchParams.set("summary", "0");

  const timeFilter = mapTimeRange(time_range, BRAVE_TIME_RANGE);
  if (timeFilter) {
    searchUrl.searchParams.set("tf", timeFilter);
  }

  const html = await fetchText(searchUrl.toString(), {
    signal,
    language,
    referrer: "https://search.brave.com/search?source=web",
  });

  return parseBraveResults(html);
}

export const braveAdapter = {
  name: "brave",
  label: "Brave",
  priority: 90,
  supports: {
    language: true,
    time_range: true,
    pageno: false,
  },
  isAvailable: () => true,
  search: searchBrave,
};

export default searchBrave;
