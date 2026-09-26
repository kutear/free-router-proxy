import fs from 'node:fs';
import { normalizeModelSlug } from './providers.mjs';

// Same lookup the unofficial catalog used: exact id, derived slug, then a
// prefix match for spelling variants (glm-5.2 → glm5). Not an official
// SWE-bench dump.

export function toSweSlugKey(id) {
  return (String(id || '').split('/').pop() ?? '')
    .toLowerCase()
    .replace(/:free$/, '')
    .replace(/[._]/g, '-')
    .replace(
      /-(instruct|it|fp8|preview|turbo|versatile|2507|2512|2506|v\d+[\d.]*|a\d+b).*$/,
      '',
    );
}

function hyphenateLetterDigit(slug) {
  return String(slug || '')
    .replace(/([a-z])(\d)/gi, '$1-$2')
    .replace(/(\d)([a-z])/gi, '$1-$2');
}

function bareModelId(id) {
  const value = String(id || '');
  const colon = value.indexOf(':');
  const slash = value.indexOf('/');
  if (colon >= 0 && (slash < 0 || colon < slash)) return value.slice(colon + 1);
  return value;
}

function parsePercent(value) {
  const n = Number(String(value ?? '').replace(/%/g, ''));
  return Number.isFinite(n) ? n : null;
}

function indexScore(bySlug, key, score) {
  if (!key || !Number.isFinite(score)) return;
  for (const alias of [
    String(key).toLowerCase(),
    normalizeModelSlug(key),
    toSweSlugKey(key),
    hyphenateLetterDigit(toSweSlugKey(key)),
  ]) {
    if (alias && !bySlug.has(alias)) bySlug.set(alias, score);
  }
}

export function loadSweBenchScores(filePath) {
  const bySlug = new Map();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return bySlug;
  }
  for (const [key, value] of Object.entries(raw.scores || {})) {
    const n = parsePercent(value);
    if (n == null) continue;
    indexScore(bySlug, key, n);
  }
  for (const model of raw.models || []) {
    const n = parsePercent(model?.swe_bench);
    if (n == null) continue;
    indexScore(bySlug, model.model_id, n);
    if (model.aa_slug) indexScore(bySlug, model.aa_slug, n);
  }
  return bySlug;
}

export function sweBenchScoreFor(scores, modelId) {
  if (!scores?.size) return null;
  const bare = bareModelId(modelId).replace(/:free$/, '');
  const slug = toSweSlugKey(bare);
  const hyphenated = hyphenateLetterDigit(slug);
  const direct =
    scores.get(String(modelId || '').toLowerCase()) ??
    scores.get(normalizeModelSlug(modelId)) ??
    scores.get(slug) ??
    scores.get(hyphenated);
  if (Number.isFinite(direct)) return direct;
  // Original catalog: query slug at least 6 chars, then prefix either way.
  if (hyphenated.length < 6) return null;
  let best = null;
  let bestLen = 0;
  for (const [key, score] of scores) {
    if (!(hyphenated.startsWith(key) || key.startsWith(hyphenated))) continue;
    if (key.length <= bestLen) continue;
    best = score;
    bestLen = key.length;
  }
  return Number.isFinite(best) ? best : null;
}
