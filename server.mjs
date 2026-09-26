#!/usr/bin/env node

import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLiveConfig,
  canonicalizeRouteEntry,
  defaultConfigPath,
  ensureConfigFile,
  isPlainObject,
  loadConfigFile,
  loadOverlayFile,
  OVERLAY_FILENAME,
  resolveConfigPaths,
  runOverlayMigrations,
  saveOverlayFile,
} from './config.mjs';
import {
  createProviderRegistry,
  isChatModel,
  isMarkedFree,
  isZeroCost,
  normalizeModelSlug,
  supportsRequest,
} from './providers.mjs';
import { installUpstreamProxy } from './proxy.mjs';
import {
  msUntilQuotaReset,
  parseQuotaFailure,
  permanentRejection,
  zeroBalanceRejection,
} from './quota.mjs';
import { createSecretRedactor } from './redact.mjs';
import {
  createStreamSignatureExtractor,
  createThoughtSignatureCache,
  injectThoughtSignatures,
  isMissingThoughtSignatureError,
  providerNeedsThoughtSignatures,
  rememberSignaturesFromPayload,
} from './thought-signature.mjs';
import { displayPath, maskSecret, renderPage, updateEnvFile, validateSecret } from './ui.mjs';
import { loadSweBenchScores, sweBenchScoreFor } from './swe-bench.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value || process.env[match[1]]) continue;
    process.env[match[1]] = value;
  }
}

const envCandidates = [
  path.join(HERE, '.env'),
  path.join(os.homedir(), '.hermes', '.env'),
];
for (const file of envCandidates) {
  if (file) loadEnvFile(file);
}

const CONFIG_PATH = process.env.FREE_ROUTER_CONFIG || defaultConfigPath(HERE);
const { overlayPath: OVERLAY_PATH } = resolveConfigPaths(HERE, process.env.FREE_ROUTER_CONFIG);
try {
  // Docker creates a directory for a volume-mounted file that does not exist
  // on the host yet; replace it with a real default config instead of
  // crashing on read.
  if (fs.existsSync(CONFIG_PATH) && fs.statSync(CONFIG_PATH).isDirectory()) {
    fs.rmSync(CONFIG_PATH, { recursive: true, force: true });
  }
} catch {
  // Fall through to the normal load path, which reports the problem.
}
if (ensureConfigFile(CONFIG_PATH)) {
  console.log(`[${new Date().toISOString()}] wrote default config to ${CONFIG_PATH}; set keys in the web UI`);
}
// Layered config: config.json (tracked defaults) + config.local.json
// (gitignored operator overlay). The live view merges both; only the
// overlay file is ever written back, so the base stays merge-clean.
const { config: baseConfig, format: CONFIG_FORMAT } = loadConfigFile(CONFIG_PATH);
const overlayLoaded = loadOverlayFile(OVERLAY_PATH);
let overlay = overlayLoaded.overlay;
if (overlayLoaded.error) {
  log(`ignoring unreadable overlay ${displayPath(OVERLAY_PATH)}: ${overlayLoaded.error}`);
}
if (runOverlayMigrations(overlay)) persistOverlayFile();
const config = buildLiveConfig(baseConfig, overlay);
// Live-view-only normalization (memory, never persisted): the overlay file
// stays sparse until a real mutation lands through the helpers below.
if (!isPlainObject(config.webui)) config.webui = {};
// Write helpers below always target the overlay object, so a base-owned
// subtree is materialized there on first write (copy-on-write) and the base
// file is never touched at runtime.
function overlayParent(path) {
  let overlayNode = overlay;
  let liveNode = config;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(overlayNode[key])) overlayNode[key] = {};
    if (!isPlainObject(liveNode[key])) liveNode[key] = {};
    overlayNode = overlayNode[key];
    liveNode = liveNode[key];
  }
  return [overlayNode, liveNode];
}
function setOverlayValue(path, value) {
  const [overlayNode, liveNode] = overlayParent(path);
  const leaf = path[path.length - 1];
  overlayNode[leaf] = value;
  liveNode[leaf] = value;
}
function deleteOverlayValue(path) {
  const [overlayNode, liveNode] = overlayParent(path);
  const leaf = path[path.length - 1];
  delete overlayNode[leaf];
  delete liveNode[leaf];
}
// Provider raw blocks need whole-object ownership (nested partial updates
// like freeModels/baseUrl must not orphan sibling keys from the live view).
function editableProviderRaw(name) {
  overlay.providers ||= {};
  if (!isPlainObject(overlay.providers[name])) {
    overlay.providers[name] = structuredClone(config.providers?.[name] || {});
  }
  const raw = overlay.providers[name];
  const provider = PROVIDERS.get(name);
  if (provider) provider.configRef = raw;
  config.providers ||= {};
  config.providers[name] = raw;
  return raw;
}
function persistOverlayFile() {
  saveOverlayFile(OVERLAY_PATH, overlay);
}
function tombstone(listKey, name, present) {
  if (!Array.isArray(overlay[listKey])) overlay[listKey] = [];
  const key = String(name);
  const index = overlay[listKey].indexOf(key);
  if (present && index < 0) overlay[listKey].push(key);
  if (!present && index >= 0) overlay[listKey].splice(index, 1);
}
installUpstreamProxy(
  (message) => {
    console.log(`[${new Date().toISOString()}]`, message);
  },
  { socksFirstHosts: config.socksFirstHosts || [] },
);
const HOST = process.env.FREE_ROUTER_HOST || config.host || '127.0.0.1';
const PORT = Number(process.env.FREE_ROUTER_PORT || config.port || 8787);
let attemptTimeoutMs = Number(
  process.env.FREE_ROUTER_ATTEMPT_TIMEOUT_MS || config.attemptTimeoutMs || 180000,
);
let catalogRefreshMs = Number(config.catalogRefreshMs || 900000);
const registry = createProviderRegistry(config, { host: HOST, port: PORT });
const PROVIDERS = registry.providers;
const discoveryConfig = config.discovery || {};
let discoveryEnabled = discoveryConfig.enabled !== false;
const DISCOVERY_INTERVAL_MS = Number(discoveryConfig.intervalMs || 2 * 60 * 60 * 1000);
const DISCOVERY_ROUTE = String(discoveryConfig.route || 'free-best');
// How long a "not free" verdict stands before the model is worth asking again.
const VERDICT_RETRY_MS = Number(discoveryConfig.verdictRetryMs || DISCOVERY_INTERVAL_MS);
const DISCOVERY_STATE_PATH = path.resolve(
  path.dirname(CONFIG_PATH),
  discoveryConfig.stateFile || 'discovered-free-models.json',
);
function compilePatterns(patterns, label) {
  const compiled = [];
  for (const pattern of patterns || []) {
    try {
      compiled.push(new RegExp(String(pattern), 'i'));
    } catch (error) {
      log(`ignoring invalid ${label} pattern ${pattern}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return compiled;
}

const excludeConfig = discoveryConfig.exclude || {};
const EXCLUDE_MODEL_PATTERNS = compilePatterns(excludeConfig.modelPatterns, 'exclude.modelPatterns');
const EXCLUDE_TEXT_PATTERNS = compilePatterns(excludeConfig.textPatterns, 'exclude.textPatterns');
const evaluationConfig = discoveryConfig.evaluation || {};
let evaluationEnabled = evaluationConfig.enabled !== false;
const EVALUATION_MAX_TOKENS = Number(evaluationConfig.maxTokens || 4000);
// Bumped whenever the benchmark or its weights change, so stored scores from an
// older scale get recomputed instead of being compared against new ones.
const EVALUATION_VERSION = 2;
const EVALUATION_MAX_PER_RUN = Math.max(1, Number(evaluationConfig.maxPerRun || 8));
const PINNED_MODELS = new Set(evaluationConfig.pinnedModels || []);
const SWE_BENCH_SCORES = loadSweBenchScores(path.join(HERE, 'swe-bench.json'));
const DISCOVERY_PROBE_TIMEOUT_MS = Math.max(1000, Number(discoveryConfig.probeTimeoutMs || 12000));
const DISCOVERY_PROBE_BATCH = Math.max(1, Number(discoveryConfig.probeBatch || 8));
const usageConfig = config.usage || {};
const USAGE_RETENTION_DAYS = Math.max(1, Number(usageConfig.retentionDays || 7));
const USAGE_TIMEZONE = String(usageConfig.timezone || '');
const USAGE_DAILY_LIMITS = usageConfig.dailyLimits || {};
const USAGE_KINDS = [
  'ok',
  'rateLimit',
  'timeout',
  'serverError',
  'empty',
  'notFound',
  'forbidden',
  'aborted',
  'other',
];
// A rejected request never reaches the model, so it does not burn daily quota.
const USAGE_NON_CONSUMING = new Set(['rateLimit', 'notFound', 'forbidden']);
const USAGE_DAY_FORMATTER = (() => {
  if (!USAGE_TIMEZONE) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: USAGE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    log(`invalid usage.timezone ${USAGE_TIMEZONE}; falling back to local dates`);
    return null;
  }
})();
const uiConfig = config.webui || config.ui || {};
const UI_ENABLED = uiConfig.enabled !== false;
const UI_ENV_PATH = path.resolve(path.dirname(CONFIG_PATH), uiConfig.envFile || '.env');
let secretRedactor = config.redactSecrets === false ? null : createSecretRedactor(redactorEnv());

// The redactor snapshots secrets at build time, so keys added through the
// UI would otherwise never be stripped from upstream payloads. Overlay-stored
// provider keys are not in process.env, so merge them under synthetic names.
function redactorEnv() {
  const merged = { ...process.env };
  let index = 0;
  for (const provider of PROVIDERS.values()) {
    for (const entry of provider.apiKeys || []) {
      if (entry.key) merged[`FREE_ROUTER_TOML_${index}_API_KEY`] = entry.key;
      index += 1;
    }
  }
  return merged;
}

function refreshSecretRedactor() {
  if (config.redactSecrets === false) return;
  secretRedactor = createSecretRedactor(redactorEnv());
}

// One-time legacy migration: on the first boot with no migration record,
// import provider keys found in the .env file into the overlay so
// config.local.json becomes the single place user data lives afterwards.
// Imported vars are removed from .env (their values already live in the
// overlay); the web UI shows a notice with what was moved.
function parseEnvAssignments(text) {
  const vars = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value) vars.set(match[1], value);
  }
  return vars;
}

function migrateEnvFileOnce() {
  if (config.migratedFromEnv) return;
  let envFileExisted = false;
  let fileVars = new Map();
  try {
    envFileExisted = fs.existsSync(UI_ENV_PATH);
    if (envFileExisted) fileVars = parseEnvAssignments(fs.readFileSync(UI_ENV_PATH, 'utf8'));
  } catch {
    fileVars = new Map();
  }
  const summary = { at: new Date().toISOString(), providers: {} };
  if (fileVars.size) {
    const clearVars = {};
    for (const provider of PROVIDERS.values()) {
      const fileKeys = (provider.apiKeys || []).filter((e) => e.source === 'file').map((e) => ({ name: e.name, key: e.key }));
      const have = new Set(fileKeys.map((e) => e.key));
      const fresh = [];
      const candidates = [
        { varName: provider.keyEnv, plural: false },
        { varName: `${provider.keyEnv}S`, plural: true },
        { varName: `${provider.keyEnv}_KEYS`, plural: true },
      ];
      for (const { varName, plural } of candidates) {
        const fileValue = fileVars.get(varName);
        if (!fileValue) continue;
        // The file wins when nothing else provides the var; otherwise only
        // migrate values the file actually contributed (a real environment
        // variable wins over the file and stays untouched).
        const effective = String(process.env[varName] || '');
        const fileValues = plural
          ? fileValue.split(',').map((s) => s.trim()).filter(Boolean)
          : [fileValue.trim()];
        const effectiveValues = plural
          ? effective.split(',').map((s) => s.trim()).filter(Boolean)
          : [effective.trim()].filter(Boolean);
        const values = effectiveValues.length
          ? effectiveValues.filter((v) => fileValues.includes(v))
          : [...fileValues];
        const usable = values.filter((v) => !have.has(v));
        for (const v of usable) {
          have.add(v);
          fresh.push(v);
        }
        if (usable.length) clearVars[varName] = '';
      }
      if (fresh.length) {
        const named = fresh.map((key, i) => ({ name: `migrated-${i + 1}`, key }));
        editableProviderRaw(provider.name);
        registry.setProviderKeys(provider.name, [...fileKeys, ...named]);
        summary.providers[provider.name] = fresh.length;
      }
    }
    if (Object.keys(clearVars).length && envFileExisted) {
      try {
        updateEnvFile(UI_ENV_PATH, clearVars);
        for (const name of Object.keys(clearVars)) delete process.env[name];
        for (const provider of PROVIDERS.values()) registry.refreshKeysFromEnv(provider.name);
      } catch (error) {
        log(`env migration: could not clean ${displayPath(UI_ENV_PATH)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (Object.keys(clearVars).length) {
      // No .env file (e.g. docker env_file injects variables without one):
      // drop the migrated values from this process so TOML stays canonical.
      for (const name of Object.keys(clearVars)) delete process.env[name];
      for (const provider of PROVIDERS.values()) registry.refreshKeysFromEnv(provider.name);
    }
  }
  setOverlayValue(['migratedFromEnv'], summary);
  try {
    persistOverlayFile();
  } catch (error) {
    log(`env migration: could not persist config: ${error instanceof Error ? error.message : String(error)}`);
  }
  refreshSecretRedactor();
  const imported = Object.values(summary.providers).reduce((a, b) => a + b, 0);
  if (imported) {
    log(`migrated ${imported} provider key(s) from ${displayPath(UI_ENV_PATH)} into ${OVERLAY_FILENAME}; the overlay file is now where user data lives`);
  }
}

migrateEnvFileOnce();

const cooldowns = new Map();
const thoughtSignatures = createThoughtSignatureCache();
let discoveredModelIds = [];
let discoverySeenIds = [];
let discoveryRemovedIds = [];
let discoveryLastCheckedAt = 0;
let discoveryError = '';
let discoveryInFlight = null;
let modelEvaluations = {};
let discoveryExcludedIds = [];
let discoveryUnavailableIds = [];
// What providers told us about their own free tier, keyed by `provider:model`.
let modelVerdicts = {};
let lastSelection = null;
let usageByDay = {};
let stateSaveTimer = null;

function log(message, detail = undefined) {
  const prefix = `[${new Date().toISOString()}]`;
  if (detail === undefined) console.log(prefix, message);
  else console.log(prefix, message, detail);
}

function knownProviderNames() {
  return new Set(PROVIDERS.keys());
}

function normalizeCandidate(entry) {
  return (
    canonicalizeRouteEntry(entry, registry.defaultProvider, knownProviderNames()) || {
      provider: registry.defaultProvider,
      model: '',
    }
  );
}

function candidateKey(candidate) {
  return `${candidate.provider}:${candidate.model}`;
}

function keySlug(key) {
  const separator = String(key).indexOf(':');
  return normalizeModelSlug(separator >= 0 ? key.slice(separator + 1) : key);
}

function candidateMetadata(candidate) {
  return registry.metadata(candidate);
}

// A negative verdict is worth acting on but not worth trusting forever: a
// provider blip would otherwise retire a model permanently with no way back.
// Positive verdicts need no expiry, since ordinary traffic revisits them and a
// later refusal overwrites them.
function verdictFor(key) {
  const verdict = modelVerdicts[key];
  if (!verdict) return null;
  if (verdict.free !== false) return verdict;
  if (probeFailureIsInconclusive(verdict.reason, key)) return null;
  const age = Date.now() - Date.parse(verdict.observedAt || 0);
  return Number.isFinite(age) && age > VERDICT_RETRY_MS ? null : verdict;
}

// What the provider itself told us outranks any local allowlist, in both
// directions: a list in config.json is only ever a guess about someone else's
// pricing, while a served request or a quota figure is a direct answer.
function candidateIsFree(candidate) {
  const verdict = verdictFor(candidateKey(candidate));
  if (verdict?.free === false) return false;
  if (verdict?.free === true) return registry.hasUsableKey(PROVIDERS.get(candidate.provider));
  return registry.isFree(candidate);
}

function setModelVerdict(key, verdict) {
  const previous = modelVerdicts[key];
  const merged = {
    ...previous,
    ...verdict,
    observedAt: new Date().toISOString(),
  };
  if (previous?.free === merged.free && previous?.dailyRequestLimit === merged.dailyRequestLimit) {
    return;
  }
  modelVerdicts[key] = merged;
  scheduleStateSave();
}

// Models named in config.json, either in a route or a provider allowlist.
function configuredCandidateKeys() {
  const keys = new Set();
  for (const entries of Object.values(config.routes || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) keys.add(candidateKey(normalizeCandidate(entry)));
  }
  for (const provider of PROVIDERS.values()) {
    for (const model of provider.freeModels) keys.add(`${provider.name}:${model}`);
  }
  return keys;
}

// Only the verdicts that contradict something asked for. A probe finding that
// some catalog model has no free tier is discovery working, not news: reporting
// every one of those buries the single case that needs attention, a model
// written into config.json that the provider will not serve for free.
function rejectedConfiguredModels() {
  const configured = configuredCandidateKeys();
  return Object.keys(modelVerdicts)
    .filter((key) => configured.has(key) && verdictFor(key)?.free === false)
    .sort()
    .map((key) => ({ key, reason: modelVerdicts[key].reason || '' }));
}

// The provider's own number beats the hand-written one in config.json.
function learnedDailyLimit(key) {
  const learned = Number(modelVerdicts[key]?.dailyRequestLimit);
  return Number.isFinite(learned) && learned > 0 ? learned : null;
}

function discoveredCandidate(id) {
  return registry.parsePrefixed(id) || { provider: registry.defaultProvider, model: id };
}

// Older state files stored OpenRouter discoveries unprefixed. A known
// `provider:` prefix wins; anything else is assumed to be defaultProvider
// (openrouter when that provider still exists).
function labeledDiscoveredId(id) {
  if (typeof id !== 'string' || !id) return '';
  const parsed = registry.parsePrefixed(id);
  if (parsed) return `${parsed.provider}:${parsed.model}`;
  const fallback = PROVIDERS.has('openrouter') ? 'openrouter' : registry.defaultProvider;
  return `${fallback}:${id}`;
}

function migrateLabeledIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(labeledDiscoveredId).filter(Boolean))];
}

