import { resolve, relative, isAbsolute, extname } from 'node:path';
import { realpath, open, readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseCsv } from '../shared/csv.mjs';
import { draft, assert, text } from './validation.mjs';
import { metricLabels } from '../shared/rules.mjs';

export function parseMonitorConfig(row) {
  const enabledRaw = String(row.monitor_enabled ?? row.monitor ?? '').trim().toLowerCase();
  if (['false', '0', 'no', 'nein', 'off', 'disabled'].includes(enabledRaw)) {
    return { enabled: false };
  }

  const rules = [];

  const metricAlias = {
    mcap: 'marketCapUsd',
    marketcap: 'marketCapUsd',
    marketcapusd: 'marketCapUsd',
    vol: 'volume24hUsd',
    volume: 'volume24hUsd',
    volume24h: 'volume24hUsd',
    volume24husd: 'volume24hUsd',
    liquidity: 'liquidityUsd',
    liquidityusd: 'liquidityUsd',
    price: 'priceUsd',
    priceusd: 'priceUsd',
    change: 'priceChangePct',
    pricechange: 'priceChangePct',
    pricechangepct: 'priceChangePct',
    gain: 'priceChangePct',
    drawdown: 'drawdownPct',
    drawdownpct: 'drawdownPct',
    trades: 'trades24h',
    trades24h: 'trades24h',
    age: 'ageMinutes',
    ageminutes: 'ageMinutes',
  };

  if (row.monitor_rules) {
    const parts = String(row.monitor_rules).split(/[;,]/).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      let metric, op, thresh;
      if (part.includes(':')) {
        const [m, o, t] = part.split(':').map(x => x.trim());
        metric = m; op = o; thresh = Number(t);
      } else {
        const match = part.match(/^([a-zA-Z0-9_]+)\s*(>=|<=|>|<|==)\s*(-?[0-9.]+)$/);
        if (match) {
          metric = match[1];
          op = ['>=', '>', '=='].includes(match[2]) ? 'gte' : 'lte';
          thresh = Number(match[3]);
        }
      }
      const normMetric = metricAlias[metric?.toLowerCase()] || metric;
      if (metricLabels[normMetric] && Number.isFinite(thresh)) {
        rules.push({ metric: normMetric, operator: op === 'lte' ? 'lte' : 'gte', threshold: thresh });
      }
    }
  }

  if (row.monitor_mcap_gte ?? row.monitor_mcap) {
    const val = Number(row.monitor_mcap_gte ?? row.monitor_mcap);
    if (Number.isFinite(val) && !rules.some(r => r.metric === 'marketCapUsd')) {
      rules.push({ metric: 'marketCapUsd', operator: 'gte', threshold: val });
    }
  }
  if (row.monitor_price_change_gte ?? row.monitor_gain) {
    const val = Number(row.monitor_price_change_gte ?? row.monitor_gain);
    if (Number.isFinite(val) && !rules.some(r => r.metric === 'priceChangePct')) {
      rules.push({ metric: 'priceChangePct', operator: 'gte', threshold: val });
    }
  }
  if (row.monitor_drawdown_gte ?? row.monitor_drawdown) {
    const val = Number(row.monitor_drawdown_gte ?? row.monitor_drawdown);
    if (Number.isFinite(val) && !rules.some(r => r.metric === 'drawdownPct')) {
      rules.push({ metric: 'drawdownPct', operator: 'gte', threshold: val });
    }
  }
  if (row.monitor_volume_gte ?? row.monitor_vol) {
    const val = Number(row.monitor_volume_gte ?? row.monitor_vol);
    if (Number.isFinite(val) && !rules.some(r => r.metric === 'volume24hUsd')) {
      rules.push({ metric: 'volume24hUsd', operator: 'gte', threshold: val });
    }
  }

  const hasConfig = rules.length > 0 || ['true', '1', 'yes', 'ja', 'on', 'enabled'].includes(enabledRaw);
  if (!hasConfig) return null;

  const mode = ['all', 'und'].includes(String(row.monitor_mode ?? '').trim().toLowerCase()) ? 'all' : 'any';
  const holdSeconds = Number.isInteger(Number(row.monitor_hold_seconds)) ? Math.max(0, Math.min(3600, Number(row.monitor_hold_seconds))) : 10;
  const cooldownSeconds = Number.isInteger(Number(row.monitor_cooldown_seconds)) ? Math.max(0, Math.min(86400, Number(row.monitor_cooldown_seconds))) : 60;
  const once = !['false', '0', 'no', 'nein'].includes(String(row.monitor_once ?? 'true').trim().toLowerCase());
  const autoSellRaw = String(row.monitor_auto_sell ?? '').trim().toLowerCase();
  const autoSell = ['true', '1', 'yes', 'ja', 'on'].includes(autoSellRaw);
  const sellModeRaw = String(row.monitor_sell_mode ?? '').trim().toLowerCase();
  const autoSellMode = ['n-1', 'n_minus_1', 'leave_best', 'keep_cheapest', 'moonbag'].includes(sellModeRaw) ? 'n_minus_1' : 'all';

  return {
    enabled: true,
    rules: rules.length > 0 ? rules : [
      { metric: 'marketCapUsd', operator: 'gte', threshold: 150000 },
      { metric: 'priceChangePct', operator: 'gte', threshold: 50 },
      { metric: 'drawdownPct', operator: 'gte', threshold: 30 }
    ],
    mode,
    holdSeconds,
    cooldownSeconds,
    once,
    autoSell,
    autoSellMode,
  };
}

