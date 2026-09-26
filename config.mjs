import fs from 'node:fs';
import path from 'node:path';

// Minimal TOML subset: top-level scalars, arrays, inline tables,
// [section], [a.b.c], [[array-of-tables]]. Enough for config.toml.
// Anything fancier (multiline strings, dates, hex) is out of scope.

function stripComment(line) {
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw) {
  const text = raw.trim();
  if (!text) throw new Error('empty value');
  if (text === 'true') return true;
  if (text === 'false') return false;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const quote = text[0];
    let out = '';
    const body = text.slice(1, -1);
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (quote === '"' && ch === '\\' && i + 1 < body.length) {
        const next = body[i + 1];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else out += next;
        i += 1;
        continue;
      }
      out += ch;
    }
    return out;
  }
  if (/^[+-]?\d+$/.test(text)) return Number(text);
  if (/^[+-]?(\d+\.\d*|\d*\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('{') && text.endsWith('}')) return parseInlineTable(text);
  if (text.startsWith('[') && text.endsWith(']')) return parseArray(text);
  throw new Error(`unsupported value: ${raw}`);
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      current += ch;
      if (ch === '\\' && i + 1 < body.length) {
        current += body[i + 1];
        i += 1;
        continue;
      }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function parseArray(raw) {
  const body = raw.slice(1, -1).trim();
  if (!body) return [];
  return splitTopLevel(body).map((part) => parseScalar(part.trim()));
}

function parseInlineTable(raw) {
  const body = raw.slice(1, -1).trim();
  const obj = {};
  if (!body) return obj;
  for (const part of splitTopLevel(body)) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new Error(`bad inline table entry: ${part}`);
    const key = part.slice(0, eq).trim().replace(/^(["'])(.*)\1$/, '$2');
    obj[key] = parseScalar(part.slice(eq + 1).trim());
  }
  return obj;
}

export function parseToml(text) {
  const root = {};
  let current = root;
  // Join logical lines: arrays / inline tables may span multiple lines.
  const physical = String(text || '').split(/\r?\n/);
  const lines = [];
  let pending = '';
  let depth = 0;
  let inStr = false;
  let strCh = '';
  const scan = (segment) => {
    for (let i = 0; i < segment.length; i += 1) {
      const ch = segment[i];
      if (inStr) {
        if (ch === '\\') {
          i += 1;
          continue;
        }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        strCh = ch;
        continue;
      }
      if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') depth -= 1;
    }
  };
  for (const rawLine of physical) {
    const noComment = pending ? rawLine : stripComment(rawLine);
    pending = pending ? `${pending}\n${noComment}` : noComment;
    // recompute depth over the whole pending buffer
    depth = 0;
    inStr = false;
    strCh = '';
    scan(pending);
    if (depth <= 0 && !inStr) {
      lines.push(pending);
      pending = '';
    }
  }
  if (pending.trim()) lines.push(pending);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const cleaned = stripComment(lines[lineNo]).trim();
    if (!cleaned) continue;
    const arrayTable = cleaned.match(/^\[\[([^\]]+)\]\]$/);
    const table = cleaned.match(/^\[([^\]]+)\]$/);
    if (arrayTable) {
      const segments = arrayTable[1].trim().split('.').map((s) => s.trim()).filter(Boolean);
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const seg = segments[i];
        if (Array.isArray(node[seg])) node = node[seg][node[seg].length - 1];
        else {
          node[seg] ||= {};
          node = node[seg];
        }
      }
      const last = segments[segments.length - 1];
      node[last] ||= [];
      if (!Array.isArray(node[last])) throw new Error(`TOML line ${lineNo + 1}: ${last} is not an array table`);
      const entry = {};
      node[last].push(entry);
      current = entry;
      continue;
    }
    if (table) {
      const segments = table[1].trim().split('.').map((s) => s.trim()).filter(Boolean);
      let node = root;
      for (const seg of segments) {
        if (Array.isArray(node[seg])) node = node[seg][node[seg].length - 1];
        else {
          node[seg] ||= {};
          node = node[seg];
        }
      }
      current = node;
      continue;
    }
    const eq = cleaned.indexOf('=');
    if (eq < 0) throw new Error(`TOML line ${lineNo + 1}: expected key = value`);
    const key = cleaned.slice(0, eq).trim().replace(/^(["'])(.*)\1$/, '$2');
    current[key] = parseScalar(cleaned.slice(eq + 1).trim());
  }
  return root;
}

function tomlString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlSectionPath(prefix, key) {
  const raw = `${prefix}${key}`;
  return raw
    .split('.')
    .map((seg) => (/^[A-Za-z0-9_-]+$/.test(seg) ? seg : `"${seg.replace(/"/g, '\\"')}"`))
    .join('.');
}

function isScalar(value) {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  );
}

function tomlValue(value) {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((entry) => typeof entry === 'string')) {
      return `[${value.map(tomlString).join(', ')}]`;
    }
    if (value.every((entry) => typeof entry === 'number' || typeof entry === 'boolean')) {
      return `[${value.join(', ')}]`;
    }
    if (value.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
      const items = value.map((entry) => {
        const fields = Object.entries(entry).map(([key, val]) => `${tomlKey(key)} = ${tomlValue(val)}`);
        return `{ ${fields.join(', ')} }`;
      });
      return `[\n  ${items.join(',\n  ')},\n]`;
    }
    return JSON.stringify(value);
  }
  if (value && typeof value === 'object') {
    const fields = Object.entries(value).map(([key, val]) => `${tomlKey(key)} = ${tomlValue(val)}`);
    return `{ ${fields.join(', ')} }`;
  }
  return '""';
}

