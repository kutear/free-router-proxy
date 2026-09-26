#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createProviderRegistry,
  isChatModel,
  isMarkedFree,
  normalizeCatalogPayload,
  normalizeModelSlug,
  supportsRequest,
} from './providers.mjs';
import {
  msUntilQuotaReset,
  parseQuotaFailure,
  permanentRejection,
  zeroBalanceRejection,
} from './quota.mjs';
import {
  SKIP_THOUGHT_SIGNATURE,
  createStreamSignatureExtractor,
  createThoughtSignatureCache,
  injectThoughtSignatures,
  isMissingThoughtSignatureError,
  providerNeedsThoughtSignatures,
  readThoughtSignature,
  rememberSignaturesFromPayload,
} from './thought-signature.mjs';
import { displayPath, maskSecret, validateSecret } from './ui.mjs';
import { loadSweBenchScores, sweBenchScoreFor } from './swe-bench.mjs';
import {
  addMissingKeys,
  buildLiveConfig,
  canonicalizeRouteEntry,
  deepMerge,
  defaultConfigObject,
  providerKeysFromConfig,
  runOverlayMigrations,
  SCHEMA_VERSION,
} from './config.mjs';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
).version;
assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+$/);

assert.equal(normalizeModelSlug('google/gemini-3.8-flash:free'), 'gemini-3.8-flash');
assert.equal(normalizeModelSlug('gemini-3.8-flash'), 'gemini-3.8-flash');
assert.equal(normalizeModelSlug('acme/extra-1:free'), 'extra-1');

{
  const scores = loadSweBenchScores(path.join(path.dirname(fileURLToPath(import.meta.url)), 'swe-bench.json'));
  assert.equal(sweBenchScoreFor(scores, 'nvidia/nemotron-3-super-120b-a12b:free'), 60.5);
  assert.equal(sweBenchScoreFor(scores, 'openrouter:nvidia/nemotron-3-super-120b-a12b'), 60.5);
  assert.equal(sweBenchScoreFor(scores, 'z-ai/glm5'), 77.8);
  assert.equal(sweBenchScoreFor(scores, 'z-ai/glm-5.2:free'), 77.8);
  assert.equal(sweBenchScoreFor(scores, 'glm-5.3-flash'), 77.8);
  assert.equal(sweBenchScoreFor(scores, 'gemini-3.8-flash'), 80.0);
  assert.equal(sweBenchScoreFor(scores, 'gemini:gemini-3.7-flash'), 80.8);
  assert.equal(sweBenchScoreFor(scores, 'google/gemini-3.8-flash:free'), 80.0);
  assert.equal(sweBenchScoreFor(scores, 'gemini-3.5-flash'), 78.8);
  assert.equal(sweBenchScoreFor(scores, 'gemini-3.5-flash-lite'), 75.0);
  assert.equal(sweBenchScoreFor(scores, 'gemini-3.6-flash'), 79.6);
  assert.equal(sweBenchScoreFor(scores, 'qwen/qwen3.8-27b:free'), 86.0);
  assert.equal(sweBenchScoreFor(scores, 'nex-agi/nex-n2.5-pro:free'), 80.8);
  assert.equal(sweBenchScoreFor(scores, 'google/gemma-4-31b-it:free'), 52.0);
  assert.equal(sweBenchScoreFor(scores, 'hy3'), null);
  assert.equal(sweBenchScoreFor(scores, 'gemma-4-26b-a4b-it'), null);
}

{
  process.env.TEST_MULTI_API_KEY = ' duplicate ';
  process.env.TEST_MULTI_API_KEYS = 'duplicate, key-a ,key-b';
  process.env.TEST_MULTI_API_KEY_KEYS = 'key-b,key-c';
  const resolved = providerKeysFromConfig('testmulti', {
    keyEnv: 'TEST_MULTI_API_KEY',
    keys: [{ name: ' saved ', key: ' file-key ' }, { name: 'duplicate', key: ' duplicate ' }],
  });
  assert.equal(resolved.keys[0].name, 'saved');
  assert.deepEqual(resolved.keys.map(({ key }) => key), [
    'file-key',
    'duplicate',
    'key-a',
    'key-b',
    'key-c',
  ]);
  const registry = createProviderRegistry(
    {
      providers: {
        testmulti: {
          baseUrl: 'http://127.0.0.1',
          keyEnv: 'TEST_MULTI_API_KEY',
          keys: [{ name: 'saved', key: 'file-key' }],
          freeModels: ['model'],
        },
      },
    },
    { host: '127.0.0.1', port: 8787 },
  );
  assert.equal(registry.keySlots('testmulti')[0].key, 'file-key');
  registry.rotateKeyCursor('testmulti');
  assert.equal(registry.keySlots('testmulti')[0].key, 'duplicate');
  registry.setApiKey('testmulti', 'replacement');
  assert.deepEqual(registry.providers.get('testmulti').apiKeys.map(({ key }) => key), [
    'file-key',
    'replacement',
    'duplicate',
    'key-a',
    'key-b',
    'key-c',
  ]);
  registry.setApiKey('testmulti', '');
  assert.deepEqual(registry.providers.get('testmulti').apiKeys.map(({ key }) => key), [
    'file-key',
    'duplicate',
    'key-a',
    'key-b',
    'key-c',
  ]);
  for (const { key } of registry.keySlots('testmulti')) registry.markKeyInvalid('testmulti', key);
  assert.deepEqual(registry.keySlots('testmulti'), []);
  assert.equal(registry.hasUsableKey(registry.providers.get('testmulti')), false);
  assert.equal(providerKeysFromConfig('object-key', { keys: { name: 'main', key: ' value ' } }).keys[0].key, 'value');
  assert.equal(providerKeysFromConfig('string-key', { keys: ' value ' }).keys[0].key, 'value');
  delete process.env.TEST_MULTI_API_KEY;
  delete process.env.TEST_MULTI_API_KEYS;
  delete process.env.TEST_MULTI_API_KEY_KEYS;
}

// Google's native listing, in the shape the live API returns it.
const googleCatalog = normalizeCatalogPayload({
  models: [
    {
      name: 'models/gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      description: 'Fast general model.',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-embedding-2',
      supportedGenerationMethods: ['embedContent', 'countTextTokens'],
    },
    {
      name: 'models/veo-3.1-generate-preview',
      supportedGenerationMethods: ['predictLongRunning'],
    },
    {
      name: 'models/gemini-3.1-flash-live-preview',
      supportedGenerationMethods: ['bidiGenerateContent'],
    },
  ],
});
assert.equal(googleCatalog.shape, 'google');
// The "models/" prefix is dropped so catalog IDs match what config.json and
// the chat endpoint use.
assert.deepEqual(
  googleCatalog.models.map((model) => model.id),
  ['gemini-3.8-flash', 'gemini-embedding-2', 'veo-3.1-generate-preview', 'gemini-3.1-flash-live-preview'],
);
assert.equal(googleCatalog.models[0].context_length, 1048576);
// Declared generation methods decide chat capability; embeddings, video, and
// live audio are excluded without naming them anywhere.
assert.deepEqual(googleCatalog.models.map(isChatModel), [true, false, false, false]);
assert.equal(isMarkedFree({ id: 'z-ai/glm-5.3-free' }), true);
assert.equal(isMarkedFree({ id: 'hy3', free: true }), true);
assert.equal(isMarkedFree({ id: 'nemotron', tags: ['free'] }), true);
assert.equal(isMarkedFree({ id: 'xai/grok-4.6' }), false);
// A listing with no prices must never read as free.
assert.equal(googleCatalog.models[0].pricing, undefined);
// And no OpenAI-style parameter list: treating that as "no tools" would skip
// Gemini on every agent request and dump traffic onto whatever has no catalog.
assert.equal(googleCatalog.models[0].supported_parameters, undefined);
{
  const tools = { tools: true, responseFormat: false, modalities: new Set() };
  const images = { tools: false, responseFormat: false, modalities: new Set(['image']) };
  assert.equal(supportsRequest(googleCatalog.models[0], tools), true);
  assert.equal(supportsRequest(googleCatalog.models[0], images), true);
  assert.equal(supportsRequest({ supported_parameters: [] }, tools), true);
  assert.equal(supportsRequest(null, tools), true);
  assert.equal(supportsRequest({ supported_parameters: ['response_format'] }, tools), false);
  assert.equal(supportsRequest({ supported_parameters: ['tools'] }, tools), true);
  assert.equal(
    supportsRequest({ architecture: { input_modalities: ['text'] } }, images),
    false,
  );
}

const openaiCatalog = normalizeCatalogPayload({ data: [{ id: 'a' }, { nope: 1 }] });
assert.equal(openaiCatalog.shape, 'openai');
assert.deepEqual(openaiCatalog.models.map((model) => model.id), ['a']);
assert.equal(normalizeCatalogPayload({ weird: true }).shape, 'unknown');

