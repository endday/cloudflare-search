# Cloudflare Search

English | [中文](./README.zh.md)

> An aggregated search API service based on Cloudflare Workers

> Supports **MCP (Model Context Protocol)**, giving AI assistants (OpenClaw, Claude Code, Codex, OpenCode) real-time web search capabilities

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://sink.proddig.com/cloudflare-search-github)

## Features

- 🔍 **Prioritized Search Gateway** - Use Bing first, then Startpage, Mojeek, DuckDuckGo, and Brave as fallback engines
- 🤖 **AI Enhanced (MCP)** - Native support for Model Context Protocol, one-click search tool integration for **OpenClaw** / **Claude Code** / **Codex**
- ⚡ **Smart Fallback** - Stop after enough deduplicated results instead of always querying every engine
- 🛡️ **Fault Tolerance** - Timeout, parse, and upstream errors are classified; unhealthy engines are cooled down automatically
- 🧹 **Deduplication & Ranking** - Canonicalize URLs, remove duplicate results, and rank by engine priority + query relevance
- 💾 **KV Cache** - Fresh-cache + stale-if-error support with configurable TTL
- 🚦 **Simple Rate Limiting** - Per-token/IP fixed-window rate limit, with optional KV-backed shared state
- ⏱️ **Timeout Control** - Configurable request timeout to avoid long waits
- 🪂 **Hedged Fallback** - Trigger the next fallback early when the primary engine is slow
- 🔒 **Token Authentication** - Supports token auth to protect the service from abuse
- 🌍 **CORS Support** - Full cross-origin resource sharing support
- 🎨 **Web Interface** - Provides a clean search UI for easy testing
- ⚡ **Zero-cost Operation** - Cloudflare Workers free tier supports 100,000 requests per day

## Page Preview

![screenshot](./screenshot.png)

## MCP Integration: Use in OpenClaw / Claude Code / AI Agents

With MCP (Model Context Protocol), AI assistants can directly call your search service and get real-time search results.

### Installation and Configuration

#### 1. Deploy the Service

