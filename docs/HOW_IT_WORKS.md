# How Free Router works

> English | [中文](zh-CN/HOW_IT_WORKS.md)

Technical reference. The short overview lives in the [README](../README.md).

## Requirements

- Node.js 20+
- An API key for at least one provider — in `.env`, or pasted in the web UI
  (Providers tab), which stores it in the gitignored `config.local.json`

A missing key just drops that provider from ranking.

## Configure API keys

Provider keys live in `config.local.json` (gitignored, never committed) or in the
environment. On first boot, keys found in `.env` are imported into
`config.local.json` automatically. `config.json` holds defaults only and stays
merge-clean; the server deep-merges both at startup (objects recurse, arrays
and scalars come from the overlay when present). Copy the example file,
uncomment the keys you have, and fill them in:

```bash
cp .env.example .env
```

| Variable | Required | Where to get it |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Yes, for OpenRouter fallbacks and model discovery | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | No | Your TokenRouter account |
| `BAI_API_KEY` | No | [chat.b.ai](https://chat.b.ai) API keys. One key covers all official B.AI models |
| `HASHNEURON_API_KEY` | No | HashNeuron OpenAI-compatible gateway at `https://hashneuron.space/v1` |
| `GEMINI_API_KEY` | No | [Google AI Studio](https://aistudio.google.com/apikey). Free-tier Flash-Lite is quota-limited, not unlimited |

Any later provider named `foo` reads `FOO_API_KEY` and `FOO_BASE_URL` unless
you override `keyEnv` / `baseUrlEnv` in config.

Lookup order, first non-empty value wins:

1. Process environment (`export OPENROUTER_API_KEY=...`)
2. `.env` in the project directory
3. `~/.hermes/.env`, if you already keep keys there

`.env` is gitignored. Do not put keys in the systemd unit, README, or config.

Optional settings are listed in `.env.example`: listen address, upstream base
URLs, and the OpenRouter app title/referer.

## Run

```bash
git clone https://github.com/www222fff/free-router-proxy.git
cd free-router-proxy
cp .env.example .env
# edit .env and set the keys you have
./start.sh
```

The gateway listens on `127.0.0.1:8787` by default. Stop it with `./stop.sh`.
Run these scripts as a normal user. If started as root, they re-exec as the
directory owner and refuse to stay root.

## Run with Docker

```bash
git clone https://github.com/www222fff/free-router-proxy.git
cd free-router-proxy
cp .env.example .env
# edit .env and set the keys you have
docker compose up -d
```

The gateway is reachable at `http://127.0.0.1:8787/v1`. The container process
binds `0.0.0.0` so Docker port forwarding works, while Compose publishes it
only on the host loopback address. Keys are injected at runtime from `.env`
and never baked into the image. Weekly-discovery state is ephemeral: it lives
inside the container and is reset on rebuild.

```bash
docker compose ps
docker compose logs -f
docker compose down
```

To pick up code changes, rebuild and recreate:

```bash
docker compose up -d --build
```

Foreground:

```bash
node server.mjs
```

List the current `free-best` priority (same order the gateway will try models):

```bash
./models.sh
./models.sh --ready-only
npm run models -- --json
```

See where requests actually landed, and how much of today's quota is left:

```bash
./models.sh --usage
```

## Web interface

Open <http://127.0.0.1:8787/>. The local-only interface has tabs for status,
providers, routes, quotas, and settings, follows the browser language, and
applies most changes immediately. Port and marked settings need a restart.

```json
"webui": {
  "enabled": true,
  "envFile": ".env"
}
```

Set `enabled: false` to remove `/` and `/api/*` entirely.

### Why the key endpoints need care

Since `start.sh` sources the env file with `set -a`, being able to write an
arbitrary variable there would mean code execution on the next start. The
write path is therefore constrained:

- Provider keys are addressed **by provider name**, never by raw variable
  name. The server resolves `keyEnv` from the merged config, so nothing
  outside a configured provider's key variable can ever be written.
- Values containing a newline or NUL are rejected, so one field cannot append
  a second assignment.
- The env file is written atomically with mode `0600`, and an existing file is
  chmod'ed down to match.
- Keys are returned masked, never in full.
- The secret redactor is rebuilt after a key change, so a key added through the
  UI is still stripped from upstream payloads.

## Provider keys (multi-account)

Each provider can hold any number of keys. Named keys live in
`config.local.json` (UI-managed, with remarks); environment keys come from
`<KEYENV>`, `<KEYENV>S`, or `<KEYENV>_KEYS` (comma-separated, auto-named,
read-only in the UI). Effective order per request: file keys, then the single
variable, then the plurals, deduplicated by value. Requests rotate across
them; a `401` retires only that key, rate limits and timeouts cool down only
that key, and the next key is tried before moving to the next model.

On first boot, provider keys found in `.env` are imported into
`config.local.json` once (named `migrated-N`) and removed from `.env`, with a
dismissible notice in the UI.

## Layered configuration

`config.json` holds defaults and stays merge-clean (byte-identical to
upstream where possible). Everything the operator changes — via the web UI
or the first-boot `.env` import — is written to the gitignored
`config.local.json`, which the server deep-merges over defaults at startup
(objects merge per key, arrays and scalars are replaced). The base file is
never written at runtime.

Consequences worth knowing:

- `git pull` can never conflict with your settings, and your settings can
  never leak into a commit.
- Route and provider deletions are recorded as tombstones, so a base entry
  you deleted stays deleted after upgrades.
- Structural additions ship as additive-only schema migrations (new skeleton
  keys, never touching your values), stamped with `_schemaVersion`.
- Full precedence, highest first: process environment → `config.local.json`
  → `config.json` → code defaults. `FREE_ROUTER_CONFIG` swaps the base file;
  the overlay is always `config.local.json` next to it.

## Use with any OpenAI-compatible client

Point the client at the local gateway. Upstream provider keys stay on the
gateway; clients may use a placeholder API key such as `local`.

**curl**

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "free-best",
    "messages": [{"role": "user", "content": "Reply with exactly: router-ok"}]
  }'
```

**OpenAI SDK**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
print(client.chat.completions.create(
    model="free-best",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

**Hermes**

```yaml
model:
  default: free-best
  provider: custom
  base_url: http://127.0.0.1:8787/v1
custom_providers:
  - name: free-router
    base_url: http://127.0.0.1:8787/v1
    api_key: local
    api_mode: chat_completions
    discover_models: true
    models:
      - free-best
```

Or add a `model_aliases.free-best` entry and switch with `/model free-best`.

The selected upstream is returned in `X-Free-Router-Provider` and
`X-Free-Router-Model`, plus the provider's normal `model` field.

## Endpoints

```text
GET  /                       local-only web interface
GET  /api/state              full UI state
POST /api/keys               provider keys: { "provider", "name"?, "key" }
POST /api/providers          { "action": "create|update|delete", ... }
POST /api/routes             { "action": "save|delete", "route", "models" }
POST /api/limits             daily limits: { "action": "set|delete", "key", "limit" }
POST /api/discovery          discovery toggles, provider, interval, pins
POST /api/settings           tuning knobs and migration notice
POST /api/server             { "port" } (restart to apply)
POST /api/restart            exit for supervisor restart
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

`GET /health` reports `version` from `package.json` (currently `1.0.0`). Releases are
git tags of the form `v1.0.0`.

`GET /v1/models` returns the route alias, each static provider's `freeModels`,
and every currently free text-chat model from catalog providers. A listed
concrete model ID can be selected directly; the gateway then tries every
provider that currently offers that same model. Prefix with `provider:` to
force a single provider.

```bash
curl -s http://127.0.0.1:8787/health | jq
```

## Routes

- `free-best`: one ranked list of models; the same model can be tried from
  more than one provider

Reorder, add, or delete entries in the web UI (Routes tab) instead of editing
files. Pin entries with `provider:model` in `discovery.evaluation.pinnedModels`.
Models without a key, or that are no longer free, are skipped. IDs that differ
only by org prefix or a `:free` suffix (for example `gemini-3.8-flash` and
`google/gemini-3.8-flash:free`) count as the same model.

## Add a provider

No code change is needed for an OpenAI-compatible `/chat/completions` endpoint.
The registry in `providers.mjs` loads every block under `config.json`
`providers`. Easiest is the web UI (Providers tab → Add provider, name plus
base URL); to do it by hand:

1. Add a provider object. Set `"catalog": true` if it exposes `GET /models`.
   Add `"pricing": true` only when that response carries per-token prices;
   otherwise keep `freeModels` as the allowlist (see below).
2. Optional: insert `{ "provider": "<name>", "model": "<id>" }` into
   `routes.free-best` only if you want a manual rank. Discovery fills the
   route on its own. Bare strings belong to `defaultProvider`.
3. Optionally pin `name:model` in `discovery.evaluation.pinnedModels`.
4. Set `<NAME>_API_KEY` in `.env` or `~/.hermes/.env`, or paste the key in the
   web UI. Override the URL with `<NAME>_BASE_URL` if needed.
5. Restart only if you changed flags that require it (`catalog`, `pricing`);
   keys, URLs, and allowlists apply immediately.

```json
"newvendor": {
  "baseUrl": "https://api.example.com/v1",
  "freeModels": ["example-free"]
}
```

Optional fields: `keyEnv`, `baseUrlEnv`, `headers`, `chatPath`, `modelsPath`,
`discover: false` to keep a priced catalog provider out of discovery, and
`probeFreeTier: true` to let a price-free catalog contribute models by probing.

Two fields cover a catalog served outside the chat prefix, on its own auth:
`modelsUrl` for an absolute listing URL and `modelsKeyHeader` for the header
carrying the key. Gemini needs both, because its native listing is the only
place `supportedGenerationMethods` appears and it answers `401` to a Bearer
token. Either response shape is accepted: OpenAI's `data[].id` or Google's
`models[].name`.

### What each provider contributes to discovery

`catalog` and `pricing` are separate switches, because fetching `/models` and
being able to tell free from paid are separate capabilities.

| `kind` | Config | Free models come from | Discovery role |
|---|---|---|---|
| `catalog` | `catalog: true, pricing: true` | zero-priced catalog entries | adds and removes models |
| `static+catalog` | `catalog: true, pricing: false` | `freeModels`, plus anything the provider serves for free | removals, and additions when `probeFreeTier` is on |
| `static` | neither | `freeModels` | none |

Only OpenRouter publishes prices, so only OpenRouter can add unknown models
from a catalog listing of `$0`. Gemini, TokenRouter, B.AI, and HashNeuron
publish no prices. With `probeFreeTier: true` they still contribute: OpenAI-
compatible catalogs get the same tiny live chat probe as OpenRouter; Gemini's
native listing uses the quota-shaped evaluate probe. Default `routes.free-best`,
`freeModels`, and `pinnedModels` lists ship empty, so the ranked route is
whatever discovery kept. A stored `free: true` verdict still promotes that
catalog id, so emptying the config does not drop models already proven free.

A catalog that fails to load, returns nothing, or belongs to a provider with no
key changes nothing: `freeModels` stays authoritative. Removal requires a
catalog that actually loaded, so an upstream outage cannot empty a route.

Model IDs are matched by slug, so Gemini listing `models/gemini-3.8-flash`
against a configured `gemini-3.8-flash` is not read as a withdrawal.

`/health` reports this under `discovery.addsFrom`,
`discovery.availabilityOnly`, and `discovery.unavailableModels`; the web UI
shows withdrawn models next to the owning provider.

## Free-model discovery

The router checks every catalog provider that can add models (`pricing: true`,
or `probeFreeTier: true`) every `discovery.intervalMs`
(currently every 2 days) for newly free text-generation models. A priced catalog
listing of `$0` is not enough: each remaining chat id gets a tiny live
completion (`hi`, `max_tokens: 4`, 12s timeout, batches of 8). Only HTTP 200
replies with no billing fields (`usage.cost` / credits) are kept. If every
probe times out or cannot connect, the previous list is left alone instead of
being wiped. Failed probes mark the model not-free so even a configured entry
is skipped. Probe calls are not counted in usage.

Ranking uses published SWE-bench Verified percentages from `swe-bench.json`
(unofficial copy of the Artificial Analysis numbers stored by
[humantonylee/free-router](https://github.com/humantonylee/free-router),
plus Gemini 3.x Flash, Qwen3.8-27B, Nemotron Ultra/Lightning, and other
live free-route models filled from the Vals-hosted SWE-bench table that copy
did not include).
Matching follows that catalog: exact id, derived slug, then a prefix match
for spelling variants such as `glm-5.2` → `glm5`. Latency, usage, catalog
metadata, and the local puzzle are not part of the rank. Failover still
tries the next reachable model at request time.

Models with no SWE match stay on the route after the scored ones, in
discovery order, with score `-1` / source `unranked`. Pins still go first.
A non-empty saved route list is a manual order and is tried before the
remaining discovered models. `evaluation.baselineScores` remains a numeric
override.

`./models.sh` shows the SWE percentage in the `SWE` column. `/health`
reports `score`, `baseScore`, and `scoreSource` (`swe-bench`, `unranked`,
`baseline`, or `pinned`).

### Asking a provider what is free

A provider without prices in its catalog can still answer the question, just
not in the listing. With `probeFreeTier: true`, each unknown chat model gets one
real request and the reply is read as the answer:

| Reply | Meaning | Effect |
|---|---|---|
| `200` | served on this key | free; stays on the route |
| `429`, every free-tier `limit: 0` | no free allowance exists | dropped from routes |
| `429`, some `limit` above `0` | free, but spent for now | kept; the number becomes its daily limit |
| `404` | not served, or withdrawn | dropped from routes |
| `400` "only supports Interactions API" | not a chat model | dropped from routes |
| timeout, `5xx` | says nothing | no verdict; retried next run |

This is only sound on a key with no billing enabled, which is why it is opt-in
per provider: with billing on, a served request proves the model runs, not that
it was free.

Each verdict is cached in the state file, so a model costs one probe ever rather
than one per run, and `evaluation.maxPerRun` caps a single run. A "not free"
verdict expires after `discovery.verdictRetryMs` (defaulting to the discovery
interval) so a provider blip cannot retire a model permanently; a "free" verdict
does not expire, because ordinary traffic revisits it and a later refusal
replaces it.

Verdicts outrank `freeModels` in both directions. That is the point: an
allowlist in `config.json` is a guess about someone else's pricing, while a
quota figure is that provider stating its own terms.

The candidate list is narrowed before anything is sent. Google's native listing
marks capability in `supportedGenerationMethods`, so embedding, video, and live
audio models are dropped without naming them. Image, speech, music,
transcription, and agent-only models share the `generateContent` method with
ordinary chat models, so `discovery.exclude.modelPatterns` carries those, along
with `-latest` aliases that would double-count one allowance with the concrete
model they resolve to.

### Daily limits the provider reported

`usage.dailyLimits` in `config.json` is a starting guess. When a provider
refuses a request and states the real allowance, that number replaces the
configured one for that model. `/health` marks which is in use: `reported` came
from the provider, `configured` is still the local guess.

The same reply drives the cooldown. A spent daily quota waits until the quota
day rolls over in `usage.timezone` rather than a fixed interval, so the router
neither retries all night for nothing nor idles past the reset. A per-minute
limit uses the `retryDelay` the provider asked for.

### Excluding domain-specific models

A narrow, domain-tuned model aces a generic benchmark and then lands high in
the ranking even though it is a bad default for general traffic. `discovery.exclude`
keeps those out:

- `modelPatterns`: case-insensitive regexes matched against the model ID.
- `textPatterns`: case-insensitive regexes matched against the catalog `name`
  and `description`. This is the more durable check, because a vendor's naming
  suffix changes but the description keeps saying what the model is for.

Two boundaries are deliberate. Anything listed in `config.json` routes is
exempt, so an explicit entry always beats the filter. And exclusion only
removes a model from automatic ranking: it stays in `GET /v1/models` and can
still be called by its exact ID, since naming it is a deliberate choice.

Filtering applies both when building a route and during collection, so a new
pattern takes effect on restart instead of after the next collection.
`/health` lists the current matches under `discovery.excludedModels`.

`evaluation.baselineScores` overrides a score outright, keyed by
`provider:model` or by the bare model ID. It applies to discovered models as
well as configured ones, and takes precedence over the SWE lookup.

If a routed catalog model becomes paid, disappears, stops qualifying as a
text chat model, or fails the live chat probe, the next catalog check removes
it from every effective route automatically. It remains in `config.json` as
ranking history and becomes active again only if a later probe succeeds.

Candidates from a `static` provider stay in the ranking as long as they are
listed under `freeModels` and a key is set. On a `static+catalog` provider they
must additionally still appear in the fetched catalog; those that do not are
reported under `discovery.unavailableModels`.

Discovery and evaluation state is stored in `discovered-free-models.json` and
survives service restarts. That file is gitignored.

Configure the schedule and destination route in `config.json`:

```json
"discovery": {
  "enabled": true,
  "intervalMs": 172800000,
  "route": "free-best",
  "stateFile": "discovered-free-models.json",
  "exclude": {
    "modelPatterns": [],
    "textPatterns": [
      "\\b(finance|medicine|legal)[\\s-]*(focused|specific)\\b"
    ]
  },
  "evaluation": {
    "enabled": true,
    "maxTokens": 4000,
    "maxPerRun": 8,
    "pinnedModels": []
  }
}
```

Discovered ids are always `provider:model`. `/health` `discovery.addsFrom`
lists every provider that can contribute new models.

`/health` reports the last collection time, free models seen, SWE scores, route
priority, and models removed because they are no longer free.

Evaluation requests are counted in the usage statistics like any other request,
because they consume the same provider quota. The tiny live-reachability probes
are not counted.

## Request history and daily quota

Every upstream attempt is counted per day and per `provider:model`, so you can
see which models actually served this week's traffic and how close a provider
is to its free daily cap. Counters live in the same `discovered-free-models.json`
state file, are written back at most once every 1.5 seconds, and are pruned to
`usage.retentionDays`.

```bash
./models.sh            # priority list with today / 7d / fail columns
./models.sh --usage    # per-day and per-model history
```

```json
"usage": {
  "retentionDays": 7,
  "timezone": "America/Los_Angeles",
  "dailyLimits": {
    "gemini:gemini-3.8-flash": 20,
    "gemini:gemini-3.5-flash-lite": 200
  }
}
```

- `timezone` decides when the day rolls over. Gemini free-tier request-per-day
  counters reset at midnight Pacific, so keep it at `America/Los_Angeles` even
  if the host runs elsewhere. Omit the field to use the host's local date.
- `dailyLimits` keys are matched as `provider:model`, then bare `model`, then
  `provider:*`. Limits are informational only; the router does not stop sending
  once a limit is reached, because the numbers are hand-maintained.
- The `today` column and `remainingToday` count only quota-consuming attempts.
  Rate limits, 404s, and 403s are excluded because the provider rejected them
  before running the model.
- Failure buckets are `rateLimit`, `timeout`, `serverError`, `empty`,
  `notFound`, `forbidden`, `aborted`, and `other`, which is what makes it
  visible *why* a request fell through to a lower-priority model.

`GET /health` exposes the same data under `usage`, and each route entry carries
its own `usage` block.

## systemd user service

The unit assumes the repo lives at `~/free-router-proxy`. If you cloned somewhere
else, edit `WorkingDirectory` and `ExecStart` before enabling it.

```bash
mkdir -p ~/.config/systemd/user
cp free-router-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now free-router-proxy
journalctl --user -u free-router-proxy -f
```

`./start.sh` also works without systemd.

## Routing behavior

1. Ranks **models** from `free-best`. Pinned models stay first, in config
   order. If the route has saved entries, those come next in that order.
   Remaining discovered models sort by unofficial SWE-bench Verified
   percentage. An empty saved list is discovery ranking only.
2. At each model, tries every provider that currently lists it as a free
   text-chat model. The configured provider is first; other listings for the
   same slug follow. Catalog IDs are matched after stripping an org prefix
   and a trailing `:free`, so a later free OpenRouter copy of a Google or
   B.AI model is tried immediately after the original instead of as a
   separate rank.
3. Skips a provider when none of its API keys is usable.
4. Refreshes catalog providers every 15 minutes.
5. Collects newly free catalog text models every `discovery.intervalMs`, live-probes them, and inserts keepers
   into `free-best` by SWE-bench score. A catalog listing of a model that is already
   ranked is attached to that model instead of being treated as a new one.
6. Removes catalog models that are no longer free, available, text-chat compatible, or reachable on a free chat probe
   from effective routes.
7. Removes models missing capabilities required by the request, such as tools
   or image input.
8. Tries remaining candidates in that unified order.
9. Applies per-provider/model/key cooldowns after rate limits, timeouts, server failures, and empty
   successful responses. A `401` retires only that key; other keys keep serving.
10. Before sending a request upstream, redacts values of `*_API_KEY` / `*_TOKEN` /
   `*_SECRET` / `*_PASSWORD` from the local environment (including provider
   keys), and `NAME=...` assignment
   lines for those names. This cannot stop Hermes from reading `.env` locally; it
   only keeps those values out of OpenRouter, TokenRouter, and B.AI payloads.
11. Buffers reasoning-only stream chunks. Nothing is sent to the client until a
   model emits content or a tool call, so an empty model can still be replaced.
12. On Gemini tool-call follow-ups, reattaches `extra_content.google.thought_signature`
   that OpenAI-only clients drop. Cached signatures from the previous Gemini
   response are preferred; otherwise Google's `skip_thought_signature_validator`
   sentinel is used so the request is not a quota-burning 400. If Gemini still
   returns that 400, remaining Gemini models for the same request are skipped.

When a concrete model ID is requested instead of a route alias, the gateway
tries every provider that currently offers that same model. Use
`provider:model` to force a single provider.