// `generateContent` is necessary but not sufficient: Google serves images,
// speech, and music through the same method, so the exclusion patterns in
// the default config carry the rest. These are the real IDs the live listing returns.
{
  const patterns = defaultConfigObject().discovery.exclude.modelPatterns.map(
    (source) => new RegExp(source, 'i'),
  );
  const excluded = (id) => patterns.some((pattern) => pattern.test(`gemini:${id}`));

  for (const id of [
    'gemini-2.5-flash-preview-tts',
    'gemini-3.1-flash-tts-preview',
    'gemini-3-pro-image',
    'gemini-3.1-flash-lite-image',
    'nano-banana-pro-preview',
    'lyria-3.5',
    'lyria-3-clip-preview',
    'gemini-3.5-transcribe',
    'gemini-robotics-er-2-preview',
    'gemini-2.5-computer-use-preview-10-2025',
    'deep-research-pro-preview-12-2025',
    'antigravity-preview-05-2026',
    // Moving aliases: they resolve to a concrete model that is ranked and
    // quota-tracked separately, so routing both double-counts one allowance.
    'gemini-flash-latest',
    'gemini-pro-latest',
  ]) {
    assert.equal(excluded(id), true, `should be excluded: ${id}`);
  }

  for (const id of [
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-3.1-pro-preview',
    'gemma-4-31b-it',
    'gemini-omni-flash-preview',
  ]) {
    assert.equal(excluded(id), false, `should stay a candidate: ${id}`);
  }
}

{
  const defaults = defaultConfigObject();
  assert.deepEqual(defaults.routes['free-best'], []);
  assert.deepEqual(defaults.providers.gemini.freeModels, []);
  assert.deepEqual(defaults.providers.bai.freeModels, []);
  assert.deepEqual(defaults.providers.hashneuron.freeModels, []);
  assert.deepEqual(defaults.providers.tokenrouter.freeModels, []);
  assert.deepEqual(defaults.discovery.evaluation.pinnedModels, []);
  assert.equal(defaults.discovery.provider, undefined);
  assert.equal(defaults.providers.bai.probeFreeTier, true);
  assert.equal(defaults.providers.hashneuron.probeFreeTier, true);
  assert.equal(defaults.providers.tokenrouter.probeFreeTier, true);
}

// Verbatim from a live 429 for gemini-3.1-pro-preview on a free-tier key.
const noFreeTierBody = {
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. ' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro' +
      '\nPlease retry in 56.713473252s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          },
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
          },
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
            quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier',
          },
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
            quotaId: 'GenerateContentInputTokensPerModelPerDay-FreeTier',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '56.713473252s' },
    ],
  },
};
const noFreeTier = parseQuotaFailure(noFreeTierBody);
assert.equal(noFreeTier.noFreeTier, true);
assert.equal(noFreeTier.dailyRequestLimit, null);
assert.equal(noFreeTier.exhaustedWindow, '');
assert.equal(noFreeTier.retryDelayMs, 56714);
// The per-day requests allowance is paired with its window, not just its number.
assert.equal(
  noFreeTier.limits.find((entry) => entry.quotaId.startsWith('GenerateRequestsPerDay')).window,
  'day',
);

// Same shape, but the allowance exists and is merely spent: this must not be
// mistaken for a model that has no free tier.
const exhaustedBody = structuredClone(noFreeTierBody);
exhaustedBody.error.message = exhaustedBody.error.message
  .replace(/generate_content_free_tier_requests, limit: 0/g, 'generate_content_free_tier_requests, limit: 20')
  .replace(
    /generate_content_free_tier_input_token_count, limit: 0/g,
    'generate_content_free_tier_input_token_count, limit: 1000000',
  );
const exhausted = parseQuotaFailure(exhaustedBody);
assert.equal(exhausted.noFreeTier, false);
assert.equal(exhausted.dailyRequestLimit, 20);
assert.equal(exhausted.exhaustedWindow, 'day');

// The decisive case: one free-tier allowance is spent while another reads
// zero. Only a model with no nonzero allowance anywhere lacks a free tier, so
// treating "any zero" as proof would permanently drop a working model.
const mixedBody = structuredClone(noFreeTierBody);
mixedBody.error.message = mixedBody.error.message.replace(
  /generate_content_free_tier_requests, limit: 0/g,
  'generate_content_free_tier_requests, limit: 20',
);
const mixed = parseQuotaFailure(mixedBody);
assert.equal(mixed.noFreeTier, false);
assert.equal(mixed.dailyRequestLimit, 20);

assert.equal(parseQuotaFailure({ error: { message: 'nothing to do with quota' } }), null);

assert.match(
  permanentRejection(404, {
    error: { message: 'This model models/gemini-2.5-pro is no longer available to new users.' },
  }),
  /withdrawn/,
);
assert.match(permanentRejection(404, {}), /not served here/);
assert.match(
  permanentRejection(400, { error: { message: 'This model only supports Interactions API.' } }),
  /not a chat/,
);
assert.equal(permanentRejection(429, { error: { message: 'quota' } }), '');
assert.equal(
  zeroBalanceRejection(400, {
    error: { message: 'credit insufficient balance: balance=0 required=2126' },
  }),
  'provider account balance is zero',
);
assert.equal(
  zeroBalanceRejection(400, {
    error: { message: 'credit insufficient balance: balance=12 required=2126' },
  }),
  '',
);
assert.equal(zeroBalanceRejection(503, { error: { message: 'balance=0' } }), '');

// A daily quota resets at Pacific midnight, so the wait is until that boundary
// rather than a fixed interval. In September that is UTC-7, and the result
// carries a one minute cushion so the retry lands past the boundary.
const minute = 60000;
// 23:50 Pacific: ten minutes left in the quota day.
assert.equal(msUntilQuotaReset(Date.parse('2026-09-08T06:50:00Z')), 11 * minute);
// 01:05 Pacific: almost a full day to wait, and notably not a fixed 10 minutes.
assert.equal(msUntilQuotaReset(Date.parse('2026-09-08T08:05:00Z')), (22 * 60 + 56) * minute);

// Paths shown in the interface or the log must not carry the username.
assert.equal(displayPath(path.join(os.homedir(), 'free-router', '.env')), '~/free-router/.env');
assert.equal(displayPath(os.homedir()), '~');
assert.equal(displayPath('/etc/free-router/.env'), '/etc/free-router/.env');
assert.equal(displayPath(''), '');

assert.equal(maskSecret('').length, 0);
assert.equal(maskSecret('short'), '*****');
assert.equal(maskSecret('sk-or-v1-0123456789abcdef'), 'sk-or********cdef');
assert.equal(maskSecret('sk-or-v1-0123456789abcdef').includes('0123456789'), false);
assert.match(validateSecret('ok\nNODE_OPTIONS=x'), /newline/);
assert.equal(validateSecret('sk-normal-key'), '');

// Layered config: base defaults + sparse overlay, tombstones for deletions,
// additive-only schema migrations.
{
  const base = {
    host: '127.0.0.1',
    nested: { keep: 1, overrideMe: 'base' },
    list: ['a', 'b'],
    routes: { r1: ['x'], r2: ['y'] },
    providers: { p1: { baseUrl: 'https://a', freeModels: ['m'] } },
  };
  // Overlay wins per key; arrays replace wholesale; base-only branches are
  // cloned so mutating the live view never touches base objects.
  const merged = deepMerge(base, { nested: { overrideMe: 'user' }, list: ['c'] });
  assert.deepEqual(merged, {
    host: '127.0.0.1',
    nested: { keep: 1, overrideMe: 'user' },
    list: ['c'],
    routes: { r1: ['x'], r2: ['y'] },
    providers: { p1: { baseUrl: 'https://a', freeModels: ['m'] } },
  });
  merged.nested.keep = 99;
  merged.providers.p1.freeModels.push('zzz');
  assert.equal(base.nested.keep, 1);
  assert.deepEqual(base.providers.p1.freeModels, ['m']);
  // Tombstones keep operator deletions sticky across restarts.
  const live = buildLiveConfig(base, {
    routes: { r3: ['z'] },
    _removedRoutes: ['r1'],
    _removedProviders: ['p1'],
  });
  assert.deepEqual(Object.keys(live.routes).sort(), ['r2', 'r3']);
  assert.deepEqual(live.providers, {});
  // Schema migrations only add missing skeleton keys, never overwrite.
  const overlay = { custom: 'mine', nested: { overrideMe: 'user' } };
  assert.equal(runOverlayMigrations(overlay), true);
  assert.equal(overlay._schemaVersion, SCHEMA_VERSION);
  assert.equal(
    runOverlayMigrations(overlay),
    false,
    'second run is a no-op',
  );
  const target = { a: 1, nested: { x: 1 } };
  assert.equal(addMissingKeys(target, { a: 2, b: 3, nested: { x: 2, y: 4 } }), true);
  assert.deepEqual(target, { a: 1, b: 3, nested: { x: 1, y: 4 } });
  assert.equal(addMissingKeys(target, { a: 1, b: 3, nested: { x: 1, y: 4 } }), false);
}

