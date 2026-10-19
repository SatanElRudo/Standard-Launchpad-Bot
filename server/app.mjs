import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { marketToken } from './markets.mjs';
import { launchTerms, prepareLaunch, inspectLaunch, executeDirectLaunch, getBalances } from './chain.mjs';
import { address, draft, monitor, text, assert } from './validation.mjs';
import { deployment } from '../shared/deployment.mjs';
import { evaluateRules } from '../shared/rules.mjs';
import { importQueue, readQueueImage } from './queue.mjs';
import { createVault } from './vault.mjs';
import { createAutoLauncher } from './auto-launcher.mjs';
import { getStockBalances, executeMultiSnipe, executeMultiSell } from './sniper.mjs';

const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);

export function createApp({
  dataDir = resolve('data'),
  assetDir = resolve('assets'),
  market = marketToken,
  interval = 5000,
  executeLaunch = executeDirectLaunch,
  inspectLaunchFn = inspectLaunch,
  balanceFn = getBalances,
  stockBalanceFn = getStockBalances,
  snipeFn = executeMultiSnipe,
  sellFn = executeMultiSell,
} = {}) {
  const store = createStore(dataDir), state = store.state;
  const vault = createVault({ store });

  let polling = false, timer;

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const tokens = [...new Set(state.monitors.filter(m => m.enabled).map(m => m.token.toLowerCase()))];
      for (let start = 0; start < tokens.length; start += 4) {
        await Promise.all(tokens.slice(start, start + 4).map(async token => {
          let sample, error;
          try { sample = await market(token); } catch (e) { error = e.message; }
          for (let i = 0; i < state.monitors.length; i++) {
            const current = state.monitors[i];
            if (!current.enabled || current.token.toLowerCase() !== token) continue;
            if (error) { current.error = error; current.conditionSince = null; continue; }
            const result = evaluateRules(current, sample);
            if (result.monitor.error) result.monitor.conditionSince = null;
            state.monitors[i] = result.monitor;
            if (result.alert) {
              state.alerts.unshift({ id: randomUUID(), ...result.alert });

              // Auto-Sell: trigger multi-wallet sell on alert if configured
              if (current.autoSell && !current.autoSellExecuted && Array.isArray(current.purchases) && current.purchases.length > 0 && current.curve) {
                current.autoSellExecuted = true;
                const targetPurchases = [...current.purchases];
                const targetCurve = current.curve;
                const targetToken = current.token;
                const targetCountry = current.country || 'us';
                const targetMode = current.autoSellMode || 'all';
                const monitorName = current.name;
                const monitorId = current.id;
                void (async () => {
                  try {
                    const sellRes = await sellFn({
                      curve: targetCurve,
                      token: targetToken,
                      country: targetCountry,
                      purchases: targetPurchases,
                      autoSellMode: targetMode,
                      vault,
                    });
                    const mon = state.monitors.find(m => m.id === monitorId);
                    if (mon) {
                      mon.sellResults = sellRes;
                    }
                    const soldCount = sellRes.filter(r => r.status === 'success').length;
                    const keptWallet = sellRes.find(r => r.status === 'kept_best_entry');
                    state.alerts.unshift({
                      id: randomUUID(),
                      name: `Auto-Sell ausgeführt: ${monitorName}`,
                      message: `Trigger ausgelöst! ${soldCount} von ${targetPurchases.length} Wallets haben ihre Token verkauft.${keptWallet ? ` (Wallet „${keptWallet.label}“ mit bestem Einstieg als Moonbag behalten).` : ''}`,
                      at: Date.now(),
                      token: targetToken,
                      metrics: sample,
                    });
                    store.save();
                  } catch (se) {
                    console.error('Auto-sell execution error:', se);
                    state.alerts.unshift({
                      id: randomUUID(),
                      name: `Auto-Sell Fehler: ${monitorName}`,
                      message: `Automatischer Verkauf fehlgeschlagen: ${se.message}`,
                      at: Date.now(),
                      token: targetToken,
                      metrics: sample,
                    });
                    store.save();
                  }
                })();
              }
            }
          }
        }));
      }
      state.alerts = state.alerts.slice(0, 1000);
      store.save();
    } finally { polling = false; }
  }

  function createLaunchMonitor({ token, curve = null, country = 'us', name, monitorConfig, creatorWallet = null, creatorLabel = null, purchases = [] }) {
    if (!monitorConfig || monitorConfig.enabled === false) return null;
    if (state.monitors.length >= 30) {
      console.warn('Maximal 30 Monitore erreicht, automatischer Launch-Monitor übersprungen.');
      return null;
    }
    try {
      const monInput = {
        token,
        curve: curve || monitorConfig.curve,
        country: country || monitorConfig.country || 'us',
        name: text(monitorConfig.name || `${name} · Launch`, 80, 'Monitorname'),
        rules: Array.isArray(monitorConfig.rules) && monitorConfig.rules.length > 0
          ? monitorConfig.rules
          : [{ metric: 'marketCapUsd', operator: 'gte', threshold: 150000 }],
        mode: monitorConfig.mode === 'all' ? 'all' : 'any',
        holdSeconds: typeof monitorConfig.holdSeconds === 'number' ? monitorConfig.holdSeconds : 10,
        cooldownSeconds: typeof monitorConfig.cooldownSeconds === 'number' ? monitorConfig.cooldownSeconds : 60,
        once: typeof monitorConfig.once === 'boolean' ? monitorConfig.once : true,
        creatorWallet: creatorWallet || monitorConfig.creatorWallet,
        creatorLabel: creatorLabel || monitorConfig.creatorLabel,
        purchases: Array.isArray(purchases) && purchases.length > 0 ? purchases : (monitorConfig.purchases || []),
        autoSell: Boolean(monitorConfig.autoSell),
        autoSellMode: monitorConfig.autoSellMode === 'n_minus_1' ? 'n_minus_1' : 'all',
      };
      const validated = monitor(monInput);
      const result = { id: randomUUID(), ...validated, createdAt: Date.now(), conditionSince: null };
      state.monitors.unshift(result);
      store.save();
      void poll().catch(console.error);
      return result;
    } catch (e) {
      console.error('Fehler beim automatischen Anlegen des Monitors:', e);
      return null;
    }
  }

  const autoLauncher = createAutoLauncher({
    store,
    vault,
    executeLaunch,
    inspectLaunch: inspectLaunchFn,
    snipeFn,
    createMonitorFn: createLaunchMonitor,
  });

  async function body(req) {
    assert(req.headers['content-type']?.split(';')[0] === 'application/json', 'Content-Type application/json erforderlich.');
    let result = '';
    for await (const chunk of req) { result += chunk; assert(Buffer.byteLength(result) <= 64_000, 'Anfrage zu groß.'); }
    let parsed; try { parsed = JSON.parse(result); } catch { assert(false, 'Ungültiges JSON.'); }
    assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'JSON-Objekt erforderlich.');
    return parsed;
  }

  const server = createServer(async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(json(value)); };
    try {
      const host = req.headers.host;
      assert(/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? ''), 'Nur lokaler Zugriff erlaubt.');
      const origin = `http://${host}`;
      if (req.headers.origin) assert(req.headers.origin === origin, 'Fremder Origin nicht erlaubt.');
      if (!['GET', 'HEAD'].includes(req.method)) assert(req.headers.origin === origin, 'Lokaler Origin erforderlich.');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      const path = new URL(req.url, origin).pathname;
      if (path.startsWith('/api/')) assert(req.headers['sec-fetch-site'] !== 'cross-site', 'Fremde Website darf nicht auf die lokale API zugreifen.');

      if (req.method === 'GET' && path === '/api/state') {
        return send(200, {
          ...state,
          deployment,
          vault: vault.status(),
          autoLauncher: autoLauncher.status(),
        });
      }
      if (req.method === 'GET' && path === '/api/terms') return send(200, await launchTerms());
      if (req.method === 'GET' && path.startsWith('/api/token/')) return send(200, await market(address(path.slice(11))));
      if (req.method === 'POST' && path === '/api/prepare') return send(200, await prepareLaunch(await body(req)));

      // Vault APIs
      if (req.method === 'GET' && path === '/api/vault/status') return send(200, vault.status());
      if (req.method === 'POST' && path === '/api/vault/init') {
        const input = await body(req);
        return send(201, vault.init(input.password));
      }
      if (req.method === 'POST' && path === '/api/vault/unlock') {
        const input = await body(req);
        return send(200, vault.unlock(input.password));
      }
      if (req.method === 'POST' && path === '/api/vault/lock') {
        vault.lock();
        return send(200, vault.status());
      }
      if (req.method === 'GET' && path === '/api/vault/wallets') {
        const wallets = vault.getWallets();
        const balances = await balanceFn(wallets.map(w => w.address));
        const enriched = wallets.map(w => ({
          ...w,
          balanceEth: balances[w.address.toLowerCase()] ?? '0',
        }));
        return send(200, enriched);
      }
      if (req.method === 'POST' && path === '/api/vault/wallets/generate') {
        const input = await body(req);
        return send(201, vault.createWallet(input.label));
      }
      if (req.method === 'POST' && path === '/api/vault/wallets/import') {
        const input = await body(req);
        return send(201, vault.importWallet(input.label, input.privateKey));
      }
      if (req.method === 'POST' && /^\/api\/vault\/wallets\/[^/]+\/export$/.test(path)) {
        const id = path.split('/')[4];
        const input = await body(req);
        return send(200, vault.exportWallet(id, input.password));
      }
      if (req.method === 'DELETE' && /^\/api\/vault\/wallets\/[^/]+$/.test(path)) {
        const id = path.split('/')[4];
        return send(200, vault.deleteWallet(id));
      }
      if (req.method === 'GET' && path === '/api/vault/stock-balances') {
        const country = new URL(req.url, origin).searchParams.get('country') || 'us';
        const wallets = vault.getWallets();
        return send(200, await stockBalanceFn(wallets.map(w => w.address), country));
      }
      if (req.method === 'POST' && path === '/api/snipe') {
        assert(vault.isUnlocked(), 'Tresor ist gesperrt.');
        const input = await body(req);
        const results = await snipeFn({
          curve: input.curve,
          token: input.token,
          country: input.country || 'us',
          snipeOrders: input.snipeOrders || [],
          antiFrontrun: input.antiFrontrun !== false,
          maxSlippagePct: typeof input.maxSlippagePct === 'number' ? input.maxSlippagePct : 1.0,
          vault,
        });
        return send(200, { results });
      }
      if (req.method === 'POST' && path === '/api/vault/launch') {
        assert(vault.isUnlocked(), 'Tresor ist gesperrt.');
        const input = await body(req);
        const wallet = vault.findWallet(input.walletId || input.wallet);
        assert(wallet, 'Wallet nicht im Tresor gefunden.');
        const privateKey = vault.getPrivateKey(wallet.id);
        const launchDraft = { ...input, wallet: wallet.address };
        const result = await executeLaunch({ draft: launchDraft, privateKey });

        const hasSnipe = Array.isArray(input.snipeOrders) && input.snipeOrders.length > 0;
        const hasMonitor = input.monitor && input.monitor.enabled !== false;

        if (hasSnipe || hasMonitor) {
          void (async () => {
            let launchInfo;
            const start = Date.now();
            while (Date.now() - start < 90_000) {
              try {
                launchInfo = await inspectLaunchFn(result.hash);
                if (launchInfo.status === 'success' || launchInfo.status === 'reverted') break;
              } catch {}
              await new Promise(r => setTimeout(r, 250));
            }
            if (launchInfo?.status === 'success') {
              let createdMon = null;
              if (hasMonitor) {
                createdMon = createLaunchMonitor({
                  token: launchInfo.token,
                  curve: launchInfo.curve,
                  country: input.country || 'us',
                  name: `${input.name} ($${input.symbol})`,
                  monitorConfig: input.monitor,
                  creatorWallet: wallet.address,
                  creatorLabel: wallet.label,
                });
              }

              if (hasSnipe && launchInfo.curve) {
                const snipeRes = await snipeFn({
                  curve: launchInfo.curve,
                  token: launchInfo.token,
                  country: input.country || 'us',
                  snipeOrders: input.snipeOrders,
                  antiFrontrun: input.antiFrontrun !== false,
                  maxSlippagePct: typeof input.maxSlippagePct === 'number' ? input.maxSlippagePct : 1.0,
                  vault,
                });
                if (createdMon) {
                  createdMon.purchases = snipeRes;
                  createdMon.curve = launchInfo.curve;
                  createdMon.country = input.country || 'us';
                }
                for (const s of snipeRes) {
                  state.alerts.unshift({
                    id: randomUUID(),
                    name: s.status === 'success' ? `Snipe: ${s.label}` : `Snipe-Fehler: ${s.label || 'Wallet'}`,
                    message: s.status === 'success' ? `${s.amount} ${s.currency} erfolgreich eingesetzt (TX: ${s.hash}).` : `Kauf fehlgeschlagen: ${s.error}`,
                    at: Date.now(),
                    token: launchInfo.token,
                    metrics: {},
                  });
                }
                store.save();
              }
            }
          })();
        }

        return send(200, result);
      }

      // Auto-Launcher APIs
      if (req.method === 'GET' && path === '/api/auto-launcher') return send(200, autoLauncher.status());
      if (req.method === 'POST' && path === '/api/auto-launcher/config') {
        const input = await body(req);
        return send(200, autoLauncher.configure(input));
      }
      if (req.method === 'POST' && path === '/api/auto-launcher/trigger') {
        return send(200, await autoLauncher.executeNext(true));
      }

      if (req.method === 'POST' && path === '/api/queue/import') {
        let items;
        try { items = importQueue((await body(req)).csv, assetDir); }
        catch (error) { error.status = 400; throw error; }
        assert(state.queue.length + items.length <= 200, 'Die Queue darf maximal 200 Einträge enthalten.');
        state.queue.push(...items); store.save(); return send(201, { imported: items.length });
      }
      if (req.method === 'GET' && /^\/api\/queue\/[^/]+\/image$/.test(path)) {
        const item = state.queue.find(item => item.id === path.split('/')[3]); assert(item, 'Queue-Eintrag nicht gefunden.');
        const { data, type } = await readQueueImage(item, assetDir);
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length }); res.end(data); return;
      }
      if (req.method === 'GET' && path.startsWith('/api/launch/')) {
        const result = await inspectLaunchFn(path.slice(12));
        if (result.status === 'success' && !state.launches.some(l => l.hash === result.hash)) { state.launches.unshift(result); store.save(); }
        return send(200, result);
      }
      if (req.method === 'POST' && path === '/api/wallets') {
        const input = await body(req), wallet = { id: randomUUID(), label: text(input.label, 60, 'Wallet-Name'), address: address(input.address) };
        assert(state.wallets.length < 100, 'Maximal 100 gespeicherte Wallets.');
        assert(!state.wallets.some(w => w.address === wallet.address), 'Diese Wallet ist bereits gespeichert.');
        state.wallets.push(wallet); store.save(); return send(201, wallet);
      }
      if (req.method === 'POST' && path === '/api/drafts') {
        assert(state.drafts.length < 200, 'Maximal 200 Entwürfe.');
        const result = { id: randomUUID(), ...draft(await body(req)), createdAt: Date.now() };
        state.drafts.unshift(result); store.save(); return send(201, result);
      }
      if (req.method === 'POST' && path === '/api/monitors') {
        assert(state.monitors.length < 30, 'Maximal 30 Monitore.');
        const result = { id: randomUUID(), ...monitor(await body(req)), createdAt: Date.now(), conditionSince: null };
        state.monitors.unshift(result); store.save(); void poll().catch(console.error); return send(201, result);
      }
      if (req.method === 'PUT' && /^\/api\/monitors\/[^/]+$/.test(path)) {
        const id = path.split('/')[3], index = state.monitors.findIndex(m => m.id === id);
        assert(index >= 0, 'Monitor nicht gefunden.');
        const result = { id, ...monitor(await body(req)), createdAt: state.monitors[index].createdAt, conditionSince: null };
        state.monitors[index] = result; store.save(); return send(200, result);
      }
      if (req.method === 'POST' && /^\/api\/monitors\/[^/]+\/(toggle|rearm)$/.test(path)) {
        const [, , , id, action] = path.split('/');
        const item = state.monitors.find(m => m.id === id); assert(item, 'Monitor nicht gefunden.');
        if (action === 'rearm') {
          item.enabled = true; item.latched = false; item.lastAlertAt = null; item.baselinePrice = null; item.highPrice = null; item.autoSellExecuted = false;
        } else {
          assert(item.enabled || !item.once || !item.lastAlertAt, 'Dieser einmalige Alert wurde bereits ausgelöst. Bitte neu scharfstellen.');
          item.enabled = !item.enabled;
        }
        item.conditionSince = null; store.save(); return send(200, item);
      }
      if (req.method === 'POST' && path === '/api/alerts/read') {
        for (const alert of state.alerts) alert.read = true;
        store.save(); return send(200, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/(wallets|drafts|monitors|queue)\/[^/]+$/.test(path)) {
        const [, , collection, id] = path.split('/');
        const item = state[collection].findIndex(x => x.id === id); assert(item >= 0, 'Eintrag nicht gefunden.');
        state[collection].splice(item, 1); store.save(); return send(200, { ok: true });
      }
      if (path.startsWith('/api/')) return send(404, { error: 'Endpoint nicht gefunden.' });
      if (req.method === 'GET' && path === '/examples/launch-queue.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="launch-queue.csv"' });
        res.end(await readFile(resolve('examples/launch-queue.csv'))); return;
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method !== 'GET' || !files[path]) return send(404, { error: 'Nicht gefunden.' });
      const [file, type] = files[path], content = await readFile(resolve('dist', file));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content);
    } catch (e) { send(e.status ?? 502, { error: (e.shortMessage ?? e.message ?? 'Unbekannter Fehler').slice(0, 800) }); }
  });

  server.on('listening', () => {
    timer = setInterval(() => {
      void poll().catch(console.error);
      void autoLauncher.tick().catch(console.error);
    }, Math.min(interval, 3000));
    timer.unref();
    void poll().catch(console.error);
  });

  async function close() {
    clearInterval(timer);
    await new Promise(resolve => server.close(resolve));
    while (polling) await new Promise(resolve => setTimeout(resolve, 20));
    vault.close();
    store.close();
  }

  return { server, state, vault, autoLauncher, poll, close };
}
