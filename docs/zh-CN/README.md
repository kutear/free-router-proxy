# Free Router

> [English](../../README.md) | 中文

<p align="center">
  <img src="../og.png" alt="Free Router 架构：任意 OpenAI 客户端 → 本地网关 → 可插拔 providers" width="100%">
</p>

本地 OpenAI 兼容网关。把任意客户端指向
`http://127.0.0.1:8787/v1` 并使用 `free-best`。它会对你配置的**任意
OpenAI 兼容 provider** 的当前免费模型做排名，遇到限流、宕机或空回复时
自动 Failover。缺 Key 的 provider 直接被跳过。

## 运行

Node.js 20+。把 `.env.example` 复制为 `.env`，填至少一个 provider 的 Key，
然后：

```bash
git clone https://github.com/www222fff/free-router-proxy.git
cd free-router-proxy
cp .env.example .env
./start.sh
```

`./stop.sh` 停止。Docker：`docker compose up -d`。打开
<http://127.0.0.1:8787/> 填 Key、管理路由、看用量。本机界面会跟随
浏览器语言（内置 12 种语言）。

| 变量 | 获取位置 |
| --- | --- |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | TokenRouter |
| `BAI_API_KEY` | [chat.b.ai](https://chat.b.ai) |
| `HASHNEURON_API_KEY` | HashNeuron（`https://hashneuron.space/v1`） |

一个 provider 需要多个 Key？设置 `OPENROUTER_API_KEYS`（或
`OPENROUTER_API_KEY_KEYS`），逗号分隔填多个值；也可以在 Web UI 里添加
命名 Key——请求会在它们之间自动轮换。

加新渠道：在 `config.json` 里加一段，或在 Web UI 里只填名字和 base URL
添加。详见[工作原理](HOW_IT_WORKS.md)。

## 配置分层

`config.json` 只放默认值，保持可合并。你的所有改动——Web UI 里改的、
首次启动从 `.env` 导入的——都写进 gitignored 的 `config.local.json`，
启动时覆盖默认值（对象按 key 合并，数组整体替换）。Provider Key 也可以
直接走环境变量，`.env` 永远是一个免 UI 的 Key 存储。

```bash
./models.sh          # 当前 free-best 排序
./models.sh --usage  # 今日配额
```

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=www222fff/free-router-proxy&type=Date&theme=dark" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=www222fff/free-router-proxy&type=Date" />
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=www222fff/free-router-proxy&type=Date" />
</picture>