// Narrow, domain-tuned models score well on a generic benchmark but are a poor
// default for general traffic. Returns a reason string, or '' to keep the model.
// Only applies to auto-discovered models; anything listed in config.json stays.
function discoveryExclusionReason(id) {
  for (const pattern of EXCLUDE_MODEL_PATTERNS) {
    if (pattern.test(id)) return `model id matches /${pattern.source}/`;
  }
  if (!EXCLUDE_TEXT_PATTERNS.length) return '';
  const model = candidateMetadata(discoveredCandidate(id));
  if (!model) return '';
  const text = `${model.name || ''} ${model.description || ''}`;
  for (const pattern of EXCLUDE_TEXT_PATTERNS) {
    if (pattern.test(text)) return `description matches /${pattern.source}/`;
  }
  return '';
}

// Combines what the last discovery run filtered out with anything currently
// tracked that the filter now rejects, so a pattern added between runs is
// visible immediately instead of only after the next collection.
function excludedModelIds() {
  const ids = new Set(discoveryExcludedIds);
  for (const id of discoveredModelIds) {
    if (discoveryExclusionReason(id)) ids.add(id);
  }
  return [...ids].sort();
}

function usageDay(at = Date.now()) {
  const date = new Date(at);
  if (USAGE_DAY_FORMATTER) return USAGE_DAY_FORMATTER.format(date);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function usageDays() {
  const days = [];
  for (let offset = 0; offset < USAGE_RETENTION_DAYS; offset += 1) {
    days.push(usageDay(Date.now() - offset * 86400000));
  }
  return days;
}

function sanitizeUsage(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const [day, models] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !models || typeof models !== 'object') continue;
    const perModel = {};
    for (const [key, counts] of Object.entries(models)) {
      if (!counts || typeof counts !== 'object') continue;
      const bucket = {};
      for (const kind of USAGE_KINDS) {
        const value = Math.floor(Number(counts[kind]));
        if (Number.isFinite(value) && value > 0) bucket[kind] = value;
      }
      if (Object.keys(bucket).length) perModel[key] = bucket;
    }
    if (Object.keys(perModel).length) clean[day] = perModel;
  }
  return clean;
}

function pruneUsage() {
  const keep = new Set(usageDays());
  for (const day of Object.keys(usageByDay)) {
    if (!keep.has(day)) delete usageByDay[day];
  }
}

function recordUsage(candidate, kind) {
  const bucket = USAGE_KINDS.includes(kind) ? kind : 'other';
  const day = usageDay();
  const perDay = (usageByDay[day] ||= {});
  const counts = (perDay[candidateKey(candidate)] ||= {});
  counts[bucket] = (counts[bucket] || 0) + 1;
  pruneUsage();
  scheduleStateSave();
}

