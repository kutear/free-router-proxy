#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveConfig, defaultConfigPath, loadConfigFile, loadOverlayFile } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

for (const file of [path.join(HERE, '.env'), path.join(os.homedir(), '.hermes', '.env')]) {
  loadEnvFile(file);
}

const CONFIG_PATH = process.env.FREE_ROUTER_CONFIG || defaultConfigPath(HERE);
// Same layered view as the server: tracked defaults + operator overlay.
function loadConfigLite(configPath) {
  if (!fs.existsSync(configPath)) return {};
  try {
    const base = loadConfigFile(configPath).config;
    const overlayPath = path.join(path.dirname(configPath), 'config.local.json');
    const { overlay } = loadOverlayFile(overlayPath);
    return buildLiveConfig(base, overlay);
  } catch {
    return {};
  }
}
const config = loadConfigLite(CONFIG_PATH);
const HOST = process.env.FREE_ROUTER_HOST || config.host || '127.0.0.1';
const PORT = Number(process.env.FREE_ROUTER_PORT || config.port || 8787);
const DEFAULT_ROUTE = config.discovery?.route || 'free-best';

function usage() {
  console.log(`Usage: ./models.sh [options]

Show free-router models in priority order (same ranking as route \`free-best\`).

Options:
  --route <name>   Route alias to inspect (default: ${DEFAULT_ROUTE})
  --ready-only     Only show models that are ready right now
  --usage          Show the request history instead of the priority list
  --json           Machine-readable JSON output
  -h, --help       Show this help
`);
}

function parseArgs(argv) {
  const options = {
    route: DEFAULT_ROUTE,
    readyOnly: false,
    usage: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--ready-only') {
      options.readyOnly = true;
      continue;
    }
    if (arg === '--usage') {
      options.usage = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--route') {
      options.route = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!options.route) throw new Error('--route requires a value');
  return options;
}

function statusFor(entry, providerConfigured) {
  if (!providerConfigured) return 'no-key';
  if (entry.zeroCost === false) return 'paid';
  if (entry.cooldownSeconds > 0) return 'cooldown';
  return 'ready';
}

function annotate(entry, providers) {
  const providerConfigured = Boolean(providers?.[entry.provider]?.configured);
  const status = statusFor(entry, providerConfigured);
  return {
    priority: entry.priority,
    status,
    ready: status === 'ready',
    provider: entry.provider,
    model: entry.id,
    pinned: entry.pinned,
    score: entry.score,
    baseScore: entry.baseScore ?? null,
    scoreAdjustment: entry.scoreAdjustment || 0,
    scoreSource: entry.scoreSource,
    zeroCost: entry.zeroCost,
    supportsTools: entry.supportsTools,
    cooldownSeconds: entry.cooldownSeconds,
    cooldownReason: entry.cooldownReason || null,
    providerConfigured,
    usage: entry.usage || null,
  };
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function todayCell(usage) {
  if (!usage) return '-';
  const { today, dailyLimit } = usage;
  if (dailyLimit) return `${today.consumed}/${dailyLimit}`;
  return today.total ? String(today.total) : '-';
}

function windowCell(usage) {
  if (!usage?.window.total) return '-';
  return String(usage.window.ok);
}

function failureDetail(counts) {
  const parts = Object.entries(counts || {})
    .filter(([kind, value]) => kind !== 'ok' && Number(value) > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, value]) => `${kind} ${value}`);
  return parts.join(', ') || '-';
}

