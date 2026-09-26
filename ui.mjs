import fs from 'node:fs';
import os from 'node:os';
import { LANGS, STRINGS } from './i18n.mjs';

const MAX_SECRET_LENGTH = 500;

// Language content lives in i18n.mjs; the page gets a frozen copy so the
// browser needs no module loader. `</script>` can never appear in it: values
// only use <span> markup (verified in tests via renderPage snapshot).
const removedI18nKey = (key) =>
  key === 'tab_access' ||
  key === 'tab_quota' ||
  key === 'tab_settings' ||
  key === 'logout' ||
  key === 'require_auth' ||
  key === 'goto_access' ||
  key === 'card_config' ||
  key === 'card_gateway' ||
  key === 'card_adminpw' ||
  key === 'prov_counts' ||
  key === 'prov_label_ph' ||
  key === 'usage_today' ||
  key === 'usage_blurb' ||
  key === 'usage_empty' ||
  key === 'th_today' ||
  key === 'th_ok' ||
  key === 'th_fail' ||
  key === 'th_limit' ||
  key === 'th_limit_day' ||
  key === 'th_source' ||
  key === 'add_provider' ||
  key === 'add_provider_blurb' ||
  key === 'del_provider' ||
  key === 'confirm_del_provider' ||
  key === 'deleted_provider' ||
  key === 'pinned_msg' ||
  key === 'unpinned_msg' ||
  key === 'rm_model_title' ||
  key === 'removed_model' ||
  key === 'added_model' ||
  key === 'adminpw_warn' ||
  key === 'mig_gw' ||
  key === 'srv_host' ||
  key === 'srv_note' ||
  key === 'err_admin_pass' ||
  key.startsWith('login_') ||
  key.startsWith('access_') ||
  key.startsWith('gw_') ||
  key.startsWith('admin_') ||
  key.startsWith('sess_') ||
  key.startsWith('np_') ||
  key.startsWith('limit_') ||
  key.startsWith('limits_') ||
  key.startsWith('disc_') ||
  key.startsWith('pin_') ||
  key.startsWith('unpinned_') ||
  key.startsWith('server_') ||
  key.startsWith('srv_') ||
  key.startsWith('restart_') ||
  key.startsWith('tuning_') ||
  key.startsWith('tun_') ||
  key.startsWith('adv_') ||
  key.startsWith('url_') ||
  key.startsWith('fm_');
const UI_STRINGS = Object.fromEntries(
  Object.entries(STRINGS).map(([lang, strings]) => [
    lang,
    Object.fromEntries(Object.entries(strings).filter(([key]) => !removedI18nKey(key))),
  ]),
);
const I18N_PAYLOAD = JSON.stringify({ langs: LANGS, strings: UI_STRINGS });

// Keeps the operator's username out of the interface and the log file, which
// both get shared or screenshotted more often than they get read locally.
export function displayPath(target) {
  const home = os.homedir();
  const text = String(target || '');
  if (!home) return text;
  if (text === home) return '~';
  if (text.startsWith(`${home}/`)) return `~/${text.slice(home.length + 1)}`;
  return text;
}

// Shows enough of a key to recognise which one is set, never enough to use it.
export function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 12) return '*'.repeat(text.length);
  return `${text.slice(0, 5)}${'*'.repeat(8)}${text.slice(-4)}`;
}

// A newline would let one field append unrelated assignments to .env, which
// start.sh sources with `set -a`. That would be code execution on next start.
export function validateSecret(value) {
  const text = String(value ?? '');
  if (/[\r\n\0]/.test(text)) return 'value must not contain newlines';
  if (text.length > MAX_SECRET_LENGTH) return `value must be at most ${MAX_SECRET_LENGTH} characters`;
  return '';
}