function dailyLimitFor(key) {
  // A limit the provider reported for itself is authoritative; the config
  // value is only a stand-in until the provider tells us the real one.
  const learned = learnedDailyLimit(key);
  if (learned) return learned;
  // Read live from config (not a startup snapshot) so UI edits apply at once.
  const limits = config.usage?.dailyLimits || {};
  const separator = String(key).indexOf(':');
  const provider = separator >= 0 ? key.slice(0, separator) : '';
  const model = separator >= 0 ? key.slice(separator + 1) : key;
  for (const lookup of [key, model, `${provider}:*`]) {
    const value = Number(limits[lookup]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function dailyLimitSource(key) {
  if (learnedDailyLimit(key)) return 'provider';
  return dailyLimitFor(key) ? 'config' : '';
}

function usageTotals(counts) {
  let ok = 0;
  let fail = 0;
  let aborted = 0;
  let consumed = 0;
  for (const [kind, raw] of Object.entries(counts || {})) {
    const amount = Number(raw) || 0;
    if (amount <= 0) continue;
    if (kind === 'ok') ok += amount;
    else if (kind === 'aborted') aborted += amount;
    else fail += amount;
    if (!USAGE_NON_CONSUMING.has(kind)) consumed += amount;
  }
  return { ok, fail, aborted, consumed, total: ok + fail + aborted };
}

function mergeUsage(target, counts) {
  for (const [kind, raw] of Object.entries(counts || {})) {
    const amount = Number(raw) || 0;
    if (amount > 0) target[kind] = (target[kind] || 0) + amount;
  }
  return target;
}

function usageForKey(key) {
  const days = usageDays();
  const todayCounts = usageByDay[days[0]]?.[key] || {};
  const windowCounts = {};
  for (const day of days) mergeUsage(windowCounts, usageByDay[day]?.[key]);
  const limit = dailyLimitFor(key);
  const today = usageTotals(todayCounts);
  return {
    today,
    window: usageTotals(windowCounts),
    dailyLimit: limit,
    dailyLimitSource: dailyLimitSource(key),
    remainingToday: limit === null ? null : Math.max(0, limit - today.consumed),
  };
}

function usageSummary() {
  const days = usageDays();
  const byModel = {};
  const byDay = days.map((day) => {
    const dayCounts = {};
    let topModel = null;
    for (const [key, counts] of Object.entries(usageByDay[day] || {})) {
      mergeUsage(dayCounts, counts);
      mergeUsage((byModel[key] ||= {}), counts);
      const totals = usageTotals(counts);
      if (!topModel || totals.ok > topModel.ok) topModel = { key, ok: totals.ok };
    }
    return { day, ...usageTotals(dayCounts), counts: dayCounts, topModel };
  });
  const models = Object.entries(byModel)
    .map(([key, counts]) => {
      const separator = key.indexOf(':');
      const limit = dailyLimitFor(key);
      const today = usageTotals(usageByDay[days[0]]?.[key] || {});
      return {
        key,
        provider: separator >= 0 ? key.slice(0, separator) : '',
        model: separator >= 0 ? key.slice(separator + 1) : key,
        ...usageTotals(counts),
        counts,
        dailyLimit: limit,
        dailyLimitSource: dailyLimitSource(key),
        today,
        remainingToday: limit === null ? null : Math.max(0, limit - today.consumed),
      };
    })
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  return {
    timezone: USAGE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    retentionDays: USAGE_RETENTION_DAYS,
    today: days[0],
    days: byDay,
    models,
  };
}

function loadDiscoveryState() {
  if (!fs.existsSync(DISCOVERY_STATE_PATH)) return;
  try {
    const state = JSON.parse(fs.readFileSync(DISCOVERY_STATE_PATH, 'utf8'));
    usageByDay = sanitizeUsage(state.usage);
    pruneUsage();
    if (!discoveryEnabled) return;
    discoveredModelIds = migrateLabeledIds(state.addedModels);
    discoverySeenIds = Array.isArray(state.freeModels)
      ? state.freeModels.filter((id) => typeof id === 'string')
      : [];
    discoveryRemovedIds = migrateLabeledIds(state.removedModels);
    discoveryExcludedIds = migrateLabeledIds(state.excludedModels);
    discoveryUnavailableIds = migrateLabeledIds(state.unavailableModels);
    modelVerdicts =
      state.modelVerdicts && typeof state.modelVerdicts === 'object' ? state.modelVerdicts : {};
    discoveryLastCheckedAt = Date.parse(state.lastCheckedAt || '') || 0;
    modelEvaluations =
      state.evaluations && typeof state.evaluations === 'object' ? state.evaluations : {};
    if (state.lastSelection && typeof state.lastSelection === 'object') {
      lastSelection = state.lastSelection;
    }
  } catch (error) {
    discoveryError = `state load failed: ${error instanceof Error ? error.message : String(error)}`;
    log(discoveryError);
  }
}

function saveDiscoveryState() {
  const payload = {
    lastCheckedAt: new Date(discoveryLastCheckedAt).toISOString(),
    route: DISCOVERY_ROUTE,
    freeModels: discoverySeenIds,
    addedModels: discoveredModelIds,
    removedModels: discoveryRemovedIds,
    excludedModels: discoveryExcludedIds,
    unavailableModels: discoveryUnavailableIds,
    modelVerdicts,
    evaluations: modelEvaluations,
    lastSelection,
    usage: usageByDay,
  };
  const temporaryPath = `${DISCOVERY_STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, DISCOVERY_STATE_PATH);
}

function flushStateSave() {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  try {
    saveDiscoveryState();
  } catch (error) {
    log(`failed to persist router state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Every request touches the counters, so batch writes instead of rewriting the
// state file once per attempt.
function scheduleStateSave(delayMs = 1500) {
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    flushStateSave();
  }, delayMs);
  stateSaveTimer.unref?.();
}

function rememberSelection(selection) {
  lastSelection = selection;
  scheduleStateSave();
}

// A manual override in `baselineScores`, keyed by `provider:model` or by the
// bare model ID. Applies to discovered models too, not just configured ones.
function explicitScore(key) {
  const modelId = String(key).includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  const explicit = Number(
    evaluationConfig.baselineScores?.[key] ?? evaluationConfig.baselineScores?.[modelId],
  );
  return Number.isFinite(explicit) ? explicit : null;
}

function modelIdFromKey(key) {
  return String(key).includes(':') ? key.slice(key.indexOf(':') + 1) : key;
}

function capabilityScore(key) {
  const explicit = explicitScore(key);
  if (explicit !== null) return explicit;
  const swe = sweBenchScoreFor(SWE_BENCH_SCORES, modelIdFromKey(key));
  return swe !== null ? swe : -1;
}

function baseModelScore(key) {
  const modelId = modelIdFromKey(key);
  if (PINNED_MODELS.has(key) || PINNED_MODELS.has(modelId)) return Number.POSITIVE_INFINITY;
  return capabilityScore(key);
}

function rankedModelScore(key) {
  return baseModelScore(key);
}

function scoreSourceFor(key, configured) {
  const modelId = modelIdFromKey(key);
  if (PINNED_MODELS.has(key) || PINNED_MODELS.has(modelId)) return 'pinned';
  if (explicitScore(key) !== null) return 'baseline';
  if (configured?.has(key)) return 'baseline';
  const slug = keySlug(key);
  if (configured) {
    for (const configuredKey of configured) {
      if (keySlug(configuredKey) === slug) return 'baseline';
    }
  }
  if (sweBenchScoreFor(SWE_BENCH_SCORES, modelId) !== null) return 'swe-bench';
  return 'unranked';
}

function groupRank(group, configuredSet, configuredIndex) {
  let pinned = false;
  let pinIndex = Number.POSITIVE_INFINITY;
  let configuredIdx = Number.POSITIVE_INFINITY;
  let score = -1;
  for (const { candidate, originalIndex } of group.members) {
    const key = candidateKey(candidate);
    if (PINNED_MODELS.has(key) || PINNED_MODELS.has(candidate.model)) {
      pinned = true;
      pinIndex = Math.min(pinIndex, originalIndex);
    }
    if (configuredSet.has(key) && configuredIndex.get(key) < configuredIdx) {
      configuredIdx = configuredIndex.get(key);
    }
    score = Math.max(score, capabilityScore(key));
  }
  for (const [key, index] of configuredIndex) {
    if (keySlug(key) !== group.slug || index >= configuredIdx) continue;
    configuredIdx = index;
  }
  if (pinned) return { pinned: true, score: Number.POSITIVE_INFINITY, tie: pinIndex };
  // A saved route order is a manual override. Keep it above any SWE %.
  if (configuredIdx !== Number.POSITIVE_INFINITY) {
    return { pinned: false, score: 1000 - configuredIdx, tie: group.firstIndex };
  }
  return { pinned: false, score, tie: group.firstIndex };
}

function orderByModelThenProvider(candidates, configuredSet, configuredIndex) {
  // Rank each route entry on its own: group by `provider:model` so an
  // unpinned variant of a model does not inherit the pinned status or score
  // of a differently-cased or differently-provider variant.
  const groups = new Map();
  candidates.forEach((candidate, originalIndex) => {
    const key = candidateKey(candidate);
    let group = groups.get(key);
    if (!group) {
      group = { slug: normalizeModelSlug(candidate.model) || key, members: [], firstIndex: originalIndex };
      groups.set(key, group);
    }
    group.members.push({ candidate, originalIndex });
  });
  const ranked = [...groups.values()].sort((left, right) => {
    const a = groupRank(left, configuredSet, configuredIndex);
    const b = groupRank(right, configuredSet, configuredIndex);
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return a.tie - b.tie;
    return b.score - a.score || a.tie - b.tie;
  });
  const expanded = [];
  const present = new Set();
  const expandedSlugs = new Set();
  // Variants that are already candidates rank on their own group, so the
  // expansion only adds genuinely new same-model offerings.
  const candidateKeys = new Set(candidates.map(candidateKey));
  const emit = (candidate) => {
    const key = candidateKey(candidate);
    if (present.has(key)) return;
    present.add(key);
    expanded.push(candidate);
  };
  for (const group of ranked) {
    for (const { candidate } of group.members.sort((a, b) => a.originalIndex - b.originalIndex)) {
      emit(candidate);
    }
    // Same-model offerings from other providers are offered once per model
    // slug, at the position of the highest-ranked variant of that model.
    if (expandedSlugs.has(group.slug)) continue;
    expandedSlugs.add(group.slug);
    for (const offering of registry.offeringsForSlug(group.slug)) {
      if (candidateKeys.has(candidateKey(offering))) continue;
      if (!candidateIsFree(offering)) continue;
      emit(offering);
    }
  }
  return expanded;
}

function routeCandidates(routeName) {
  const configured = config.routes?.[routeName];
  if (!configured) return null;
  const normalizedConfigured = configured.map(normalizeCandidate).filter((candidate) => candidate.model);
  const activeConfigured = normalizedConfigured.filter(candidateIsFree);
  const configuredKeys = normalizedConfigured.map(candidateKey);
  const configuredSet = new Set(configuredKeys);
  const configuredIndex = new Map(configuredKeys.map((key, index) => [key, index]));
  if (!discoveryEnabled || routeName !== DISCOVERY_ROUTE) {
    return orderByModelThenProvider(activeConfigured, configuredSet, configuredIndex);
  }

  const candidates = [...activeConfigured];
  const present = new Set(candidates.map(candidateKey));
  for (const id of discoveredModelIds) {
    if (discoveryExclusionReason(id)) continue;
    const candidate = discoveredCandidate(id);
    if (verdictFor(candidateKey(candidate))?.free === false) continue;
    if (present.has(candidateKey(candidate))) continue;
    const model = candidateMetadata(candidate);
    const provider = PROVIDERS.get(candidate.provider);
    if (provider?.catalogHasPricing && provider.catalog.size && (!model || !isZeroCost(model))) {
      continue;
    }
    candidates.push(candidate);
    present.add(candidateKey(candidate));
  }
  return orderByModelThenProvider(candidates, configuredSet, configuredIndex);
}

// Providers without published prices cannot offer new models safely, but their
// catalog still says what they stopped offering. Recomputed on every catalog
// refresh rather than once per discovery run, because routing already drops a
// missing model as soon as the catalog updates; recording it only every
// `discovery.intervalMs` would leave the log two days behind the behaviour.
function syncModelAvailability() {
  const current = registry.unavailableFreeModels();
  const gone = current.filter((id) => !discoveryUnavailableIds.includes(id));
  const restored = discoveryUnavailableIds.filter((id) => !current.includes(id));
  if (!gone.length && !restored.length) return;
  discoveryUnavailableIds = current;
  if (gone.length) log(`no longer offered upstream; skipped in routes`, gone);
  if (restored.length) log(`offered upstream again; restored to routes`, restored);
  scheduleStateSave();
}

async function refreshCatalog(force = false) {
  await registry.refreshCatalogs(force, catalogRefreshMs, log);
  syncModelAvailability();
  if (adoptKnownFreeCatalogModels().length) saveDiscoveryState();
}

function evaluationText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .join('');
}

function parseEvaluationAnswers(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function metadataScore(model) {
  const supported = new Set(model?.supported_parameters || []);
  const contextLength = Number(model?.context_length || 0);
  const createdMs = Number(model?.created || 0) * 1000;
  let score = 0;
  if (supported.has('tools')) score += 6;
  if (supported.has('response_format') || supported.has('structured_outputs')) score += 4;
  score += Math.min(6, Math.max(0, Math.log2(Math.max(4096, contextLength) / 4096)));
  if ((model?.architecture?.input_modalities || ['text']).includes('text')) score += 2;
  if (createdMs && Date.now() - createdMs <= 180 * 24 * 60 * 60 * 1000) score += 2;
  return Math.round(score * 10) / 10;
}

async function evaluateModel(target) {
  const startedAt = Date.now();
  const candidate =
    typeof target === 'string'
      ? { provider: registry.defaultProvider, model: target }
      : target;
  const model = candidateMetadata(candidate);
  const supported = new Set(model?.supported_parameters || []);
  const evaluationBody = {
    messages: [
      {
        role: 'user',
        content:
          'Return ONLY one JSON object with keys token, crt, trace, path, sequence, binary, ' +
          'derange, recur, modpow. ' +
          'No markdown and no explanation. token must be "OX-RANK-7". ' +
          'crt: smallest positive integer n where n%7=3, n%11=5, n%13=9. ' +
          'trace: output of JavaScript: let a=[1,2,3,4]; for(let i=0;i<a.length;i++){if(a[i]%2===0)a.splice(i,1)} console.log(a.join("-")). ' +
          'path: shortest distance A to E for undirected edges A-B:4,A-C:2,C-B:1,B-D:5,C-D:8,C-E:10,D-E:2. ' +
          'sequence: next number after 2,6,12,20,30. ' +
          'binary: number of binary strings of length 8 with no consecutive ones. ' +
          'derange: number of permutations of 1,2,3,4,5 where no value stays in its own position. ' +
          'recur: a(1)=1, and for n>1 a(n)=a(n-1)+n when n is even else a(n-1)*2; give a(6). ' +
          'modpow: 7^222 mod 100.',
      },
    ],
    temperature: 0,
    max_tokens: EVALUATION_MAX_TOKENS,
  };
  if (supported.has('reasoning') || supported.has('reasoning_effort')) {
    evaluationBody.reasoning = { effort: 'low' };
  }
  const slots = registry.keySlots(candidate.provider);
  const slot = slots[0];
  if (slot) registry.rotateKeyCursor(candidate.provider);
  const result = await attemptJson(candidate, evaluationBody, undefined, slot);
  const latencyMs = Date.now() - startedAt;
  recordUsage(candidate, result.ok ? 'ok' : result.kind || 'other');
  if (!result.ok) {
    // The refusal is the useful part when probing: it says whether the model is
    // offered for free at all, which no catalog on a price-free provider does.
    applyProviderVerdict(candidate, result);
    return {
      status: 'pending',
      version: EVALUATION_VERSION,
      attemptedAt: new Date().toISOString(),
      latencyMs,
      error: `${result.status} ${result.reason}`.slice(0, 300),
    };
  }
  // Serving the request is itself the proof, on a key with no billing.
  if (!PROVIDERS.get(candidate.provider)?.catalogHasPricing) {
    setModelVerdict(candidateKey(candidate), {
      free: true,
      reason: 'served a free-tier request',
    });
  }

  // Diagnostic only. Ranking uses unofficial SWE-bench percentages, not
  // this puzzle, catalog metadata, or a single latency sample.
  const answers = parseEvaluationAnswers(evaluationText(result.payload));
  let benchmarkScore = 0;
  if (answers) benchmarkScore += 3;
  if (answers?.token === 'OX-RANK-7') benchmarkScore += 2;
  if (Number(answers?.crt) === 269) benchmarkScore += 8;
  if (String(answers?.trace) === '1-3') benchmarkScore += 8;
  if (Number(answers?.path) === 10) benchmarkScore += 6;
  if (Number(answers?.sequence) === 42) benchmarkScore += 4;
  if (Number(answers?.binary) === 55) benchmarkScore += 6;
  if (Number(answers?.derange) === 44) benchmarkScore += 10;
  if (Number(answers?.recur) === 26) benchmarkScore += 10;
  if (Number(answers?.modpow) === 49) benchmarkScore += 8;

  const modelMetadataScore = metadataScore(candidateMetadata(candidate));
  const latencyScore = latencyMs <= 5000 ? 6 : latencyMs <= 15000 ? 4 : latencyMs <= 30000 ? 2 : 0;
  const score = Math.round((benchmarkScore + modelMetadataScore + latencyScore) * 10) / 10;
  return {
    status: 'scored',
    version: EVALUATION_VERSION,
    evaluatedAt: new Date().toISOString(),
    score,
    benchmarkScore,
    metadataScore: modelMetadataScore,
    latencyScore,
    latencyMs,
  };
}

function responseLooksBilled(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object') return false;
  for (const key of ['cost', 'total_cost', 'credits', 'credit', 'total_credits']) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) return true;
  }
  return false;
}

