import { ApiError } from "./errors.js";
import {
  fetchSearchText,
  isChallengeResponse,
  throwBlockedUpstreamError,
} from "./engineRequest.js";
import { resolvePageNumber } from "./engineUtils.js";
import { cleanText, parseHtml } from "./html.js";
import { normalizeResults } from "./index.js";

const MOJEEK_CHALLENGE_PATTERNS = [
  /name=["']captcha["']/i,
  /id=["'][^"']*captcha[^"']*["']/i,
];

function isMojeekChallengeResponse(source) {
  const text = String(source || "");

  return (
    isChallengeResponse(text, MOJEEK_CHALLENGE_PATTERNS) ||
    ((/verify you are human/i.test(text) || /unusual traffic/i.test(text)) &&
      /<form\b/i.test(text))
  );
}

function throwMojeekChallengeError() {
  throwBlockedUpstreamError({
    engine: "Mojeek",
    surface: "html",
  });
}

export function parseMojeekResults(html) {
  if (isMojeekChallengeResponse(html)) {
    throwMojeekChallengeError();
  }

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

  const html = await fetchSearchText(searchUrl.toString(), {
    engine: "mojeek",
    engineLabel: "Mojeek",
    signal,
    language,
    referrer: "https://www.mojeek.com/",
    blockedStatuses: [403, 429],
    isBlocked: isMojeekChallengeResponse,
    blockedSurface: "html",
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