First, follow the guide to [Deploy Cloudflare Search](#installation-methods)

#### 2. Add MCP Server Configuration

Edit your config file ([configuration guide](https://modelcontextprotocol.io/quickstart/user)):

- **OpenClaw**: `~/.openclaw/openclaw.json`
- **Claude Code**: `~/.claude/config.json` / `~/.claude.json`
- **Claude Desktop macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
	"mcpServers": {
		"cloudflare-search": {
			"command": "npx",
			"args": ["-y", "@yrobot/cf-search-mcp"],
			"env": {
				"CF_SEARCH_URL": "https://your-worker.workers.dev",
				"CF_SEARCH_TOKEN": "your-token-here"
			}
		}
	}
}
```

#### Observability Headers

- `X-Search-Request-Id`: request identifier for log correlation
- `X-Search-Cache`: `miss` / `hit` / `revalidated` / `stale-if-error`
- `X-Search-Fallback-Order`: engine priority order for this request
- `X-Search-Fallback-Path`: engines actually started for this request
- `X-Search-Duration-Ms`: total gateway duration
- `Server-Timing`: per-engine timing data

**Environment Variables**:

- `CF_SEARCH_URL`: Worker deployment URL (required)
- `CF_SEARCH_TOKEN`: Auth token (required if your Worker has `TOKEN` configured)

#### 3. Verify Installation

- **OpenClaw**: Run `openclaw gateway restart` + `openclaw mcp list` and check that `cloudflare-search` appears
- **Claude Code**:
	- Run `/mcp` in Claude Code, and you should see the `cloudflare-search` tool.
	- Or run `claude mcp list`; seeing `cloudflare-search: npx -y @yrobot/cf-search-mcp@latest - ✓ Connected` means setup is successful

## Installation Methods

### Method 1: One-click Deployment (Recommended)

Click the "Deploy to Cloudflare Workers" button above and follow the prompts.

### Method 2: Use Wrangler CLI

```bash
# 1. Install Wrangler
npm install -g wrangler

# 2. Login to Cloudflare
wrangler login

# 3. Clone the repository
git clone https://github.com/Yrobot/cloudflare-search.git
cd cloudflare-search

# 4. Deploy
wrangler deploy
```

### Method 3: Use Cloudflare Dashboard

1. Sign in to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Go to **Workers & Pages**
3. Click **Create Application** > **Create Worker**
4. Click **Upload** to upload your local code folder
	 - Select the cloned `cloudflare-search` folder
	 - Or manually copy `worker.js`, `envs.js`, `utils/`, and other files
5. Click **Save and Deploy**

### Get Access URL

After deployment, you will get a Worker URL:

```
https://your-worker-name.your-subdomain.workers.dev
```

**Note**: The default domain may not be directly accessible in some regions. It is recommended to bind your own custom domain.

## Usage

### Method 1: Web Interface

Open your Worker URL directly and enter search keywords in the web UI:

```
https://$YOUR-DOMAIN/
```

### Method 2: API Request (GET)

Search using query parameters:

```bash
# Basic search
curl "https://$YOUR-DOMAIN/search?q=cloudflare"

# Specify search engines
curl "https://$YOUR-DOMAIN/search?q=cloudflare&engines=bing,startpage"

# Use token authentication (if TOKEN env var is configured)
curl "https://$YOUR-DOMAIN/search?q=cloudflare&token=$YOUR-TOKEN"
```

### Method 3: API Request (POST)

Submit search by POST form:

```bash
curl -X POST "https://$YOUR-DOMAIN/search" \
	-d "q=cloudflare" \
	-d "engines=bing,startpage" \
	-d "token=$YOUR-TOKEN" # if TOKEN env var is configured
```

## API Reference

### `/search` Endpoint

Used to execute search queries and return aggregated results.

#### Request Parameters

| Parameter     | Type     | Required | Description                                                | Example          |
| ------------- | -------- | -------- | ---------------------------------------------------------- | ---------------- |
| `q` / `query` | `string` | yes      | Search keyword                                             | `cloudflare`     |
| `engines`     | `string` | no       | Specify search engines, separated by commas               | `bing,startpage` |
| `language`    | `string` | no       | Language/region hint passed to supported engines          | `en`, `zh-CN`    |
| `time_range`  | `string` | no       | Time filter: `day`, `week`, `month`, or `year`            | `month`          |
| `pageno`      | `number` | no       | Zero-based page number                                    | `0`              |
| `token`       | `string` | no/yes   | Access token (required when `TOKEN` env var is configured) | `$YOUR-TOKEN`    |

**Supported Search Engines**:

- `bing` - Bing Search
- `startpage` - Startpage Search
- `mojeek` - Mojeek Search
- `duckduckgo` - DuckDuckGo Search
- `brave` - Brave Search

#### Response Value

```typescript
{
	query: string;                    // Search keyword
	number_of_results: number;        // Total number of results
	enabled_engines: string[];        // Enabled search engine list
	unresponsive_engines: string[];   // Unresponsive search engine list
	results: Array<{
		title: string;                  // Result title
		description: string;            // Result description
		url: string;                    // Result link
		engine: string;                 // Source engine
	}>;
}
```

#### Request Examples

```bash
# GET request
curl "https://$YOUR-DOMAIN/search?q=cloudflare&engines=bing,startpage"

# JSON POST request
curl -X POST "https://$YOUR-DOMAIN/search" \
	-H "Content-Type: application/json" \
	-d '{"q":"cloudflare","engines":["bing","startpage"],"language":"en","time_range":"month"}'

# Form POST request
curl -X POST "https://$YOUR-DOMAIN/search" \
	-H "Content-Type: application/x-www-form-urlencoded" \
	-d "q=cloudflare&engines=bing,startpage"
```

#### Response Example

```json
{
	"query": "cloudflare",
	"number_of_results": 15,
	"enabled_engines": ["bing", "startpage", "mojeek", "duckduckgo", "brave"],
	"unresponsive_engines": [],
	"results": [
		{
			"title": "Cloudflare - The Web Performance & Security Company",
			"description": "Cloudflare is on a mission to help build a better Internet...",
			"url": "https://www.cloudflare.com/",
			"engine": "bing"
		},
		{
			"title": "Cloudflare Workers",
			"description": "Deploy serverless code instantly across the globe...",
			"url": "https://workers.cloudflare.com/",
			"engine": "startpage"
		}
	]
}
```

## Search Engine Notes

### Supported Search Engines

| Engine         | Description                  | Configuration Required          | Default Role |
| -------------- | ---------------------------- | ------------------------------- | ------------ |
| **Bing**       | HTML search parser           | -                               | Primary      |
| **Startpage**  | Serialized SERP payload      | -                               | Fallback 1   |
| **Mojeek**     | Simple HTML parser           | -                               | Fallback 2   |
| **DuckDuckGo** | HTML search endpoint         | -                               | Fallback 3   |
| **Brave**      | HTML result parser, no `eval` | -                              | Fallback 4   |

### Basic Working Approach

1. **Prioritized Fallback**: Try engines in order (`bing,startpage,mojeek,duckduckgo,brave` by default)
2. **Early Stop**: Stop when deduplicated results reach `FALLBACK_MIN_RESULTS` and at least `FALLBACK_MIN_CONTRIBUTING_ENGINES` engines have contributed
3. **Normalization**: Normalize titles/descriptions, canonicalize URLs, and remove duplicates
4. **Health Control**: Repeated failures temporarily move an engine behind healthier fallbacks; bind `SEARCH_STATE_KV` to share state across isolates
5. **Cache**: If `SEARCH_KV` is bound, final `/search` responses are cached by query + parameters, with stale-if-error fallback
6. **Hedged Fallback**: When the primary path exceeds `HEDGED_FALLBACK_DELAY_MS`, the next fallback starts early

## Environment Variable Configuration

### Environment Variables

| Variable Name | Type | Default | Description |
| ------------- | ---- | ------- | ----------- |
| `DEFAULT_ENGINES` | `string`/`array` | `bing,startpage,mojeek,duckduckgo,brave` | Priority/fallback order |
| `DEFAULT_TIMEOUT` | `string` | `"4000"` | Timeout per engine request, in milliseconds |
| `HEDGED_FALLBACK_DELAY_MS` | `string` | `"400"` | Start the next fallback early when the current engine is slow |
| `FALLBACK_MIN_RESULTS` | `string` | `"6"` | Stop fallback after this many deduplicated results |
| `FALLBACK_MIN_CONTRIBUTING_ENGINES` | `string` | `"2"` | Minimum result-contributing engines before early stop |
| `CACHE_TTL_SECONDS` | `string` | `"300"` | KV cache TTL; set `0` to disable cache |
| `STALE_CACHE_TTL_SECONDS` | `string` | `"1800"` | Keep expired cache available for stale-if-error responses |
| `RATE_LIMIT_WINDOW_SECONDS` | `string` | `"60"` | Rate-limit window size |
| `RATE_LIMIT_MAX_REQUESTS` | `string` | `"60"` | Requests allowed per token/IP per window; set `0` to disable |
| `HEALTH_FAILURE_THRESHOLD` | `string` | `"2"` | Failures before temporary engine cooldown |
| `HEALTH_COOLDOWN_SECONDS` | `string` | `"180"` | Engine cooldown duration |
| `HEALTH_STATE_TTL_SECONDS` | `string` | `"3600"` | Retention time for engine health state in KV |
| `TOKEN` | `string` | `null` | Access token. Enables auth when configured to prevent abuse |

**Notes**:

- After `TOKEN` is configured, all requests must provide a valid token
- Bind `SEARCH_STATE_KV` to share rate-limit counters and engine health across isolates; KV writes are eventually consistent, not strict atomic counters
- Bind a KV namespace named `SEARCH_KV` to enable response caching; stale cache can still be returned if live upstream search fails

### Configuration Methods

#### Method 1: `wrangler.toml` File

Edit the `[vars]` section in `wrangler.toml`:

```toml
[vars]
DEFAULT_ENGINES = "bing,startpage,mojeek,duckduckgo,brave"
DEFAULT_TIMEOUT = "4000"
HEDGED_FALLBACK_DELAY_MS = "400"
FALLBACK_MIN_CONTRIBUTING_ENGINES = "2"
CACHE_TTL_SECONDS = "300"
STALE_CACHE_TTL_SECONDS = "1800"
RATE_LIMIT_MAX_REQUESTS = "60"
HEALTH_STATE_TTL_SECONDS = "3600"
TOKEN = "your-secret-token-here"

[[kv_namespaces]]
binding = "SEARCH_KV"
id = "your-kv-namespace-id"

[[kv_namespaces]]
binding = "SEARCH_STATE_KV"
id = "your-state-kv-namespace-id"
```

#### Method 2: Cloudflare Dashboard

1. Go to the Worker settings page
2. Find the **Environment Variables** section
3. Add variables and save

## Use Cases

### 1. Aggregated Search Service

Build your own aggregated search API and combine results from multiple search engines:

```javascript
const response = await fetch(
	"https://$YOUR-DOMAIN/search?q=javascript&engines=bing,startpage",
);
const data = await response.json();
console.log(`Found ${data.number_of_results} results`);
```

### 2. Frontend Search Feature

Add search functionality to your website or app:

```javascript
async function search(query) {
	const response = await fetch(
		`https://$YOUR-DOMAIN/search?q=${encodeURIComponent(query)}`,
	);
	const data = await response.json();
	return data.results;
}
```

### 3. Data Collection and Analysis

Collect results from multiple search engines for comparative analysis:

```javascript
const engines = ["bing", "startpage", "duckduckgo"];
const results = await fetch(
	`https://$YOUR-DOMAIN/search?q=AI&engines=${engines.join(",")}`,
);
const data = await results.json();

// Group by engine
const byEngine = data.results.reduce((acc, result) => {
	acc[result.engine] = acc[result.engine] || [];
	acc[result.engine].push(result);
	return acc;
}, {});
```

## MCP Integration

With MCP (Model Context Protocol), AI assistants can directly call your search service and get real-time search results.

## Notes and Reminders

### 🚨 Important Notes

1. **Use a Custom Domain**
	 - The default Cloudflare `*.workers.dev` domain may be inaccessible in some regions
	 - It is **strongly recommended** to bind your own domain for a better access experience
	 - In Worker settings, click **Triggers** > **Add Custom Domain** to add a custom domain

2. **Search Engine Limits**
	 - HTML-based engines may change their markup over time, so parser fixture tests matter
	 - Search engines may temporarily rate-limit frequent requests
	 - Frequent requests may cause temporary rate limiting

3. **Timeout Settings**
	 - Default timeout per engine is 4 seconds
	 - Can be adjusted with `DEFAULT_TIMEOUT`
	 - Do not set it too high to avoid long overall response times

4. **KV Cache**
	 - Bind `SEARCH_KV` if you want cross-request response caching
	 - Cache keys include query, engine list, language, time range, and page number

### 🔒 Security Configuration

#### Enable Authentication

1. Configure the `TOKEN` environment variable to protect your service from abuse:

- Configure `TOKEN` in `wrangler.toml`
- Configure `TOKEN` in Cloudflare Worker Dashboard

2. Pass token in requests:

```bash
# Access homepage
https://$YOUR-DOMAIN?token=$YOUR-TOKEN

# Request API with token parameter in query/body
curl "https://$YOUR-DOMAIN/search?q=cloudflare&token=$YOUR-TOKEN"

curl -X POST "https://$YOUR-DOMAIN/search" \
	-d "q=cloudflare" \
	-d "token=$YOUR-TOKEN"
```

## FAQ

### Q: Why do some search engines return empty results?

A: Possible reasons:

- Search engine API is temporarily unavailable or timed out
- No relevant results for the search keyword
- Search engine has rate-limited access

You can check the `unresponsive_engines` field in the response to see which engines did not respond.

### Q: How can I improve search speed?

A: Recommendations:

- Keep the default fallback chain and let the gateway stop early
- Bind `SEARCH_KV` and tune `CACHE_TTL_SECONDS`
- Use `STALE_CACHE_TTL_SECONDS` to improve availability when upstream engines fail
- Bind `SEARCH_STATE_KV` so rate limiting and engine health are shared across isolates
- Adjust `DEFAULT_TIMEOUT`, `HEDGED_FALLBACK_DELAY_MS`, `FALLBACK_MIN_RESULTS`, and `FALLBACK_MIN_CONTRIBUTING_ENGINES` appropriately

### Q: How does fallback work?

A: The gateway tries engines in order. By default:

1. `bing`
2. `startpage`
3. `mojeek`
4. `duckduckgo`
5. `brave`

It stops once deduplicated results reach `FALLBACK_MIN_RESULTS` and at least `FALLBACK_MIN_CONTRIBUTING_ENGINES` engines have contributed results.

If the primary engine is still slow after `HEDGED_FALLBACK_DELAY_MS`, the gateway starts the next fallback early to reduce tail latency.

### Q: How can I protect the service from abuse?

A: It is recommended to configure the `TOKEN` environment variable to enable authentication:

1. Set `TOKEN = "your-random-token"` in `wrangler.toml`
2. Or add it in Environment Variables in Cloudflare Dashboard
3. After configuration, all requests must provide a valid token

Authentication failure returns a 401 error.

### Q: Does rate limiting work globally?

A: If `SEARCH_STATE_KV` is bound, counters are shared across isolates and are suitable for basic abuse protection. Cloudflare KV writes are eventually consistent, so this is not a strict atomic global limiter; use Durable Objects later if you need hard global consistency.

## Disclaimer

This project is for learning and research purposes only. Users must comply with the following:

1. **Lawful Use** - Only use for legal search purposes. Do not use for illegal or infringing activities
2. **Terms of Service** - Comply with the terms of Cloudflare Workers and each search engine
3. **API Limits** - Follow usage limits and quotas of each search engine API
4. **Use at Your Own Risk** - Any consequences from using this service are the user's responsibility
5. **Commercial Use** - For commercial use, ensure compliance with relevant laws, regulations, and service terms

## Contributing

Issues and Pull Requests are welcome!

## License

[GPL-3 License](LICENSE)

## Related Links

- [Project GitHub](https://github.com/Yrobot/cloudflare-search)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)

## Support the Project

If this project helps you, you can buy the author a coffee ☕

<image src="https://yrobot.top/donate_wx.jpeg" width="300"/>