// Catalog price 0 is not the same as "this id will answer". routeOpen keeps
// only models that return HTTP 200 with no billing fields on a tiny chat call.
async function probeChatReachable(candidate) {
  const provider = PROVIDERS.get(candidate.provider);
  const key = registry.keySlots(candidate.provider)[0]?.key ?? provider?.apiKey;
  if (!provider?.baseUrl || !key) {
    return { status: 0, billed: false, ok: false, reason: 'missing key' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(registry.chatUrl(candidate.provider), {
      method: 'POST',
      headers: registry.headers(candidate.provider, key),
      body: JSON.stringify({
        model: candidate.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4,
        stream: false,
      }),
      signal: controller.signal,
    });
    let billed = false;
    if (response.status === 200) {
      try {
        billed = responseLooksBilled(await response.json());
      } catch {
        billed = false;
      }
    }
    const ok = response.status === 200 && !billed;
    return {
      status: response.status,
      billed,
      ok,
      reason: ok ? '' : billed ? 'billed' : `HTTP ${response.status}`,
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return { status: 0, billed: false, ok: false, reason: timedOut ? 'timeout' : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function keepWorkingCatalogModels(ids, providerName) {
  const kept = [];
  const failed = [];
  let reached = 0;
  for (let index = 0; index < ids.length; index += DISCOVERY_PROBE_BATCH) {
    const batch = ids.slice(index, index + DISCOVERY_PROBE_BATCH);
    const results = await Promise.all(
      batch.map((model) => probeChatReachable({ provider: providerName, model })),
    );
    for (let offset = 0; offset < batch.length; offset += 1) {
      const result = results[offset];
      if (result.status > 0) reached += 1;
      if (result.ok) kept.push(batch[offset]);
      else failed.push({ id: batch[offset], reason: result.reason });
    }
  }
  return { kept, failed, reached, probed: ids.length };
}

function probeFailureIsInconclusive(reason, providerName = '') {
  const text = String(reason || '');
  if (/timeout/i.test(text) || /missing key/i.test(text)) return true;
  const status = Number((text.match(/HTTP (\d+)/i) || [])[1]);
  if (status >= 500) return true;
  if (status !== 429) return false;
  const name = String(providerName).includes(':')
    ? String(providerName).slice(0, String(providerName).indexOf(':'))
    : String(providerName);
  // A priced catalog 429 during a probe burst is rate limiting. An unpriced
  // 429 is often "no free tier" (B.AI / TokenRouter).
  return Boolean(PROVIDERS.get(name)?.catalogHasPricing);
}

function shouldLiveProbeCatalog(provider) {
  if (!provider?.usesCatalog || !registry.hasUsableKey(provider)) return false;
  if (!provider.catalog?.size || provider.catalogError) return false;
  if (provider.catalogHasPricing) return provider.discover !== false;
  // Google native catalogs use quota-shaped 429s; the evaluate probe reads those.
  return provider.probeFreeTier === true && !provider.modelsUrl;
}

function providerAddsDiscoveredModels(provider) {
  if (!registry.hasUsableKey(provider) || !provider.catalog?.size) return false;
  if (provider.catalogHasPricing) return provider.discover !== false;
  if (!provider.probeFreeTier) return false;
  // Native listings skip a re-probe on a cached verdict, so they need this
  // promotion. Live-probed unpriced catalogs insert keepers themselves.
  return Boolean(provider.modelsUrl);
}

function catalogVerdict(providerName, modelId) {
  for (const key of verdictKeysFor(providerName, modelId)) {
    const verdict = verdictFor(key);
    if (verdict) return verdict;
  }
  return null;
}

function rawVerdict(providerName, modelId) {
  for (const key of verdictKeysFor(providerName, modelId)) {
    const verdict = modelVerdicts[key];
    if (verdict) return verdict;
  }
  return null;
}

function alreadyDiscovered(providerName, modelId) {
  const labeled = discoveredIdFor(providerName, modelId);
  const slug = normalizeModelSlug(modelId);
  for (const id of discoveredModelIds) {
    if (id === labeled || id === `${providerName}:${modelId}` || id === modelId) return true;
    const candidate = discoveredCandidate(id);
    if (candidate.provider !== providerName) continue;
    if (candidate.model === modelId) return true;
    if (slug && normalizeModelSlug(candidate.model) === slug) return true;
  }
  return false;
}

// Config no longer seeds models. A free:true verdict from an earlier probe
// still means the catalog entry can be routed — promote it into the discovered
// set instead of waiting for a re-probe that the cache would skip.
function adoptKnownFreeCatalogModels() {
  if (!discoveryEnabled) return [];
  const adopted = [];
  for (const provider of PROVIDERS.values()) {
    if (!providerAddsDiscoveredModels(provider)) continue;
    for (const model of provider.catalog.values()) {
      if (!model?.id || !isChatModel(model)) continue;
      if (alreadyDiscovered(provider.name, model.id)) continue;
      const labeled = discoveredIdFor(provider.name, model.id);
      if (
        discoveryExclusionReason(labeled) ||
        discoveryExclusionReason(`${provider.name}:${model.id}`) ||
        discoveryExclusionReason(model.id)
      ) {
        continue;
      }
      const raw = rawVerdict(provider.name, model.id);
      if (raw?.free === false && !probeFailureIsInconclusive(raw.reason, provider.name)) continue;
      if (provider.catalogHasPricing) {
        if (!isZeroCost(model)) continue;
        if (!(raw?.free === false && probeFailureIsInconclusive(raw.reason, provider.name))) continue;
      } else if ((verdictFor(`${provider.name}:${model.id}`) || catalogVerdict(provider.name, model.id))?.free !== true) {
        continue;
      }
      discoveredModelIds.push(labeled);
      adopted.push(labeled);
    }
  }
  if (adopted.length) {
    log(`adopted ${adopted.length} catalog model(s) already proven free`, adopted);
  }
  return adopted;
}

function catalogLiveProbeIds(provider) {
  const models = [...provider.catalog.values()].filter(
    (model) => typeof model.id === 'string' && model.id && isChatModel(model),
  );
  const usable = provider.catalogHasPricing
    ? models.filter(isZeroCost)
    : models.some(isMarkedFree)
      ? models.filter(isMarkedFree)
      : models;
  return usable
    .map((model) => model.id)
    .filter((id) => id.toLowerCase() !== 'all')
    .sort();
}

function discoveredIdFor(providerName, modelId) {
  return `${providerName}:${modelId}`;
}

function verdictKeysFor(providerName, modelId) {
  const keys = [`${providerName}:${modelId}`];
  const slug = normalizeModelSlug(modelId);
  if (slug && slug !== modelId) keys.push(`${providerName}:${slug}`);
  return keys;
}

function modelReachable(modelId, reachable, reachableSlugs) {
  return reachable.has(modelId) || reachableSlugs.has(normalizeModelSlug(modelId));
}

async function discoverLiveProvider(provider, configuredRoute) {
  const providerName = provider.name;
  const freeIds = catalogLiveProbeIds(provider);
  const configuredIds = configuredRoute
    .filter((candidate) => candidate.provider === providerName)
    .map((candidate) => candidate.model);
  const configuredSet = new Set(configuredIds);
  const configuredSlugs = new Set(configuredIds.map(normalizeModelSlug).filter(Boolean));
  const excluded = new Map();
  for (const id of freeIds) {
    if (configuredSet.has(id) || configuredSlugs.has(normalizeModelSlug(id))) continue;
    const reason =
      discoveryExclusionReason(id) || discoveryExclusionReason(`${providerName}:${id}`);
    if (reason) excluded.set(id, reason);
  }
  const probeIds = freeIds.filter((id) => !excluded.has(id));
  let reachable = new Set(probeIds);
  if (probeIds.length) {
    log(`probing ${probeIds.length} ${providerName} catalog model(s) for live chat`);
    const probed = await keepWorkingCatalogModels(probeIds, providerName);
    if (probed.reached === 0) {
      log(`${providerName} discovery probe unreachable; keeping previous list`);
      return { excluded, seen: freeIds, additions: [], removed: [], skipped: true };
    }
    reachable = new Set(probed.kept);
    const inconclusive = probed.failed.filter((item) =>
      probeFailureIsInconclusive(item.reason, providerName),
    );
    const definitive = probed.failed.filter(
      (item) => !probeFailureIsInconclusive(item.reason, providerName),
    );
    if (probed.kept.length === 0 && definitive.length === 0 && probed.reached > 0) {
      // Every probe was 429/5xx/timeout. That is congestion, not "this id is
      // paid". Keep (or restore) the catalog's free listings instead of wiping
      // the provider off the route.
      log(
        `${providerName} discovery probes inconclusive; keeping catalog free models`,
        probed.failed.map((item) => item.id),
      );
      reachable = new Set(freeIds.filter((id) => !excluded.has(id)));
    } else {
      for (const id of probed.kept) {
        for (const key of verdictKeysFor(providerName, id)) {
          setModelVerdict(key, { free: true, reason: 'probe 200 unpaid' });
        }
      }
      for (const item of definitive) {
        for (const key of verdictKeysFor(providerName, item.id)) {
          setModelVerdict(key, { free: false, reason: `probe failed: ${item.reason}` });
        }
      }
      if (definitive.length) {
        log(
          `dropped ${definitive.length} ${providerName} model(s) that did not serve a free chat`,
          definitive.map((item) => item.id),
        );
      }
      if (inconclusive.length) {
        log(
          `left ${inconclusive.length} ${providerName} model(s) unranked; probe was inconclusive`,
          inconclusive.map((item) => item.id),
        );
      }
    }
  }

  const reachableSlugs = new Set([...reachable].map((id) => normalizeModelSlug(id)).filter(Boolean));
  const fromProvider = (id) => discoveredCandidate(id).provider === providerName;
  const catalogDiscovered = discoveredModelIds.filter(fromProvider);
  const allRouted = [...new Set([
    ...configuredIds.map((id) => discoveredIdFor(providerName, id)),
    ...catalogDiscovered,
  ])];
  const removed = allRouted.filter((id) => {
    const model = discoveredCandidate(id).model;
    return !modelReachable(model, reachable, reachableSlugs);
  });
  discoveredModelIds = discoveredModelIds.filter((id) => {
    if (!fromProvider(id)) return true;
    const model = discoveredCandidate(id).model;
    return modelReachable(model, reachable, reachableSlugs) && !excluded.has(model);
  });
  const knownSlugs = new Set(
    [
      ...configuredRoute.map((candidate) => normalizeModelSlug(candidate.model)),
      ...catalogDiscovered.map((id) => normalizeModelSlug(discoveredCandidate(id).model)),
    ].filter(Boolean),
  );
  const already = new Set([
    ...configuredIds,
    ...[...configuredSlugs],
    ...catalogDiscovered.map((id) => discoveredCandidate(id).model),
    ...catalogDiscovered.map((id) => normalizeModelSlug(discoveredCandidate(id).model)),
  ]);
  const additions = freeIds.filter((id) => {
    if (!reachable.has(id) || excluded.has(id)) return false;
    if (already.has(id) || already.has(normalizeModelSlug(id))) return false;
    // Priced catalogs attach a same-slug copy to an already-ranked model
    // instead of inserting a duplicate discovery row.
    if (provider.catalogHasPricing && knownSlugs.has(normalizeModelSlug(id))) return false;
    return true;
  });
  const labeled = additions.map((id) => discoveredIdFor(providerName, id));
  if (labeled.length) {
    discoveredModelIds.push(...labeled);
    log(`discovered ${labeled.length} ${providerName} model(s); evaluating for ${DISCOVERY_ROUTE}`, labeled);
  } else {
    log(`free-model discovery complete for ${providerName}: no additions`);
  }
  return { excluded, seen: freeIds, additions: labeled, removed, skipped: false };
}

// For a provider that publishes no prices, the only way to learn whether a
// model is free is to ask it. One request per candidate, verdict cached
// forever, so the cost is paid once per model rather than once per run.
async function probeFreeTierCandidates() {
  const configuredRoute = (config.routes?.[DISCOVERY_ROUTE] || []).map(normalizeCandidate);
  let budget = EVALUATION_MAX_PER_RUN;

  for (const provider of PROVIDERS.values()) {
    if (!provider.probeFreeTier || !registry.hasUsableKey(provider) || !provider.catalog?.size) continue;
    // OpenAI-compatible unpriced catalogs are live-probed in
    // performFreeModelDiscovery; this path is for quota-shaped native listings.
    if (shouldLiveProbeCatalog(provider)) continue;

    const known = new Set(
      [
        ...provider.freeModels,
        ...configuredRoute
          .filter((candidate) => candidate.provider === provider.name)
          .map((candidate) => candidate.model),
        ...discoveredModelIds.map((id) => discoveredCandidate(id).model),
      ].map(normalizeModelSlug),
    );

    const candidates = [];
    for (const model of provider.catalog.values()) {
      if (budget <= 0) break;
      // Compared by slug, because a catalog id and the id used for chat need
      // not match character for character. Raw string comparison re-probes
      // models that are already routed and adds a duplicate entry for them.
      if (known.has(normalizeModelSlug(model.id))) continue;
      if (!isChatModel(model)) continue;
      const reason = discoveryExclusionReason(`${provider.name}:${model.id}`);
      if (reason) continue;
      const existing = catalogVerdict(provider.name, model.id);
      if (existing) {
        // A cached free:true used to skip both the probe *and* the route, so
        // emptying config.json dropped models discovery had already proven.
        if (existing.free === true) {
          const key = `${provider.name}:${model.id}`;
          if (!discoveredModelIds.includes(key)) {
            discoveredModelIds.push(key);
            known.add(normalizeModelSlug(model.id));
          }
        }
        continue;
      }
      candidates.push(model.id);
      budget -= 1;
    }
    if (!candidates.length) continue;

    log(`probing ${candidates.length} ${provider.name} model(s) for free-tier access`, candidates);
    for (const model of candidates) {
      const candidate = { provider: provider.name, model };
      const key = candidateKey(candidate);
      const evaluation = await evaluateModel(candidate);
      if (modelVerdicts[key]?.free === false) continue;
      if (evaluation.status !== 'scored') {
        log(`probe inconclusive for ${key}: ${evaluation.error}`);
        continue;
      }
      modelEvaluations[model] = evaluation;
      if (!discoveredModelIds.includes(key)) discoveredModelIds.push(key);
      log(`${key} is free: score ${evaluation.score}`);
      saveDiscoveryState();
    }
  }
}

async function performFreeModelDiscovery(forceCatalogRefresh = false) {
  if (!discoveryEnabled) return;
  if (
    discoveryLastCheckedAt &&
    Date.now() - discoveryLastCheckedAt < DISCOVERY_INTERVAL_MS
  ) {
    return;
  }

  const configured = config.routes?.[DISCOVERY_ROUTE];
  if (!Array.isArray(configured)) {
    discoveryError = `discovery route does not exist: ${DISCOVERY_ROUTE}`;
    log(`free-model discovery failed: ${discoveryError}`);
    discoveryLastCheckedAt = Date.now();
    saveDiscoveryState();
    return;
  }
  const configuredRoute = configured.map(normalizeCandidate);

  try {
    if (forceCatalogRefresh || ![...PROVIDERS.values()].some((provider) => provider.catalog?.size)) {
      await refreshCatalog(true);
    } else {
      await refreshCatalog(forceCatalogRefresh);
    }
    const additions = [];
    const removed = [];
    const seen = [];
    const excluded = [];
    for (const provider of PROVIDERS.values()) {
      if (!shouldLiveProbeCatalog(provider)) continue;
      const result = await discoverLiveProvider(provider, configuredRoute);
      if (result.skipped) continue;
      additions.push(...result.additions);
      removed.push(...result.removed);
      seen.push(...result.seen);
      excluded.push(...[...result.excluded.keys()].map((id) => discoveredIdFor(provider.name, id)));
    }
    discoveryExcludedIds = [...new Set(excluded)].sort();
    if (discoveryExcludedIds.length) {
      log(
        `excluding ${discoveryExcludedIds.length} domain-specific model(s) from ${DISCOVERY_ROUTE}`,
        discoveryExcludedIds,
      );
    }
    discoveryRemovedIds = removed;
    if (removed.length) {
      log(
        `removed ${removed.length} non-free or unavailable model(s) from active routes`,
        removed,
      );
    }

    // A model whose one evaluation attempt failed used to keep score -1 forever,
    // because it was already in discoveredModelIds and so never reappeared in
    // `additions`. Retry those, plus anything scored on an older benchmark.
    const addedSet = new Set(additions);
    // Scores are keyed by bare model id, since a benchmark result describes the
    // model rather than the provider serving it, while route entries may carry
    // a `provider:` prefix once more than one provider contributes models.
    const stale = discoveredModelIds.filter((id) => {
      if (addedSet.has(id)) return false;
      const evaluation = modelEvaluations[discoveredCandidate(id).model];
      return evaluation?.status !== 'scored' || evaluation.version !== EVALUATION_VERSION;
    });
    const toEvaluate = [...additions, ...stale].slice(0, EVALUATION_MAX_PER_RUN);
    if (evaluationEnabled && toEvaluate.length) {
      if (stale.length) {
        log(`re-evaluating ${stale.length} model(s) with missing or outdated scores`, stale);
      }
      for (const id of toEvaluate) {
        const candidate = discoveredCandidate(id);
        log(`evaluating ${addedSet.has(id) ? 'newly discovered' : 'stale'} model ${id}`);
        const evaluation = await evaluateModel(candidate);
        modelEvaluations[candidate.model] = evaluation;
        if (evaluation.status === 'scored') {
          log(`evaluated ${id}: score ${evaluation.score}`);
        } else {
          log(`evaluation deferred for ${id}: ${evaluation.error}`);
        }
        saveDiscoveryState();
      }
    }

    discoverySeenIds = seen;
    discoveryError = '';
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
    log(`free-model discovery failed: ${discoveryError}`);
  }

  // Google native catalogs still use the quota-shaped evaluate probe.
  if (evaluationEnabled) {
    try {
      await probeFreeTierCandidates();
    } catch (error) {
      log(`free-tier probing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  adoptKnownFreeCatalogModels();

  // Timestamped once the whole run is over, so the interval measures complete
  // runs and an observer waiting on it cannot see a half-finished one.
  discoveryLastCheckedAt = Date.now();
  saveDiscoveryState();
}

function discoverFreeModels(forceCatalogRefresh = false) {
  if (discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = performFreeModelDiscovery(forceCatalogRefresh).finally(() => {
    discoveryInFlight = null;
  });
  return discoveryInFlight;
}

async function evaluateUnscoredDiscoveredModels() {
  if (!evaluationEnabled) return;
  const pending = discoveredModelIds
    .filter((id) => {
      if (discoveryExclusionReason(id)) return false;
      const evaluation = modelEvaluations[discoveredCandidate(id).model];
      return evaluation?.status !== 'scored' || evaluation.version !== EVALUATION_VERSION;
    })
    .slice(0, EVALUATION_MAX_PER_RUN);
  if (!pending.length) return;
  log(`evaluating ${pending.length} unscored discovered model(s)`, pending);
  for (const id of pending) {
    const candidate = discoveredCandidate(id);
    const evaluation = await evaluateModel(candidate);
    modelEvaluations[candidate.model] = evaluation;
    if (evaluation.status === 'scored') {
      log(`evaluated ${id}: score ${evaluation.score}`);
    } else {
      log(`evaluation deferred for ${id}: ${evaluation.error}`);
    }
    saveDiscoveryState();
  }
}

function scheduleNextDiscovery() {
  if (!discoveryEnabled) return;
  const elapsed = discoveryLastCheckedAt ? Date.now() - discoveryLastCheckedAt : 0;
  const delay = discoveryLastCheckedAt
    ? Math.max(1000, DISCOVERY_INTERVAL_MS - elapsed)
    : Math.min(DISCOVERY_INTERVAL_MS, 60 * 60 * 1000);
  const timer = setTimeout(async () => {
    await discoverFreeModels(true);
    scheduleNextDiscovery();
  }, delay);
  timer.unref();
}

loadDiscoveryState();

function requestNeeds(body) {
  const modalities = new Set();
  let hasImages = false;
  let hasVideo = false;
  for (const message of body.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url' || part?.type === 'input_image') hasImages = true;
      if (part?.type === 'video_url' || part?.type === 'input_video') hasVideo = true;
    }
  }
  if (hasImages) modalities.add('image');
  if (hasVideo) modalities.add('video');
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    responseFormat: Boolean(body.response_format),
    modalities,
  };
}

function cooldownKey(candidate, slot) {
  const base = candidateKey(candidate);
  if (slot === undefined || slot === null) return base;
  const suffix =
    typeof slot === 'object' && slot.key
      ? createHash('sha256').update(String(slot.key)).digest('hex').slice(0, 16)
      : typeof slot === 'object'
        ? (slot.name ?? slot.index ?? '')
        : slot;
  return `${base}#${suffix}`;
}

function cooldownRemaining(candidate, slot) {
  const entry = cooldowns.get(cooldownKey(candidate, slot));
  if (!entry) {
    // Legacy entries predate per-key cooldowns; still honour them.
    if (slot !== undefined && slot !== null) {
      const legacy = cooldowns.get(candidateKey(candidate));
      if (legacy && legacy.until > Date.now()) return legacy.until - Date.now();
    }
    return 0;
  }
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(cooldownKey(candidate, slot));
    return 0;
  }
  return remaining;
}

function setCooldown(candidate, kind, reason, overrideMs = 0, slot = null) {
  const durations = config.cooldownMs || {};
  const duration = overrideMs || Number(durations[kind] || 0);
  if (!duration) return;
  cooldowns.set(cooldownKey(candidate, slot), {
    until: Date.now() + duration,
    kind,
    reason: String(reason || '').slice(0, 300),
  });
}

function aggregateCooldown(candidate, now = Date.now()) {
  const legacy = cooldowns.get(candidateKey(candidate));
  if (legacy?.until > now) return legacy;
  const slots = registry.keySlots(candidate.provider);
  if (!slots.length) return null;
  const active = slots
    .map((slot) => cooldowns.get(cooldownKey(candidate, slot)))
    .filter((entry) => entry?.until > now);
  if (active.length !== slots.length) return null;
  return active.reduce((soonest, entry) => (entry.until < soonest.until ? entry : soonest));
}

// A provider that explains its own refusal is worth listening to. Turns one
// failed attempt into three separate decisions: how long to wait, whether the
// model is free at all, and what its real daily allowance is.
function applyProviderVerdict(
  candidate,
  result,
  { allowNoFreeTier = true, allowZeroBalance = true } = {},
) {
  const key = candidateKey(candidate);
  const body = result.errorBody;
  if (!body) return 0;

  const permanent = permanentRejection(result.status, body);
  if (permanent) {
    setModelVerdict(key, { free: false, reason: permanent });
    log(`excluding ${key}: ${permanent}`);
    return 0;
  }

  const zeroBalance = zeroBalanceRejection(result.status, body);
  if (zeroBalance) {
    if (!allowZeroBalance) return 0;
    setModelVerdict(key, { free: false, reason: zeroBalance });
    log(`excluding ${key}: ${zeroBalance}`);
    return 0;
  }

  const quota = parseQuotaFailure(body);
  if (!quota) return 0;

  if (quota.noFreeTier) {
    if (!allowNoFreeTier) return 0;
    // Every free-tier allowance is zero, so no amount of waiting helps.
    setModelVerdict(key, { free: false, reason: 'no free-tier allowance (limit 0)' });
    log(`excluding ${key}: provider reports no free-tier quota`);
    return 0;
  }

  // The allowance exists, which is itself proof the model is free.
  const verdict = { free: true, reason: 'free-tier quota reported by provider' };
  if (quota.dailyRequestLimit) verdict.dailyRequestLimit = quota.dailyRequestLimit;
  setModelVerdict(key, verdict);

  if (quota.exhaustedWindow === 'day') {
    const wait = msUntilQuotaReset(Date.now(), USAGE_TIMEZONE || 'America/Los_Angeles');
    log(`${key} spent its daily free quota; waiting ${Math.round(wait / 60000)}m for reset`);
    return wait;
  }
  return quota.retryDelayMs;
}

function candidateModels(requestedModel, body) {
  const configured = routeCandidates(requestedModel);
  return filterCandidates(configured || registry.directCandidates(requestedModel), body, requestedModel);
}

function filterCandidates(configured, body, requestedModel) {
  const needs = requestNeeds(body);
  const active = [];
  const skipped = [];
  for (const candidate of configured) {
    const model = candidateMetadata(candidate);
    if (!candidateIsFree(candidate)) {
      skipped.push({ model: candidateKey(candidate), reason: 'not currently zero-cost or missing key' });
      continue;
    }
    if (!supportsRequest(model, needs)) {
      skipped.push({ model: candidateKey(candidate), reason: 'missing requested capability' });
      continue;
    }
    const slots = registry.keySlots(candidate.provider);
    const remaining = slots.length
      ? Math.min(...slots.map((slot) => cooldownRemaining(candidate, slot)))
      : cooldownRemaining(candidate);
    if (remaining > 0) {
      skipped.push({
        model: candidateKey(candidate),
        reason: `cooldown ${Math.ceil(remaining / 1000)}s`,
      });
      continue;
    }
    active.push(candidate);
  }

  // If every compatible model is cooling down, retry them in order instead of
  // turning a temporary cooldown into a hard outage.
  if (!active.length) {
    for (const candidate of configured) {
      if (
        candidateIsFree(candidate) &&
        supportsRequest(candidateMetadata(candidate), needs)
      ) {
        active.push(candidate);
      }
    }
  }

  if (skipped.length) log(`${requestedModel}: skipped ${skipped.length} candidate(s)`, skipped);
  return active;
}

function sanitizeUpstreamBody(body, candidate) {
  const upstream = JSON.parse(
    JSON.stringify({
      ...body,
      model: candidate.model,
    }),
  );
  delete upstream.models;
  delete upstream.route;
  if (providerNeedsThoughtSignatures(PROVIDERS.get(candidate.provider))) {
    injectThoughtSignatures(upstream, thoughtSignatures);
  }
  if (!secretRedactor) return upstream;
  const { value, count } = secretRedactor.redact(upstream);
  if (count) log(`redacted ${count} secret occurrence(s) before upstream`);
  return value;
}

function rememberGeminiSignatures(candidate, payload) {
  if (!providerNeedsThoughtSignatures(PROVIDERS.get(candidate.provider))) return;
  rememberSignaturesFromPayload(payload, thoughtSignatures);
}

function geminiStreamExtractor(candidate) {
  if (!providerNeedsThoughtSignatures(PROVIDERS.get(candidate.provider))) return null;
  return createStreamSignatureExtractor((id, signature) => {
    thoughtSignatures.remember(id, signature);
  });
}

function usefulMessage(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (!message) return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return true;
  if (typeof message.content === 'string' && message.content.trim()) return true;
  if (Array.isArray(message.content) && message.content.length) {
    return message.content.some((part) => {
      if (typeof part === 'string') return part.trim();
      return typeof part?.text === 'string' && part.text.trim();
    });
  }
  return false;
}

function usefulDelta(payload) {
  const delta = payload?.choices?.[0]?.delta;
  if (!delta) return false;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) return true;
  if (typeof delta.content === 'string' && delta.content.length) return true;
  if (Array.isArray(delta.content) && delta.content.length) return true;
  return false;
}

function classifyFailure(status, message, timedOut = false) {
  if (timedOut) return 'timeout';
  if (status === 429) return 'rateLimit';
  if (status === 404) return 'notFound';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'serverError';
  if (/empty|reasoning only|no useful/i.test(message)) return 'empty';
  return '';
}

// Gemini's OpenAI-compatible layer returns errors wrapped in a single-element
// array, so an `error.message` lookup finds nothing and the real reason is lost.
function parseErrorPayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed[0] : parsed) ?? null;
  } catch {
    return null;
  }
}

function errorSummary(status, raw) {
  const parsed = parseErrorPayload(raw);
  if (!parsed) return raw.trim().slice(0, 500) || `HTTP ${status}`;
  return (
    parsed?.error?.metadata?.raw ||
    parsed?.error?.message ||
    parsed?.message ||
    `HTTP ${status}`
  );
}

async function fetchModel(candidate, body, clientSignal, slot) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('attempt timeout')), attemptTimeoutMs);
  const abortFromClient = () => controller.abort(new Error('client disconnected'));
  clientSignal?.addEventListener('abort', abortFromClient, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', abortFromClient);
  };
  try {
    const provider = PROVIDERS.get(candidate.provider);
    const key = slot?.key ?? provider?.apiKey;
    if (!provider?.baseUrl || !key) {
      throw new Error(`provider ${candidate.provider} is not configured`);
    }
    const response = await fetch(registry.chatUrl(candidate.provider), {
      method: 'POST',
      headers: registry.headers(candidate.provider, key),
      body: JSON.stringify(sanitizeUpstreamBody(body, candidate)),
      signal: controller.signal,
    });
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function attemptJson(candidate, body, clientSignal, slot) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: false },
      clientSignal,
      slot,
    ));
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    cleanup();
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }
  cleanup();
  if (!response.ok) {
    const reason = errorSummary(response.status, raw);
    return {
      ok: false,
      status: response.status,
      reason,
      kind: classifyFailure(response.status, reason),
      fatal: response.status === 401,
      // Kept so the caller can read what the provider said about its own
      // quotas instead of only seeing a status code.
      errorBody: parseErrorPayload(raw),
    };
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, status: 502, reason: 'invalid JSON response', kind: 'serverError' };
  }
  if (!usefulMessage(payload)) {
    const finish = payload?.choices?.[0]?.finish_reason || 'unknown';
    return {
      ok: false,
      status: 502,
      reason: `no useful content or tool call (finish_reason=${finish})`,
      kind: 'empty',
    };
  }
  rememberGeminiSignatures(candidate, payload);
  return {
    ok: true,
    payload,
    contentType: response.headers.get('content-type') || 'application/json',
  };
}

