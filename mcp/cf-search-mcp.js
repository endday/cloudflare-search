#!/usr/bin/env node

/**
 * Cloudflare Search MCP Server
 *
 * This MCP server provides access to the Cloudflare Search API,
 * allowing AI assistants to search across multiple search engines.
 *
 * Environment Variables:
 * - CF_SEARCH_URL: The URL of your Cloudflare Search Worker (required)
 * - CF_SEARCH_TOKEN: Authentication token for the search API (optional)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Get configuration from environment variables
const CF_SEARCH_URL = process.env.CF_SEARCH_URL;
const CF_SEARCH_TOKEN = process.env.CF_SEARCH_TOKEN;

if (!CF_SEARCH_URL) {
  console.error("Error: CF_SEARCH_URL environment variable is required");
  console.error(
    "Example: export CF_SEARCH_URL=https://your-worker.workers.dev",
  );
  process.exit(1);
}

function getSearchEndpoint() {
  const baseUrl = CF_SEARCH_URL.endsWith("/")
    ? CF_SEARCH_URL
    : `${CF_SEARCH_URL}/`;

  return new URL("search", baseUrl);
}

/**
 * Call the Cloudflare Search API
 */
async function searchAPI(query, engines = null, options = {}) {
  try {
    const params = new URLSearchParams({ q: query });

    if (engines && engines.length > 0) {
      params.append("engines", engines.join(","));
    }

    if (options.language) {
      params.append("language", options.language);
    }

    if (options.location) {
      params.append("location", options.location);
    }

    if (options.time_range) {
      params.append("time_range", options.time_range);
    }

    if (Number.isInteger(options.pageno)) {
      params.append("pageno", String(options.pageno));
    }

    const headers = {};
    if (CF_SEARCH_TOKEN) {
      headers.Authorization = `Bearer ${CF_SEARCH_TOKEN}`;
    }

    const url = getSearchEndpoint();
    url.search = params.toString();
    const response = await fetch(url, {
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    throw new Error(`Failed to search: ${error.message}`);
  }
}

/**
 * Create and configure the MCP server
 */
const server = new Server(
  {
    name: "cloudflare-search",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The search query string",
    },
    engines: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "bing",
          "startpage",
          "mojeek",
          "duckduckgo",
          "brave",
          "qwant",
          "yahoo",
        ],
      },
      description:
        "Optional: Array of search engines to use. If not specified, uses default engines. " +
        "Available engines: bing, startpage, mojeek, duckduckgo, brave, qwant, yahoo",
    },
    language: {
      type: "string",
      description: "Optional language/region hint, for example en or zh-CN",
    },
    location: {
      type: "string",
      description:
        "Optional location hint. Defaults to auto on the Worker. Use off to disable location enrichment.",
    },
    time_range: {
      type: "string",
      enum: ["day", "week", "month", "year"],
      description: "Optional time range filter",
    },
    pageno: {
      type: "integer",
      minimum: 0,
      description: "Optional zero-based page number",
    },
  },
  required: ["query"],
};

/**
 * Handler for listing available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "web_search",
        description:
          "Search the web for current information, news, or any topic. " +
          "Uses the configured fallback order across Startpage, DuckDuckGo, Brave, Mojeek, Bing, Qwant, and Yahoo " +
          "when results are insufficient. Returns deduplicated source URLs. " +
          "Use this when you need real-time information not in your training data. ",
        inputSchema: SEARCH_INPUT_SCHEMA,
      },
      {
        name: "search",
        description:
          "Search through the Cloudflare Workers search gateway and return deduplicated results. " +
          "The gateway uses prioritized fallback with source attribution for each result.",
        inputSchema: SEARCH_INPUT_SCHEMA,
      },
    ],
  };
});

/**
 * Handler for tool execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (
    request.params.name !== "search" &&
    request.params.name !== "web_search"
  ) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  if (!request.params.arguments) {
    throw new Error("Missing arguments");
  }

  const { query, engines, language, location, time_range, pageno } =
    request.params.arguments;

  if (!query || typeof query !== "string") {
    throw new Error("Query must be a non-empty string");
  }

  try {
    const result = await searchAPI(query, engines, {
      language,
      location,
      time_range,
      pageno,
    });

    // Format the results for better readability
    const formattedResults = result.results
      .map((item, index) => {
        return `${index + 1}. [${item.engine.toUpperCase()}] ${item.title}\n   ${item.description}\n   ${item.url}`;
      })
      .join("\n\n");

    const summary = [
      `Search Query: "${result.query}"`,
      result.effective_query && result.effective_query !== result.query
        ? `Effective Query: "${result.effective_query}"`
        : null,
      result.location
        ? `Location: ${result.location} (${result.location_source})`
        : null,
      `Total Results: ${result.number_of_results}`,
      `Engines Used: ${result.enabled_engines.join(", ")}`,
      result.unresponsive_engines.length > 0
        ? `Unresponsive Engines: ${result.unresponsive_engines.join(", ")}`
        : null,
      "",
      "Results:",
      formattedResults,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: summary,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Search failed: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Cloudflare Search MCP Server running on stdio");
  console.error(`Connected to: ${CF_SEARCH_URL}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
