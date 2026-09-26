# Free Router 工作原理

> [English](../HOW_IT_WORKS.md) | 中文

技术参考。简短总览见 [README](README.md)。

## 环境要求

- Node.js 20+
- 至少一个渠道的 API Key——放 `.env`，或在 Web UI（渠道 tab）里粘贴，
  会存进 gitignored 的 `config.local.json`

缺 Key 的 provider 直接从排名里跳过。

## 配置 API Key

Provider Key 放在 `config.local.json`（gitignored，永不入库）或环境变量
里。首次启动时，`.env` 里找到的 Key 会自动导入 `config.local.json`。
`config.json` 只放默认值、保持可合并；服务端启动时深度合并两者（对象
按 key 递归，数组和标量以覆盖层为准）。复制示例文件，解开你有的 Key
并填值：

```bash
cp .env.example .env
```

| 变量 | 是否必需 | 获取位置 |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | 是，OpenRouter 兜底和模型发现都要它 | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | 否 | 你的 TokenRouter 账号 |
| `BAI_API_KEY` | 否 | [chat.b.ai](https://chat.b.ai) API Key，一个 Key 通所有 B.AI 官方模型 |
| `HASHNEURON_API_KEY` | 否 | HashNeuron OpenAI 兼容网关 `https://hashneuron.space/v1` |
| `GEMINI_API_KEY` | 否 | [Google AI Studio](https://aistudio.google.com/apikey)。免费层 Flash-Lite 是限配额的，不是无限的 |

之后加的 provider 叫 `foo`，默认读 `FOO_API_KEY` 和 `FOO_BASE_URL`，除非
在配置里覆盖 `keyEnv` / `baseUrlEnv`。

查找顺序，第一个非空值获胜：

1. 进程环境变量（`export OPENROUTER_API_KEY=...`）
2. 项目目录的 `.env`
3. `~/.hermes/.env`，如果你本来就在那里存 Key

`.env` 是 gitignored 的。不要把 Key 写进 systemd unit、README 或配置里。

`.env.example` 列了可选设置：监听地址、上游 base URL、OpenRouter 的
app 标题/referer。

## 运行

```bash
git clone https://github.com/www222fff/free-router-proxy.git
cd free-router-proxy
cp .env.example .env
# 编辑 .env，填上你有的 Key
./start.sh
```

网关默认监听 `127.0.0.1:8787`。`./stop.sh` 停止。请用普通用户跑这两个
脚本；如果以 root 启动，它们会 re-exec 到目录属主身份，拒绝保持 root。

## Docker 运行

```bash
git clone https://github.com/www222fff/free-router-proxy.git
cd free-router-proxy
cp .env.example .env
# 编辑 .env，填上你有的 Key
docker compose up -d
```

网关在 `http://127.0.0.1:8787/v1` 可达。容器进程绑 `0.0.0.0` 只是为了
Docker 端口转发；Compose 在宿主机上只发布到 loopback。Key 运行时从
`.env` 注入，不会 bake 进镜像。每周发现状态在容器重建时重置。

```bash
docker compose ps
docker compose logs -f
docker compose down
```

要让代码改动生效，重建再重建容器：

```bash
docker compose up -d --build
```

前台运行：

```bash
node server.mjs
```

看当前 `free-best` 优先级（就是网关尝试模型的顺序）：

```bash
./models.sh
./models.sh --ready-only
npm run models -- --json
```

看请求实际落到哪、今日配额还剩多少：

```bash
./models.sh --usage
```

## Web 界面

打开 <http://127.0.0.1:8787/>。这个仅限本机的界面有状态、渠道、路由、
配额、设置几个标签页，会跟随浏览器语言；大多数修改立即生效，端口和
标注的设置需要重启。

```json
"webui": {
  "enabled": true,
  "envFile": ".env"
}
```

设 `enabled: false` 可整个拿掉 `/` 和 `/api/*`。

### 写 Key 接口为什么要小心

`start.sh` 用 `set -a` source env 文件，能往里面写任意变量就等于下次
启动时代码执行。所以写入路径是受限的：

- Provider Key 按 **provider 名**寻址，绝不按原始变量名。服务端从合并
  后的配置里解析 `keyEnv`，写不出任何已配置渠道 Key 变量之外的东西。
- 含换行或 NUL 的值直接拒绝，一行字串不出第二个赋值。
- env 文件原子写入，权限 `0600`，已存在的文件会被 chmod 压下来。
- Key 只返回掩码版，绝不返回全文。
- 改完 Key 重建脱敏器，所以 UI 里加的 Key 照样会从上游请求里剥掉。

## Provider Key（多账号）

一个渠道可以配任意多个 Key。命名 Key 住 `config.local.json`（UI 管理，
带备注）；环境变量 Key 来自 `<KEYENV>`、`<KEYENV>S` 或 `<KEYENV>_KEYS`
（逗号分隔，自动命名，UI 里只读）。单次请求的有效顺序：文件 Key、
单个变量、复数变量，按值去重。请求在它们之间轮换；`401` 只退役中招
那把，限流和超时只冷却那把，换下一把不行才换下一个模型。

首次启动时，`.env` 里的 provider Key 会一次性导入 `config.local.json`
（命名为 `migrated-N`）并从 `.env` 里删掉，UI 会提示迁移数量。

## 配置分层

`config.json` 只放默认值、和上游保持一致可合并；操作员的一切改动都写
gitignored 的 `config.local.json`，服务端启动时深度合并（对象按 key
递归，数组和标量以覆盖层为准），运行中**只写覆盖层文件**，base 文件
永不落盘。

几个推论，提前说清楚：

- `git pull` 永远冲不掉你的设置，你的设置也永远进不了提交。
- 路由/渠道的**删除**记成墓碑（`_removedRoutes/_removedProviders`），
  上游加回来也不会复活你删掉的东西。
- 以后的结构性新增走加法式 schema 迁移（只补缺的骨架键，用户的值
  一个不动），盖着 `_schemaVersion` 戳。
- 完整优先级（从高到低）：进程环境变量 → `config.local.json` →
  `config.json` → 代码内置。`FREE_ROUTER_CONFIG` 换的是 base 文件，
  覆盖层永远是它旁边的 `config.local.json`。

## 对接任意 OpenAI 兼容客户端

把客户端指向本机网关；上游 provider 的 Key 不出网关。客户端需要填写
API Key 时可使用 `local` 这样的占位值。

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

或者加一条 `model_aliases.free-best` 再 `/model free-best` 切换。

选中的上游从 `X-Free-Router-Provider` 和 `X-Free-Router-Model` 返回，
外加 provider 自己的 `model` 字段。

## 接口

```text
GET  /                       仅限本机的 Web 界面
GET  /api/state              完整 UI 状态
POST /api/keys               provider Key：{ "provider", "name"?, "key" }
POST /api/providers          { "action": "create|update|delete", ... }
POST /api/routes             { "action": "save|delete", "route", "models" }
POST /api/limits             每日限额：{ "action": "set|delete", "key", "limit" }
POST /api/discovery          发现开关、渠道、间隔、置顶
POST /api/settings           调优参数、迁移提示
POST /api/server             { "port" }（重启生效）
POST /api/restart            退出等 supervisor 重启
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

`GET /health` 报 `package.json` 的 `version`（当前 `1.0.0`），发版用
`v1.0.0` 这种 git tag。

`GET /v1/models` 返回路由别名、各 static 渠道的 `freeModels`，以及
catalog 渠道当前免费的文本模型。直接点名具体模型 ID 也行，网关会把当
前提供同一模型的每个渠道都试一遍；`provider:` 前缀强制只用一家。

```bash
curl -s http://127.0.0.1:8787/health | jq
```

## 路由

- `free-best`：一个排好序的模型表；同一模型可以由多家提供

去 Web UI（路由 tab）里排序、增删，别直接改文件。`provider:model` 格式
写进 `discovery.evaluation.pinnedModels` 置顶。没 Key、或已经不免费的
模型直接跳过。只差 org 前缀或 `:free` 后缀的 ID 算同一个模型（比如
`gemini-3.8-flash` 和 `google/gemini-3.8-flash:free`）。

## 加新渠道

OpenAI 兼容的 `/chat/completions` 端口加进来不用改代码。`providers.mjs`
的注册表加载 `config.json` 里 `providers` 下的每一块。最省事的是 Web UI
（渠道 tab → 添加渠道，名字加 base URL 就行）；手改的话：

1. 加一个 provider 对象。有 `GET /models` 就 `"catalog": true`；返回体
   带逐 token 价格才加 `"pricing": true`，否则 `freeModels` 当白名单（见下）。
2. 可选：只有要手动排名时才把 `{ "provider": "<name>", "model": "<id>" }`
   插进 `routes.free-best`。发现会自己填排名。裸字符串归 `defaultProvider`。
3. 可选：`discovery.evaluation.pinnedModels` 里 `name:model` 置顶。
4. `.env` 或 `~/.hermes/.env` 里设 `<NAME>_API_KEY`；URL 不一样用
   `<NAME>_BASE_URL` 覆盖。
5. 只有改了要重启的开关（`catalog`、`pricing`）才重启；Key、地址、
   白名单都是即时生效。

```json
"newvendor": {
  "baseUrl": "https://api.example.com/v1",
  "freeModels": ["example-free"]
}
```

可选字段：`keyEnv`、`baseUrlEnv`、`headers`、`chatPath`、`modelsPath`、
`discover: false`（把带价格目录的渠道排除在发现之外）、
`probeFreeTier: true`（让无价格目录自己探出免费模型）。

`modelsUrl` + `modelsKeyHeader` 覆盖一种特殊情况：目录不在 chat 前缀下、
走独立鉴权。Gemini 两样都要，因为只有它的原生列表里才有
`supportedGenerationMethods`，而且它对 Bearer token 直接回 `401`。两种
返回形状都认：OpenAI 的 `data[].id` 或 Google 的 `models[].name`。

### 每个渠道给发现贡献什么

`catalog` 和 `pricing` 是两个独立开关，因为"拉 `/models`"和"分得出免
费还是收费"是两种能力：

| `kind` | 配置 | 免费模型从哪来 | 发现里的角色 |
|---|---|---|---|
| `catalog` | `catalog: true, pricing: true` | 零价格目录条目 | 又加又减 |
| `static+catalog` | `catalog: true, pricing: false` | `freeModels`，外加实际能免费服务的 | 只管减；`probeFreeTier` 开了也能加 |
| `static` | 都不设 | `freeModels` | 无 |

只有 OpenRouter 公布价格，所以只有它能光看目录 `$0` 加新模型。Gemini、
TokenRouter、B.AI、HashNeuron 没有价格。开了 `probeFreeTier` 照样能贡献：
OpenAI 兼容目录走和 OpenRouter 一样的极小现场探测；Gemini 原生列表走
配额形 429 的评测探测。默认 `routes.free-best`、`freeModels`、
`pinnedModels` 都是空的，排名里只有发现留下来的模型。已经判定免费的
目录条目仍会收进排名，所以清空配置不会丢掉证过的模型。

目录拉失败、返回空、或者渠道没 Key，都不改变现状：`freeModels` 照旧
说了算。删条目必须看到一份**真正拉到的**目录，上游一抖不会清空路由。

模型 ID 按 slug 比对，所以 Gemini 的 `models/gemini-3.8-flash` 对上配置
的 `gemini-3.8-flash` 不算下架。

`/health` 在 `discovery.addsFrom`、`discovery.availabilityOnly`、
`discovery.unavailableModels` 里报这些；Web UI 在所属渠道旁边标下架模型。

## 免费模型发现

路由器每 `discovery.intervalMs`（当前每 2 天）扫一遍**能加模型**的目录
渠道（`pricing: true` 或 `probeFreeTier: true`），看有没有新的免费文本
模型。目录标价 `$0` 不等于能打：剩下的
聊天 id 再发一次极小补全（`hi`，`max_tokens: 4`，12 秒超时，每批 8 个）。
只保留 HTTP 200 且响应里没有扣费字段的模型。若探测全部超时或连不上，
保留上一份名单，不清空。探测失败会记下“不免费”，配置里写了也会跳过。
探测请求不计用量。

排名用 `swe-bench.json` 里公布的 SWE-bench Verified 百分比（从
[humantonylee/free-router](https://github.com/humantonylee/free-router)
抄的 Artificial Analysis 数字，另补了那份表对不上当前免费名单的模型（Gemini 3.x Flash、Qwen3.8-27B、
Nemotron Ultra/Lightning 等），来自 Vals 托管的 SWE-bench；不是 SWE-bench 官方 dump）。匹配方式跟那份
目录一样：精确 id、派生 slug，再前缀匹配拼写变体（`glm-5.2` → `glm5`）。
延迟、用量、目录元数据、本地测验都不进排名。请求时照样会切到下一台能打
通的模型。

表里没有的模型仍留在路由里，排在有 SWE 分的后面，分数 `-1`、来源
`unranked`。置顶仍然最前。路由里保存了条目时，按保存顺序先于其余发现
的模型。`evaluation.baselineScores` 仍可手改覆盖。
本地 10 题测验还是会记在 `discovery.evaluations` 里当诊断，但不决定
`free-best` 顺序。

`./models.sh` 的 `SWE` 列是这个百分比。`/health` 每条有 `score`、
`baseScore`、`scoreSource`（`swe-bench` / `unranked` / `baseline` /
`pinned`）。

### 问渠道什么免费

没价格的目录回答不了"哪个免费"，但可以直接问。`probeFreeTier: true`
的渠道，每个没见过的聊天模型吃一次真实请求，回复即答案：

| 回复 | 含义 | 效果 |
|---|---|---|
| `200` | 这把 Key 能 serve | 免费；留在路由 |
| `429`，免费配额全 `limit: 0` | 根本没有免费档 | 移出路由 |
| `429`，有 `limit` 大于 `0` | 免费，但今天花完了 | 留下；数字变每日限额 |
| `404` | 不接，或下架了 | 移出路由 |
| `400` "only supports Interactions API" | 不是聊天模型 | 移出路由 |
| 超时、`5xx` | 说明不了问题 | 无 verdict，下轮再探 |

这招只对无账单的 Key 成立——serve 成功只能证明"能跑"，证明不了"免
费"，所以按渠道 opt-in：开了账单就别开它。

每个 verdict 缓存进状态文件，一个模型一辈子只花一次探路钱，
`evaluation.maxPerRun` 卡单轮上限。"不免费"的 verdict 过
`discovery.verdictRetryMs`（默认等于发现间隔）过期，provider 抖一下不
会永久退役模型；"免费"的不过期，反正正常流量天天 revisit，翻车了后
来的拒绝会覆盖。

verdict 双向压过 `freeModels`，这就是意义所在：`config.json` 的白名单
只是你对别人定价的猜，配额数字是 provider 亲口报的价。

发请求前先窄化候选。Google 原生列表用 `supportedGenerationMethods` 标
能力，所以 embedding、视频、直播音频模型不用点名就掉了；图片、语音、
音乐、转写、agent 专用模型和普通聊天模型共用 `generateContent`，所以
`discovery.exclude.modelPatterns` 管它们，连同 `-latest` 这种别名（它和
指向的 concrete 模型会 double-count 一份配额）。

### provider 上报的每日限额

`config.json` 的 `usage.dailyLimits` 只是起始猜测。provider 拒绝请求时
报出真实配额，这个数就替换掉该模型的配置值。`/health` 标谁在生效：
`reported` 是 provider 说的，`configured` 还是本地猜的。

同一个回复还驱动冷却。每日配额花完就等到 `usage.timezone` 的配额日切换，
而不是固定间隔——半夜不会白重试，也不会 idle 过复位点。按分钟的限额用
provider 让等的 `retryDelay`。

### 排除领域专用模型

窄领域调优的模型刷通用 benchmark 分很高，但当默认路由很烂。
`discovery.exclude` 管这个：

- `modelPatterns`：模型 ID 的大小写不敏感正则。
- `textPatterns`：目录 `name` + `description` 的大小写不敏感正则。这个更
  经久，因为厂商改名换后缀，描述里讲它是干嘛的可一直都在。

两条红线是故意的：`config.json` 路由里写了的豁免，显式声明永远赢过滤
器；排除只拿掉自动排名，被点名的 ID 照调不误（`GET /v1/models` 里留
着，精确 ID 可调），点名即 deliberate。

过滤建路由和收集时都生效，所以新 pattern 重启即生效，不用等下一轮收
集。`/health` 在 `discovery.excludedModels` 里列当前命中。

`evaluation.baselineScores` 直接覆盖分数，按 `provider:model` 或裸模型
ID 找。发现的和配置的都管，优先于 SWE 查找表。

catalog 模型变付费、下架、不再符合文本聊天、或现场探测打不通，下一轮
目录检查自动移出有效路由。它留在 `config.json` 里当排名历史，下次探测
成功才恢复。

`static` 渠道的候选，有 `freeModels` 又有 Key 就一直在；`static+catalog`
的还得出现在拉到的目录里，不在的进 `discovery.unavailableModels` 报备。

发现和评测状态存 `discovered-free-models.json`，重启不丢，那文件是
gitignored 的。

排期和目标路由配在 `config.json`：

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

发现写入的 id 一律是 `渠道:模型`。`/health` 的 `discovery.addsFrom` 列出
能贡献新模型的渠道。

`/health` 报上次收集时间、见过的免费模型、SWE 分数、路由优先级、以及因为
不免费被拿掉的模型。

评测请求和普通请求一样计用量，因为烧的是同一份 provider 配额。现场探
测那次极小补全不计用量。

## 请求历史和每日配额

每次上游尝试都按天、按 `provider:model` 计数，一眼看出这周流量到底谁
serve 了、谁快摸到免费日 cap。计数器和发现状态住同一个
`discovered-free-models.json`，最多 1.5 秒回写一次，按
`usage.retentionDays` 裁剪。

```bash
./models.sh            # 优先级表，带 today / 7d / fail 列
./models.sh --usage    # 按天、按模型的历史
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

- `timezone` 决定哪天翻天。Gemini 免费档的日请求计数按太平洋午夜清，
  所以主机在哪都建议留 `America/Los_Angeles`；不填就用主机本地日期。
- `dailyLimits` 按 `provider:model`、裸 `model`、`provider:*` 顺序匹配。
  限额只做展示参考，到了也不停发，因为数字是手维护的。
- `today` 列和 `remainingToday` 只算烧配额的尝试；限流、404、403 是
  provider 在跑模型前就拒了，不算。
- 失败桶有 `rateLimit`、`timeout`、`serverError`、`empty`、
  `notFound`、`forbidden`、`aborted`、`other`——请求掉到低优先级模型的
  *原因* 看得见。

`GET /health` 的 `usage` 里是同一份数据，每条路由条目自带 `usage` 块。

## systemd 用户服务

unit 默认仓库在 `~/free-router-proxy`，clone 到别处先改 `WorkingDirectory`
和 `ExecStart` 再 enable。

```bash
mkdir -p ~/.config/systemd/user
cp free-router-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now free-router-proxy
journalctl --user -u free-router-proxy -f
```

不用 systemd 就 `./start.sh`。

## 路由行为

1. `free-best` 里按**模型**排名。置顶按配置顺序打头；路由里已保存的条目
   按保存顺序接着排；其余发现的模型按非官方 SWE-bench Verified 百分比。
   保存名单为空时，整表都是发现排名。同一 `provider:model` 各自成组排名。
2. 每个模型，把当前标免费文本聊天的每家都试一遍。配置的渠道先行，
   同 slug 别家跟上。目录 ID 先剥 org 前缀和 `:free` 尾巴再比对，所以
   OpenRouter 后出的 Google/B.AI 同款免费版会紧跟原版试，而不是另起一行。
3. 一把可用 Key 都没有的渠道跳过。
4. catalog 渠道每 15 分钟刷新。
5. 每 `discovery.intervalMs` 收集新免费目录文本模型、现场探测、按 SWE 分插进
   `free-best`。目录里撞见已在排名的模型，挂到那条下当多渠道，不当新
   模型。
6. 变付费、下架、不再符合文本聊天、或免费聊天探测失败的目录模型，移出有效路由。
7. 缺请求要的能力（工具、图片输入等）的模型去掉。
8. 剩下按统一顺序试。
9. 限流、超时、服务端错、空成功回复走 provider/model/Key 三级冷却；
   `401` 只退役那把 Key。
10. 发上游前，把本地环境里 `*_API_KEY` / `*_TOKEN` / `*_SECRET` /
    `*_PASSWORD` 的值（含 provider Key）以及这些名字
    的 `NAME=...` 赋值行都脱敏。这拦不住 Hermes 在本地读 `.env`，只保证
    这些值不进 OpenRouter、TokenRouter、B.AI 的请求体。
11. 推理专用的流 chunk 先攒着，模型吐出正文或工具调用才往客户端发，
    空模型照样能被换掉。
12. Gemini 工具调用续聊，把 OpenAI 客户端丢掉的
    `extra_content.google.thought_signature` 贴回去。优先用上次 Gemini
    回包缓存的签名，不然用 Google 的 `skip_thought_signature_validator`
    哨兵，省一次烧配额的 400。还 400 就跳过同请求的剩下 Gemini 模型。

点名具体模型 ID 而不是路由别名，网关把当前提供同一模型的每家都试一
遍。`provider:model` 强制只用一家。