assert.deepEqual(canonicalizeRouteEntry('poolside/laguna-s-2.1:free'), {
  provider: 'openrouter',
  model: 'poolside/laguna-s-2.1:free',
});
assert.deepEqual(canonicalizeRouteEntry('openrouter:poolside/laguna-s-2.1:free'), {
  provider: 'openrouter',
  model: 'poolside/laguna-s-2.1:free',
});
assert.deepEqual(canonicalizeRouteEntry('google/gemma-4-31b-it:free'), {
  provider: 'openrouter',
  model: 'google/gemma-4-31b-it:free',
});
assert.deepEqual(canonicalizeRouteEntry('hashneuron:hy3', 'openrouter', new Set(['openrouter', 'hashneuron'])), {
  provider: 'hashneuron',
  model: 'hy3',
});
assert.deepEqual(canonicalizeRouteEntry({ provider: 'hashneuron', model: 'hy3' }), {
  provider: 'hashneuron',
  model: 'hy3',
});
assert.equal(canonicalizeRouteEntry('tokenrouter:'), null);

{
  const live = buildLiveConfig(
    {
      defaultProvider: 'openrouter',
      providers: { openrouter: {}, hashneuron: {} },
      routes: {
        'free-best': [
          'poolside/laguna-s-2.1:free',
          { provider: 'hashneuron', model: 'hy3' },
          'hashneuron:qwen3.8-flash',
        ],
      },
    },
    {},
  );
  assert.deepEqual(live.routes['free-best'], [
    { provider: 'openrouter', model: 'poolside/laguna-s-2.1:free' },
    { provider: 'hashneuron', model: 'hy3' },
    { provider: 'hashneuron', model: 'qwen3.8-flash' },
  ]);
  const overlay = {
    _schemaVersion: SCHEMA_VERSION,
    routes: { 'free-best': ['thinkingmachines/inkling:free', 'hashneuron:hy3'] },
  };
  assert.equal(runOverlayMigrations(overlay), true);
  assert.deepEqual(overlay.routes['free-best'], [
    { provider: 'openrouter', model: 'thinkingmachines/inkling:free' },
    { provider: 'hashneuron', model: 'hy3' },
  ]);
  assert.equal(runOverlayMigrations(overlay), false);
  const staleDiscovery = {
    _schemaVersion: SCHEMA_VERSION,
    discovery: { enabled: true, provider: 'openrouter' },
  };
  assert.equal(runOverlayMigrations(staleDiscovery), true);
  assert.equal(staleDiscovery.discovery.provider, undefined);
  assert.equal(runOverlayMigrations(staleDiscovery), false);
}

assert.equal(providerNeedsThoughtSignatures({ name: 'gemini', baseUrl: 'http://127.0.0.1' }), true);
assert.equal(
  providerNeedsThoughtSignatures({
    name: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  }),
  true,
);
assert.equal(providerNeedsThoughtSignatures({ name: 'bai', baseUrl: 'https://api.b.ai/v1' }), false);
assert.equal(
  isMissingThoughtSignatureError(
    400,
    'Function call is missing a thought_signature in functionCall parts',
  ),
  true,
);
assert.equal(isMissingThoughtSignatureError(400, 'bad request'), false);
assert.equal(isMissingThoughtSignatureError(429, 'thought_signature'), false);

{
  const cache = createThoughtSignatureCache(2);
  cache.remember('a', 'sig-a');
  cache.remember('b', 'sig-b');
  cache.remember('c', 'sig-c');
  assert.equal(cache.lookup('a'), '');
  assert.equal(cache.lookup('c'), 'sig-c');
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_keep',
            type: 'function',
            function: { name: 'search_files', arguments: '{}' },
            extra_content: { google: { thought_signature: 'KEEP' } },
          },
          {
            id: 'call_cached',
            type: 'function',
            function: { name: 'terminal', arguments: '{}' },
          },
          {
            id: 'call_skip',
            type: 'function',
            function: { name: 'other', arguments: '{}' },
          },
        ],
      },
    ],
  };
  cache.remember('call_cached', 'CACHED');
  injectThoughtSignatures(body, cache);
  assert.equal(readThoughtSignature(body.messages[1].tool_calls[0]), 'KEEP');
  assert.equal(readThoughtSignature(body.messages[1].tool_calls[1]), 'CACHED');
  assert.equal(readThoughtSignature(body.messages[1].tool_calls[2]), SKIP_THOUGHT_SIGNATURE);
}

