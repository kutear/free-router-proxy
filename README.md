# Free Router

> English | [中文](docs/zh-CN/README.md)

<p align="center">
  <img src="docs/og.png" alt="Free Router architecture: any OpenAI client to a local gateway to pluggable providers" width="100%">
</p>
Local OpenAI-compatible gateway. Point any client at
`http://127.0.0.1:8787/v1` and use `free-best`. It ranks currently free
models across **any OpenAI-compatible provider you configure**, then fails
over when one is rate-limited, down, or empty. A missing key just drops that
provider.

## Run

Node.js 20+. Copy `.env.example` to `.env`, add at least one provider key,
then:

```bash
git clone https://github.com/www222fff/free-router-proxy.git
cd free-router-proxy
cp .env.example .env
./start.sh
```

Stop with `./stop.sh`. Docker: `docker compose up -d`. Open
<http://127.0.0.1:8787/> to set keys, manage routing, and watch usage. The
local-only interface follows your browser language (12 languages included).

| Variable | Where |
| --- | --- |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | TokenRouter |
| `BAI_API_KEY` | [chat.b.ai](https://chat.b.ai) |
| `HASHNEURON_API_KEY` | HashNeuron (`https://hashneuron.space/v1`) |

Need more than one key per provider? Set `OPENROUTER_API_KEYS` (or
`OPENROUTER_API_KEY_KEYS`) with comma-separated values, or add named keys in
the web UI — requests rotate across them automatically.

More providers: add a block in `config.json`, or add one in the web UI with
just a name and a base URL. See [How it works](docs/HOW_IT_WORKS.md).

## Configuration layers

`config.json` holds defaults and stays merge-clean. Everything you change —
in the web UI or via the first-boot `.env` import — is written to the
gitignored `config.local.json`, which wins over defaults at startup (objects
merge per key, arrays are replaced). Provider keys also work straight from
the environment, so `.env` remains a valid key store that never needs a UI.

```bash
./models.sh          # current free-best order
./models.sh --usage  # today's quota
```

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=www222fff/free-router-proxy&type=Date&theme=dark" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=www222fff/free-router-proxy&type=Date" />
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=www222fff/free-router-proxy&type=Date" />
</picture>
