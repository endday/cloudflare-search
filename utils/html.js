import { parse } from "node-html-parser";

export function parseHtml(html) {
  return parse(html, {
    comment: false,
    lowerCaseTagName: false,
    blockTextElements: {
      script: true,
      noscript: false,
      style: false,
      pre: true,
    },
  });
}

export function cleanText(input) {
  if (!input) {
    return "";
  }

  const parsed = parse(`<span>${String(input)}</span>`);
  return parsed.text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractBalancedSegment(source, startIndex) {
  const opening = source[startIndex];
  const closing = opening === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  throw new Error("Unable to extract balanced JSON segment");
}