{
  const cache = createThoughtSignatureCache();
  rememberSignaturesFromPayload(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_json',
                extra_content: { google: { thoughtSignature: 'JSON-SIG' } },
              },
            ],
          },
        },
      ],
    },
    cache,
  );
  assert.equal(cache.lookup('call_json'), 'JSON-SIG');
  const streamCache = createThoughtSignatureCache();
  const extractor = createStreamSignatureExtractor((id, signature) => {
    streamCache.remember(id, signature);
  });
  extractor.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_files","arguments":"{}"}}]}}]}\n',
  );
  extractor.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"extra_content":{"google":{"thought_signature":"STREAM-SIG"}}}]}}]}\n\n',
  );
  extractor.flush();
  assert.equal(streamCache.lookup('call_1'), 'STREAM-SIG');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const mock = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: [
          'mock-a',
          'mock-b',
          'mock-new',
          'mock-dead',
          'mock-audio',
          'acme/extra-1:free',
          'mock-domain',
        ].map((id) => ({
          id,
          description:
            id === 'mock-domain'
              ? 'A finance-focused mixture-of-experts model for investment research.'
              : 'A general purpose text model.',
          pricing:
            id === 'mock-b'
              ? { prompt: '0.000001', completion: '0.000001' }
              : { prompt: '0', completion: '0' },
          supported_parameters: ['tools', 'response_format'],
          architecture: {
            input_modalities: ['text'],
            output_modalities: id === 'mock-audio' ? ['text', 'audio'] : ['text'],
          },
        })),
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model === 'mock-dead') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No endpoints found' } }));
      return;
    }
    const isEvaluation = body.messages?.some(
      (message) => typeof message.content === 'string' && message.content.includes('OX-RANK-7'),
    );
    if (isEvaluation) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  token: 'OX-RANK-7',
                  crt: 269,
                  trace: '1-3',
                  path: 10,
                  sequence: 42,
                  binary: 55,
                  derange: 44,
                  recur: 26,
                  modpow: 49,
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (body.model === 'mock-a') {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning: 'thinking only' }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
      } else {
        res.write(
          `data: ${JSON.stringify({
            model: 'mock-b',
            choices: [{ delta: { content: 'router-ok' }, finish_reason: null }],
          })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message:
              body.model === 'mock-a'
                ? { role: 'assistant', content: '', reasoning: 'thinking only' }
                : { role: 'assistant', content: 'router-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let tokenRouterRequests = 0;
const tokenRouterMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
    tokenRouterRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const shouldFail = body.messages?.some(
      (message) => message.content === 'force-token-failure',
    );
    if (shouldFail) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tokenrouter rate limited' } }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'glm-5.3',
        choices: [
          {
            message: { role: 'assistant', content: 'tokenrouter-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let baiRequests = 0;
let lastBaiBody = null;
let lastBaiAuth = '';
const baiMock = http.createServer(async (req, res) => {
  // A price-free catalog, in the shape Gemini's OpenAI-compat endpoint returns:
  // ids carry a "models/" prefix and glm-withdrawn is simply absent.
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'models/glm-5.3-flash', object: 'model', owned_by: 'bai' },
          // Not in freeModels, so these three are probe candidates: one is
          // served, one has no free allowance, one is not a chat model at all.
          { id: 'models/glm-5.3-pro', object: 'model', owned_by: 'bai' },
          { id: 'models/glm-5.3-paid', object: 'model', owned_by: 'bai' },
          {
            id: 'models/glm-5.3-embed',
            object: 'model',
            architecture: { output_modalities: ['embedding'] },
          },
        ],
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    baiRequests += 1;
    lastBaiAuth = req.headers.authorization || '';
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    lastBaiBody = body;
    // Probes address a model by the id the catalog published, prefix included.
    if (normalizeModelSlug(body.model) === 'glm-5.3-paid') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      // Wrapped in an array, the way Gemini's OpenAI-compatible layer returns
      // errors. Read as an object, `error.message` is missing and the whole
      // reason for the refusal is lost.
      res.end(JSON.stringify([quotaRejection(0)]));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [{ delta: { content: 'bai-ok' }, finish_reason: null }],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: 'assistant', content: 'bai-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let extraRequests = 0;
const extraMock = http.createServer(async (req, res) => {
  // A catalog that cannot be fetched must not empty the route: freeModels stays
  // authoritative and availability checking is simply skipped.
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'catalog unavailable' } }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    extraRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const shouldFail = body.messages?.some(
      (message) => message.content === 'force-extra-failure',
    );
    if (shouldFail) {
      // Empty 200: ranking reliability must react to a useless reply, not to
      // a 429. Quota exhaustion is congestion, not a quality signal.
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        }),
      );
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: 'assistant', content: 'extra-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let geminiRequests = 0;
let lastGeminiBody = null;
const geminiMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1beta/openai/chat/completions') {
    geminiRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    lastGeminiBody = body;
    const forceMissing = body.messages?.some(
      (message) => message.content === 'force-thought-signature-400',
    );
    const missingSignature = (body.messages || []).some(
      (message) =>
        Array.isArray(message.tool_calls) &&
        message.tool_calls.some((call) => !readThoughtSignature(call)),
    );
    if (forceMissing || missingSignature) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            error: {
              code: 400,
              message:
                'Function call is missing a thought_signature in functionCall parts. https://ai.google.dev/gemini-api/docs/thought-signatures',
            },
          },
        ]),
      );
      return;
    }
    if (body.stream && body.messages?.some((message) => message.content === 'need-tools-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_stream',
                    type: 'function',
                    function: { name: 'search_files', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    extra_content: { google: { thought_signature: 'STREAM-SIG' } },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (body.messages?.some((message) => message.content === 'need-tools-json')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_json',
                    type: 'function',
                    function: { name: 'search_files', arguments: '{}' },
                    extra_content: { google: { thought_signature: 'JSON-SIG' } },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: 'gemini-ok' }, finish_reason: 'stop' }],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

// Mimics Gemini's quota rejection so the two meanings of 429 can be told apart
// end to end: no free allowance at all, versus today's allowance spent.
function quotaRejection(limit) {
  const metric = (suffix) => `generativelanguage.googleapis.com/generate_content_${suffix}`;
  const lines = [
    `${metric('free_tier_requests')}, limit: ${limit}`,
    `${metric('free_tier_requests')}, limit: ${limit}`,
    `${metric('free_tier_input_token_count')}, limit: ${limit === 0 ? 0 : 1000000}`,
    `${metric('free_tier_input_token_count')}, limit: ${limit === 0 ? 0 : 1000000}`,
  ].map((line) => `* Quota exceeded for metric: ${line}, model: mock`);
  return {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: `You exceeded your current quota.\n${lines.join('\n')}\nPlease retry in 42.5s.`,
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            ['free_tier_requests', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'],
            ['free_tier_requests', 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'],
            ['free_tier_input_token_count', 'GenerateContentInputTokensPerModelPerMinute-FreeTier'],
            ['free_tier_input_token_count', 'GenerateContentInputTokensPerModelPerDay-FreeTier'],
          ].map(([suffix, quotaId]) => ({ quotaMetric: metric(suffix), quotaId })),
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42.5s' },
      ],
    },
  };
}

let quotaRequests = 0;
const quotaMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    quotaRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(quotaRejection(model === 'no-free-tier' ? 0 : 20)));
    return;
  }
  res.writeHead(404).end();
});

const multiKeyRequests = [];
const multiKeyMock = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  multiKeyRequests.push(key);
  if (key === 'bad-key') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    return;
  }
  if (key === 'rate-key') {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(quotaRejection(20)));
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: key }, finish_reason: 'stop' }],
    }),
  );
});

await listen(mock);
const mockPort = mock.address().port;
await listen(quotaMock);
const quotaPort = quotaMock.address().port;
await listen(tokenRouterMock);
const tokenRouterPort = tokenRouterMock.address().port;
await listen(baiMock);
const baiPort = baiMock.address().port;
await listen(extraMock);
const extraPort = extraMock.address().port;
await listen(geminiMock);
const geminiPort = geminiMock.address().port;
await listen(multiKeyMock);
const multiKeyPort = multiKeyMock.address().port;

const portProbe = http.createServer();
await listen(portProbe);
const routerPort = portProbe.address().port;
await close(portProbe);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-test-'));
const testConfig = path.join(tempDir, 'config.json');
fs.writeFileSync(
  testConfig,
  JSON.stringify({
    host: '127.0.0.1',
    port: routerPort,
    attemptTimeoutMs: 5000,
    catalogRefreshMs: 1000,
    defaultProvider: 'openrouter',
    providers: {
      openrouter: {
        catalog: true,
        pricing: true,
        baseUrl: `http://127.0.0.1:${mockPort}/api/v1`,
        keyEnv: 'OPENROUTER_API_KEY',
      },
      tokenrouter: {
        baseUrl: `http://127.0.0.1:${tokenRouterPort}/api/v1`,
        keyEnv: 'TOKENROUTER_API_KEY',
        freeModels: ['z-ai/glm-5.3-free'],
      },
      bai: {
        catalog: true,
        pricing: false,
        probeFreeTier: true,
        baseUrl: `http://127.0.0.1:${baiPort}/v1`,
        keyEnv: 'BAI_API_KEY',
        freeModels: ['glm-5.3-flash', 'glm-withdrawn'],
      },
      extra: {
        catalog: true,
        pricing: false,
        baseUrl: `http://127.0.0.1:${extraPort}/v1`,
        keyEnv: 'EXTRA_API_KEY',
        freeModels: ['extra-1'],
      },
      gemini: {
        baseUrl: `http://127.0.0.1:${geminiPort}/v1beta/openai`,
        keyEnv: 'GEMINI_API_KEY',
        freeModels: ['gemini-3.8-flash', 'gemini-3.7-flash'],
      },
      // No dailyLimits entry anywhere in this config: the limit for
      // daily-exhausted has to be learned from the provider's own 429.
      quotamock: {
        baseUrl: `http://127.0.0.1:${quotaPort}/v1`,
        keyEnv: 'QUOTAMOCK_API_KEY',
        freeModels: ['no-free-tier', 'daily-exhausted'],
      },
      multikey: {
        baseUrl: `http://127.0.0.1:${multiKeyPort}/v1`,
        keyEnv: 'MULTIKEY_API_KEY',
        freeModels: ['multi-model'],
      },
      roundrobin: {
        baseUrl: `http://127.0.0.1:${multiKeyPort}/v1`,
        keyEnv: 'ROUNDROBIN_API_KEY',
        freeModels: ['multi-model'],
      },
      cooldownmulti: {
        baseUrl: `http://127.0.0.1:${multiKeyPort}/v1`,
        keyEnv: 'COOLDOWNMULTI_API_KEY',
        freeModels: ['multi-model'],
      },
    },
    discovery: {
      enabled: true,
      intervalMs: 604800000,
      route: 'test-route',
      stateFile: 'discovered-free-models.json',
      exclude: {
        textPatterns: ['\\b(finance|medicine)[\\s-]*focused\\b'],
      },
      evaluation: {
        enabled: true,
        pinnedModels: ['tokenrouter:z-ai/glm-5.3-free', 'bai:glm-5.3-flash'],
        baselineScores: { 'mock-b': 80 },
        usageWeight: 12,
        usageMinRequests: 2,
      },
    },
    cooldownMs: {},
    usage: {
      retentionDays: 3,
      timezone: 'UTC',
      dailyLimits: { 'bai:glm-5.3-flash': 5, 'tokenrouter:*': 50 },
    },
    routes: {
      'test-route': [
        { provider: 'tokenrouter', model: 'z-ai/glm-5.3-free' },
        { provider: 'bai', model: 'glm-5.3-flash' },
        'mock-a',
        'mock-b',
        { provider: 'extra', model: 'extra-1' },
        { provider: 'bai', model: 'glm-withdrawn' },
        { provider: 'quotamock', model: 'no-free-tier' },
        { provider: 'quotamock', model: 'daily-exhausted' },
      ],
      'tool-fallback': [
        { provider: 'gemini', model: 'gemini-3.8-flash' },
        { provider: 'gemini', model: 'gemini-3.7-flash' },
      ],
      'cooldown-route': [
        { provider: 'cooldownmulti', model: 'multi-model' },
      ],
    },
  }),
);