export function validateImagePath(value, root) {
  const path = text(value ?? '', 1024, 'Bildpfad', false);
  if (!path) return '';
  // Paths are either project-relative (assets/...) or absolute inside this project's assets folder.
  const full = resolve(root, '..', path);
  const rel = relative(resolve(root), full);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Lokale Bilder müssen im Projektordner assets liegen.');
  assert(['.png', '.jpg', '.jpeg', '.webp'].includes(extname(full).toLowerCase()), 'Bildpfad benötigt PNG, JPG oder WebP.');
  return full;
}
export function importQueue(csv, root) {
  return parseCsv(csv).map((row, index) => {
    try {
      return {
        id: randomUUID(),
        ...draft({ ...row, image: row.image_url ?? '', metadataURI: row.metadata_uri ?? '', website: row.website ?? '' }),
        imagePath: validateImagePath(row.image_path, root),
        monitor: parseMonitorConfig(row),
        createdAt: Date.now()
      };
    } catch (error) { throw new Error(`CSV-Eintrag ${index + 1}: ${error.message}`); }
  });
}
export async function readQueueImage(item, root) {
  assert(item.imagePath, 'Dieser Eintrag hat keinen lokalen Bildpfad.');
  const path = validateImagePath(item.imagePath, root);
  const [base, canonical] = await Promise.all([realpath(root), realpath(path)]);
  const rel = relative(base, canonical);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Bildpfad verlässt den erlaubten assets-Ordner.');
  const file = await open(canonical, 'r');
  try {
    const stat = await file.stat();
    assert(stat.isFile() && stat.size <= 10 * 1024 * 1024, 'Bild muss eine Datei bis 10 MB sein.');
    const data = await file.readFile();
    const type = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : data.subarray(0, 3).equals(Buffer.from([255,216,255])) ? 'image/jpeg'
      : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
    assert(type, 'Datei enthält kein unterstütztes Bildformat.');
    return { data, type };
  } finally { await file.close(); }
}

export function createQueueWatcher({ projectRoot, assetDir, state, store, onSync } = {}) {
  state.queueSync ??= {
    path: 'examples/launch-queue.csv',
    lastSyncAt: null,
    error: null,
    count: state.queue?.length ?? 0,
  };

  let activeWatcher = null;
  let debounceTimer = null;

  function resolveCsvPath(userPath) {
    const raw = String(userPath || state.queueSync.path || 'examples/launch-queue.csv').trim();
    return isAbsolute(raw) ? raw : resolve(projectRoot, raw);
  }

  async function syncFromFile(filePath) {
    const targetPath = filePath || state.queueSync.path || 'examples/launch-queue.csv';
    const fullPath = resolveCsvPath(targetPath);
    try {
      const content = await readFile(fullPath, 'utf8');
      const items = importQueue(content, assetDir);
      assert(items.length <= 200, 'Die Queue darf maximal 200 Einträge enthalten.');
      state.queue = items;
      state.queueSync.path = targetPath;
      state.queueSync.lastSyncAt = Date.now();
      state.queueSync.error = null;
      state.queueSync.count = items.length;
      store.save();
      if (typeof onSync === 'function') onSync({ count: items.length, path: targetPath });
      return { success: true, count: items.length, path: targetPath };
    } catch (err) {
      state.queueSync.error = err.message;
      store.save();
      throw err;
    }
  }

  function startWatch(filePath) {
    if (activeWatcher) {
      try { activeWatcher.close(); } catch {}
      activeWatcher = null;
    }
    const targetPath = filePath || state.queueSync.path || 'examples/launch-queue.csv';
    const fullPath = resolveCsvPath(targetPath);
    try {
      activeWatcher = watch(fullPath, (eventType) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            await syncFromFile(targetPath);
            console.log(`[QueueWatcher] CSV automatisch neu eingelesen: ${targetPath} (${state.queue.length} Einträge).`);
          } catch (e) {
            console.warn(`[QueueWatcher] Fehler beim automatischen Einlesen von ${targetPath}:`, e.message);
          }
        }, 300);
      });
      activeWatcher.on('error', () => {
        // Ignored
      });
    } catch (e) {
      // File may not exist yet or cannot be watched
    }
  }

  return {
    syncFromFile,
    startWatch,
    status() {
      return {
        path: state.queueSync?.path || 'examples/launch-queue.csv',
        lastSyncAt: state.queueSync?.lastSyncAt || null,
        error: state.queueSync?.error || null,
        count: state.queue?.length ?? 0,
      };
    },
    stop() {
      if (activeWatcher) {
        try { activeWatcher.close(); } catch {}
        activeWatcher = null;
      }
    }
  };
}
