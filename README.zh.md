# Cloudflare Search

[English](./README.md) | 中文

> 基于 Cloudflare Workers 的聚合搜索 API 服务

> 支持 **MCP (Model Context Protocol)**，让 AI 助手（OpenClaw、Claude Code、Codex、OpenCode）拥有实时联网搜索能力

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://sink.proddig.com/cloudflare-search-github)

## 特性

- 🔍 **优先级搜索网关** - 默认先用 Bing，再按 Startpage、Mojeek、DuckDuckGo、Brave 顺序 fallback
- 🤖 **AI 增强 (MCP)** - 原生支持 Model Context Protocol，一键为 **OpenClaw** / **Claude Code** / **Codex** 添加搜索工具
- ⚡ **智能 fallback** - 达到足够的去重结果后提前停止，不再固定全并行
- 🛡️ **容错机制** - 分类处理超时、解析失败、上游异常，并对不健康引擎做冷却
- 🧹 **去重与排序** - URL 归一化、跨引擎去重、按引擎优先级和相关性排序
- 💾 **KV 缓存** - 支持新鲜缓存和 `stale-if-error` 兜底缓存
- 🚦 **简单限流** - 基于 token / IP 的固定窗口限流，可绑定 KV 跨 isolate 共享状态
- ⏱️ **超时控制** - 可配置请求超时时间，避免长时间等待
- 🪂 **Hedged Fallback** - 主引擎过慢时提前触发 fallback，降低尾延迟
- 🔒 **Token 鉴权** - 支持 Token 认证，保护服务不被滥用
- 🌍 **CORS 支持** - 完整的跨域资源共享支持
- 🎨 **Web 界面** - 提供简洁的搜索界面，方便测试
- ⚡ **零成本运行** - Cloudflare Workers 免费版每天 10 万次请求

## 页面展示

![screenshot](./screenshot.png)

## MCP 集成， 在 OpenClaw / Claude Code / AI Agent 中使用

通过 MCP (Model Context Protocol) 让 AI 助手直接调用你的搜索服务，获取实时搜索结果。

### 安装配置



#### 1. 部署服务