const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  env: {
    ...process.env,
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/api/v1`,
    TOKENROUTER_API_KEY: 'token-test-key',
    TOKENROUTER_BASE_URL: `http://127.0.0.1:${tokenRouterPort}/api/v1`,
    BAI_API_KEY: 'bai-test-key',
    BAI_BASE_URL: `http://127.0.0.1:${baiPort}/v1`,
    EXTRA_API_KEY: 'extra-test-key',
    EXTRA_BASE_URL: `http://127.0.0.1:${extraPort}/v1`,
    GEMINI_API_KEY: 'gemini-test-key',
    GEMINI_BASE_URL: `http://127.0.0.1:${geminiPort}/v1beta/openai`,
    QUOTAMOCK_API_KEY: 'quota-test-key',
    QUOTAMOCK_BASE_URL: `http://127.0.0.1:${quotaPort}/v1`,
    MULTIKEY_API_KEYS: 'bad-key,good-key',
    ROUNDROBIN_API_KEYS: 'round-a,round-b',
    COOLDOWNMULTI_API_KEYS: 'rate-key,cooldown-good',
    FREE_ROUTER_CONFIG: testConfig,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let childOutput = '';
child.stdout.on('data', (chunk) => {
  childOutput += chunk;
});
child.stderr.on('data', (chunk) => {
  childOutput += chunk;
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${routerPort}/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.discovery?.lastCheckedAt) return health;
      }
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`router did not start\n${childOutput}`);
}

