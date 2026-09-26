import { providerKeysFromConfig } from './config.mjs';

const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;

export function isZeroCost(model) {
  const prompt = Number(model?.pricing?.prompt);
  const completion = Number(model?.pricing?.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

function looksFreeId(id) {
  const lower = String(id || '').toLowerCase();
  return lower.endsWith(':free') || /(?:^|[/_.-])free(?:$|[/_.-])/.test(lower) || lower.includes('-free');
}

// Unpriced catalogs cannot use isZeroCost. A free flag, :free suffix, or a
// "free" tag is the listing saying so; otherwise the caller must live-probe.
export function isMarkedFree(model) {
  if (!model) return false;
  if (model.free === true || model.is_free === true) return true;
  if (looksFreeId(model.id)) return true;
  const tags = model.tags;
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  return list.some((tag) => String(tag).trim().toLowerCase() === 'free');
}

export function isChatModel(model) {
  // A catalog that states which generation methods a model supports is
  // authoritative; guessing from modalities is only for catalogs that do not.
  if (typeof model?.chatCapable === 'boolean') return model.chatCapable;
  const outputs = model?.architecture?.output_modalities || ['text'];
  if (!outputs.includes('text') || outputs.some((modality) => modality !== 'text')) return false;
  if (model?.architecture?.tokenizer === 'Router') return false;
  return !/(?:content[-_ ]?safety|moderation|guard)(?:[:/_-]|$)/i.test(model?.id || '');
}

// A catalog that lists parameters can rule a model out. Missing or empty means
// the listing did not say, which is not the same as "cannot use tools".
export function supportsRequest(model, needs) {
  if (!model) return true;
  const listed = model.supported_parameters;
  if (Array.isArray(listed) && listed.length) {
    const supported = new Set(listed);
    if (needs.tools && !supported.has('tools')) return false;
    if (
      needs.responseFormat &&
      !supported.has('response_format') &&
      !supported.has('structured_outputs')
    ) {
      return false;
    }
  }
  const inputs = model.architecture?.input_modalities;
  if (Array.isArray(inputs) && inputs.length) {
    const allowed = new Set(inputs);
    for (const modality of needs.modalities || []) {
      if (!allowed.has(modality)) return false;
    }
  }
  return true;
}

// Google's native /v1beta/models speaks a different dialect than the
// OpenAI-compatible listing: models[] keyed by `name`, capabilities in
// `supportedGenerationMethods`, and no pricing at all. Normalizing here keeps
// the rest of the router on one model shape.
export function normalizeCatalogPayload(payload) {
  if (Array.isArray(payload?.data)) {
    return {
      shape: 'openai',
      models: payload.data.filter((model) => model && typeof model.id === 'string'),
      nextPageToken: '',
    };
  }
  if (!Array.isArray(payload?.models)) return { shape: 'unknown', models: [], nextPageToken: '' };
  const models = [];
  for (const raw of payload.models) {
    if (!raw || typeof raw.name !== 'string') continue;
    const methods = Array.isArray(raw.supportedGenerationMethods)
      ? raw.supportedGenerationMethods
      : [];
    models.push({
      id: raw.name.replace(/^models\//, ''),
      name: raw.displayName || '',
      description: raw.description || '',
      context_length: Number(raw.inputTokenLimit || 0),
      max_output_tokens: Number(raw.outputTokenLimit || 0),
      // Text chat is exactly `generateContent`. Embeddings expose
      // `embedContent`, video `predictLongRunning`, live audio
      // `bidiGenerateContent`, and none of those belong in a chat route.
      chatCapable: methods.includes('generateContent'),
      supportedGenerationMethods: methods,
      // supported_parameters is omitted on purpose: this listing does not
      // describe OpenAI-style tools, and an empty list would skip the model.
    });
  }
  return { shape: 'google', models, nextPageToken: String(payload.nextPageToken || '') };
}

function envName(providerName, suffix) {
  return `${String(providerName).replace(/-/g, '_').toUpperCase()}_${suffix}`;
}

export function normalizeModelSlug(id) {
  let slug = String(id || '').toLowerCase().trim();
  slug = slug.replace(/:free$/, '');
  const slash = slug.lastIndexOf('/');
  if (slash >= 0) slug = slug.slice(slash + 1);
  return slug;
}

function resolveHeaderValue(spec, { host, port }) {
  const origin = `http://${host}:${port}`;
  const expand = (value) => (value === '${origin}' ? origin : value);
  if (typeof spec === 'string') return expand(spec);
  if (!spec || typeof spec !== 'object') return '';
  const fromEnv = spec.env ? process.env[spec.env] : '';
  if (fromEnv) return fromEnv;
  return expand(spec.default || '');
}

function joinUrl(baseUrl, path) {
  const prefix = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path || ''}`;
  return `${prefix}${suffix}`;
}

export function createProviderRegistry(config, { host, port }) {
  const providers = new Map();

  function makeProviderEntry(name, raw) {
    if (!PROVIDER_ID.test(name)) {
      throw new Error(`invalid provider id "${name}"; use lowercase letters, digits, _ or -`);
    }
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const keyEnv = cfg.keyEnv || envName(name, 'API_KEY');
    const baseUrlEnv = cfg.baseUrlEnv || envName(name, 'BASE_URL');
    const usesCatalog = cfg.catalog === true;
    // Fetching /models and deciding what is free are separate powers. Only a
    // catalog that publishes per-token prices can decide freeness by itself;
    // for the rest `freeModels` stays the allowlist and the catalog is used
    // solely to notice models that disappeared upstream.
    const catalogHasPricing = usesCatalog && cfg.pricing !== false;
    const baseUrl = String(process.env[baseUrlEnv] || cfg.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error(`provider ${name} is missing baseUrl`);
    // Multi-account: keys live in config file (`[[providers.<name>.keys]]`
    // with `{name, key}`) plus env fallback (`<KEYENV>`, `<KEYENV>S`,
    // `<KEYENV>_KEYS`). `apiKey` stays as the first key for compatibility.
    const resolved = providerKeysFromConfig(name, { ...cfg, keyEnv });
    return {
      name,
      keyEnv,
      baseUrlEnv,
      usesCatalog,
      catalogHasPricing,
      // Adding unknown models from a catalog is only safe where prices are
      // published, so a priced catalog is a precondition for that route in.
      discover: catalogHasPricing && cfg.discover !== false,
      // The other way in: no prices, so ask the provider directly whether it
      // will serve the model for free. Opt-in, since it spends a request per
      // candidate and is only sound on a key with no billing attached.
      probeFreeTier: usesCatalog && !catalogHasPricing && cfg.probeFreeTier === true,
      chatPath: cfg.chatPath || '/chat/completions',
      modelsPath: cfg.modelsPath || '/models',
      // Some providers serve a richer catalog outside the OpenAI-compatible
      // prefix used for chat, on its own auth scheme.
      modelsUrl: String(cfg.modelsUrl || ''),
      modelsKeyHeader: String(cfg.modelsKeyHeader || ''),
      extraHeaders: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
      baseUrl,
      configRef: cfg,
      apiKeys: resolved.keys,
      apiKey: resolved.keys[0]?.key || '',
      keyCursor: 0,
      invalidKeys: new Set(),
      freeModels: new Set(cfg.freeModels || []),
      catalog: usesCatalog ? new Map() : null,
      catalogSlugs: usesCatalog ? new Map() : null,
      catalogFetchedAt: 0,
      catalogAttemptedAt: 0,
      catalogError: '',
    };
  }

  const entries = Object.entries(config.providers || {});
  if (!entries.length) throw new Error('config.providers is empty');

  for (const [name, raw] of entries) {
    providers.set(name, makeProviderEntry(name, raw));
  }

  const configuredDefault = config.defaultProvider;
  if (configuredDefault && !providers.has(configuredDefault)) {
    throw new Error(`defaultProvider "${configuredDefault}" is not in providers`);
  }
  let defaultProvider =
    configuredDefault ||
    [...providers.values()].find((provider) => provider.catalogHasPricing)?.name ||
    [...providers.keys()][0];

  function get(name) {
    return providers.get(name);
  }

  // Runtime provider management for the web UI. Config persistence is the
  // caller's job; the registry only mirrors it into live state.
  function addProvider(name, rawCfg) {
    if (providers.has(name)) throw new Error(`provider already exists: ${name}`);
    const entry = makeProviderEntry(name, rawCfg);
    providers.set(name, entry);
    return entry;
  }

  function removeProvider(name) {
    if (!providers.has(name)) return false;
    if (name === defaultProvider) throw new Error(`cannot remove the default provider: ${name}`);
    providers.delete(name);
    return true;
  }

  function setDefaultProvider(name) {
    if (!providers.has(name)) throw new Error(`unknown provider: ${name}`);
    defaultProvider = name;
  }

  function headers(name, keyOverride) {
    const provider = get(name);
    const resolved = {
      Authorization: `Bearer ${keyOverride ?? provider?.apiKey ?? ''}`,
      'Content-Type': 'application/json',
    };
    for (const [header, spec] of Object.entries(provider?.extraHeaders || {})) {
      const value = resolveHeaderValue(spec, { host, port });
      if (value) resolved[header] = value;
    }
    return resolved;
  }

  // Providers disagree on how to spell the same model: Gemini's OpenAI-compat
  // catalog returns "models/gemini-3.8-flash" where config.json says
  // "gemini-3.8-flash". Fall back to the slug so a naming difference does not
  // read as a model that vanished upstream.
  function catalogEntry(provider, modelId) {
    if (!provider?.catalog) return null;
    const exact = provider.catalog.get(modelId);
    if (exact) return exact;
    const slug = normalizeModelSlug(modelId);
    return (slug && provider.catalogSlugs?.get(slug)) || null;
  }

  function metadata(candidate) {
    const provider = get(candidate.provider);
    return provider?.usesCatalog ? catalogEntry(provider, candidate.model) : null;
  }

  function hasUsableKey(provider) {
    return Boolean(provider && keySlots(provider.name).length);
  }

  function isFree(candidate) {
    const provider = get(candidate.provider);
    if (!provider || !hasUsableKey(provider)) return false;
    if (provider.catalogHasPricing) {
      const model = provider.catalog.get(candidate.model);
      return !provider.catalog.size || Boolean(model && isZeroCost(model) && isChatModel(model));
    }
    if (!provider.freeModels.has(candidate.model)) return false;
    // A catalog that failed to load must not empty the route, so absence only
    // counts as removal when we actually hold a catalog to check against.
    if (!provider.usesCatalog || !provider.catalog.size) return true;
    return Boolean(catalogEntry(provider, candidate.model));
  }

  // Allowlisted models the provider no longer offers. Attempting these wastes
  // an upstream round trip and a cooldown slot on a guaranteed 404.
  function unavailableFreeModels() {
    const missing = [];
    for (const provider of providers.values()) {
      if (!provider.usesCatalog || provider.catalogHasPricing) continue;
      if (!hasUsableKey(provider) || !provider.catalog.size) continue;
      for (const id of provider.freeModels) {
        if (!catalogEntry(provider, id)) missing.push(`${provider.name}:${id}`);
      }
    }
    return missing.sort();
  }

  // Round-robin over usable keys. Invalid (401) keys are skipped until the
  // provider is reconfigured. Returns [{index, name, key}] in try-order.
  // Pure read: rotation advances only via rotateKeyCursor (called when a
  // request actually goes out), so status pages and filters never skew it.
  function keySlots(providerName) {
    const provider = get(providerName);
    if (!provider || !provider.apiKeys?.length) return [];
    const usable = provider.apiKeys
      .map((entry, index) => ({ ...entry, index }))
      .filter((entry) => entry.key && !provider.invalidKeys.has(entry.key));
    if (!usable.length) return [];
    const start = provider.keyCursor % usable.length;
    return [...usable.slice(start), ...usable.slice(0, start)];
  }

  function rotateKeyCursor(providerName) {
    const provider = get(providerName);
    if (provider) provider.keyCursor += 1;
  }

  function markKeyInvalid(providerName, key) {
    get(providerName)?.invalidKeys.add(key);
  }

  function refreshKeysFromEnv(providerName) {
    const provider = get(providerName);
    if (!provider) return false;
    const raw = provider.configRef && typeof provider.configRef === 'object' ? provider.configRef : {};
    const resolved = providerKeysFromConfig(providerName, { ...raw, keyEnv: provider.keyEnv });
    provider.apiKeys = resolved.keys;
    provider.apiKey = resolved.keys[0]?.key || '';
    provider.invalidKeys.clear();
    return true;
  }

  function parsePrefixed(requestedModel) {
    const separator = requestedModel.indexOf(':');
    if (separator <= 0) return null;
    const providerName = requestedModel.slice(0, separator);
    const model = requestedModel.slice(separator + 1);
    if (!providers.has(providerName) || !model) return null;
    return { provider: providerName, model };
  }

  function offeringsForSlug(slug) {
    const normalized = String(slug || '');
    if (!normalized) return [];
    const offerings = [];
    const seen = new Set();
    for (const provider of providers.values()) {
      if (!hasUsableKey(provider)) continue;
      if (provider.catalogHasPricing) {
        if (!provider.catalog) continue;
        for (const model of provider.catalog.values()) {
          if (normalizeModelSlug(model.id) !== normalized) continue;
          if (!isZeroCost(model) || !isChatModel(model)) continue;
          const key = `${provider.name}:${model.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          offerings.push({ provider: provider.name, model: model.id });
        }
        continue;
      }
      for (const id of provider.freeModels) {
        if (normalizeModelSlug(id) !== normalized) continue;
        if (provider.usesCatalog && provider.catalog.size && !catalogEntry(provider, id)) continue;
        const key = `${provider.name}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        offerings.push({ provider: provider.name, model: id });
      }
    }
    return offerings;
  }

  function directCandidates(requestedModel) {
    const prefixed = parsePrefixed(requestedModel);
    if (prefixed) return [prefixed];
    const slug = normalizeModelSlug(requestedModel);
    const offerings = offeringsForSlug(slug);
    if (!offerings.length) {
      return [{ provider: defaultProvider, model: requestedModel }];
    }
    const exact = [];
    const rest = [];
    for (const offering of offerings) {
      if (offering.model === requestedModel) exact.push(offering);
      else rest.push(offering);
    }
    return [...exact, ...rest];
  }

  function catalogUrl(provider) {
    return provider.modelsUrl || joinUrl(provider.baseUrl, provider.modelsPath);
  }

  function catalogHeaders(provider, keyOverride) {
    const key = keyOverride ?? keySlots(provider.name)[0]?.key;
    if (!key) return undefined;
    // Google's native endpoint rejects a Bearer token with 401 and wants its
    // own header. Keeping the key out of the query string keeps it out of logs.
    if (provider.modelsKeyHeader) return { [provider.modelsKeyHeader]: key };
    return { Authorization: `Bearer ${key}` };
  }

  async function fetchCatalogPage(provider, pageToken, keyOverride) {
    const url = new URL(catalogUrl(provider));
    if (provider.modelsUrl) url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, {
      headers: catalogHeaders(provider, keyOverride),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return normalizeCatalogPayload(await response.json());
  }

  async function refreshProviderCatalog(provider, force, catalogRefreshMs) {
    if (!provider.usesCatalog) return;
    if (!hasUsableKey(provider)) return;
    if (
      !force &&
      Date.now() - provider.catalogAttemptedAt < catalogRefreshMs &&
      (provider.catalog.size || provider.catalogError)
    ) {
      return;
    }
    provider.catalogAttemptedAt = Date.now();
    const keyCandidates = keySlots(provider.name);
    let lastError = null;
    for (const slot of keyCandidates) {
      try {
        const listed = [];
        let pageToken = '';
        // A truncated listing is indistinguishable from models withdrawn
        // upstream, so follow pagination rather than trusting the first page.
        for (let page = 0; page < 10; page += 1) {
          const result = await fetchCatalogPage(provider, pageToken, slot.key);
          if (result.shape === 'unknown') throw new Error('unrecognised catalog response shape');
          listed.push(...result.models);
          pageToken = result.nextPageToken;
          if (!pageToken) break;
        }
        if (!listed.length) throw new Error('catalog response listed no models');
        provider.catalog = new Map(listed.map((model) => [model.id, model]));
        provider.catalogSlugs = new Map();
        for (const model of listed) {
          const slug = normalizeModelSlug(model.id);
          if (slug && !provider.catalogSlugs.has(slug)) provider.catalogSlugs.set(slug, model);
        }
        provider.catalogFetchedAt = Date.now();
        provider.catalogError = '';
        const freeCount = provider.catalogHasPricing
          ? [...provider.catalog.values()].filter(isZeroCost).length
          : null;
        const chatCount = [...provider.catalog.values()].filter(isChatModel).length;
        return { name: provider.name, size: provider.catalog.size, freeCount, chatCount };
      } catch (error) {
        lastError = error;
        if (error?.status === 401) {
          markKeyInvalid(provider.name, slot.key);
          continue;
        }
        const status = Number(error?.status || 0);
        if (
          status === 408 ||
          status === 429 ||
          status >= 500 ||
          error?.name === 'AbortError' ||
          error?.name === 'TimeoutError'
        ) {
          continue;
        }
        break;
      }
    }
    provider.catalogError = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${provider.name}: ${provider.catalogError}`);
  }

  async function refreshCatalogs(force, catalogRefreshMs, log) {
    for (const provider of providers.values()) {
      if (!provider.usesCatalog) continue;
      try {
        const result = await refreshProviderCatalog(provider, force, catalogRefreshMs);
        if (result) {
          const detail =
            result.freeCount === null
              ? `${result.chatCount} chat-capable, no prices published`
              : `${result.freeCount} zero-cost`;
          log(`catalog refreshed (${result.name}): ${result.size} models, ${detail}`);
        }
      } catch (error) {
        log(
          `catalog refresh failed for ${provider.name}; retaining previous catalog: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  function listListedModels() {
    const models = [];
    const ids = new Set();
    for (const provider of providers.values()) {
      if (!hasUsableKey(provider) || provider.catalogHasPricing) continue;
      for (const id of provider.freeModels) {
        if (ids.has(id)) continue;
        if (provider.usesCatalog && provider.catalog.size && !catalogEntry(provider, id)) continue;
        ids.add(id);
        models.push({
          id,
          object: 'model',
          created: 0,
          owned_by: provider.name,
          context_length: 0,
        });
      }
    }
    return { models, ids };
  }

  function listCatalogModels(excludeIds = new Set()) {
    const models = [];
    const seen = new Set(excludeIds);
    for (const provider of providers.values()) {
      if (!hasUsableKey(provider) || !provider.catalogHasPricing || !provider.catalog) continue;
      for (const model of provider.catalog.values()) {
        if (!isZeroCost(model) || !isChatModel(model) || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push({
          id: model.id,
          object: 'model',
          created: Number(model.created || 0),
          owned_by: model.id.split('/')[0] || provider.name,
          context_length: Number(model.context_length || 0),
          provider: provider.name,
        });
      }
    }
    models.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return models;
  }

  // 'catalog' lets prices decide what is free; 'static' trusts the freeModels
  // allowlist; 'static+catalog' trusts the allowlist but still consults the
  // catalog to drop models the provider stopped offering.
  function providerKind(provider) {
    if (provider.catalogHasPricing) return 'catalog';
    return provider.usesCatalog ? 'static+catalog' : 'static';
  }

  function health() {
    const unavailable = new Set(unavailableFreeModels());
    return Object.fromEntries(
      [...providers.entries()].map(([name, provider]) => [
        name,
        {
          configured: hasUsableKey(provider),
          keyCount: provider.apiKeys?.length || 0,
          kind: providerKind(provider),
          baseUrl: provider.baseUrl,
          freeModels: provider.catalogHasPricing ? undefined : [...provider.freeModels],
          unavailableModels: provider.catalogHasPricing
            ? undefined
            : [...provider.freeModels].filter((id) => unavailable.has(`${name}:${id}`)),
          catalogModels: provider.usesCatalog ? provider.catalog.size : undefined,
          catalogFetchedAt:
            provider.usesCatalog && provider.catalogFetchedAt
              ? new Date(provider.catalogFetchedAt).toISOString()
              : undefined,
          catalogError: provider.usesCatalog ? provider.catalogError || null : undefined,
        },
      ]),
    );
  }

  function discoveryCatalog() {
    if (get(defaultProvider)?.usesCatalog) return get(defaultProvider);
    return [...providers.values()].find((provider) => provider.usesCatalog) || null;
  }

  // Applied to the live provider and to process.env, so a key set at runtime
  // works on the next request without a restart. The single-key path updates
  // only <KEYENV>; named file keys and plural env keys remain available.
  function setApiKey(name, key) {
    const provider = get(name);
    if (!provider) return false;
    const value = String(key || '');
    if (value) {
      process.env[provider.keyEnv] = value;
    } else {
      delete process.env[provider.keyEnv];
    }
    refreshKeysFromEnv(name);
    if (provider.usesCatalog && !provider.apiKeys.length) {
      provider.catalog = new Map();
      provider.catalogSlugs = new Map();
      provider.catalogFetchedAt = 0;
      provider.catalogAttemptedAt = 0;
      provider.catalogError = '';
    }
    return true;
  }

  // Named multi-key write path used by the web UI (persisted to TOML by the
  // caller via configRef). Entries: [{name, key}].
  function setProviderKeys(name, entries) {
    const provider = get(name);
    if (!provider) return false;
    const cleaned = (entries || [])
      .map((entry, index) => ({
        name: String(entry?.name || `key-${index + 1}`).trim(),
        key: String(entry?.key || '').trim(),
        source: 'file',
      }))
      .filter((entry) => entry.key);
    const seenKeys = new Set();
    const seenNames = new Set();
    const deduped = [];
    for (const entry of cleaned) {
      if (seenKeys.has(entry.key) || seenNames.has(entry.name)) continue;
      seenKeys.add(entry.key);
      seenNames.add(entry.name);
      deduped.push(entry);
    }
    provider.configRef.keys = deduped.map(({ name: keyName, key }) => ({ name: keyName, key }));
    refreshKeysFromEnv(name);
    return true;
  }

  return {
    providers,
    get defaultProvider() {
      return defaultProvider;
    },
    get,
    headers,
    metadata,
    isFree,
    parsePrefixed,
    offeringsForSlug,
    directCandidates,
    refreshCatalogs,
    listListedModels,
    listCatalogModels,
    health,
    discoveryCatalog,
    catalogEntry,
    unavailableFreeModels,
    providerKind,
    setApiKey,
    setProviderKeys,
    addProvider,
    removeProvider,
    setDefaultProvider,
    keySlots,
    rotateKeyCursor,
    markKeyInvalid,
    refreshKeysFromEnv,
    hasUsableKey,
    chatUrl(name) {
      const provider = get(name);
      return provider ? joinUrl(provider.baseUrl, provider.chatPath) : '';
    },
  };
}