先按照文档 [部署 Cloudflare Search](#安装方式)

#### 2. 添加 MCP 服务器配置

编辑配置文件（[配置指南](https://modelcontextprotocol.io/quickstart/user)）：

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

#### 观测响应头

- `X-Search-Request-Id`：请求唯一 ID，方便日志排查
- `X-Search-Cache`：`miss` / `hit` / `revalidated` / `stale-if-error`
- `X-Search-Fallback-Order`：本次请求的引擎优先级
- `X-Search-Fallback-Path`：本次实际触发过的引擎路径
- `X-Search-Duration-Ms`：网关总耗时
- `Server-Timing`：各引擎耗时

**环境变量说明**：

- `CF_SEARCH_URL`: Worker 部署地址（必填）
- `CF_SEARCH_TOKEN`: 鉴权 Token（如果 Worker 配置了 TOKEN 则必填）

#### 3. 验证安装

- **OpenClaw**: `openclaw gateway restart` + `openclaw mcp list` 能看到 `cloudflare-search`
- **Claude Code**:
  - 在 Claude Code 中运行 `/mcp` 命令，应该能看到 `cloudflare-search` 工具。
  - 或 使用 `claude mcp list`, 看到 `cloudflare-search: npx -y @yrobot/cf-search-mcp@latest - ✓ Connected` 说明配置成功

## 安装方式

### 方式一：一键部署（推荐）

点击上方 "Deploy to Cloudflare Workers" 按钮，按照提示完成部署。

### 方式二：使用 Wrangler CLI

```bash
# 1. 安装 Wrangler
npm install -g wrangler

# 2. 登录 Cloudflare
wrangler login

# 3. 克隆仓库
git clone https://github.com/Yrobot/cloudflare-search.git
cd cloudflare-search

# 4. 部署
wrangler deploy
```

### 方式三：使用 Cloudflare Dashboard

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages**
3. 点击 **Create Application** > **Create Worker**
4. 点击 **Upload** 上传本地代码文件夹
   - 选择克隆的 `cloudflare-search` 文件夹
   - 或者手动复制 `worker.js`、`envs.js`、`utils/` 等文件
5. 点击 **Save and Deploy**

### 获取访问地址

部署成功后，你会获得一个 Worker URL：

```
https://your-worker-name.your-subdomain.workers.dev
```

**注意**：这个自带的域名在某些区域可能无法直接访问，建议绑定自己的域名使用。

## 使用方式

### 方式 1: Web 界面

直接访问你的 Worker URL，在网页界面输入搜索关键词：

```
https://$YOUR-DOMAIN/
```

### 方式 2: API 请求（GET）

使用查询参数进行搜索：

```bash
# 基本搜索
curl "https://$YOUR-DOMAIN/search?q=cloudflare"

# 指定搜索引擎
curl "https://$YOUR-DOMAIN/search?q=cloudflare&engines=bing,startpage"

# 使用 token 鉴权（如果配置了 TOKEN 环境变量）
curl "https://$YOUR-DOMAIN/search?q=cloudflare&token=$YOUR-TOKEN"
```

### 方式 3: API 请求（POST）

通过 POST 表单提交搜索：

```bash
curl -X POST "https://$YOUR-DOMAIN/search" \
  -d "q=cloudflare" \
  -d "engines=bing,startpage" \
  -d "token=$YOUR-TOKEN" # 如果配置了 TOKEN 环境变量
```

## API 接口说明

### `/search` 接口

用于执行搜索查询并返回聚合结果。

#### 请求参数

| 参数          | 类型     | 必填   | 说明                                      | 示例           |
| ------------- | -------- | ------ | ----------------------------------------- | -------------- |
| `q` / `query` | `string` | yes    | 搜索关键词                                | `cloudflare`   |
| `engines`     | `string` | no     | 指定搜索引擎，多个用逗号分隔              | `bing,startpage` |
| `language`    | `string` | no     | 语言/地区提示，传给支持的搜索引擎         | `en`、`zh-CN` |
| `time_range`  | `string` | no     | 时间范围：`day`、`week`、`month`、`year` | `month` |
| `pageno`      | `number` | no     | 从 0 开始的页码                           | `0` |
| `token`       | `string` | no/yse | 访问令牌（当配置了 TOKEN 环境变量时必填） | `$YOUR-TOKEN`  |

**支持的搜索引擎**：

- `bing` - Bing 搜索
- `startpage` - Startpage 搜索
- `mojeek` - Mojeek 搜索
- `duckduckgo` - DuckDuckGo 搜索
- `brave` - Brave 搜索

#### 返回值

```typescript
{
  query: string;                    // 搜索关键词
  number_of_results: number;        // 结果总数
  enabled_engines: string[];        // 启用的搜索引擎列表
  unresponsive_engines: string[];   // 无响应的搜索引擎列表
  results: Array<{
    title: string;                  // 结果标题
    description: string;            // 结果描述
    url: string;                    // 结果链接
    engine: string;                 // 来源引擎
  }>;
}
```

#### 请求示例

```bash
# GET 请求
curl "https://$YOUR-DOMAIN/search?q=cloudflare&engines=bing,startpage"

# JSON POST 请求
curl -X POST "https://$YOUR-DOMAIN/search" \
  -H "Content-Type: application/json" \
  -d '{"q":"cloudflare","engines":["bing","startpage"],"language":"zh-CN","time_range":"month"}'

# 表单 POST 请求
curl -X POST "https://$YOUR-DOMAIN/search" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "q=cloudflare&engines=bing,startpage"
```

#### 响应示例

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

## 搜索引擎说明

### 支持的搜索引擎

| 引擎           | 说明                           | 是否需要配置                  | 默认角色 |
| -------------- | ------------------------------ | ----------------------------- | -------- |
| **Bing**       | HTML 搜索解析                  | -                             | 主引擎   |
| **Startpage**  | 序列化 SERP 结果               | -                             | fallback 1 |
| **Mojeek**     | 简单 HTML 解析                 | -                             | fallback 2 |
| **DuckDuckGo** | HTML 搜索接口                  | -                             | fallback 3 |
| **Brave**      | HTML 结果解析（已去掉 `eval`） | -                             | fallback 4 |

### 基本工作方案

1. **优先级 fallback**：默认按 `bing,startpage,mojeek,duckduckgo,brave` 顺序执行
2. **提前停止**：当去重后的结果达到 `FALLBACK_MIN_RESULTS` 且至少 `FALLBACK_MIN_CONTRIBUTING_ENGINES` 个引擎贡献结果后停止继续请求
3. **结果归一化**：统一标题、描述、URL，并做去重与简单排序
4. **健康度控制**：连续失败的引擎会临时进入冷却；绑定 `SEARCH_STATE_KV` 后可跨 isolate 共享
5. **KV 缓存**：若绑定 `SEARCH_KV`，会缓存最终 `/search` 响应，并支持 stale-if-error 回退
6. **Hedged Fallback**：主链路超过 `HEDGED_FALLBACK_DELAY_MS` 仍未返回时，会提前启动下一个 fallback

## 环境变量配置

### 环境变量说明

| 变量名            | 类型     | 默认值   | 说明                                              |
| ----------------- | -------- | -------- | ------------------------------------------------- |
| `DEFAULT_ENGINES` | `string`/`array` | `bing,startpage,mojeek,duckduckgo,brave` | 引擎优先级 / fallback 顺序 |
| `DEFAULT_TIMEOUT` | `string` | `"4000"` | 单个搜索引擎的超时时间（毫秒）                    |
| `HEDGED_FALLBACK_DELAY_MS` | `string` | `"400"` | 主引擎慢于该阈值时提前触发 fallback（毫秒） |
| `FALLBACK_MIN_RESULTS` | `string` | `"6"` | 达到该去重结果数后停止 fallback                   |
| `FALLBACK_MIN_CONTRIBUTING_ENGINES` | `string` | `"2"` | 提前停止前至少需要贡献结果的引擎数 |
| `CACHE_TTL_SECONDS` | `string` | `"300"` | KV 缓存 TTL；设为 `0` 可关闭缓存                  |
| `STALE_CACHE_TTL_SECONDS` | `string` | `"1800"` | 过期缓存可在错误时兜底返回的保留时间（秒）     |
| `RATE_LIMIT_WINDOW_SECONDS` | `string` | `"60"` | 限流窗口大小（秒）                            |
| `RATE_LIMIT_MAX_REQUESTS` | `string` | `"60"` | 每个 token / IP 在窗口内允许的请求数            |
| `HEALTH_FAILURE_THRESHOLD` | `string` | `"2"` | 引擎进入冷却前允许的连续失败次数                |
| `HEALTH_COOLDOWN_SECONDS` | `string` | `"180"` | 引擎冷却时间（秒）                            |
| `HEALTH_STATE_TTL_SECONDS` | `string` | `"3600"` | 引擎健康状态在 KV 中的保留时间（秒）          |
| `TOKEN`           | `string` | `null`   | 访问令牌，配置后启用鉴权，保护服务不被滥用        |

**注意**：

- `TOKEN` 配置后，所有请求都需要提供有效的 token
- 绑定 `SEARCH_STATE_KV` 后，限流计数和引擎健康度会跨 isolate 共享；KV 写入是最终一致，不是强原子限流
- 绑定 `SEARCH_KV` 后即可启用跨请求缓存；若实时请求失败且 stale 缓存仍在有效期，会返回 stale 结果

### 配置方式

#### 方式 1: wrangler.toml 文件

编辑 `wrangler.toml` 文件中的 `[vars]` 部分：

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

#### 方式 2: Cloudflare Dashboard

1. 进入 Worker 设置页面
2. 找到 **Environment Variables** 部分
3. 添加变量并保存

## 使用场景

### 1. 聚合搜索服务

构建自己的搜索聚合 API，整合多个搜索引擎结果：

```javascript
const response = await fetch(
  "https://$YOUR-DOMAIN/search?q=javascript&engines=bing,startpage",
);
const data = await response.json();
console.log(`找到 ${data.number_of_results} 个结果`);
```

### 2. 前端搜索功能

为网站或应用添加搜索功能：

```javascript
async function search(query) {
  const response = await fetch(
    `https://$YOUR-DOMAIN/search?q=${encodeURIComponent(query)}`,
  );
  const data = await response.json();
  return data.results;
}
```

### 3. 数据采集与分析

收集多个搜索引擎的结果进行对比分析：

```javascript
const engines = ["bing", "startpage", "duckduckgo"];
const results = await fetch(
  `https://$YOUR-DOMAIN/search?q=AI&engines=${engines.join(",")}`,
);
const data = await results.json();