export function stringifyToml(config) {
  const lines = ['# free-router configuration (TOML). Keys with secrets: keep this file at 0600.', ''];
  const scalars = {};
  const tables = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (isScalar(value) || (Array.isArray(value) && value.every(isScalar))) scalars[key] = value;
    else tables[key] = value;
  }
  for (const [key, value] of Object.entries(scalars)) {
    if (value === undefined) continue;
    lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
  }
  if (Object.keys(scalars).length && Object.keys(tables).length) lines.push('');

  const emit = (obj, prefix) => {
    const subScalars = {};
    const subTables = {};
    const subArrays = {};
    for (const [key, value] of Object.entries(obj || {})) {
      if (Array.isArray(value) && value.length && value.every((e) => e && typeof e === 'object' && !Array.isArray(e))) {
        subArrays[key] = value;
      } else if (value && typeof value === 'object' && !Array.isArray(value)) subTables[key] = value;
      else subScalars[key] = value;
    }
    for (const [key, value] of Object.entries(subScalars)) {
      if (value === undefined) continue;
      const name = tomlKey(key);
      if (Array.isArray(value) && !value.length) {
        lines.push(`${name} = []`);
        continue;
      }
      if (Array.isArray(value) && value.length > 6) {
        lines.push(`${name} = [`);
        for (const entry of value) lines.push(`  ${tomlValue(entry)},`);
        lines.push(']');
        continue;
      }
      lines.push(`${name} = ${tomlValue(value)}`);
    }
    for (const [key, value] of Object.entries(subTables)) {
      lines.push('');
      lines.push(`[${tomlSectionPath(prefix, key)}]`);
      emit(value, `${prefix}${key}.`);
    }
    for (const [key, value] of Object.entries(subArrays)) {
      for (const entry of value) {
        lines.push('');
        lines.push(`[[${tomlSectionPath(prefix, key)}]]`);
        emit(entry, `${prefix}${key}.`);
      }
    }
  };

  for (const [key, value] of Object.entries(tables)) {
    lines.push(`[${tomlSectionPath('', key)}]`);
    emit(value, `${key}.`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function defaultConfigPath(here) {
  return path.join(here, 'config.json');
}

// The user layer. config.json (tracked) holds defaults; this file
// (gitignored) holds everything the operator changed. The server merges
// them at boot and persists only this file.
export const OVERLAY_FILENAME = 'config.local.json';

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// Deep merge for the boot-time view: plain objects recurse, everything else
// (scalars, arrays) comes from the overlay when present, else the base.
// Base-only branches are cloned so runtime code can never mutate the base
// objects in memory; overlay branches are shared by reference so targeted
// writes land in the overlay object that gets persisted.
export function deepMerge(base, over) {
  if (over === undefined) return cloneValue(base);
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const merged = {};
  for (const [key, value] of Object.entries(base)) {
    merged[key] = Object.prototype.hasOwnProperty.call(over, key)
      ? deepMerge(value, over[key])
      : cloneValue(value);
  }
  for (const [key, value] of Object.entries(over)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) merged[key] = value;
  }
  return merged;
}

// Additive-only merge for schema updates: copies keys missing in `target`
// from `defaults`, never overwrites or deletes what the operator set.
// This is what keeps structural updates non-destructive.
export function addMissingKeys(target, defaults) {
  if (!isPlainObject(defaults)) return false;
  if (!isPlainObject(target)) return false;
  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = cloneValue(value);
      changed = true;
    } else if (isPlainObject(target[key]) && isPlainObject(value)) {
      changed = addMissingKeys(target[key], value) || changed;
    }
  }
  return changed;
}

