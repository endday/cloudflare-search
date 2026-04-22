import { ApiError } from "./errors.js";
import {
  fetchText,
  mapLanguage,
  resolvePageNumber,
} from "./engineUtils.js";
import { cleanText, extractBalancedSegment } from "./html.js";
import { normalizeResults } from "./index.js";

const STARTPAGE_LANGUAGE = {
  en: "english",
  zh: "chinese_simplified",
  "zh-cn": "chinese_simplified",
  "zh-tw": "chinese_traditional",
};

function extractStartpageResultArray(html) {
  const markerIndex = [
    '"display_type":"web-google"',
    '"display_type":"web-results"',
    '"display_type":"web"',
  ]
    .map((marker) => html.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (typeof markerIndex !== "number") {
    return null;
  }

  const resultsMarker = '"results":';
  const resultsIndex = html.indexOf(resultsMarker, markerIndex);
  if (resultsIndex === -1) {
    return null;
  }

  const arrayStart = html.indexOf("[", resultsIndex);
  if (arrayStart === -1) {
    return null;
  }

  return JSON.parse(extractBalancedSegment(html, arrayStart));
}

export function parseStartpageResults(html) {
  const items = extractStartpageResultArray(html);

  if (!Array.isArray(items)) {
    throw new ApiError({
      status: 502,
      code: "UPSTREAM_PARSE_ERROR",
      category: "upstream",
      message: "Startpage parser could not find result payload",
    });
  }

  return normalizeResults(
    items
      .filter((item) => item?.clickUrl && item?.title)
      .map((item) => ({
        title: cleanText(item.title),
        url: item.clickUrl,
        description: cleanText(item.description || ""),
      }))
  );
}

async function searchStartpage(params) {
  const { query, language, time_range, pageno, signal } = params;

  if (time_range) {
    throw new ApiError({
      status: 400,
      code: "UNSUPPORTED_PARAMETER",
      category: "validation",
      message: "Startpage time_range filtering is not supported",
    });
  }

  const searchUrl = new URL("https://www.startpage.com/sp/search");
  searchUrl.searchParams.set("query", query);
  searchUrl.searchParams.set("cat", "web");
  searchUrl.searchParams.set("segment", "startpage.udog");

  const page = resolvePageNumber(pageno);
  if (page > 0) {
    searchUrl.searchParams.set("page", String(page + 1));
  }

  const languageValue = mapLanguage(language, STARTPAGE_LANGUAGE, "");
  if (languageValue) {
    searchUrl.searchParams.set("language", languageValue);
    searchUrl.searchParams.set("lui", languageValue);
  }

  const html = await fetchText(searchUrl.toString(), {
    signal,
    language,
    referrer: "https://www.startpage.com/",
  });

  return parseStartpageResults(html);
}

export const startpageAdapter = {
  name: "startpage",
  label: "Startpage",
  priority: 100,
  supports: {
    language: true,
    time_range: false,
    pageno: true,
  },
  isAvailable: () => true,
  search: searchStartpage,
};

export default searchStartpage;