// 按引擎分组
const byEngine = data.results.reduce((acc, result) => {
  acc[result.engine] = acc[result.engine] || [];
  acc[result.engine].push(result);
  return acc;
}, {});
```

## MCP 集成

通过 MCP (Model Context Protocol) 让 AI 助手直接调用你的搜索服务，获取实时搜索结果。

## 注意与提醒

### 🚨 重要提示

1. **使用自定义域名**
   - Cloudflare 默认的 `*.workers.dev` 域名在某些地区可能无法访问
   - **强烈建议**绑定自己的域名以获得更好的访问体验
   - 在 Worker 设置中点击 **Triggers** > **Add Custom Domain** 添加自定义域名

2. **搜索引擎限制**
   - HTML 抓取引擎页面结构可能变化，建议保留 parser fixture 测试
   - 搜索引擎一般没有严格公开配额，但请合理使用
   - 频繁请求可能导致被临时限制访问

3. **超时设置**
   - 默认单个引擎超时 4 秒
   - 可通过环境变量 `DEFAULT_TIMEOUT` 调整
   - 建议不要设置过长，避免整体响应时间过长

### 🔒 安全配置

#### 启用鉴权

1. 配置 `TOKEN` 环境变量 来保护你的服务不被滥用：

- 利用 wrangler.toml 配置 TOKEN 环境变量
- 通过 Cloudflare Worker Dashboard 配置 TOKEN 环境变量

2. 在请求时传入 token：

```bash
# 访问首页
https://$YOUR-DOMAIN?token=$YOUR-TOKEN