async function attemptStream(candidate, body, res, clientSignal, slot) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: true },
      clientSignal,
      slot,
    ));
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }

  if (!response.ok) {
    let raw;
    try {
      raw = await response.text();
    } finally {
      cleanup();
    }
    const reason = errorSummary(response.status, raw);
    return {
      ok: false,
      status: response.status,
      reason,
      kind: classifyFailure(response.status, reason),
      fatal: response.status === 401,
      errorBody: parseErrorPayload(raw),
    };
  }
  if (!response.body) {
    cleanup();
    return { ok: false, status: 502, reason: 'empty response body', kind: 'empty' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const extractor = geminiStreamExtractor(candidate);
  const bufferedChunks = [];
  let parserBuffer = '';
  let committed = false;
  let finishReason = '';

  while (true) {
    let read;
    try {
      read = await reader.read();
    } catch (error) {
      extractor?.flush();
      cleanup();
      if (committed) {
        res.end();
        return { ok: true, candidate, interrupted: true };
      }
      return { ok: false, status: 502, reason: String(error), kind: 'serverError' };
    }
    if (read.done) break;
    const bytes = Buffer.from(read.value);
    const text = decoder.decode(read.value, { stream: true });
    extractor?.push(text);
    if (committed) {
      res.write(bytes);
      continue;
    }

    bufferedChunks.push(bytes);
    parserBuffer += text;
    const lines = parserBuffer.split('\n');
    parserBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const payload = JSON.parse(data);
        const finish = payload?.choices?.[0]?.finish_reason;
        if (finish) finishReason = finish;
        if (usefulDelta(payload)) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Free-Router-Model': candidate.model,
            'X-Free-Router-Provider': candidate.provider,
          });
          for (const chunk of bufferedChunks) res.write(chunk);
          bufferedChunks.length = 0;
          committed = true;
          log(`selected ${candidateKey(candidate)} (stream)`);
          break;
        }
      } catch {
        // Ignore keepalives and malformed provider-specific event lines.
      }
    }
  }

  extractor?.flush();
  if (committed) {
    cleanup();
    res.end();
    return { ok: true, candidate };
  }
  cleanup();
  return {
    ok: false,
    status: 502,
    reason: `reasoning only or empty stream (finish_reason=${finishReason || 'unknown'})`,
    kind: 'empty',
  };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readJson(req, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function routeStatus() {
  const now = Date.now();
  const routes = {};
  for (const name of Object.keys(config.routes || {})) {
    const candidates = routeCandidates(name) || [];
    const configured = (config.routes[name] || []).map(normalizeCandidate);
    const configuredKeys = configured.map(candidateKey);
    const configuredSet = new Set(configuredKeys);
    const configuredIndex = new Map(configuredKeys.map((key, index) => [key, index]));
    routes[name] = candidates.map((candidate, priority) => {
      const key = candidateKey(candidate);
      const model = candidateMetadata(candidate);
      // The model remains ready while at least one usable key is ready.
      const cooldown = aggregateCooldown(candidate, now);
      const pinned = PINNED_MODELS.has(key) || PINNED_MODELS.has(candidate.model);
      return {
        priority: priority + 1,
        provider: candidate.provider,
        id: candidate.model,
        pinned,
        score: pinned ? null : rankedModelScore(key),
        baseScore: pinned ? null : baseModelScore(key),
        scoreAdjustment: 0,
        scoreSource: scoreSourceFor(key, configuredSet),
        // Only meaningful where the catalog publishes prices; elsewhere the
        // freeModels allowlist is the guarantee, so report it as free.
        zeroCost: PROVIDERS.get(candidate.provider)?.catalogHasPricing
          ? model
            ? isZeroCost(model)
            : null
          : true,
        supportsTools: model ? (model.supported_parameters || []).includes('tools') : null,
        cooldownSeconds:
          cooldown && cooldown.until > now ? Math.ceil((cooldown.until - now) / 1000) : 0,
        cooldownReason: cooldown?.reason,
        usage: usageForKey(key),
      };
    });
  }
  return routes;
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: { message: String(error), type: 'invalid_request_error' },
    });
  }

  const requestedModel = String(body.model || 'free-best');
  await refreshCatalog();
  const candidates = candidateModels(requestedModel, body);
  if (!candidates.length) {
    return sendJson(res, 503, {
      error: {
        message: `No currently free model supports this request for route ${requestedModel}`,
        type: 'no_compatible_free_model',
      },
    });
  }

  const failures = [];
  const failedProviders = new Set();
  const rotatedProviders = new Set();
  const clientController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientController.abort();
  });

  for (const candidate of candidates) {
    if (clientController.signal.aborted) return;
    if (failedProviders.has(candidate.provider)) continue;
    // Multi-account: each candidate is tried with every usable key in
    // round-robin order. A 401 retires just that key; rate limits cool down
    // just that key.
    const slots = registry.keySlots(candidate.provider);
    if (!slots.length) {
      failedProviders.add(candidate.provider);
      continue;
    }
    const ready = slots.filter((slot) => cooldownRemaining(candidate, slot) === 0);
    const attempts = ready.length ? ready : slots;
    if (!rotatedProviders.has(candidate.provider)) {
      registry.rotateKeyCursor(candidate.provider);
      rotatedProviders.add(candidate.provider);
    }
    let noFreeTierFailures = 0;
    let zeroBalanceFailures = 0;
    for (const slot of attempts) {
      if (clientController.signal.aborted) return;
      const slotLabel = ` [${slot.name}]`;
      log(`trying ${candidateKey(candidate)}${slotLabel} for ${requestedModel}`);
      const result = body.stream
        ? await attemptStream(candidate, body, res, clientController.signal, slot)
        : await attemptJson(candidate, body, clientController.signal, slot);

      if (result.ok) {
        recordUsage(candidate, 'ok');
        rememberSelection({
          route: requestedModel,
          provider: candidate.provider,
          model: candidate.model,
          selectedAt: new Date().toISOString(),
        });
        if (!body.stream) {
          log(`selected ${candidateKey(candidate)}${slotLabel}`);
          return sendJson(res, 200, result.payload, {
            'X-Free-Router-Model': candidate.model,
            'X-Free-Router-Provider': candidate.provider,
          });
        }
        return;
      }

      recordUsage(
        candidate,
        clientController.signal.aborted ? 'aborted' : result.kind || 'other',
      );
      failures.push({
        provider: candidate.provider,
        model: candidate.model,
        key: slot.name,
        status: result.status,
        reason: result.reason,
      });
      const quota = parseQuotaFailure(result.errorBody);
      if (quota?.noFreeTier) noFreeTierFailures += 1;
      const zeroBalance = zeroBalanceRejection(result.status, result.errorBody);
      if (zeroBalance) zeroBalanceFailures += 1;
      const providerWaitMs = applyProviderVerdict(candidate, result, {
        allowNoFreeTier: false,
        allowZeroBalance: false,
      });
      if (result.kind) setCooldown(candidate, result.kind, result.reason, providerWaitMs, slot);
      if (zeroBalance) setCooldown(candidate, 'forbidden', zeroBalance, 0, slot);
      log(`failed ${candidateKey(candidate)}${slotLabel}: ${result.status} ${result.reason}`);
      if (zeroBalance && attempts.length > 1) {
        log(`key [${slot.name}] for ${candidate.provider} has zero balance; trying next key`);
        continue;
      }
      if (result.fatal) {
        // Wrong key: retire it and try the next key on the same candidate.
        if (result.status === 401) {
          registry.markKeyInvalid(candidate.provider, slot.key);
          log(`retired key [${slot.name}] for ${candidate.provider}: 401`);
          continue;
        }
        break;
      }
      // The same history will 400 on every Gemini thinking model. Stop here so
      // 3.8-flash, 3.7-flash, and Flash-Lite are not each billed for a refusal.
      if (isMissingThoughtSignatureError(result.status, result.reason)) {
        log(`skipping remaining ${candidate.provider} candidates: missing thought_signature`);
        failedProviders.add(candidate.provider);
        break;
      }
      // Rate limit / timeout on this key: try the next key before moving on.
      if (
        attempts.length > 1 &&
        (result.status === 429 ||
          result.status === 504 ||
          result.kind === 'timeout' ||
          result.kind === 'serverError')
      ) {
        continue;
      }
      break;
    }
    if (
      attempts.length === slots.length &&
      noFreeTierFailures + zeroBalanceFailures === slots.length
    ) {
      const key = candidateKey(candidate);
      const reason = zeroBalanceFailures
        ? 'no usable key has free credit'
        : 'no free-tier allowance (limit 0)';
      setModelVerdict(key, { free: false, reason });
      log(`excluding ${key}: ${reason}`);
    }
    if (!registry.hasUsableKey(PROVIDERS.get(candidate.provider))) {
      failedProviders.add(candidate.provider);
    }
  }

  if (!res.headersSent) {
    sendJson(res, 502, {
      error: {
        message: `All models failed for route ${requestedModel}`,
        type: 'free_router_exhausted',
        failures,
      },
    });
  }
}