try {
  const health = await waitForHealth();
  assert.equal(health.version, PACKAGE_VERSION);
  // mock-new came from the priced catalog; glm-5.3-pro came from asking bai to
  // serve a model its price-free catalog says nothing about.
  assert.deepEqual(health.discovery.addedModels, ['openrouter:mock-new', 'bai:models/glm-5.3-pro']);
  // Catalog $0 is not enough: a live chat probe has to return 200 unpaid.
  assert.equal(
    health.discovery.addedModels.includes('mock-dead'),
    false,
  );
  assert.equal(
    health.routes['test-route'].some((entry) => entry.id === 'mock-dead'),
    false,
  );

  const probeVerdicts = health.discovery.modelVerdicts;
  assert.equal(probeVerdicts['openrouter:mock-new'].free, true);
  assert.match(probeVerdicts['openrouter:mock-new'].reason, /probe 200 unpaid/);
  assert.equal(probeVerdicts['openrouter:mock-dead'].free, false);
  assert.match(probeVerdicts['openrouter:mock-dead'].reason, /HTTP 404/);
  assert.equal(health.discovery.evaluations['mock-dead'], undefined);
  assert.equal(probeVerdicts['bai:models/glm-5.3-pro'].free, true);
  assert.match(probeVerdicts['bai:models/glm-5.3-pro'].reason, /probe 200 unpaid|served a free-tier request/);
  // Answered 429, so it never enters a route.
  assert.equal(probeVerdicts['bai:models/glm-5.3-paid'].free, false);
  assert.match(probeVerdicts['bai:models/glm-5.3-paid'].reason, /HTTP 429/);
  assert.equal(
    health.routes['test-route'].some((entry) => entry.id.includes('glm-5.3-paid')),
    false,
  );
  // Not a chat model, so it was filtered out before any request was spent on it.
  assert.equal(probeVerdicts['bai:models/glm-5.3-embed'], undefined);
  // Configured under a bare id; the catalog spelling still gets a live probe.
  assert.equal(probeVerdicts['bai:glm-5.3-flash'].free, true);
  assert.match(probeVerdicts['bai:glm-5.3-flash'].reason, /probe 200 unpaid/);
  assert.equal(
    health.routes['test-route'].filter((entry) => entry.id.includes('glm-5.3-flash')).length,
    1,
  );
  // A domain-tuned model is free and chat-capable, but must not be auto-routed
  // or spend an evaluation on it.
  assert.deepEqual(health.discovery.excludedModels, ['openrouter:mock-domain']);
  assert.equal(health.discovery.evaluations['mock-domain'], undefined);
  assert.equal(
    health.routes['test-route'].some((entry) => entry.id === 'mock-domain'),
    false,
  );
  // Pins first, then the saved route order, then discovered models by SWE.
  assert.deepEqual(
    health.routes['test-route'].map((entry) => `${entry.provider}:${entry.id}`),
    [
      'tokenrouter:z-ai/glm-5.3-free',
      'bai:glm-5.3-flash',
      'openrouter:mock-a',
      'extra:extra-1',
      'openrouter:acme/extra-1:free',
      'quotamock:no-free-tier',
      'quotamock:daily-exhausted',
      'bai:models/glm-5.3-pro',
      'openrouter:mock-new',
    ],
  );
  const mockNewEvaluation = health.discovery.evaluations['mock-new'];
  assert.equal(mockNewEvaluation.version, 2);
  assert.equal(mockNewEvaluation.benchmarkScore, 65);
  assert.equal(mockNewEvaluation.metadataScore, 12);
  assert.equal(mockNewEvaluation.latencyScore, 6);
  assert.equal(mockNewEvaluation.score, 83);
  assert.equal(health.defaultProvider, 'openrouter');
  assert.equal(health.providers.openrouter.kind, 'catalog');
  assert.equal(health.providers.tokenrouter.kind, 'static');
  assert.equal(health.providers.extra.configured, true);

  // Priced catalogs and probeFreeTier catalogs both add models; extra has a
  // catalog only so it can notice withdrawals.
  assert.deepEqual(health.discovery.addsFrom, ['openrouter', 'bai']);
  assert.deepEqual(health.discovery.availabilityOnly, ['extra']);
  assert.equal(health.providers.bai.kind, 'static+catalog');

  // glm-5.3-flash is listed upstream as "models/glm-5.3-flash": a spelling
  // difference must not read as a withdrawal.
  assert.deepEqual(health.providers.bai.unavailableModels, ['glm-withdrawn']);
  assert.deepEqual(health.discovery.unavailableModels, ['bai:glm-withdrawn']);
  assert.equal(
    health.routes['test-route'].some((entry) => entry.id === 'glm-withdrawn'),
    false,
  );
  // An allowlisted model is free by configuration, so a catalog without prices
  // must not make it look paid.
  assert.equal(
    health.routes['test-route'].find((entry) => entry.id === 'glm-5.3-flash').zeroCost,
    true,
  );
  // extra's catalog request fails, which must leave its allowlist authoritative
  // instead of dropping the provider from the route.
  assert.equal(health.providers.extra.kind, 'static+catalog');
  assert.deepEqual(health.providers.extra.unavailableModels, []);
  assert.equal(
    health.routes['test-route'].some((entry) => entry.id === 'extra-1'),
    true,
  );
  assert.ok(health.providers.extra.catalogError);
  assert.deepEqual(health.discovery.removedModels, ['openrouter:mock-b', 'bai:glm-withdrawn']);
  assert.equal(health.discovery.evaluations['mock-new'].status, 'scored');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(tempDir, 'discovered-free-models.json'), 'utf8'))
      .addedModels[0],
    'openrouter:mock-new',
  );
  const modelsResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/models`);
  assert.equal(modelsResponse.status, 200);
  const callMulti = async (provider) => {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `${provider}:multi-model`,
        messages: [{ role: 'user', content: 'multi-key' }],
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).choices[0].message.content;
  };
  assert.equal(await callMulti('multikey'), 'good-key');
  assert.deepEqual(multiKeyRequests.splice(0), ['bad-key', 'good-key']);
  assert.deepEqual(
    [await callMulti('roundrobin'), await callMulti('roundrobin'), await callMulti('roundrobin')],
    ['round-a', 'round-b', 'round-a'],
  );
  assert.deepEqual(multiKeyRequests.splice(0), ['round-a', 'round-b', 'round-a']);
  assert.equal(await callMulti('cooldownmulti'), 'cooldown-good');
  assert.deepEqual(multiKeyRequests.splice(0), ['rate-key', 'cooldown-good']);
  const multiHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) => res.json());
  assert.equal(multiHealth.routes['cooldown-route'][0].cooldownSeconds, 0);
  const models = await modelsResponse.json();
  // Exclusion only removes a model from automatic ranking. It stays listed and
  // callable by explicit ID, since asking for it by name is a deliberate choice.
  assert.deepEqual(
    models.data.map((model) => model.id),
    [
      'test-route',
      'tool-fallback',
      'cooldown-route',
      'z-ai/glm-5.3-free',
      'glm-5.3-flash',
      'extra-1',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'no-free-tier',
      'daily-exhausted',
      'multi-model',
      'acme/extra-1:free',
      'mock-a',
      'mock-domain',
      'mock-new',
    ],
  );
  const request = {
    model: 'test-route',
    messages: [{ role: 'user', content: 'force-token-failure' }],
  };

  const jsonResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get('x-free-router-provider'), 'bai');
  assert.equal(jsonResponse.headers.get('x-free-router-model'), 'glm-5.3-flash');
  const json = await jsonResponse.json();
  assert.equal(json.model, 'glm-5.3-flash');
  assert.equal(json.choices[0].message.content, 'bai-ok');

  const streamResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    },
  );
  assert.equal(streamResponse.status, 200);
  assert.equal(streamResponse.headers.get('x-free-router-provider'), 'bai');
  assert.equal(streamResponse.headers.get('x-free-router-model'), 'glm-5.3-flash');
  const stream = await streamResponse.text();
  assert.match(stream, /bai-ok/);
  assert.doesNotMatch(stream, /thinking only/);

  const directTokenRouterResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'z-ai/glm-5.3-free',
        messages: [{ role: 'user', content: 'token-success' }],
      }),
    },
  );
  assert.equal(directTokenRouterResponse.status, 200);
  assert.equal(
    directTokenRouterResponse.headers.get('x-free-router-provider'),
    'tokenrouter',
  );
  assert.equal(
    (await directTokenRouterResponse.json()).choices[0].message.content,
    'tokenrouter-ok',
  );

  const updatedHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  assert.equal(updatedHealth.lastSelection.route, 'z-ai/glm-5.3-free');
  assert.equal(updatedHealth.lastSelection.provider, 'tokenrouter');
  assert.equal(updatedHealth.lastSelection.model, 'z-ai/glm-5.3-free');
  const directBaiResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'bai-success' }],
      }),
    },
  );
  assert.equal(directBaiResponse.status, 200);
  assert.equal(directBaiResponse.headers.get('x-free-router-provider'), 'bai');
  assert.equal((await directBaiResponse.json()).choices[0].message.content, 'bai-ok');

  const afterBaiHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  assert.equal(afterBaiHealth.lastSelection.provider, 'bai');
  assert.equal(afterBaiHealth.lastSelection.model, 'glm-5.3-flash');

  const directExtraResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'extra-1',
        messages: [{ role: 'user', content: 'extra-success' }],
      }),
    },
  );
  assert.equal(directExtraResponse.status, 200);
  assert.equal(directExtraResponse.headers.get('x-free-router-provider'), 'extra');
  assert.equal((await directExtraResponse.json()).choices[0].message.content, 'extra-ok');
  assert.ok(extraRequests >= 1);

  const extraFailoverResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'extra-1',
        messages: [{ role: 'user', content: 'force-extra-failure' }],
      }),
    },
  );
  assert.equal(extraFailoverResponse.status, 200);
  assert.equal(extraFailoverResponse.headers.get('x-free-router-provider'), 'openrouter');
  assert.equal(extraFailoverResponse.headers.get('x-free-router-model'), 'acme/extra-1:free');
  assert.equal(
    (await extraFailoverResponse.json()).choices[0].message.content,
    'router-ok',
  );

  const geminiSkipResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'search' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_unseen',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_unseen', content: 'found' },
      ],
    }),
  });
  assert.equal(geminiSkipResponse.status, 200);
  assert.equal(readThoughtSignature(lastGeminiBody.messages[1].tool_calls[0]), SKIP_THOUGHT_SIGNATURE);

  const geminiToolResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [{ role: 'user', content: 'need-tools-json' }],
    }),
  });
  assert.equal(geminiToolResponse.status, 200);
  const geminiTools = await geminiToolResponse.json();
  const jsonToolCall = geminiTools.choices[0].message.tool_calls[0];
  assert.equal(readThoughtSignature(jsonToolCall), 'JSON-SIG');
  const geminiReplay = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'need-tools-json' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: jsonToolCall.id,
              type: 'function',
              function: jsonToolCall.function,
            },
          ],
        },
        { role: 'tool', tool_call_id: jsonToolCall.id, content: 'found' },
      ],
    }),
  });
  assert.equal(geminiReplay.status, 200);
  assert.equal(readThoughtSignature(lastGeminiBody.messages[1].tool_calls[0]), 'JSON-SIG');

  const geminiStream = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      stream: true,
      messages: [{ role: 'user', content: 'need-tools-stream' }],
    }),
  });
  assert.equal(geminiStream.status, 200);
  assert.match(await geminiStream.text(), /call_stream/);
  const geminiStreamReplay = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'need-tools-stream' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_stream',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_stream', content: 'found' },
      ],
    }),
  });
  assert.equal(geminiStreamReplay.status, 200);
  assert.equal(readThoughtSignature(lastGeminiBody.messages[1].tool_calls[0]), 'STREAM-SIG');

  const geminiBeforeSkip = geminiRequests;
  const geminiSkipProvider = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'tool-fallback',
      messages: [
        { role: 'user', content: 'force-thought-signature-400' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_force',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_force', content: 'found' },
      ],
    }),
  });
  assert.equal(geminiSkipProvider.status, 502);
  const geminiSkipBody = await geminiSkipProvider.json();
  assert.equal(geminiSkipBody.error.failures.length, 1);
  assert.match(geminiSkipBody.error.failures[0].reason, /thought_signature/);
  assert.equal(geminiRequests, geminiBeforeSkip + 1);

  // Both quota models are in the route and both answer 429, but the reasons
  // differ and so must the consequences.
  for (const model of ['no-free-tier', 'daily-exhausted']) {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `quotamock:${model}`,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 502);
  }

  const quotaHealth = await (await fetch(`http://127.0.0.1:${routerPort}/health`)).json();
  const verdicts = quotaHealth.discovery.modelVerdicts;

  // limit: 0 on every free-tier metric means waiting can never help, so the
  // model is dropped from the route rather than retried forever.
  assert.equal(verdicts['quotamock:no-free-tier'].free, false);
  assert.match(verdicts['quotamock:no-free-tier'].reason, /no free-tier allowance/);
  assert.equal(
    quotaHealth.routes['test-route'].some((entry) => entry.id === 'no-free-tier'),
    false,
  );

  // A positive limit proves the opposite: the model is free, just spent. It
  // stays in the route and the reported number becomes the daily limit, even
  // though no dailyLimits entry exists for it in config.
  assert.equal(verdicts['quotamock:daily-exhausted'].free, true);
  assert.equal(verdicts['quotamock:daily-exhausted'].dailyRequestLimit, 20);
  const exhaustedEntry = quotaHealth.routes['test-route'].find(
    (entry) => entry.id === 'daily-exhausted',
  );
  assert.equal(exhaustedEntry.usage.dailyLimit, 20);
  assert.equal(exhaustedEntry.usage.dailyLimitSource, 'provider');
  assert.equal(
    quotaHealth.usage.models.find((entry) => entry.key === 'quotamock:daily-exhausted')
      .dailyLimitSource,
    'provider',
  );
  // Exhausted for the day, so the wait runs to the quota reset rather than the
  // 42.5s the provider suggested for its per-minute window.
  assert.ok(exhaustedEntry.cooldownSeconds > 3600, `cooldown ${exhaustedEntry.cooldownSeconds}`);

  const leakResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [
          {
            role: 'user',
            content: 'here is bai-test-key in chat',
          },
          {
            role: 'tool',
            content: 'BAI_API_KEY=bai-test-key\nOPENROUTER_API_KEY=test-key',
          },
        ],
      }),
    },
  );
  assert.equal(leakResponse.status, 200);
  const leaked = JSON.stringify(lastBaiBody);
  assert.equal(leaked.includes('bai-test-key'), false);
  assert.equal(leaked.includes('test-key'), false);
  assert.match(leaked, /\[REDACTED\]/);

  assert.ok(tokenRouterRequests >= 3);
  assert.ok(baiRequests >= 3);

  const usageHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  const usage = usageHealth.usage;
  assert.equal(usage.timezone, 'UTC');
  assert.equal(usage.retentionDays, 3);
  assert.equal(usage.days.length, 3);
  const usageByKey = new Map(usage.models.map((entry) => [entry.key, entry]));
  assert.deepEqual(
    [...usageByKey.keys()].sort(),
    [
      'bai:glm-5.3-flash',
      'bai:models/glm-5.3-pro',
      'cooldownmulti:multi-model',
      'extra:extra-1',
      'gemini:gemini-3.8-flash',
      'multikey:multi-model',
      'openrouter:acme/extra-1:free',
      'openrouter:mock-new',
      'quotamock:daily-exhausted',
      'quotamock:no-free-tier',
      'roundrobin:multi-model',
      'tokenrouter:z-ai/glm-5.3-free',
    ],
  );
  // The discovery evaluation burns real quota, so it has to be counted too.
  assert.equal(usageByKey.get('openrouter:mock-new').ok, 1);
  assert.equal(usageByKey.get('bai:glm-5.3-flash').ok, 4);
  assert.equal(usageByKey.get('bai:glm-5.3-flash').fail, 0);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').ok, 1);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').counts.rateLimit, 2);
  assert.equal(usageByKey.get('extra:extra-1').counts.empty, 1);
  assert.equal(usageByKey.get('gemini:gemini-3.8-flash').ok, 5);
  assert.equal(usageByKey.get('gemini:gemini-3.8-flash').fail, 1);
  assert.equal(usageByKey.has('gemini:gemini-3.7-flash'), false);
  // Existing routing plus five successful multi-key requests.
  assert.equal(usage.days[0].ok, 19);
  // Existing failures plus one retired key and one per-key quota cooldown.
  assert.equal(usage.days[0].fail, 8);
  assert.equal(usage.days[0].topModel.key, 'gemini:gemini-3.8-flash');

  // A daily limit only counts attempts the provider actually served, so the
  // two tokenrouter 429s stay out of the consumed total.
  assert.equal(usageByKey.get('bai:glm-5.3-flash').dailyLimit, 5);
  assert.equal(usageByKey.get('bai:glm-5.3-flash').dailyLimitSource, 'config');
  assert.equal(usageByKey.get('bai:glm-5.3-flash').remainingToday, 1);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').dailyLimit, 50);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').remainingToday, 49);
  assert.equal(usageByKey.get('extra:extra-1').dailyLimit, null);
  assert.equal(usageByKey.get('extra:extra-1').remainingToday, null);
  // A 429 never reaches the model, so it does not burn today's consumed count.
  assert.equal(usageByKey.get('quotamock:no-free-tier').today.consumed, 0);

  const routeEntry = usageHealth.routes['test-route'].find(
    (entry) => `${entry.provider}:${entry.id}` === 'bai:glm-5.3-flash',
  );
  assert.equal(routeEntry.usage.today.ok, 4);
  assert.equal(routeEntry.usage.remainingToday, 1);

  const routeByKey = new Map(
    usageHealth.routes['test-route'].map((entry) => [`${entry.provider}:${entry.id}`, entry]),
  );
  // extra:extra-1 served 1 useful reply and 1 empty. Usage is recorded but
  // no longer moves the rank; capability score stays SWE / unranked.
  const extraEntry = routeByKey.get('extra:extra-1');
  assert.equal(extraEntry.baseScore, -1);
  assert.equal(extraEntry.scoreAdjustment, 0);
  assert.equal(extraEntry.score, -1);
  assert.equal(extraEntry.scoreSource, 'baseline');
  assert.equal(routeByKey.get('bai:models/glm-5.3-pro').score, 77.8);
  assert.equal(routeByKey.get('bai:models/glm-5.3-pro').scoreSource, 'swe-bench');
  assert.equal(routeByKey.get('openrouter:mock-new').score, -1);
  // Pinned models are exempt from the numeric rank.
  assert.equal(routeByKey.get('bai:glm-5.3-flash').scoreAdjustment, 0);
  assert.equal(routeByKey.get('openrouter:acme/extra-1:free').scoreAdjustment, 0);
  // Both quotamock models answered 429 earlier, yet only the one with no free
  // allowance is gone. The exhausted one is still a free model and comes back
  // when its quota resets, so it keeps its place.
  assert.deepEqual(
    usageHealth.routes['test-route'].map((entry) => `${entry.provider}:${entry.id}`),
    [
      'tokenrouter:z-ai/glm-5.3-free',
      'bai:glm-5.3-flash',
      'openrouter:mock-a',
      'extra:extra-1',
      'openrouter:acme/extra-1:free',
      'quotamock:daily-exhausted',
      'bai:models/glm-5.3-pro',
      'openrouter:mock-new',
    ],
  );

  const statePath = path.join(tempDir, 'discovered-free-models.json');
  const today = new Date().toISOString().slice(0, 10);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (persisted.usage?.[today]?.['bai:glm-5.3-flash']?.ok === 4) break;
    if (attempt === 39) throw new Error('usage counters were never persisted');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const base = `http://127.0.0.1:${routerPort}`;
  const pageResponse = await fetch(`${base}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /text\/html/);
  assert.match(pageResponse.headers.get('content-security-policy'), /default-src 'none'/);
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /Provider keys/);
  assert.match(pageHtml, /Route priority/);
  assert.match(pageHtml, /key1,key2,key3/);
  assert.ok(
    pageHtml.indexOf('<button data-tab="providers"') <
      pageHtml.indexOf('<button data-tab="routes"') &&
      pageHtml.indexOf('<button data-tab="routes"') <
        pageHtml.indexOf('<button data-tab="status"'),
  );
  assert.equal(pageHtml.includes('id="endpoint"'), false);
  assert.equal(pageHtml.includes('data-tab="access"'), false);
  assert.equal(pageHtml.includes('data-tab="quota"'), false);
  assert.equal(pageHtml.includes('data-tab="settings"'), false);
  assert.equal(pageHtml.includes('id="usage"'), false);
  assert.equal(pageHtml.includes('card_config'), false);
  assert.equal(pageHtml.includes('id="np-create"'), false);
  assert.equal(pageHtml.includes('id="login"'), false);
  assert.equal(pageHtml.includes('admin123'), false);
  assert.equal(pageHtml.includes('Today\'s quota'), false);
  // The page is a template string; an apostrophe in a JS string must not be
  // written as \', or the browser sees a truncated literal and the UI is blank.
  const pageScript = pageHtml.split('<script>')[1]?.split('</script>')[0];
  assert.ok(pageScript);
  new Function(pageScript);
  // The page script is embedded in a JS template literal: a single-backslash
  // regex like /\{(\w+)\}/ would be cooked into /{(w+)}/ and silently break
  // every {var} interpolation. Assert the served bytes kept the backslashes.
  assert.ok(pageHtml.includes('\\{(\\w+)\\}'));

  const uiState = await fetch(`${base}/api/state`).then((res) => res.json());
  const uiHeaders = {
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
  };
  const sessionCookie = '';
  const authedState = uiState;
  assert.ok(authedState.editable.routes['test-route'].includes('openrouter:mock-a'));
  const uiProviders = new Map(authedState.providers.map((entry) => [entry.name, entry]));
  assert.equal(uiProviders.get('bai').configured, true);
  // Gemini is listed first when present; this test config has no gemini, so the
  // first row stays whoever was declared first.
  if (uiProviders.has('gemini')) assert.equal(authedState.providers[0].name, 'gemini');
  assert.equal(uiProviders.get('bai').keyEnv, 'BAI_API_KEY');
  // The real key must never leave the process, only a recognisable stub.
  assert.equal(uiProviders.get('bai').maskedKey.includes('bai-test-key'), false);
  assert.equal(JSON.stringify(authedState).includes('bai-test-key'), false);
  assert.ok(authedState.usage.models.length > 0);
  assert.ok(authedState.routes.length > 0);

  // The interface warns about a rejection only when it contradicts config.json.
  // quotamock:no-free-tier was written into the route by hand, so its refusal is
  // worth surfacing; bai's glm-5.3-paid was merely a probe candidate, and
  // listing every one of those would bury the case that needs attention.
  assert.deepEqual(
    authedState.excludedByProvider.map((entry) => entry.key),
    ['quotamock:no-free-tier'],
  );
  assert.match(authedState.excludedByProvider[0].reason, /no free-tier allowance/);
  // Still recorded in full for diagnosis, just not shown as a warning.
  const fullVerdicts = await (await fetch(`${base}/health`)).json();
  assert.equal(fullVerdicts.discovery.modelVerdicts['bai:models/glm-5.3-paid'].free, false);

  // A browser request from another site must be rejected before it can write.
  const csrf = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ provider: 'bai', key: 'attacker-key' }),
  });
  assert.equal(csrf.status, 403);
  // fetch() silently drops a Host override, so this one needs a raw request.
  const rebind = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: routerPort,
        path: '/api/state',
        method: 'GET',
        headers: { Host: 'evil.example.com' },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(rebind, 403);
  const badOrigin = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ provider: 'bai', key: 'attacker-key' }),
  });
  assert.equal(badOrigin.status, 403);

  // Only known providers, so the env file cannot gain arbitrary variables.
  const unknownProvider = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'NODE_OPTIONS', key: '--require /tmp/evil.js' }),
  });
  assert.equal(unknownProvider.status, 400);
  const newlineInjection = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'bai', key: 'ok\nNODE_OPTIONS=--require /tmp/evil.js' }),
  });
  assert.equal(newlineInjection.status, 400);

  const envPath = path.join(tempDir, '.env');
  assert.equal(fs.existsSync(envPath), false);

  const saved = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'bai', key: 'bai-rotated-key' }),
  });
  assert.equal(saved.status, 200);
  const envBody = fs.readFileSync(envPath, 'utf8');
  assert.equal(envBody, 'BAI_API_KEY=bai-rotated-key\n');
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.equal(process.env.NODE_OPTIONS, undefined);

  // The new key has to apply without a restart, and the redactor has to learn
  // it so it cannot leak back out through an upstream payload.
  await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'echo bai-rotated-key please' }],
    }),
  });
  assert.equal(lastBaiAuth, 'Bearer bai-rotated-key');
  assert.equal(JSON.stringify(lastBaiBody).includes('bai-rotated-key'), false);

  const cleared = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'bai', key: '' }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(fs.readFileSync(envPath, 'utf8'), '');
  const afterClear = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(
    afterClear.providers.find((entry) => entry.name === 'bai').configured,
    false,
  );

  // Named UI keys belong only in the sparse local overlay, never config.json
  // or .env. Deleting the last named key reports the provider as unconfigured.
  const namedSaved = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'bai', name: 'work', key: 'named-bai-key' }),
  });
  assert.equal(namedSaved.status, 200);
  assert.equal((await namedSaved.json()).configured, true);
  assert.equal(fs.readFileSync(envPath, 'utf8'), '');
  const namedOverlay = JSON.parse(fs.readFileSync(path.join(tempDir, 'config.local.json'), 'utf8'));
  assert.deepEqual(namedOverlay.providers.bai, {
    keys: [{ name: 'work', key: 'named-bai-key' }],
  });
  assert.equal(
    fs.readFileSync(path.join(tempDir, 'config.json'), 'utf8').includes('named-bai-key'),
    false,
  );
  const namedCleared = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ provider: 'bai', name: 'work', key: '' }),
  });
  assert.equal(namedCleared.status, 200);
  assert.equal((await namedCleared.json()).configured, false);

  // Editable-config endpoints: routes, limits, discovery, settings, providers.
  assert.ok(afterClear.editable);
  assert.ok(afterClear.allRoutes['test-route']);
  const saveRoute = await fetch(`${base}/api/routes`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'save', route: 'smoke-tmp', models: ['mock-a', 'tokenrouter:z-ai/glm-5.3-free'] }),
  });
  assert.equal(saveRoute.status, 200);
  const withRoute = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.deepEqual(withRoute.editable.routes['smoke-tmp'], [
    'openrouter:mock-a',
    'tokenrouter:z-ai/glm-5.3-free',
  ]);
  const badRoute = await fetch(`${base}/api/routes`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'save', route: 'smoke-tmp', models: ['tokenrouter:'] }),
  });
  assert.equal(badRoute.status, 400);
  const delRoute = await fetch(`${base}/api/routes`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'delete', route: 'smoke-tmp' }),
  });
  assert.equal(delRoute.status, 200);

  const setLimit = await fetch(`${base}/api/limits`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'set', key: 'smoke:model', limit: 7 }),
  });
  assert.equal(setLimit.status, 200);
  const withLimit = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(withLimit.editable.limits.find((entry) => entry.key === 'smoke:model')?.limit, 7);
  const delLimit = await fetch(`${base}/api/limits`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'delete', key: 'smoke:model' }),
  });
  assert.equal(delLimit.status, 200);

  const discOff = await fetch(`${base}/api/discovery`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ enabled: false, evaluationEnabled: false, pin: 'smoke:pinned' }),
  });
  assert.equal(discOff.status, 200);
  const discState = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(discState.editable.discovery.enabled, false);
  assert.equal(discState.editable.discovery.evaluationEnabled, false);
  assert.ok(discState.editable.discovery.pinnedModels.includes('smoke:pinned'));
  const discOn = await fetch(`${base}/api/discovery`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ enabled: true, evaluationEnabled: true, unpin: 'smoke:pinned' }),
  });
  assert.equal(discOn.status, 200);

  const settings = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ attemptTimeoutMs: 6000, redactSecrets: true }),
  });
  assert.equal(settings.status, 200);
  const settingsState = await fetch(`${base}/api/state`, { headers: { Cookie: sessionCookie } }).then((res) => res.json());
  assert.equal(settingsState.editable.general.attemptTimeoutMs, 6000);

  const addProv = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'create', name: 'smokeprov', baseUrl: 'http://127.0.0.1:1/v1', freeModels: ['smoke-1'] }),
  });
  assert.equal(addProv.status, 200);
  const dupProv = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'create', name: 'smokeprov', baseUrl: 'http://127.0.0.1:1/v1' }),
  });
  assert.equal(dupProv.status, 400);
  const delProv = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'delete', name: 'smokeprov' }),
  });
  assert.equal(delProv.status, 200);
  const noDefDel = await fetch(`${base}/api/providers`, {
    method: 'POST',
    headers: uiHeaders,
    body: JSON.stringify({ action: 'delete', name: 'openrouter' }),
  });
  assert.equal(noDefDel.status, 400);

  const finalState = await fetch(`${base}/api/state`).then((res) => res.json());
  const counts = new Map(finalState.providers.map((entry) => [entry.name, entry]));
  assert.equal(counts.get('extra').modelCount, 1);
  assert.equal(counts.get('extra').freeCount, 1);
  assert.equal(counts.get('bai').modelCount, 2);
  // bai's key was cleared above, so withdrawals cannot be checked and every
  // allowlisted model counts as available.
  assert.equal(counts.get('bai').freeCount, 2);
  assert.deepEqual(finalState.migration.providers, {});

  // Runtime settings land in the overlay; the tracked base stays untouched.
  const overlayPath = path.join(tempDir, 'config.local.json');
  const persistedOverlay = fs.readFileSync(overlayPath, 'utf8');
  assert.match(persistedOverlay, /attemptTimeoutMs/);
  const persistedBase = fs.readFileSync(testConfig, 'utf8');
  assert.equal(persistedBase.includes('attemptTimeoutMs": 6000'), false);

  // Restart must be last: the server exits and stops answering.
  const restart = await fetch(`${base}/api/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(restart.status, 200);
  assert.equal((await restart.json()).ok, true);
  let wentAway = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    } catch {
      wentAway = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(wentAway, true, 'server did not exit after /api/restart');

  console.log(
    'smoke test passed: pluggable providers, ranking, fallback, discovery, usage counters, and tracking work',
  );
} finally {
  child.kill('SIGTERM');
  // Wait for the router to exit so its shutdown state write cannot race the
  // temp directory cleanup.
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await close(mock);
  await close(tokenRouterMock);
  await close(baiMock);
  await close(extraMock);
  await close(quotaMock);
  await close(geminiMock);
  await close(multiKeyMock);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
}