// Schema version of the overlay file. Bump when new structural fields are
// introduced and append a migration step that adds ONLY the new skeleton
// (addMissingKeys semantics: user values are never touched).
export const SCHEMA_VERSION = 1;
const OVERLAY_MIGRATIONS = [
  // v1: baseline marker. The live code tolerates absent sections, so the
  // first version needs no structural backfill.
];

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]*$/;

// Route entries used to be bare OpenRouter ids (`poolside/laguna-s-2.1:free`).
// Discovery, the web UI, and older overlays still emit that form. Canonical
// storage is always `{ provider, model }`; a `provider:` prefix wins when the
// prefix is a known provider id, otherwise the string belongs to defaultProvider.
export function canonicalizeRouteEntry(entry, defaultProvider = 'openrouter', knownProviders = null) {
  const fallback = String(defaultProvider || 'openrouter');
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const provider = String(entry.provider || fallback).trim() || fallback;
    const model = String(entry.model || entry.id || '').trim();
    return model ? { provider, model } : null;
  }
  const text = String(entry || '').trim();
  if (!text) return null;
  const separator = text.indexOf(':');
  if (separator > 0) {
    const prefix = text.slice(0, separator);
    const model = text.slice(separator + 1).trim();
    const known = !knownProviders || knownProviders.has(prefix);
    if (PROVIDER_ID_RE.test(prefix) && known) {
      return model ? { provider: prefix, model } : null;
    }
  }
  return { provider: fallback, model: text };
}

function canonicalizeRouteList(entries, defaultProvider, knownProviders) {
  if (!Array.isArray(entries)) return { list: entries, changed: false };
  let changed = false;
  const list = [];
  for (const entry of entries) {
    const canonical = canonicalizeRouteEntry(entry, defaultProvider, knownProviders);
    if (!canonical) {
      changed = true;
      continue;
    }
    if (
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      String(entry.provider || '') !== canonical.provider ||
      String(entry.model || entry.id || '') !== canonical.model
    ) {
      changed = true;
    }
    list.push(canonical);
  }
  return { list, changed };
}

export function canonicalizeOverlayRoutes(overlay) {
  if (!isPlainObject(overlay) || !isPlainObject(overlay.routes)) return false;
  const defaultProvider = String(overlay.defaultProvider || 'openrouter');
  let changed = false;
  for (const [name, entries] of Object.entries(overlay.routes)) {
    const { list, changed: routeChanged } = canonicalizeRouteList(entries, defaultProvider, null);
    if (!routeChanged) continue;
    overlay.routes[name] = list;
    changed = true;
  }
  return changed;
}

export function runOverlayMigrations(overlay) {
  if (!isPlainObject(overlay)) return false;
  let changed = false;
  const current = Number(overlay._schemaVersion || 0);
  for (const step of OVERLAY_MIGRATIONS) {
    if (step.version <= current) continue;
    if (step.addDefaults) changed = addMissingKeys(overlay, step.addDefaults) || changed;
  }
  if (current !== SCHEMA_VERSION) {
    overlay._schemaVersion = SCHEMA_VERSION;
    changed = true;
  }
  if (canonicalizeOverlayRoutes(overlay)) changed = true;
  if (isPlainObject(overlay.discovery) && Object.prototype.hasOwnProperty.call(overlay.discovery, 'provider')) {
    delete overlay.discovery.provider;
    changed = true;
  }
  return changed;
}