function isLoopbackAddress(address) {
  const plain = String(address || '').replace(/^::ffff:/, '');
  return plain === '::1' || plain === '127.0.0.1' || plain.startsWith('127.');
}

// The management interface has no login because it is local-only. Require a
// loopback peer and loopback Host/Origin, and reject cross-site browser calls.
// A plain curl call sends neither Origin nor Sec-Fetch-Site and is allowed.
function uiGuardFailure(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return 'requests must come from loopback';

  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (hostname && hostname !== 'localhost' && !isLoopbackAddress(hostname)) {
    return `unexpected Host header: ${host}`;
  }

  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') {
    return `cross-site request blocked (Sec-Fetch-Site: ${site})`;
  }

  const origin = String(req.headers.origin || '');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return `invalid Origin header: ${origin}`;
    }
    if (originHost !== 'localhost' && !isLoopbackAddress(originHost)) {
      return `unexpected Origin header: ${origin}`;
    }
  }
  return '';
}

function uiProviderState() {
  const catalogHealth = registry.health();
  const providers = [...PROVIDERS.values()];
  providers.sort((left, right) => Number(right.name === 'gemini') - Number(left.name === 'gemini'));
  return providers.map((provider) => {
    const unavailable = catalogHealth[provider.name]?.unavailableModels || [];
    // Model totals next to the free-model availability: priced catalogs count
    // zero-cost chat models, allowlists count entries still offered upstream.
    let modelCount = null;
    let freeCount = null;
    if (provider.catalogHasPricing) {
      if (provider.catalog?.size) {
        modelCount = provider.catalog.size;
        freeCount = [...provider.catalog.values()].filter((m) => isZeroCost(m) && isChatModel(m)).length;
      }
    } else {
      modelCount = provider.freeModels.size;
      freeCount = [...provider.freeModels].filter((id) => !unavailable.includes(id)).length;
    }
    return {
      name: provider.name,
      keyEnv: provider.keyEnv,
      baseUrl: provider.baseUrl,
      kind: registry.providerKind(provider),
      configured: registry.hasUsableKey(provider),
      keyCount: provider.apiKeys?.length || 0,
      keys: (provider.apiKeys || []).map((entry) => ({
        name: entry.name,
        source: entry.source,
        maskedKey: maskSecret(entry.key),
        invalid: provider.invalidKeys.has(entry.key),
      })),
      maskedKey: maskSecret(provider.apiKey),
      catalogModels: provider.usesCatalog ? provider.catalog.size : null,
      modelCount,
      freeCount,
      catalogError: catalogHealth[provider.name]?.catalogError || null,
      unavailableModels: unavailable,
    };
  });
}