# 使用 query/body 的 token 参数 请求 API
curl "https://$YOUR-DOMAIN/search?q=cloudflare&token=$YOUR-TOKEN"

curl -X POST "https://$YOUR-DOMAIN/search" \
  -d "q=cloudflare" \
  -d "token=$YOUR-TOKEN"
```

## 常见问题

### Q: 为什么有些搜索引擎返回结果为空？

A: 可能原因：

- 搜索引擎 API 临时不可用或响应超时
- 搜索关键词没有相关结果
- 搜索引擎限制了访问频率

可以查看返回的 `unresponsive_engines` 字段了解哪些引擎没有响应。

### Q: 如何提高搜索速度？

A: 建议：

- 保持默认 fallback 链路，让网关在拿到足够结果后提前停止
- 绑定 `SEARCH_KV` 并合理设置 `CACHE_TTL_SECONDS`
- 配合 `STALE_CACHE_TTL_SECONDS` 提升上游失败时的可用性
- 绑定 `SEARCH_STATE_KV`，让限流和引擎健康度跨 isolate 共享
- 结合 `DEFAULT_TIMEOUT`、`HEDGED_FALLBACK_DELAY_MS`、`FALLBACK_MIN_RESULTS` 和 `FALLBACK_MIN_CONTRIBUTING_ENGINES` 做调优

### Q: fallback 是怎么工作的？

A: 默认顺序如下：

1. `bing`
2. `startpage`
3. `mojeek`
4. `duckduckgo`
5. `brave`

当去重后的结果数达到 `FALLBACK_MIN_RESULTS` 且至少 `FALLBACK_MIN_CONTRIBUTING_ENGINES` 个引擎贡献结果后，网关会停止继续请求。

如果主引擎超过 `HEDGED_FALLBACK_DELAY_MS` 仍未返回，网关会提前启动下一个 fallback，以降低尾延迟。

### Q: 如何保护服务不被滥用？

A: 建议配置 `TOKEN` 环境变量启用鉴权：

1. 在 `wrangler.toml` 中设置 `TOKEN = "your-random-token"`
2. 或在 Cloudflare Dashboard 的 Environment Variables 中添加
3. 配置后所有请求都需要提供有效的 token

鉴权失败会返回 401 错误

### Q: 限流是不是全局强一致？

A: 绑定 `SEARCH_STATE_KV` 后，限流计数会跨 isolate 共享，适合基础防滥用。但 Cloudflare KV 写入是最终一致，不是严格原子计数；如果你需要强一致全局限流，建议后续接入 Durable Objects。

## 免责声明

本项目仅供学习和研究使用，使用者需遵守以下规定：

1. **合法使用** - 仅用于合法搜索需求，不得用于违法或侵权用途
2. **服务条款** - 使用时需遵守 Cloudflare Workers 和各搜索引擎的服务条款
3. **API 限制** - 遵守各搜索引擎 API 的使用限制和配额
4. **责任自负** - 使用本服务产生的任何后果由使用者自行承担
5. **商业用途** - 如需商业使用，请确保符合相关法律法规和服务条款

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

[GPL-3 License](LICENSE)

## 相关链接

- [项目 GitHub](https://github.com/Yrobot/cloudflare-search)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)

## 支持一下

如果这个项目对你有帮助，可以请作者喝杯咖啡 ☕

<image src="https://yrobot.top/donate_wx.jpeg" width="300"/>