export function resolveConfigPaths(here, customPath) {
  const basePath = customPath || path.join(here, 'config.json');
  return { basePath, overlayPath: path.join(path.dirname(basePath), OVERLAY_FILENAME) };
}

// Reads the overlay file; missing or corrupt files behave as an empty
// overlay (the returned error lets the caller log it once).
export function loadOverlayFile(overlayPath) {
  try {
    if (!fs.existsSync(overlayPath)) return { overlay: {}, error: '' };
    const raw = fs.readFileSync(overlayPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { overlay: {}, error: 'overlay is not an object' };
    return { overlay: parsed, error: '' };
  } catch (error) {
    return { overlay: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

export function saveOverlayFile(overlayPath, overlay) {
  try {
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  } catch {
    // The directory normally exists; a failure surfaces on write below.
  }
  saveConfigFile(overlayPath, overlay);
}

// Builds the live view: base defaults + overlay, minus anything the
// operator deleted (tombstones in overlay._removedRoutes/_removedProviders
// keep deletions sticky across restarts, since the base file still lists them).
export function buildLiveConfig(base, overlay) {
  const merged = deepMerge(base || {}, overlay || {});
  if (!isPlainObject(merged)) return {};
  const removedRoutes = overlay?._removedRoutes;
  if (Array.isArray(removedRoutes) && isPlainObject(merged.routes)) {
    for (const name of removedRoutes) delete merged.routes[String(name)];
  }
  const removedProviders = overlay?._removedProviders;
  if (Array.isArray(removedProviders) && isPlainObject(merged.providers)) {
    for (const name of removedProviders) delete merged.providers[String(name)];
  }
  if (isPlainObject(merged.routes)) {
    const defaultProvider = String(merged.defaultProvider || 'openrouter');
    const known = new Set(Object.keys(merged.providers || {}));
    if (defaultProvider) known.add(defaultProvider);
    for (const [name, entries] of Object.entries(merged.routes)) {
      const { list, changed } = canonicalizeRouteList(entries, defaultProvider, known);
      if (changed) merged.routes[name] = list;
    }
  }
  return merged;
}

export function loadConfigFile(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return { config: parseToml(raw), format: 'toml' };
  return { config: JSON.parse(raw), format: 'json' };
}

// Minimal boot config: shipped so a fresh checkout starts with zero manual
// edits (no keys -> providers are skipped until keys are added in the UI).
export function defaultConfigObject() {
  return {
    host: '127.0.0.1',
    port: 8787,
    attemptTimeoutMs: 180000,
    catalogRefreshMs: 900000,
    redactSecrets: true,
    socksFirstHosts: ['generativelanguage.googleapis.com'],
    defaultProvider: 'openrouter',
    providers: {
      gemini: {
        catalog: true,
        pricing: false,
        probeFreeTier: true,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
        modelsKeyHeader: 'x-goog-api-key',
        keyEnv: 'GEMINI_API_KEY',
        freeModels: [],
        keys: [],
      },
      openrouter: {
        catalog: true,
        pricing: true,
        baseUrl: 'https://openrouter.ai/api/v1',
        keyEnv: 'OPENROUTER_API_KEY',
        headers: {
          'HTTP-Referer': { env: 'OPENROUTER_HTTP_REFERER', default: '${origin}' },
          'X-Title': { env: 'OPENROUTER_APP_NAME', default: 'Free Router' },
        },
        keys: [],
      },
      tokenrouter: {
        catalog: true,
        pricing: false,
        probeFreeTier: true,
        baseUrl: 'https://api.tokenrouter.com/v1',
        keyEnv: 'TOKENROUTER_API_KEY',
        freeModels: [],
        keys: [],
      },
      bai: {
        catalog: true,
        pricing: false,
        probeFreeTier: true,
        baseUrl: 'https://api.b.ai/v1',
        keyEnv: 'BAI_API_KEY',
        freeModels: [],
        keys: [],
      },
      hashneuron: {
        catalog: true,
        pricing: false,
        probeFreeTier: true,
        baseUrl: 'https://hashneuron.space/v1',
        keyEnv: 'HASHNEURON_API_KEY',
        freeModels: [],
        keys: [],
      },
    },
    discovery: {
      enabled: true,
      intervalMs: 7200000,
      route: 'free-best',
      stateFile: 'discovered-free-models.json',
      exclude: {
        modelPatterns: [
          '[-_]tts(?:$|[-_])',
          '[-_]image(?:$|[-_])',
          '(?:^|[:/])nano-banana',
          '(?:^|[:/])lyria',
          '[-_]transcribe(?:$|[-_])',
          'robotics',
          'computer-use',
          'deep-research',
          '(?:^|[:/])antigravity',
          '[-_]latest$',
        ],
        textPatterns: [
          "\\b(finance|financial|investment|medicine|medical|healthcare|health|clinical|biomedical|pharmaceutical|legal|accounting|tax)[\\s-]*(focused|specific|specialized|specialised|domain)\\b",
          '\\bdomain-(specific|specialized|specialised)\\b',
        ],
      },
      evaluation: {
        enabled: true,
        maxTokens: 4000,
        maxPerRun: 8,
        pinnedModels: [],
      },
    },
    usage: {
      retentionDays: 7,
      timezone: 'America/Los_Angeles',
      dailyLimits: {
        'gemini:gemini-3.8-flash': 20,
        'gemini:gemini-3.7-flash': 20,
        'gemini:gemini-3.5-flash-lite': 200,
        'gemini:gemini-3.1-flash-lite': 200,
      },
    },
    cooldownMs: {
      rateLimit: 600000,
      timeout: 300000,
      serverError: 120000,
      empty: 300000,
      notFound: 3600000,
      forbidden: 3600000,
    },
    routes: {
      'free-best': [],
    },
    webui: { enabled: true, envFile: '.env' },
  };
}

// If no config file exists yet, write the defaults so the server boots with
// zero manual edits; everything else is then configured in the web UI.
export function ensureConfigFile(configPath) {
  try {
    if (fs.existsSync(configPath)) return false;
  } catch {
    return false;
  }
  saveConfigFile(configPath, defaultConfigObject());
  return true;
}

export function saveConfigFile(configPath, config) {
  const body = configPath.endsWith('.toml') ? stringifyToml(config) : `${JSON.stringify(config, null, 2)}\n`;
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, body, { mode: 0o600 });
  fs.renameSync(temporaryPath, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // ignore
  }
}

// Provider multi-key normalization. TOML shape:
//   [providers.gemini]
//   keyEnv = "GEMINI_API_KEY"
//   [[providers.gemini.keys]]
//   name = "main"
//   key = "sk-..."
// Env fallback: <KEYENV> (single) and <KEYENV>S / <KEYENV>_KEYS (comma separated).
export function providerKeysFromConfig(providerName, providerConfig) {
  const cfg = providerConfig && typeof providerConfig === 'object' ? providerConfig : {};
  const keyEnv = cfg.keyEnv || `${String(providerName).replace(/-/g, '_').toUpperCase()}_API_KEY`;
  const rawFileKeys = Array.isArray(cfg.keys)
    ? cfg.keys
    : typeof cfg.keys === 'string' || (cfg.keys && typeof cfg.keys === 'object')
      ? [cfg.keys]
      : [];
  const fromFile = rawFileKeys
    .map((entry, index) => {
      if (typeof entry === 'string') {
        return { name: `key-${index + 1}`, key: entry.trim(), source: 'file' };
      }
      if (entry && typeof entry === 'object') {
        return {
          name: String(entry.name || `key-${index + 1}`).trim(),
          key: String(entry.key || '').trim(),
          source: 'file',
        };
      }
      return null;
    })
    .filter((entry) => entry?.key);
  const envKeys = [];
  const single = String(process.env[keyEnv] || '').trim();
  if (single) envKeys.push({ name: 'env', key: single, source: 'env', keyEnv });
  for (const plural of [`${keyEnv}S`, `${keyEnv}_KEYS`]) {
    const raw = process.env[plural] || '';
    if (!raw) continue;
    raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((key, index) => {
      envKeys.push({ name: `${plural.toLowerCase()}[${index}]`, key, source: 'env', keyEnv: plural });
    });
  }
  const seen = new Set();
  const merged = [];
  for (const entry of [...fromFile, ...envKeys]) {
    if (!entry.key || seen.has(entry.key)) continue;
    seen.add(entry.key);
    merged.push(entry);
  }
  return { keyEnv, keys: merged };
}