function uiRouteState() {
  const routes = routeStatus();
  const entries = routes[DISCOVERY_ROUTE] || Object.values(routes)[0] || [];
  return entries.map((entry) => ({
    priority: entry.priority,
    provider: entry.provider,
    model: entry.id,
    pinned: entry.pinned,
    score: entry.score,
    scoreSource: entry.scoreSource,
    zeroCost: entry.zeroCost,
    cooldownSeconds: entry.cooldownSeconds,
    scoreAdjustment: entry.scoreAdjustment,
    providerConfigured: registry.hasUsableKey(PROVIDERS.get(entry.provider)),
    usage: entry.usage,
  }));
}

function providerFileKeys(name) {
  const raw = config.providers?.[name];
  if (!raw || typeof raw !== 'object') return [];
  return (Array.isArray(raw.keys) ? raw.keys : raw.keys ? [raw.keys] : [])
    .map((entry, index) =>
      typeof entry === 'string'
        ? { name: `key-${index + 1}`, key: entry.trim() }
        : {
            name: String(entry?.name || `key-${index + 1}`).trim(),
            key: String(entry?.key || '').trim(),
          },
    )
    .filter((entry) => entry.key);
}

// Named multi-key write path. Body variants:
//   {provider, key}                 legacy: replace the env-backed key
//   {provider, name, key}           add or replace the named file key
//   {provider, name, key: ''}       delete the named file key
// File keys persist to the TOML/JSON config; the legacy env path still
// updates the .env file so `start.sh` keeps working.
async function handleKeyUpdate(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, {
      error: { message: String(error), type: 'invalid_request_error' },
    });
  }

  const name = String(body.provider || '');
  const provider = PROVIDERS.get(name);
  // Whitelisted by provider name, never by raw env name: start.sh sources the
  // env file with `set -a`, so writing an arbitrary variable such as
  // NODE_OPTIONS would be code execution on the next start.
  if (!provider) {
    return sendJson(res, 400, {
      error: {
        message: `unknown provider: ${name || '(missing)'}`,
        type: 'invalid_request_error',
      },
    });
  }

  const keyName = String(body.name || '').trim().slice(0, 64);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const problem = validateSecret(key);
  if (problem) {
    return sendJson(res, 400, { error: { message: problem, type: 'invalid_request_error' } });
  }

  // Named path: file-backed multi-account keys -> overlay file.
  if (keyName) {
    const next = providerFileKeys(name)
      .filter((entry) => String(entry?.name || '') !== keyName)
      .map((entry) => ({ name: String(entry.name), key: String(entry.key || '') }));
    if (key) next.push({ name: keyName, key });
    registry.setProviderKeys(name, next);
    setOverlayValue(['providers', name, 'keys'], structuredClone(provider.configRef.keys));
    try {
      persistOverlayFile();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return sendJson(res, 500, {
        error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
      });
    }
    refreshSecretRedactor();
    log(`${key ? 'set' : 'cleared'} provider key [${keyName}] for ${name} via web interface`);
    if (key && provider.usesCatalog) {
      try {
        await refreshCatalog(true);
      } catch (error) {
        log(`catalog refresh after key change failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return sendJson(res, 200, {
      ok: true,
      provider: name,
      name: keyName,
      configured: registry.hasUsableKey(provider),
    });
  }

  try {
    updateEnvFile(UI_ENV_PATH, { [provider.keyEnv]: key });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`failed to write ${displayPath(UI_ENV_PATH)}: ${reason}`);
    return sendJson(res, 500, {
      error: { message: `could not write env file: ${reason}`, type: 'env_write_failed' },
    });
  }

  registry.setApiKey(name, key);
  refreshSecretRedactor();
  log(`${key ? 'set' : 'cleared'} ${provider.keyEnv} via web interface`);
  if (key && provider.usesCatalog) {
    try {
      await refreshCatalog(true);
    } catch (error) {
      log(`catalog refresh after key change failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sendJson(res, 200, {
    ok: true,
    provider: name,
    configured: registry.hasUsableKey(provider),
  });
}

async function handleServerConfig(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const notes = [];
  if (body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendJson(res, 400, { error: { message: 'port must be 1-65535', type: 'invalid_request_error' } });
    }
    setOverlayValue(['port'], port);
    notes.push('port saved; restart to take effect');
  }
  try {
    persistOverlayFile();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return sendJson(res, 500, {
      error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
    });
  }
  return sendJson(res, 200, { ok: true, host: config.host, port: config.port, notes });
}

// ---- Editable configuration (web UI settings tabs) ----

function routeEntryString(entry) {
  const canonical = canonicalizeRouteEntry(entry, registry.defaultProvider, knownProviderNames());
  return canonical ? `${canonical.provider}:${canonical.model}` : '';
}

// Accepts `{provider, model}`, `provider:model`, or a bare model id that
// belongs to defaultProvider (including OpenRouter ids that themselves contain
// a colon, e.g. `z-ai/glm-5.2:free`).
function parseRouteEntryString(raw) {
  return canonicalizeRouteEntry(raw, registry.defaultProvider, knownProviderNames());
}

function editableConfigState() {
  const routes = {};
  for (const [name, entries] of Object.entries(config.routes || {})) {
    routes[name] = (Array.isArray(entries) ? entries : []).map(routeEntryString).filter(Boolean);
  }
  const limits = Object.entries(config.usage?.dailyLimits || {}).map(([key, limit]) => ({
    key,
    limit: Number(limit),
    source: dailyLimitSource(key),
  }));
  limits.sort((a, b) => a.key.localeCompare(b.key));
  return {
    providers: [...PROVIDERS.values()].map((provider) => ({
      name: provider.name,
      keyEnv: provider.keyEnv,
      baseUrl: provider.baseUrl,
      catalog: provider.usesCatalog,
      pricing: provider.catalogHasPricing,
      probeFreeTier: provider.probeFreeTier,
      freeModels: [...provider.freeModels],
      keyCount: provider.apiKeys?.length || 0,
    })),
    routes,
    discovery: {
      enabled: discoveryEnabled,
      intervalHours: Math.round(DISCOVERY_INTERVAL_MS / 3600000),
      route: DISCOVERY_ROUTE,
      evaluationEnabled,
      pinnedModels: [...PINNED_MODELS],
    },
    limits,
    general: {
      attemptTimeoutMs,
      catalogRefreshMs,
      redactSecrets: config.redactSecrets !== false,
      socksFirstHosts: config.socksFirstHosts || [],
      defaultProvider: registry.defaultProvider,
      retentionDays: USAGE_RETENTION_DAYS,
      timezone: USAGE_TIMEZONE || '',
    },
  };
}

function persistOrFail(res) {
  try {
    persistOverlayFile();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, {
      error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
    });
    return false;
  }
  return true;
}

function validProviderId(name) {
  return /^[a-z][a-z0-9_-]*$/.test(String(name || ''));
}

function validHttpUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Providers: create a new upstream, edit baseUrl/freeModels/flags, or delete.
// Deleting also purges the provider's entries from all routes.
async function handleProviders(req, res) {
  let body;
  try {
    body = await readJson(req, 128 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const action = String(body.action || '');
  const name = String(body.name || '').trim();

  if (action === 'create') {
    if (!validProviderId(name)) {
      return sendJson(res, 400, { error: { message: 'name must match [a-z][a-z0-9_-]*', type: 'invalid_request_error' } });
    }
    if (PROVIDERS.has(name)) {
      return sendJson(res, 400, { error: { message: `provider already exists: ${name}`, type: 'invalid_request_error' } });
    }
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
    if (!validHttpUrl(baseUrl)) {
      return sendJson(res, 400, { error: { message: 'baseUrl must be an http(s) URL', type: 'invalid_request_error' } });
    }
    const freeModels = Array.isArray(body.freeModels)
      ? [...new Set(body.freeModels.map((m) => String(m || '').trim()).filter(Boolean))]
      : [];
    const cfg = {
      baseUrl,
      keyEnv: String(body.keyEnv || `${name.replace(/-/g, '_').toUpperCase()}_API_KEY`),
      catalog: body.catalog === true,
      pricing: body.pricing !== false,
      probeFreeTier: body.probeFreeTier === true,
      freeModels,
      keys: [],
    };
    setOverlayValue(['providers', name], cfg);
    try {
      registry.addProvider(name, cfg);
    } catch (error) {
      deleteOverlayValue(['providers', name]);
      return sendJson(res, 400, { error: { message: String(error.message || error), type: 'invalid_request_error' } });
    }
    tombstone('_removedProviders', name, false);
    if (!persistOrFail(res)) return undefined;
    refreshSecretRedactor();
    if (cfg.catalog) {
      try {
        await refreshCatalog(true);
      } catch (error) {
        log(`catalog refresh after provider add failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`added provider ${name} via web interface`);
    return sendJson(res, 200, { ok: true, name });
  }

  const provider = PROVIDERS.get(name);
  if (!provider) {
    return sendJson(res, 404, { error: { message: `unknown provider: ${name || '(missing)'}`, type: 'not_found' } });
  }

  if (action === 'delete') {
    try {
      registry.removeProvider(name);
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error.message || error), type: 'invalid_request_error' } });
    }
    deleteOverlayValue(['providers', name]);
    tombstone('_removedProviders', name, true);
    let purged = 0;
    for (const [routeName, entries] of Object.entries(config.routes || {})) {
      if (!Array.isArray(entries)) continue;
      const kept = entries
        .map((entry) => normalizeCandidate(entry))
        .filter((candidate) => candidate.model && candidate.provider !== name);
      if (kept.length === entries.length) continue;
      purged += entries.length - kept.length;
      setOverlayValue(['routes', routeName], kept);
    }
    if (!persistOrFail(res)) return undefined;
    refreshSecretRedactor();
    log(`deleted provider ${name} via web interface (purged ${purged} route entr${purged === 1 ? 'y' : 'ies'})`);
    return sendJson(res, 200, { ok: true, purged });
  }

  if (action === 'update') {
    const notes = [];
    const cfg = editableProviderRaw(name);
    if (body.baseUrl !== undefined) {
      const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      if (!validHttpUrl(baseUrl)) {
        return sendJson(res, 400, { error: { message: 'baseUrl must be an http(s) URL', type: 'invalid_request_error' } });
      }
      cfg.baseUrl = baseUrl;
      provider.baseUrl = baseUrl;
      notes.push('baseUrl updated');
    }
    if (body.freeModels !== undefined) {
      if (!Array.isArray(body.freeModels)) {
        return sendJson(res, 400, { error: { message: 'freeModels must be an array', type: 'invalid_request_error' } });
      }
      const list = [...new Set(body.freeModels.map((m) => String(m || '').trim()).filter(Boolean))];
      cfg.freeModels = list;
      provider.freeModels = new Set(list);
      notes.push('freeModels updated');
    }
    if (body.catalog !== undefined) {
      cfg.catalog = body.catalog === true;
      notes.push('catalog flag saved; restart to take effect');
    }
    if (body.pricing !== undefined) {
      cfg.pricing = body.pricing !== false;
      notes.push('pricing flag saved; restart to take effect');
    }
    if (body.probeFreeTier !== undefined) {
      cfg.probeFreeTier = body.probeFreeTier === true;
      notes.push('probeFreeTier saved; restart to take effect');
    }
    // cfg is already the overlay-owned raw (see editableProviderRaw above).
    if (!persistOrFail(res)) return undefined;
    if (body.baseUrl !== undefined && provider.usesCatalog) {
      try {
        await refreshCatalog(true);
      } catch (error) {
        log(`catalog refresh after provider update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return sendJson(res, 200, { ok: true, name, notes });
  }

  return sendJson(res, 400, { error: { message: `unknown action: ${action}`, type: 'invalid_request_error' } });
}

// Routes: replace a whole route membership list, create a new route, or delete
// one. Models for price-free providers are auto-added to their freeModels
// allowlist so the new entry is actually routable.
async function handleRoutes(req, res) {
  let body;
  try {
    body = await readJson(req, 128 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const action = String(body.action || 'save');
  const route = String(body.route || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(route)) {
    return sendJson(res, 400, { error: { message: 'route must match [A-Za-z0-9_-]+', type: 'invalid_request_error' } });
  }

  if (action === 'delete') {
    if (route === DISCOVERY_ROUTE) {
      return sendJson(res, 400, { error: { message: `cannot delete the discovery route: ${route}`, type: 'invalid_request_error' } });
    }
    if (!config.routes?.[route]) {
      return sendJson(res, 404, { error: { message: `unknown route: ${route}`, type: 'not_found' } });
    }
    delete config.routes[route];
    tombstone('_removedRoutes', route, true);
    if (!persistOrFail(res)) return undefined;
    log(`deleted route ${route} via web interface`);
    return sendJson(res, 200, { ok: true });
  }

  if (action !== 'save') {
    return sendJson(res, 400, { error: { message: `unknown action: ${action}`, type: 'invalid_request_error' } });
  }
  if (!Array.isArray(body.models)) {
    return sendJson(res, 400, { error: { message: 'models must be an array of "provider:model" or model strings', type: 'invalid_request_error' } });
  }
  const parsed = [];
  const seen = new Set();
  const notes = [];
  for (const raw of body.models) {
    const entry = parseRouteEntryString(raw);
    if (!entry) {
      return sendJson(res, 400, { error: { message: `empty model entry`, type: 'invalid_request_error' } });
    }
    const key = `${entry.provider}:${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(entry);
    const provider = PROVIDERS.get(entry.provider);
    if (!provider) {
      return sendJson(res, 400, { error: { message: `unknown provider in entry: ${routeEntryString(entry)}`, type: 'invalid_request_error' } });
    }
    if (!provider.catalogHasPricing && !provider.freeModels.has(entry.model)) {
      provider.freeModels.add(entry.model);
      const cfg = editableProviderRaw(entry.provider);
      cfg.freeModels = [...provider.freeModels];
      notes.push(`added ${entry.model} to ${entry.provider} freeModels`);
    }
  }
  setOverlayValue(['routes', route], parsed);
  tombstone('_removedRoutes', route, false);
  if (!persistOrFail(res)) return undefined;
  log(`saved route ${route} via web interface (${parsed.length} entries)`);
  return sendJson(res, 200, { ok: true, route, count: parsed.length, notes });
}

// Daily quota limits: config values (provider-reported ones stay authoritative).
async function handleLimits(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const action = String(body.action || 'set');
  const key = String(body.key || '').trim();
  if (!key) {
    return sendJson(res, 400, { error: { message: 'key is required, e.g. "gemini:gemini-3.8-flash"', type: 'invalid_request_error' } });
  }
  if (action === 'delete') {
    deleteOverlayValue(['usage', 'dailyLimits', key]);
    if (!persistOrFail(res)) return undefined;
    return sendJson(res, 200, { ok: true });
  }
  if (action !== 'set') {
    return sendJson(res, 400, { error: { message: `unknown action: ${action}`, type: 'invalid_request_error' } });
  }
  const limit = Number(body.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return sendJson(res, 400, { error: { message: 'limit must be a positive number', type: 'invalid_request_error' } });
  }
  setOverlayValue(['usage', 'dailyLimits', key], limit);
  if (!persistOrFail(res)) return undefined;
  return sendJson(res, 200, { ok: true, key, limit });
}

// Discovery + evaluation toggles apply immediately. The interval needs a
// restart because it arms the next timer.
async function handleDiscovery(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const notes = [];
  if (body.enabled !== undefined) {
    discoveryEnabled = body.enabled !== false;
    setOverlayValue(['discovery', 'enabled'], discoveryEnabled);
  }
  if (body.evaluationEnabled !== undefined) {
    evaluationEnabled = body.evaluationEnabled !== false;
    setOverlayValue(['discovery', 'evaluation', 'enabled'], evaluationEnabled);
  }
  if (body.intervalHours !== undefined) {
    const hours = Number(body.intervalHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      return sendJson(res, 400, { error: { message: 'intervalHours must be 1-720', type: 'invalid_request_error' } });
    }
    setOverlayValue(['discovery', 'intervalMs'], Math.round(hours * 3600000));
    notes.push('interval saved; restart to take effect');
  }
  if (body.pin !== undefined || body.unpin !== undefined) {
    const pinned = new Set(config.discovery?.evaluation?.pinnedModels || [...PINNED_MODELS]);
    if (body.pin) {
      const model = String(body.pin).trim();
      if (!model) {
        return sendJson(res, 400, { error: { message: 'pin must be a non-empty model id', type: 'invalid_request_error' } });
      }
      pinned.add(model);
      PINNED_MODELS.add(model);
    }
    if (body.unpin) {
      pinned.delete(String(body.unpin));
      PINNED_MODELS.delete(String(body.unpin));
    }
    setOverlayValue(['discovery', 'evaluation', 'pinnedModels'], [...pinned]);
  }
  if (!persistOrFail(res)) return undefined;
  return sendJson(res, 200, { ok: true, notes });
}

// General tuning knobs. Most apply immediately; host-like values and the
// usage timezone need a restart and are reported back as notes.
async function handleSettings(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const notes = [];
  if (body.attemptTimeoutMs !== undefined) {
    const value = Number(body.attemptTimeoutMs);
    if (!Number.isFinite(value) || value < 5000 || value > 900000) {
      return sendJson(res, 400, { error: { message: 'attemptTimeoutMs must be 5000-900000', type: 'invalid_request_error' } });
    }
    attemptTimeoutMs = value;
    setOverlayValue(['attemptTimeoutMs'], value);
  }
  if (body.catalogRefreshMs !== undefined) {
    const value = Number(body.catalogRefreshMs);
    if (!Number.isFinite(value) || value < 60000 || value > 86400000) {
      return sendJson(res, 400, { error: { message: 'catalogRefreshMs must be 60000-86400000', type: 'invalid_request_error' } });
    }
    catalogRefreshMs = value;
    setOverlayValue(['catalogRefreshMs'], value);
  }
  if (body.redactSecrets !== undefined) {
    setOverlayValue(['redactSecrets'], body.redactSecrets !== false);
    refreshSecretRedactor();
  }
  if (body.socksFirstHosts !== undefined) {
    if (!Array.isArray(body.socksFirstHosts)) {
      return sendJson(res, 400, { error: { message: 'socksFirstHosts must be an array', type: 'invalid_request_error' } });
    }
    setOverlayValue(['socksFirstHosts'], body.socksFirstHosts.map((h) => String(h || '').trim()).filter(Boolean));
    notes.push('socksFirstHosts saved; restart to take effect');
  }
  if (body.defaultProvider !== undefined) {
    const name = String(body.defaultProvider || '');
    try {
      registry.setDefaultProvider(name);
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error.message || error), type: 'invalid_request_error' } });
    }
    setOverlayValue(['defaultProvider'], name);
  }
  if (body.retentionDays !== undefined) {
    const value = Number(body.retentionDays);
    if (!Number.isInteger(value) || value < 1 || value > 90) {
      return sendJson(res, 400, { error: { message: 'retentionDays must be 1-90', type: 'invalid_request_error' } });
    }
    setOverlayValue(['usage', 'retentionDays'], value);
    notes.push('retentionDays saved; restart to take effect');
  }
  if (body.timezone !== undefined) {
    setOverlayValue(['usage', 'timezone'], String(body.timezone || ''));
    notes.push('timezone saved; restart to take effect');
  }
  if (body.dismissMigrationNotice === true) {
    deleteOverlayValue(['migratedFromEnv']);
  }
  if (!persistOrFail(res)) return undefined;
  return sendJson(res, 200, { ok: true, notes });
}

// Graceful restart for applying host/port changes from the web UI.
// Responds first, then flushes state and exits: process supervisors
// (docker restart policy, systemd) bring the server back up. Without a
// supervisor (plain ./start.sh) the process simply stops — the UI says so.
async function handleRestart(req, res) {
  sendJson(res, 200, { ok: true });
  setTimeout(() => {
    log('restart requested via web interface; exiting for supervisor restart');
    try {
      if (stateSaveTimer) flushStateSave();
    } catch {
      // Best effort; the process is exiting either way.
    }
    try {
      server.close(() => process.exit(0));
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 3000).unref?.();
  }, 300).unref?.();
}

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const isUiPath = url.pathname === '/' || url.pathname.startsWith('/api/');
  if (isUiPath) {
    if (!UI_ENABLED) {
      return sendJson(res, 404, {
        error: { message: 'web interface is disabled', type: 'not_found' },
      });
    }
    const failure = uiGuardFailure(req);
    if (failure) {
      log(`blocked web interface request: ${failure}`);
      return sendJson(res, 403, { error: { message: failure, type: 'forbidden' } });
    }
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const page = renderPage();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(page),
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    return res.end(page);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    await refreshCatalog();
    return sendJson(
      res,
      200,
      {
        endpoint: `http://${HOST}:${PORT}/v1`,
        envFile: displayPath(UI_ENV_PATH),
        configFile: displayPath(CONFIG_PATH),
        configFormat: CONFIG_FORMAT,
        overlayFile: displayPath(OVERLAY_PATH),
        route: DISCOVERY_ROUTE,
        server: { host: config.host, port: config.port, runningHost: HOST, runningPort: PORT },
        providers: uiProviderState(),
        usage: usageSummary(),
        routes: uiRouteState(),
        migration: config.migratedFromEnv || null,
        editable: editableConfigState(),
        allRoutes: routeStatus(),
        unavailableModels: discoveryUnavailableIds,
        excludedByProvider: rejectedConfiguredModels(),
        lastSelection,
      },
      { 'Cache-Control': 'no-store' },
    );
  }
  if (req.method === 'POST' && url.pathname === '/api/keys') {
    return handleKeyUpdate(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/server') {
    return handleServerConfig(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    return handleRestart(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/providers') {
    return handleProviders(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/routes') {
    return handleRoutes(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/limits') {
    return handleLimits(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/discovery') {
    return handleDiscovery(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    return handleSettings(req, res);
  }
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'free-router',
      version: VERSION,
      defaultProvider: registry.defaultProvider,
      catalogModels: registry.discoveryCatalog()?.catalog?.size || 0,
      catalogFetchedAt: registry.discoveryCatalog()?.catalogFetchedAt
        ? new Date(registry.discoveryCatalog().catalogFetchedAt).toISOString()
        : null,
      catalogError: registry.discoveryCatalog()?.catalogError || null,
      providers: registry.health(),
      discovery: {
        enabled: discoveryEnabled,
        route: DISCOVERY_ROUTE,
        intervalMs: DISCOVERY_INTERVAL_MS,
        lastCheckedAt: discoveryLastCheckedAt
          ? new Date(discoveryLastCheckedAt).toISOString()
          : null,
        freeModelsSeen: discoverySeenIds.length,
        addedModels: discoveredModelIds,
        removedModels: discoveryRemovedIds,
        excludedModels: excludedModelIds(),
        unavailableModels: discoveryUnavailableIds,
        modelVerdicts,
        // Which providers can contribute new models, and which are only
        // checked for models that disappeared.
        addsFrom: [...PROVIDERS.values()].filter((p) => p.discover || p.probeFreeTier).map((p) => p.name),
        availabilityOnly: [...PROVIDERS.values()]
          .filter((p) => p.usesCatalog && !p.catalogHasPricing && !p.probeFreeTier)
          .map((p) => p.name),
        evaluations: modelEvaluations,
        error: discoveryError || null,
      },
      lastSelection,
      usage: usageSummary(),
      routes: routeStatus(),
    });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    await refreshCatalog();
    const routeModels = Object.keys(config.routes || {}).map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'free-router',
    }));
    const listed = registry.listListedModels();
    const catalogModels = registry
      .listCatalogModels(listed.ids)
      .filter((model) => verdictFor(`${model.provider}:${model.id}`)?.free !== false)
      .map((model) => ({
      id: model.id,
      object: model.object,
      created: model.created,
      owned_by: model.owned_by,
      context_length: model.context_length,
    }));
    return sendJson(res, 200, {
      object: 'list',
      data: [...routeModels, ...listed.models, ...catalogModels],
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChat(req, res);
  }
  return sendJson(res, 404, {
    error: { message: `Unknown endpoint: ${req.method} ${url.pathname}`, type: 'not_found' },
  });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    log('unhandled request error', error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: { message: 'Internal router error', type: 'router_internal_error' },
      });
    } else {
      res.end();
    }
  });
});

server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, async () => {
  log(`Free Router ${VERSION} listening on http://${HOST}:${PORT}/v1 (config: ${displayPath(CONFIG_PATH)}, ${CONFIG_FORMAT})`);
  if (UI_ENABLED) log(`web interface on http://${HOST}:${PORT}/`);
  for (const provider of PROVIDERS.values()) {
    if (!registry.hasUsableKey(provider)) log(`warning: ${provider.keyEnv} is missing`);
    else if (provider.apiKeys.length > 1) log(`${provider.name}: ${provider.apiKeys.length} keys configured`);
  }
  await refreshCatalog(true);
  await discoverFreeModels();
  await evaluateUnscoredDiscoveredModels();
  scheduleNextDiscovery();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`received ${signal}; shutting down`);
    if (stateSaveTimer) flushStateSave();
    server.close(() => process.exit(0));
  });
}
