import { ApiError } from "./errors.js";
import { fetchText, resolvePageNumber } from "./engineUtils.js";
import { cleanText, parseHtml } from "./html.js";
import { normalizeResults } from "./index.js";

export function parseMojeekResults(html) {
  const root = parseHtml(html);
  const resultNodes = root.querySelectorAll("ul.results-standard li");
  const results = [];

  for (const node of resultNodes) {
    const linkNode =
      node.querySelector("h2 a.title[href]") || node.querySelector("h2 a[href]");
    const descriptionNode = node.querySelector("p.s");

    if (!linkNode) {
      continue;
    }

    results.push({
      title: cleanText(linkNode.innerHTML || linkNode.text),
      url: linkNode.getAttribute("href"),
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
      message: "Mojeek parser could not find organic results",
    });
  }

  return normalizeResults(results);
}

async function searchMojeek(params) {
  const { query, language, pageno, signal } = params;
  const searchUrl = new URL("https://www.mojeek.com/search");
  searchUrl.searchParams.set("q", query);

  const page = resolvePageNumber(pageno);
  if (page > 0) {
    searchUrl.searchParams.set("s", String(page * 10 + 1));
  }

  const html = await fetchText(searchUrl.toString(), {
    signal,
    language,
    referrer: "https://www.mojeek.com/",
  });

  return parseMojeekResults(html);
}

export const mojeekAdapter = {
  name: "mojeek",
  label: "Mojeek",
  priority: 80,
  supports: {
    language: true,
    time_range: false,
    pageno: true,
  },
  isAvailable: () => true,
  search: searchMojeek,
};

export default searchMojeek;