function formatTable(models, route, health, allModels) {
  const usage = health.usage;
  const totalCount = allModels.length;
  const lines = [];
  lines.push(`route: ${route}`);
  lines.push(`endpoint: http://${HOST}:${PORT}/v1`);
  if (health.lastSelection?.model) {
    const last = health.lastSelection;
    lines.push(
      `last used: ${last.provider}:${last.model} (${last.selectedAt || 'unknown time'})`,
    );
  }
  const windowDays = usage?.retentionDays || 7;
  lines.push('');
  lines.push(
    `${pad('#', 3)}  ${pad('status', 14)}  ${pad('today', 8)}  ${pad(`${windowDays}d ok`, 7)}  ${pad('fail', 5)}  ${pad('SWE', 6)}  ${pad('provider', 12)}  model`,
  );
  for (const entry of models) {
    const pin = entry.pinned ? ' *' : '';
    let status = entry.status;
    if (entry.status === 'cooldown') {
      status = `cooldown ${entry.cooldownSeconds}s`;
    }
    const fails = entry.usage?.window.fail || 0;
    const swe =
      entry.pinned
        ? '*'
        : Number.isFinite(entry.score) && entry.score >= 0
          ? String(entry.score)
          : '-';
    lines.push(
      `${pad(entry.priority, 3)}  ${pad(status, 14)}  ${pad(todayCell(entry.usage), 8)}  ${pad(windowCell(entry.usage), 7)}  ${pad(fails || '-', 5)}  ${pad(swe, 6)}  ${pad(entry.provider, 12)}  ${entry.model}${pin}`,
    );
  }
  lines.push('');
  lines.push(`ready: ${models.filter((entry) => entry.ready).length}/${totalCount}`);
  if (usage) {
    const today = usage.days[0] || { ok: 0, fail: 0 };
    lines.push(
      `today (${usage.today} ${usage.timezone}): ${today.ok} ok, ${today.fail} fail`,
    );
  }
  const capped = allModels.filter((entry) => entry.usage?.dailyLimit);
  if (capped.length) {
    lines.push('');
    lines.push('daily quota:');
    const width = Math.max(...capped.map((entry) => `${entry.provider}:${entry.model}`.length));
    for (const entry of capped) {
      const { today, dailyLimit, remainingToday } = entry.usage;
      lines.push(
        `  ${pad(`${entry.provider}:${entry.model}`, width)}  ${pad(`${today.consumed}/${dailyLimit}`, 8)}  ${remainingToday} left`,
      );
    }
    lines.push('');
  }
  lines.push('* = pinned, today = quota-consuming requests');
  return lines.join('\n');
}

function formatUsage(usage) {
  if (!usage) return 'this router build does not report usage';
  const lines = [];
  lines.push(`usage: last ${usage.retentionDays} day(s), timezone ${usage.timezone}`);
  lines.push('');
  lines.push(`${pad('day', 12)}  ${pad('ok', 5)}  ${pad('fail', 5)}  busiest model`);
  for (const day of usage.days) {
    const busiest = day.topModel?.ok
      ? `${day.topModel.key} (${day.topModel.ok})`
      : '-';
    lines.push(
      `${pad(day.day, 12)}  ${pad(day.ok || '-', 5)}  ${pad(day.fail || '-', 5)}  ${busiest}`,
    );
  }
  lines.push('');
  if (!usage.models.length) {
    lines.push('no requests recorded yet');
    return lines.join('\n');
  }
  lines.push(
    `${pad('ok', 6)}  ${pad('fail', 6)}  ${pad('today', 8)}  ${pad('provider', 12)}  ${pad('model', 34)}  failures`,
  );
  for (const entry of usage.models) {
    lines.push(
      `${pad(entry.ok, 6)}  ${pad(entry.fail || '-', 6)}  ${pad(todayCell(entry), 8)}  ${pad(entry.provider, 12)}  ${pad(entry.model, 34)}  ${failureDetail(entry.counts)}`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const url = `http://${HOST}:${PORT}/health`;
  let health;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = await response.json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`free-router is not reachable at http://${HOST}:${PORT} (${reason})`);
    console.error('start it with: ./start.sh');
    process.exit(1);
  }

  if (options.usage) {
    if (options.json) {
      console.log(JSON.stringify(health.usage || null, null, 2));
      return;
    }
    console.log(formatUsage(health.usage));
    return;
  }

  const routeModels = health.routes?.[options.route];
  if (!routeModels) {
    console.error(`route not found: ${options.route}`);
    console.error(`available routes: ${Object.keys(health.routes || {}).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const allModels = routeModels.map((entry) => annotate(entry, health.providers));
  const totalCount = allModels.length;
  const models = options.readyOnly
    ? allModels.filter((entry) => entry.ready)
    : allModels;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          route: options.route,
          endpoint: `http://${HOST}:${PORT}/v1`,
          readyCount: models.filter((entry) => entry.ready).length,
          totalCount,
          lastSelection: health.lastSelection || null,
          usage: health.usage || null,
          models,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(formatTable(models, options.route, health, allModels));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