{
  const adoptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-adopt-'));
  const catalog = http.createServer((req, res) => {
    if (req.method === 'GET' && String(req.url || '').startsWith('/v1beta/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'models/kept-flash',
              displayName: 'Kept Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/paid-flash',
              displayName: 'Paid Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/embed-only',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await listen(catalog);
  const catalogPort = catalog.address().port;
  const portHolder = http.createServer();
  await listen(portHolder);
  const adoptPort = portHolder.address().port;
  await close(portHolder);
  const adoptConfig = path.join(adoptDir, 'config.json');
  fs.writeFileSync(
    adoptConfig,
    JSON.stringify({
      host: '127.0.0.1',
      port: adoptPort,
      webui: { enabled: false },
      defaultProvider: 'gemini',
      providers: {
        gemini: {
          catalog: true,
          pricing: false,
          probeFreeTier: true,
          baseUrl: `http://127.0.0.1:${catalogPort}/v1beta/openai`,
          modelsUrl: `http://127.0.0.1:${catalogPort}/v1beta/models`,
          modelsKeyHeader: 'x-goog-api-key',
          keyEnv: 'GEMINI_API_KEY',
          freeModels: [],
        },
      },
      discovery: {
        enabled: true,
        intervalMs: 604800000,
        route: 'free-best',
        stateFile: 'discovered-free-models.json',
        evaluation: { enabled: false, pinnedModels: [] },
      },
      routes: { 'free-best': [] },
    }),
  );
  fs.writeFileSync(
    path.join(adoptDir, 'discovered-free-models.json'),
    JSON.stringify({
      lastCheckedAt: new Date().toISOString(),
      addedModels: [],
      modelVerdicts: {
        'gemini:kept-flash': {
          free: true,
          reason: 'prior probe',
          observedAt: new Date().toISOString(),
        },
        'gemini:paid-flash': {
          free: false,
          reason: 'no free-tier allowance (limit 0)',
          observedAt: new Date().toISOString(),
        },
      },
    }),
  );
  const adoptChild = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: {
      ...process.env,
      GEMINI_API_KEY: 'adopt-test-key',
      FREE_ROUTER_CONFIG: adoptConfig,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let adoptOut = '';
  adoptChild.stdout.on('data', (chunk) => {
    adoptOut += chunk;
  });
  adoptChild.stderr.on('data', (chunk) => {
    adoptOut += chunk;
  });
  try {
    let health = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${adoptPort}/health`);
        if (response.ok) {
          health = await response.json();
          if (health.discovery?.addedModels?.includes('gemini:kept-flash')) break;
        }
      } catch {
        // Still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(health, `adopt test router did not start\n${adoptOut}`);
    assert.deepEqual(health.discovery.addedModels, ['gemini:kept-flash']);
    assert.deepEqual(
      (health.routes['free-best'] || []).map((entry) => `${entry.provider}:${entry.id}`),
      ['gemini:kept-flash'],
    );
  } finally {
    adoptChild.kill('SIGTERM');
    await new Promise((resolve) => {
      if (adoptChild.exitCode !== null || adoptChild.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        adoptChild.kill('SIGKILL');
        resolve();
      }, 3000);
      adoptChild.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await close(catalog);
    fs.rmSync(adoptDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