function formatEnvLine(name, value) {
  const needsQuotes = /[\s#'"]/.test(value);
  if (!needsQuotes) return `${name}=${value}`;
  return `${name}="${value.replace(/(["\\])/g, '\\$1')}"`;
}

// Rewrites only the named assignments, preserving comments, ordering, and any
// unrelated variables. An empty value removes the assignment entirely.
export function updateEnvFile(file, updates) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const output = [];

  for (const line of lines) {
    const match = line.match(/^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const name = match?.[2];
    if (!name || !pending.has(name)) {
      output.push(line);
      continue;
    }
    const value = pending.get(name);
    pending.delete(name);
    if (!value) continue;
    output.push(`${match[1] || ''}${formatEnvLine(name, value)}`);
  }

  for (const [name, value] of pending) {
    if (!value) continue;
    output.push(formatEnvLine(name, value));
  }

  while (output.length && !output[output.length - 1].trim()) output.pop();
  const body = output.length ? `${output.join('\n')}\n` : '';
  const temporaryPath = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, body, { mode: 0o600 });
  fs.renameSync(temporaryPath, file);
  // A pre-existing file may have been group or world readable.
  fs.chmodSync(file, 0o600);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Free Router</title>
<style>
:root {
  color-scheme: light;
  --bg: #f7f8fa;
  --card: #ffffff;
  --line: #e2e5ea;
  --line-soft: #eef0f4;
  --text: #1c1f24;
  --muted: #5f6773;
  --faint: #8a929e;
  --accent: #0b62d6;
  --accent-soft: #eaf1fd;
  --ok: #16794a;
  --ok-soft: #e6f4ec;
  --warn: #8a5b00;
  --warn-soft: #fdf2dd;
  --bad: #c22c38;
  --bad-soft: #fdeced;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }

header {
  background: var(--card);
  border-bottom: 1px solid var(--line);
  padding: 16px 28px;
  box-shadow: 0 1px 10px rgba(20, 28, 40, .06);
}
.head-inner {
  max-width: 1040px; margin: 0 auto;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.head-spacer { flex: 1; }
#lang { max-width: 150px; }
#logout-top { padding: 6px 12px; font-size: 12.5px; }
h1 { font-size: 19px; font-weight: 650; margin: 0; letter-spacing: -.2px; }
main { max-width: 1040px; margin: 0 auto; padding: 28px; display: grid; gap: 26px; }

section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
.sec-head { padding: 18px 22px 0; }
.sec-head h2 { font-size: 15px; font-weight: 650; margin: 0; letter-spacing: -.1px; }
.sec-head p { margin: 5px 0 0; font-size: 13px; color: var(--muted); max-width: 74ch; }
.sec-head .key-instruction {
  display: inline-block; max-width: none; padding: 4px 9px; border-radius: 7px;
  background: var(--accent-soft); color: var(--accent); font-weight: 650;
}
.sec-body { padding: 14px 22px 20px; overflow-x: auto; }

.prov {
  display: grid; grid-template-columns: minmax(120px, 180px) 1fr;
  gap: 18px; align-items: start;
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 16px 18px;
  transition: box-shadow .18s, border-color .18s;
}
.prov:hover { border-color: #c6cdd6; box-shadow: 0 4px 16px rgba(20, 28, 40, .07); }
#providers { display: grid; gap: 10px; }
.prov-name { font-weight: 600; padding-top: 7px; }
.prov-name span { display: block; font-weight: 400; font-size: 12px; color: var(--faint); margin-top: 2px; }
.prov-field input {
  width: 100%; padding: 9px 12px; border-radius: 8px;
  border: 1px solid #ccd2db; background: #fff; color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px;
}
.prov-field input::placeholder { color: var(--faint); font-family: inherit; }
.prov-field input:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(11, 98, 214, .13);
}
.prov-hint { margin-top: 7px; font-size: 12px; color: var(--muted); }

button {
  padding: 9px 15px; border-radius: 8px; font-size: 13px; font-weight: 550;
  border: 1px solid #ccd2db; background: #fff; color: var(--text); cursor: pointer;
  transition: background .15s, border-color .15s, box-shadow .15s, transform .05s;
}
button:hover { background: #f3f5f8; }
button:active:not(:disabled) { transform: translateY(1px); }
button:focus-visible, input:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { background: #0954b5; }
button.quiet { border-color: transparent; background: transparent; color: var(--muted); }
button.quiet:hover { background: var(--bad-soft); color: var(--bad); }
button:disabled { opacity: .55; cursor: default; }

.pill {
  display: inline-block; padding: 2px 9px; border-radius: 999px;
  font-size: 12px; font-weight: 600; white-space: nowrap;
}
.pill.ok { color: var(--ok); background: var(--ok-soft); }
.pill.no { color: var(--muted); background: #eef0f4; }
.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line-soft); }
th {
  color: var(--muted); font-weight: 600; font-size: 12px;
  border-bottom: 1px solid var(--line);
}
tbody tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.mono { font-size: 12.5px; }
tbody tr:hover { background: #fafbfc; }

.note { font-size: 12.5px; color: var(--muted); margin: 14px 0 0; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.row input {
  padding: 9px 12px; border-radius: 8px; border: 1px solid #ccd2db;
  font-size: 13px;
}
.row label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
.check { font-size: 13px; color: var(--muted); display: flex; gap: 6px; align-items: center; }

/* Inline text link (card shortcuts across tabs). */
.linklike {
  border: 0; background: none; padding: 0;
  color: var(--accent); font-size: inherit; font-weight: 600; cursor: pointer;
  white-space: nowrap;
}
.linklike:hover { background: none; text-decoration: underline; }

/* Small icon button (copy endpoint). */
.iconbtn { padding: 3px 9px; font-size: 13px; line-height: 1.3; border-radius: 7px; }
.keyrow {
  display: flex; gap: 10px; align-items: center; padding: 6px 0;
  font-size: 13px; border-top: 1px solid var(--line-soft);
}
.keyrow .mono { flex: 1; overflow: hidden; text-overflow: ellipsis; }
#tabs {
  position: sticky; top: 0; z-index: 5;
  display: flex; gap: 4px; flex-wrap: wrap;
  background: var(--bg); padding: 10px;
  border: 1px solid var(--line); border-radius: 12px;
}
#tabs button {
  border: 1px solid transparent; background: transparent;
  padding: 8px 16px; font-weight: 600; color: var(--muted);
}
#tabs button:hover { background: var(--accent-soft); color: var(--text); }
#tabs button.active {
  background: var(--accent); border-color: var(--accent); color: #fff;
  box-shadow: 0 2px 8px rgba(11, 98, 214, .3);
}
#tabs button.active:hover { background: #0954b5; }
#tabs button[data-tab="status"] { margin-left: auto; }

/* Tab panes stack their cards with a fixed gap (main's grid gap does not
   reach inside the pane wrapper). */
[data-pane] { display: grid; gap: 10px; align-content: start; }
[data-pane][hidden] { display: none; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.card {
  border: 1px solid var(--line-soft); border-radius: 10px; padding: 12px 14px;
  background: #fafbfc;
}
.card .k { font-size: 12px; color: var(--muted); }
.card .v { font-size: 14px; font-weight: 600; margin-top: 2px; word-break: break-all; }

select {
  padding: 9px 12px; border-radius: 8px; border: 1px solid #ccd2db;
  background: #fff; color: var(--text); font-size: 13px; max-width: 280px;
}

.entry {
  display: flex; gap: 8px; align-items: center; padding: 7px 0;
  border-top: 1px solid var(--line-soft); font-size: 13px;
}
.entry .mono { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.entry .st { font-size: 12px; color: var(--muted); min-width: 90px; text-align: right; }
.entry button { padding: 4px 10px; font-size: 12px; }

.warn { color: var(--warn); font-weight: 600; }
.bad-text { color: var(--bad); font-weight: 600; }
.ok-text { color: var(--ok); font-weight: 600; }

/* One-time migration notice. */
.banner {
  border: 1px solid var(--warn); background: var(--warn-soft); color: var(--text);
  border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 14px;
  display: flex; gap: 12px; align-items: center; justify-content: space-between;
}
/* display:flex above beats the hidden attribute's UA rule without this. */
.banner[hidden] { display: none; }
.banner button { flex: none; }

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171c; --card: #1d2128; --line: #333a44; --line-soft: #262c35;
    --text: #e8ebef; --muted: #a7b0bc; --faint: #767f8c;
    --accent: #4d94f1; --accent-soft: #1c2f4d;
    --ok: #4cc38a; --ok-soft: #173b2a;
    --warn: #e0a63c; --warn-soft: #3d2f14;
    --bad: #f26d79; --bad-soft: #431b20;
  }
  .prov-field input, .row input, select { background: #14171c; border-color: #3a424d; color: var(--text); }
  button { background: #262c35; border-color: #3a424d; color: var(--text); }
  button:hover { background: #2f3641; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #0c1116; }
  button.primary:hover { background: #6aa5f3; }
  tbody tr:hover { background: #22282f; }
  .card { background: #22282f; }
  .prov:hover { border-color: #3a424d; box-shadow: 0 4px 16px rgba(0, 0, 0, .35); }
  .iconbtn { background: #262c35; border-color: #3a424d; }
}

#toast {
  position: fixed; right: 20px; bottom: 20px; padding: 12px 16px; border-radius: 9px;
  background: var(--card); border: 1px solid var(--line); color: var(--text);
  box-shadow: 0 6px 24px rgba(20, 28, 40, .13);
  max-width: 430px; font-size: 13px;
  opacity: 0; transform: translateY(8px); transition: .18s; pointer-events: none;
}
#toast.show { opacity: 1; transform: none; }
#toast.good { border-left: 3px solid var(--ok); }
#toast.err { border-left: 3px solid var(--bad); }

@media (max-width: 760px) {
  .prov { grid-template-columns: 1fr; gap: 10px; }
  .prov-name { padding-top: 0; }
  .entry { flex-wrap: wrap; }
  .entry .mono { min-width: calc(100% - 110px); }
  #tabs button { flex: 1; }
  #tabs button[data-tab="status"] { margin-left: 0; }
  main, header { padding-left: 18px; padding-right: 18px; }
}
</style>
</head>
<body>
<header>
  <div class="head-inner">
    <h1>Free Router</h1>
    <span class="head-spacer"></span>
    <select id="lang" title="Language"></select>
  </div>
</header>
<main id="app">
  <nav id="tabs">
    <button data-tab="providers" data-i18n="tab_providers">Providers</button>
    <button data-tab="routes" data-i18n="tab_routes">Routes</button>
    <button data-tab="status" class="active" data-i18n="tab_status">Status</button>
  </nav>

  <div data-pane="status">
    <section>
      <div class="sec-head"><h2 data-i18n="overview">Overview</h2><p id="status-blurb"></p></div>
      <div class="sec-body"><div id="status-cards" class="cards"></div></div>
    </section>
    <section>
      <div class="sec-head">
        <h2 data-i18n="route_priority">Route priority</h2>
        <p id="routes-blurb"></p>
      </div>
      <div class="sec-body"><div id="routes"></div></div>
    </section>
  </div>

  <div data-pane="providers" hidden>
    <section>
      <div class="sec-head">
        <h2 data-i18n="providers_title">Provider keys</h2>
        <p class="key-instruction" data-i18n="keys_blurb">Paste one or more keys separated by commas, for example: key1,key2,key3</p>
      </div>
      <div class="sec-body">
        <div id="migrate-banner" class="banner" hidden></div>
        <div id="providers"></div>
      </div>
    </section>
  </div>

  <div data-pane="routes" hidden>
    <section>
      <div class="sec-head"><h2 data-i18n="routes_title">Routes</h2><p data-i18n="routes_blurb">Order the gateway tries models in. Entries are <span class="mono">provider:model</span> or plain model ids. Adding a model auto-allows it for price-free providers.</p></div>
      <div class="sec-body">
        <div class="row">
          <label><span data-i18n="route_label">Route</span> <select id="route-select"></select></label>
          <button id="route-new" data-i18n="route_new">New route</button>
          <button class="quiet" id="route-del" data-i18n="route_del">Delete route</button>
        </div>
        <div id="route-entries"></div>
        <div class="row">
          <input id="route-add" class="mono" data-i18n-ph="route_add_ph" placeholder="provider:model or model id" style="flex:1;min-width:200px">
          <button id="route-add-btn" data-i18n="route_add">Add</button>
          <button class="primary" id="route-save" data-i18n="route_save">Save route</button>
        </div>
        <p class="note" id="route-note"></p>
      </div>
    </section>
  </div>

</main>
<div id="toast"></div>
<script>window.FR_I18N = ${I18N_PAYLOAD};</script>
<script>
const el = (id) => document.getElementById(id);
let state = null;

// Minimal i18n runtime. The dictionary comes from i18n.mjs via
// window.FR_I18N; semantics mirror translate() there (English fallback,
// {var} interpolation). Static markup uses data-i18n / data-i18n-ph /
// data-i18n-title attributes; dynamic strings call t() directly.
const FR_LANGS = (window.FR_I18N && window.FR_I18N.langs) || [['en', 'English']];
const FR_STR = (window.FR_I18N && window.FR_I18N.strings) || { en: {} };
let lang = 'en';
try {
  lang = localStorage.getItem('fr-lang') || detectLang();
} catch (error) {
  lang = detectLang();
}
if (!FR_LANGS.some(([code]) => code === lang)) lang = 'en';

function detectLang() {
  const nav = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase();
  for (const [code] of FR_LANGS) {
    if (code.toLowerCase() === nav) return code;
  }
  if (nav === 'zh-hk' || nav === 'zh-hant' || nav === 'zh-tw') return 'zh-TW';
  if (nav.indexOf('zh') === 0) return 'zh-CN';
  const prefix = nav.split('-')[0];
  const hit = FR_LANGS.find(([code]) => code.toLowerCase() === prefix);
  return hit ? hit[0] : 'en';
}

function t(key, vars) {
  const table = FR_STR[lang] || {};
  const value = table[key] !== undefined ? table[key] : (FR_STR.en[key] !== undefined ? FR_STR.en[key] : key);
  if (!vars) return value;
  // NOTE: this script is embedded in a JS template literal, so backslashes
  // must be doubled here to arrive intact in the served page.
  return String(value).replace(/\\{(\\w+)\\}/g, (_, name) =>
    vars[name] === undefined || vars[name] === null ? '' : String(vars[name]),
  );
}

function applyI18n() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const value = t(node.dataset.i18n);
    if (/<[a-z][^>]*>/i.test(value)) node.innerHTML = value;
    else node.textContent = value;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((node) => {
    node.setAttribute('placeholder', t(node.dataset.i18nPh));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.setAttribute('title', t(node.dataset.i18nTitle));
  });
  const select = el('lang');
  if (select && !select.options.length) {
    for (const [code, label] of FR_LANGS) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = label;
      select.appendChild(option);
    }
  }
  if (select) select.value = lang;
}

function setLang(code) {
  if (!FR_LANGS.some(([entry]) => entry === code)) return;
  lang = code;
  try {
    localStorage.setItem('fr-lang', lang);
  } catch (error) {
    // Private browsing etc: language just doesn't persist.
  }
  applyI18n();
  if (state) renderAll();
}

function renderAll() {
  switchTab(activeTab);
  renderStatus();
  renderProviders();
  renderRoutes();
  renderRouteEditor();
  renderMigration();
}


function toast(message, kind) {
  const node = el('toast');
  node.textContent = message;
  node.className = 'show ' + (kind || '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = ''; }, 4600);
}

async function api(path, options) {
  const config = Object.assign({ headers: {} }, options || {});
  config.headers['X-Free-Router-UI'] = '1';
  if (config.body) config.headers['Content-Type'] = 'application/json';
  const response = await fetch(path, config);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (error) { payload = null; }
  if (!response.ok) {
    throw new Error((payload && payload.error && payload.error.message) || ('HTTP ' + response.status));
  }
  return payload;
}

function td(value, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  if (value instanceof Node) cell.appendChild(value);
  else cell.textContent = value;
  return cell;
}

function table(headers, rows) {
  const node = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) {
    const cell = document.createElement('th');
    cell.textContent = header.label;
    if (header.num) cell.className = 'num';
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  node.appendChild(head);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) tr.appendChild(cell);
    body.appendChild(tr);
  }
  node.appendChild(body);
  return node;
}

function pill(text, kind) {
  const node = document.createElement('span');
  node.className = 'pill ' + kind;
  node.textContent = text;
  return node;
}

function renderProviders() {
  const host = el('providers');
  host.textContent = '';
  for (const provider of state.providers) {
    const row = document.createElement('div');
    row.className = 'prov';

    const name = document.createElement('div');
    name.className = 'prov-name';
    name.textContent = provider.name;

    const fieldCell = document.createElement('div');
    fieldCell.className = 'prov-field';

    // Named multi-account keys (stored in the TOML/JSON config).
    const fileKeys = (provider.keys || []).filter((entry) => entry.source === 'file');
    for (const entry of fileKeys) {
      const line = document.createElement('div');
      line.className = 'keyrow';
      const label = document.createElement('span');
      label.textContent = entry.name + (entry.invalid ? ' ' + t('retired') : '');
      const masked = document.createElement('span');
      masked.className = 'mono';
      masked.textContent = entry.maskedKey;
      const del = document.createElement('button');
      del.className = 'quiet';
      del.textContent = t('del');
      del.onclick = async () => {
        if (!confirm(t('confirm_del_key', { k: entry.name, p: provider.name }))) return;
        del.disabled = true;
        try {
          await api('api/keys', {
            method: 'POST',
            body: JSON.stringify({ provider: provider.name, name: entry.name, key: '' }),
          });
          toast(t('deleted_key', { n: entry.name }), 'good');
          await load();
        } catch (error) {
          toast(String(error.message || error), 'err');
          del.disabled = false;
        }
      };
      line.appendChild(label);
      line.appendChild(masked);
      line.appendChild(del);
      fieldCell.appendChild(line);
    }

    const addRow = document.createElement('div');
    addRow.className = 'row';
    const keyField = document.createElement('input');
    keyField.type = 'password';
    keyField.autocomplete = 'off';
    keyField.spellcheck = false;
    keyField.placeholder = fileKeys.length ? t('prov_paste_more') : t('prov_paste_first', { env: provider.keyEnv });
    keyField.style.flex = '1';
    const add = document.createElement('button');
    add.className = 'primary';
    add.textContent = fileKeys.length ? t('prov_add') : t('prov_save');
    add.onclick = async () => {
      const values = [...new Set(keyField.value.split(',').map((value) => value.trim()).filter(Boolean))];
      const names = new Set((provider.keys || []).map((entry) => entry.name));
      if (!values.length) { toast(t('prov_empty'), 'err'); return; }
      add.disabled = true;
      try {
        const labels = [];
        for (const value of values) {
          let next = 1;
          while (names.has('key-' + next)) next += 1;
          const label = 'key-' + next;
          await api('api/keys', {
            method: 'POST',
            body: JSON.stringify({ provider: provider.name, name: label, key: value }),
          });
          names.add(label);
          labels.push(label);
        }
        toast(t('prov_saved', { n: labels.join(', '), p: provider.name }), 'good');
        await load();
      } catch (error) {
        toast(String(error.message || error), 'err');
        add.disabled = false;
      }
    };
    addRow.appendChild(keyField);
    addRow.appendChild(add);
    fieldCell.appendChild(addRow);

    const hint = document.createElement('div');
    hint.className = 'prov-hint';
    const envKeys = (provider.keys || []).filter((entry) => entry.source === 'env');
    if (!provider.configured) {
      hint.textContent = t('prov_notset');
    } else if (envKeys.length) {
      hint.textContent = t('prov_env', { m: envKeys.map((entry) => entry.maskedKey).join(', ') });
    } else {
      hint.textContent = t('prov_rot', { n: provider.keyCount });
    }
    if (provider.catalogError && !provider.catalogModels) {
      hint.appendChild(document.createTextNode('  '));
      hint.appendChild(pill(t('catalog_down'), 'bad'));
    }
    fieldCell.appendChild(hint);

    if (provider.unavailableModels && provider.unavailableModels.length) {
      const gone = document.createElement('div');
      gone.className = 'prov-hint';
      gone.appendChild(pill(t('withdrawn'), 'warn'));
      gone.appendChild(document.createTextNode(' ' + t('withdrawn_models') + ' '));
      const ids = document.createElement('span');
      ids.className = 'mono';
      ids.textContent = provider.unavailableModels.join(', ');
      gone.appendChild(ids);
      fieldCell.appendChild(gone);
    }

    row.appendChild(name);
    row.appendChild(fieldCell);
    host.appendChild(row);
  }
}

let activeTab = 'status';
let draftRoute = '';
let draftEntries = [];

function switchTab(name) {
  activeTab = name;
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('active', button.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll('[data-pane]')) {
    pane.hidden = pane.dataset.pane !== name;
  }
}

function card(host, key, value, cls) {
  const node = document.createElement('div');
  node.className = 'card';
  const k = document.createElement('div');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'v' + (cls ? ' ' + cls : '');
  if (value instanceof Node) v.appendChild(value);
  else v.textContent = value;
  node.appendChild(k);
  node.appendChild(v);
  host.appendChild(node);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (ignored) {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function gotoLink(label, tab) {
  const link = document.createElement('button');
  link.className = 'linklike';
  link.textContent = label;
  link.onclick = () => switchTab(tab);
  return link;
}

function renderStatus() {
  const host = el('status-cards');
  host.textContent = '';
  const endpointWrap = document.createElement('span');
  const endpointText = document.createElement('span');
  endpointText.className = 'mono';
  endpointText.textContent = state.endpoint + ' ';
  const copy = document.createElement('button');
  copy.className = 'iconbtn';
  copy.textContent = '⧉';
  copy.title = t('copy_title');
  copy.onclick = async () => {
    const ok = await copyText(state.endpoint);
    toast(ok ? t('copied_msg') : state.endpoint, ok ? 'good' : 'err');
  };
  endpointWrap.appendChild(endpointText);
  endpointWrap.appendChild(copy);
  card(host, t('card_endpoint'), endpointWrap);
  const noKey = state.providers.filter((entry) => !entry.configured).map((entry) => entry.name);
  const noKeyValue = document.createElement('span');
  if (!noKey.length) {
    noKeyValue.textContent = t('nokey_all');
  } else {
    noKeyValue.textContent = noKey.join(', ') + ' ';
    noKeyValue.appendChild(gotoLink(t('goto_providers'), 'providers'));
  }
  card(host, t('card_nokey'), noKeyValue, noKey.length ? 'warn' : 'ok-text');
  el('status-blurb').textContent = t('status_blurb');
}

function routeStatusFor(routeName, modelString) {
  const entries = (state.allRoutes && state.allRoutes[routeName]) || [];
  return entries.find((entry) => entry.provider + ':' + (entry.id || '') === modelString) || null;
}

function renderRouteEditor() {
  const select = el('route-select');
  const names = Object.keys(state.editable.routes || {});
  const current = names.includes(draftRoute) ? draftRoute : (state.route || names[0]);
  select.textContent = '';
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name + (name === state.route ? t('route_disc_suffix') : '');
    select.appendChild(option);
  }
  select.value = current;
  if (draftRoute !== current) {
    draftRoute = current;
    draftEntries = [...(state.editable.routes[current] || [])];
  }
  const live = (state.allRoutes && state.allRoutes[current]) || [];
  const liveKeys = live.map((entry) => entry.provider + ':' + entry.id);
  const viewingLive = !draftEntries.length && liveKeys.length;
  const rows = viewingLive ? liveKeys : draftEntries;
  const host = el('route-entries');
  host.textContent = '';
  if (viewingLive) {
    const heading = document.createElement('p');
    heading.className = 'note';
    heading.textContent = t('route_from_discovery');
    host.appendChild(heading);
  }
  const adoptLive = () => {
    if (draftEntries.length) return;
    draftEntries = [...liveKeys];
  };
  rows.forEach((modelString, index) => {
    const line = document.createElement('div');
    line.className = 'entry';
    const num = document.createElement('span');
    num.className = 'st';
    num.textContent = '#' + (index + 1);
    const id = document.createElement('span');
    id.className = 'mono';
    id.textContent = modelString;
    const st = document.createElement('span');
    st.className = 'st';
    const status = routeStatusFor(current, modelString);
    if (!status) st.textContent = t('st_unsaved');
    else if (!status.providerConfigured) st.textContent = t('st_nokey');
    else if (status.zeroCost === false) st.textContent = t('st_paid');
    else if (status.cooldownSeconds > 0) st.textContent = t('st_cooldown', { n: status.cooldownSeconds });
    else st.textContent = t('st_ready');
    const up = document.createElement('button');
    up.textContent = '↑';
    up.disabled = index === 0;
    up.onclick = () => {
      adoptLive();
      draftEntries.splice(index - 1, 0, draftEntries.splice(index, 1)[0]);
      renderRouteEditor();
    };
    const down = document.createElement('button');
    down.textContent = '↓';
    down.disabled = index === rows.length - 1;
    down.onclick = () => {
      adoptLive();
      draftEntries.splice(index + 1, 0, draftEntries.splice(index, 1)[0]);
      renderRouteEditor();
    };
    const rm = document.createElement('button');
    rm.className = 'quiet';
    rm.textContent = '×';
    rm.onclick = () => {
      adoptLive();
      draftEntries.splice(index, 1);
      renderRouteEditor();
    };
    line.appendChild(num);
    line.appendChild(id);
    line.appendChild(st);
    line.appendChild(up);
    line.appendChild(down);
    line.appendChild(rm);
    host.appendChild(line);
  });
  if (viewingLive) {
    el('route-note').textContent = t('route_empty');
    return;
  }
  el('route-note').textContent = draftEntries.length ? t('route_unsaved_note') : t('route_empty');
}

function renderMigration() {
  const banner = el('migrate-banner');
  const summary = state.migration;
  const movedProviders = summary && summary.providers ? Object.entries(summary.providers) : [];
  if (!summary || summary.empty || !movedProviders.length) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.textContent = '';
  const text = document.createElement('span');
  text.textContent = t('mig_text', {
    p: movedProviders.map(([name, count]) => name + '×' + count).join(', '),
    g: '',
  });
  const dismiss = document.createElement('button');
  dismiss.textContent = t('mig_dismiss');
  dismiss.onclick = async () => {
    try {
      await api('api/settings', { method: 'POST', body: JSON.stringify({ dismissMigrationNotice: true }) });
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  banner.appendChild(text);
  banner.appendChild(dismiss);
}

function bindOnce() {
  if (bindOnce.done) return;
  bindOnce.done = true;
  for (const button of document.querySelectorAll('#tabs button')) {
    button.onclick = () => switchTab(button.dataset.tab);
  }
  el('lang').onchange = () => setLang(el('lang').value);
  el('route-select').onchange = () => {
    draftRoute = el('route-select').value;
    draftEntries = [...(state.editable.routes[draftRoute] || [])];
    renderRouteEditor();
  };
  el('route-add-btn').onclick = () => {
    const value = el('route-add').value.trim();
    if (!value) return;
    const live = (state.allRoutes && state.allRoutes[draftRoute]) || [];
    const displayed = draftEntries.length
      ? draftEntries
      : live.map((entry) => entry.provider + ':' + entry.id);
    if (displayed.includes(value)) { toast(t('route_in_list'), 'err'); return; }
    if (!draftEntries.length) draftEntries = [...displayed];
    draftEntries.push(value);
    el('route-add').value = '';
    renderRouteEditor();
  };
  el('route-save').onclick = async () => {
    try {
      const result = await api('api/routes', {
        method: 'POST',
        body: JSON.stringify({ action: 'save', route: draftRoute, models: draftEntries }),
      });
      if ((result.notes || []).length) toast(result.notes.join(' '), 'good');
      toast(t('route_saved', { r: draftRoute, n: result.count }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('route-new').onclick = async () => {
    const name = prompt(t('route_new_prompt'), 'my-route');
    if (!name) return;
    try {
      await api('api/routes', { method: 'POST', body: JSON.stringify({ action: 'save', route: name.trim(), models: [] }) });
      draftRoute = name.trim();
      draftEntries = [];
      toast(t('route_created', { r: draftRoute }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('route-del').onclick = async () => {
    if (!confirm(t('route_confirm_del', { r: draftRoute }))) return;
    try {
      await api('api/routes', { method: 'POST', body: JSON.stringify({ action: 'delete', route: draftRoute }) });
      draftRoute = '';
      draftEntries = [];
      toast(t('route_deleted'), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
}

async function load() {
  try {
    state = await api('api/state');
  } catch (error) {
    toast(String(error.message || error), 'err');
    return;
  }
  bindOnce();
  applyI18n();
  renderAll();
}

function renderRoutes() {
  const host = el('routes');
  host.textContent = '';
  el('routes-blurb').innerHTML = t('routes_blurb');
  const rows = state.routes.map((entry) => {
    let status = t('st_ready');
    let kind = 'ok';
    if (!entry.providerConfigured) { status = t('st_nokey'); kind = 'no'; }
    else if (entry.zeroCost === false) { status = t('st_paid'); kind = 'bad'; }
    else if (entry.cooldownSeconds > 0) { status = t('st_cooldown', { n: entry.cooldownSeconds }); kind = 'warn'; }
    const used = entry.usage ? entry.usage.today.consumed : 0;
    return [
      td(String(entry.priority), 'num'),
      td(pill(status, kind)),
      td(entry.provider, 'muted'),
      td(entry.model + (entry.pinned ? '  *' : ''), 'mono'),
      td(entry.pinned ? '*' : (Number.isFinite(entry.score) && entry.score >= 0 ? String(entry.score) : '—'), 'num'),
      td(used || '-', 'num'),
    ];
  });
  host.appendChild(table(
    [
      { label: t('th_num'), num: true },
      { label: t('th_status') },
      { label: t('th_provider') },
      { label: t('th_model') },
      { label: 'SWE', num: true },
      { label: t('th_used'), num: true },
    ],
    rows,
  ));
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = t('pinned_note');
  host.appendChild(note);

  if (state.unavailableModels && state.unavailableModels.length) {
    const gone = document.createElement('p');
    gone.className = 'note';
    gone.appendChild(pill(t('withdrawn'), 'warn'));
    gone.appendChild(document.createTextNode(' ' + t('withdrawn_note') + ' '));
    const ids = document.createElement('span');
    ids.className = 'mono';
    ids.textContent = state.unavailableModels.join(', ');
    gone.appendChild(ids);
    host.appendChild(gone);
  }

  for (const entry of state.excludedByProvider || []) {
    const line = document.createElement('p');
    line.className = 'note';
    line.appendChild(pill(t('notfree_badge'), 'bad'));
    line.appendChild(document.createTextNode(' '));
    const id = document.createElement('span');
    id.className = 'mono';
    id.textContent = entry.key;
    line.appendChild(id);
    line.appendChild(document.createTextNode(' ' + t('notfree_mid') + ' ' + entry.reason + t('notfree_end')));
    host.appendChild(line);
  }
}

bindOnce();
load().catch((error) => toast(String(error.message || error), 'err'));
</script>
</body>
</html>
`;

export function renderPage() {
  return PAGE;
}
