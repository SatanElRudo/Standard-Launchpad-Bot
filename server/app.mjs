import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { marketToken } from './markets.mjs';
import { launchTerms, prepareLaunch, inspectLaunch, executeDirectLaunch, getBalances, getClaimableFees, executeClaimFees, client } from './chain.mjs';
import { address, draft, monitor, text, assert } from './validation.mjs';
import { deployment } from '../shared/deployment.mjs';
import { evaluateRules } from '../shared/rules.mjs';
import { importQueue, readQueueImage, createQueueWatcher, validateImagePath } from './queue.mjs';
import { createVault } from './vault.mjs';
import { createAutoLauncher } from './auto-launcher.mjs';
import { getStockBalances, executeMultiSnipe, executeMultiSell, extractPayoutFromReceipt } from './sniper.mjs';
import { hostImageAndMetadata, listSampleAssets } from './metadata.mjs';

const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);

const tokenPointsCache = new Map();
const walletPointsCache = new Map();

async function getLiveWalletPoints(walletAddr) {
  if (!walletAddr || !/^0x[0-9a-fA-F]{40}$/.test(walletAddr)) return null;
  const key = walletAddr.toLowerCase();
  const cached = walletPointsCache.get(key);
  if (cached && Date.now() - cached.at < 20_000) return cached.data;
  try {
    const res = await fetch(`https://markets.standardreserve.xyz/v1/pilot/wallets/${walletAddr}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
    if (res) {
      walletPointsCache.set(key, { at: Date.now(), data: res });
      return res;
    }
  } catch {}
  return null;
}

async function getLiveTokenPoints(tokenAddr, vaultMap) {
  if (!tokenAddr || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddr)) return null;
  const key = tokenAddr.toLowerCase();
  const cached = tokenPointsCache.get(key);
  if (cached && Date.now() - cached.at < 15_000) return cached.data;

  try {
    const [tokenRes, tradesRes] = await Promise.all([
      fetch(`https://markets.standardreserve.xyz/v1/tokens/${tokenAddr}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`https://markets.standardreserve.xyz/v1/tokens/${tokenAddr}/trades`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const deployerPoints = Number(tokenRes?.token?.deployerPoints || 0);
    const pilotPoints = Number(tokenRes?.token?.pilotPoints || 0);

    const buyersMap = new Map();
    for (const t of (tradesRes?.trades || [])) {
      const traderAddr = t.trader?.toLowerCase();
      if (vaultMap && vaultMap.has(traderAddr)) {
        const vw = vaultMap.get(traderAddr);
        const cur = buyersMap.get(traderAddr) || { wallet: traderAddr, label: vw.label, usdVolume: 0 };
        cur.usdVolume += Number(t.usd) || 0;
        buyersMap.set(traderAddr, cur);
      }
    }

    const buyerPoints = Array.from(buyersMap.values()).map(b => {
      // Standard Reserve Season 1 rule: 5.07 points per USD traded on bonding curve (multiplier 5 + bonuses)
      const pts = Number((b.usdVolume * 5.07).toFixed(2));
      return {
        wallet: b.wallet,
        label: b.label,
        usdVolume: Number(b.usdVolume.toFixed(2)),
        points: pts,
      };
    });

    const data = {
      deployerPoints: Number(deployerPoints.toFixed(2)),
      pilotPoints: Number(pilotPoints.toFixed(2)),
      buyerPoints,
      totalBuyerPoints: buyerPoints.reduce((acc, b) => acc + b.points, 0),
    };
    tokenPointsCache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return { deployerPoints: 0, pilotPoints: 0, buyerPoints: [], totalBuyerPoints: 0 };
  }
}

let pilotPoolCache = { at: 0, vault: 0, data: null };
async function getLivePilotPoolStats(rewardVaultOverride) {
  const currentRewardVault = Number(rewardVaultOverride) || 1141245.2;
  if (pilotPoolCache.data && Date.now() - pilotPoolCache.at < 30_000 && pilotPoolCache.vault === currentRewardVault) {
    return pilotPoolCache.data;
  }
  try {
    const summaryRes = await fetch('https://markets.standardreserve.xyz/v1/pilot/summary')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);

    const totalPoints = Number(summaryRes?.summary?.totalPoints || summaryRes?.totalPoints || 43549000);
    const countries = summaryRes?.summary?.countries || summaryRes?.countries || [];
    const leaderCode = summaryRes?.summary?.leader || summaryRes?.leader || 'US';
    const leaderCountry = countries.find(c => (c.country || '').toUpperCase() === leaderCode.toUpperCase());
    const leaderPoints = Number(leaderCountry?.points || 25150000);

    // 65% Incentives: Every point earns its share, whichever team wins
    const incentivesPoolUsd = currentRewardVault * 0.65;
    const incentivesPointValueUsd = totalPoints > 0 ? Number((incentivesPoolUsd / totalPoints).toFixed(5)) : 0.01703;

    // 100% Average: Entire pool distributed over all points
    const poolPointValueUsd = totalPoints > 0 ? Number((currentRewardVault / totalPoints).toFixed(5)) : 0.02621;

    // 35% Jackpot: Split by the team with the most points (leader country, e.g. US)
    const jackpotPoolUsd = currentRewardVault * 0.35;
    const jackpotExtraPerPoint = leaderPoints > 0 ? (jackpotPoolUsd / leaderPoints) : 0;
    const leaderPointValueUsd = Number((incentivesPointValueUsd + jackpotExtraPerPoint).toFixed(5));

    const stats = {
      totalPoints,
      feesUsd: currentRewardVault,
      rewardVaultUsd: currentRewardVault,
      leaderCountry: leaderCode,
      leaderPoints,
      incentivesPoolUsd: Number(incentivesPoolUsd.toFixed(2)),
      jackpotPoolUsd: Number(jackpotPoolUsd.toFixed(2)),
      incentivesPointValueUsd,  // 65% guaranteed
      poolPointValueUsd,        // 100% average
      leaderPointValueUsd,      // 65% + 35% Jackpot for winning team
      updatedAt: Date.now(),
    };
    pilotPoolCache = { at: Date.now(), vault: currentRewardVault, data: stats };
    return stats;
  } catch {
    return pilotPoolCache.data || {
      totalPoints: 43549000,
      feesUsd: currentRewardVault,
      rewardVaultUsd: currentRewardVault,
      leaderCountry: 'US',
      leaderPoints: 25150000,
      incentivesPoolUsd: 741809.38,
      jackpotPoolUsd: 399435.82,
      incentivesPointValueUsd: 0.01703,
      poolPointValueUsd: 0.02621,
      leaderPointValueUsd: 0.03291,
      updatedAt: 0,
    };
  }
}

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
  getFeesFn = getClaimableFees,
  claimFeesFn = executeClaimFees,
} = {}) {
  const store = createStore(dataDir), state = store.state;
  const vault = createVault({
    store,
    isKeepAliveActive: () => Boolean(state.autoLauncher?.enabled && (state.queue?.length > 0 || state.autoLauncher?.status === 'running'))
  });

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
                    const defaultRef = state.autoLauncher?.defaultReferrer || '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7';
                    const effectiveRef = (current.referrer && current.referrer !== '0x0000000000000000000000000000000000000000') ? current.referrer : defaultRef;
                    const sellRes = await sellFn({
                      curve: targetCurve,
                      token: targetToken,
                      country: targetCountry,
                      purchases: targetPurchases,
                      autoSellMode: targetMode,
                      referrer: effectiveRef,
                      vault,
                    });
                    const mon = state.monitors.find(m => m.id === monitorId);
                    if (mon) {
                      mon.sellResults = sellRes;
                      mon.autoSellResults = sellRes;
                    }
                    const matchingLaunch = state.launches.find(l => (l.token || '').toLowerCase() === targetToken.toLowerCase());
                    if (matchingLaunch) {
                      matchingLaunch.sellResults = sellRes;
                    }
                    const soldCount = sellRes.filter(r => r.status === 'success').length;
                    const keptWallet = sellRes.find(r => r.status === 'kept_best_entry');
                    state.alerts.unshift({
                      id: randomUUID(),
                      category: 'success',
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
                      category: 'error',
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

  const projectRoot = resolve(assetDir, '..');
  const queueWatcher = createQueueWatcher({
    projectRoot,
    assetDir,
    state,
    store,
    onSync: ({ count, path }) => {
      state.alerts.unshift({
        id: randomUUID(),
        category: 'info',
        name: 'CSV-Queue synchronisiert',
        message: `${count} Entwürfe aus ${path} eingelesen.`,
        at: Date.now(),
        token: '0x0000000000000000000000000000000000000000',
        metrics: {},
      });
    }
  });

  try {
    queueWatcher.startWatch();
  } catch (e) {
    console.warn('Queue watcher could not start on init:', e.message);
  }

  const autoLauncher = createAutoLauncher({
    store,
    vault,
    executeLaunch,
    inspectLaunch: inspectLaunchFn,
    snipeFn,
    createMonitorFn: createLaunchMonitor,
    removeQueueItemFn: (item) => queueWatcher.removeQueueItemFromFile(item),
  });

  async function body(req) {
    assert(req.headers['content-type']?.split(';')[0] === 'application/json', 'Content-Type application/json erforderlich.');
    let result = '';
    for await (const chunk of req) { result += chunk; assert(Buffer.byteLength(result) <= 5_000_000, 'Anfrage zu groß (max. 5 MB).'); }
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

      // Metadata & Image Hosting APIs
      if (req.method === 'GET' && path === '/api/sample-assets') {
        return send(200, await listSampleAssets(assetDir));
      }
      if (req.method === 'POST' && path === '/api/metadata/upload') {
        const input = await body(req);
        let imageBuffer = null;
        if (input.imageBase64) {
          const parts = input.imageBase64.split(',');
          const rawBase64 = parts.length > 1 ? parts[1] : parts[0];
          imageBuffer = Buffer.from(rawBase64, 'base64');
        }
        const hosted = await hostImageAndMetadata({
          name: input.name,
          symbol: input.symbol,
          description: input.description,
          website: input.website,
          imageBuffer,
          imageMime: input.imageMime || 'image/png',
          imageFilename: input.imageFilename || 'image.png',
          sampleAsset: input.sampleAsset,
          existingImageUrl: input.image,
          assetDir,
        });
        return send(200, hosted);
      }

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
        const addrs = wallets.map(w => w.address);
        const [balances, spcxBalances] = await Promise.all([
          balanceFn(addrs),
          stockBalanceFn(addrs, 'us'),
        ]);
        const enriched = wallets.map(w => ({
          ...w,
          balanceEth: balances[w.address.toLowerCase()] ?? '0',
          balanceSpcx: spcxBalances[w.address.toLowerCase()] ?? '0',
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
      if (req.method === 'GET' && path === '/api/fees') {
        const curves = [...new Set([
          ...(state.launches || []).map(l => l.curve),
          ...(state.monitors || []).map(m => m.curve),
        ].filter(c => c && /^0x[0-9a-fA-F]{40}$/.test(c)))];
        const feeData = await getFeesFn(curves);
        const vaultWallets = vault.getWallets();
        const vaultMap = new Map(vaultWallets.map(w => [w.address.toLowerCase(), w]));
        const publicWalletMap = new Map((state.wallets || []).map(w => [w.address.toLowerCase(), w]));
        const launchesMap = new Map((state.launches || []).map(l => [l.curve?.toLowerCase(), l]));

        const byCurve = await Promise.all(feeData.map(async f => {
          const launch = launchesMap.get(f.curve.toLowerCase());
          const vaultWallet = vaultMap.get(f.feeRecipient?.toLowerCase());
          const publicWallet = publicWalletMap.get(f.feeRecipient?.toLowerCase());
          const tokenAddr = f.token || launch?.token || '';
          const pts = await getLiveTokenPoints(tokenAddr, vaultMap);
          return {
            ...f,
            name: launch?.name || '',
            symbol: launch?.symbol || '',
            token: tokenAddr,
            walletLabel: vaultWallet?.label || publicWallet?.label || '',
            isMine: Boolean(vaultWallet),
            confirmedAt: launch?.confirmedAt || null,
            txHash: launch?.hash || '',
            deployerPoints: pts?.deployerPoints || 0,
            pilotPoints: pts?.pilotPoints || 0,
            buyerPoints: pts?.buyerPoints || [],
          };
        }));

        const byWallet = {};
        for (const item of byCurve) {
          const addr = (item.feeRecipient || '').toLowerCase();
          if (!addr) continue;
          if (!byWallet[addr]) {
            const vw = vaultMap.get(addr);
            const pw = publicWalletMap.get(addr);
            byWallet[addr] = {
              address: item.feeRecipient,
              label: vw?.label || pw?.label || (item.feeRecipient.slice(0, 6) + '…' + item.feeRecipient.slice(-4)),
              isVault: Boolean(vw),
              vaultId: vw?.id || null,
              totalBalanceEth: 0,
              totalBalanceSpcx: 0,
              feesByCurrency: {},
              curves: [],
              totalDeployerPoints: 0,
              totalBuyerPoints: 0,
            };
          }
          const num = Number(item.balanceFormatted || item.balanceEth) || 0;
          const sym = item.stockSymbol || (item.isNativeEth ? 'ETH' : 'SPCX');
          byWallet[addr].feesByCurrency[sym] = (byWallet[addr].feesByCurrency[sym] || 0) + num;
          byWallet[addr].totalBalanceEth += num;
          if (sym === 'SPCX') {
            byWallet[addr].totalBalanceSpcx += num;
          }
          byWallet[addr].totalDeployerPoints += (item.deployerPoints || 0);
          if (num > 0) {
            byWallet[addr].curves.push(item);
          }
        }

        // Add buyer points to byWallet for wallets that bought tokens
        for (const item of byCurve) {
          for (const b of (item.buyerPoints || [])) {
            const buyerAddr = b.wallet.toLowerCase();
            if (!byWallet[buyerAddr]) {
              const vw = vaultMap.get(buyerAddr);
              const pw = publicWalletMap.get(buyerAddr);
              byWallet[buyerAddr] = {
                address: b.wallet,
                label: b.label || vw?.label || pw?.label || (b.wallet.slice(0, 6) + '…' + b.wallet.slice(-4)),
                isVault: Boolean(vw),
                vaultId: vw?.id || null,
                totalBalanceEth: 0,
                totalBalanceSpcx: 0,
                feesByCurrency: {},
                curves: [],
                totalDeployerPoints: 0,
                totalBuyerPoints: 0,
              };
            }
            byWallet[buyerAddr].totalBuyerPoints += (b.points || 0);
          }
        }

        for (const w of Object.values(byWallet)) {
          w.totalBalanceEth = (w.totalBalanceEth || 0).toFixed(6).replace(/\.?0+$/, '') || '0';
          w.totalBalanceSpcx = (w.totalBalanceSpcx || 0).toFixed(4).replace(/\.?0+$/, '') || '0';
          const feeParts = [];
          for (const [sym, amt] of Object.entries(w.feesByCurrency || {})) {
            if (amt > 0) {
              const dec = sym === 'ETH' ? 6 : 4;
              feeParts.push(`${amt.toFixed(dec).replace(/\.?0+$/, '')} ${sym}`);
            }
          }
          w.feeSummary = feeParts.length > 0 ? feeParts.join(' + ') : '0 ETH';
          w.hasFees = feeParts.length > 0;
          const liveWp = await getLiveWalletPoints(w.address);
          if (liveWp) {
            const totalTrading = (liveWp.countries || []).reduce((acc, c) => acc + (c.trading || 0), 0);
            const totalDeployer = (liveWp.countries || []).reduce((acc, c) => acc + (c.deployer || 0), 0);
            if (totalDeployer > 0) w.totalDeployerPoints = Number(totalDeployer.toFixed(2));
            if (totalTrading > 0) w.totalBuyerPoints = Number(totalTrading.toFixed(2));
          } else {
            w.totalDeployerPoints = Number((w.totalDeployerPoints || 0).toFixed(2));
            w.totalBuyerPoints = Number((w.totalBuyerPoints || 0).toFixed(2));
          }
        }

        const enrichedLaunches = await Promise.all((state.launches || []).map(async l => {
          const pts = await getLiveTokenPoints(l.token, vaultMap);

          const matchingMon = (state.monitors || []).find(m => (m.token || '').toLowerCase() === (l.token || '').toLowerCase());
          const snipeResults = (Array.isArray(l.snipeResults) && l.snipeResults.length)
            ? l.snipeResults
            : (matchingMon?.purchases || []);
          const sellResults = (Array.isArray(l.sellResults) && l.sellResults.length)
            ? l.sellResults
            : (matchingMon?.sellResults || matchingMon?.autoSellResults || []);

          // Backfill payout / ethReceived from on-chain receipt if missing
          for (const s of sellResults) {
            if ((!s.ethReceived || s.ethReceived === '0') && s.hash && s.status === 'success') {
              try {
                const rc = await client.getTransactionReceipt({ hash: s.hash });
                if (rc) {
                  s.ethReceived = extractPayoutFromReceipt(rc, s.address);
                  s.payoutAmount = s.ethReceived;
                }
              } catch {}
            }
          }

          let snipeEth = 0;
          let snipeUsd = 0;
          let snipeStock = 0;
          let snipeCurrency = l.country === 'us' ? 'SPCX' : 'ETH';
          for (const s of (snipeResults || [])) {
            const amt = Number(s.amount) || 0;
            if (s.currency === 'SPCX') {
              snipeCurrency = 'SPCX';
              snipeStock += amt;
              snipeUsd += amt;
              snipeEth += amt / 2600;
            } else {
              snipeEth += amt;
              snipeUsd += amt * 2600;
            }
          }

          let sellEth = 0;
          let sellUsd = 0;
          let sellStock = 0;
          for (const s of (sellResults || [])) {
            const amt = Number(s.payoutAmount || s.ethReceived) || 0;
            if (s.currency === 'SPCX') {
              sellStock += amt;
              sellUsd += amt;
              sellEth += amt / 2600;
            } else {
              sellEth += amt;
              sellUsd += amt * 2600;
            }
          }

          // Historical on-chain amounts for the two initial test launches
          if (l.hash === '0xee928cfd534d22d2dec01cd0c0f4e4aad04ea8c778507a73cbb6b82311bc0e93') {
            snipeEth = 0.0042;
            snipeUsd = 0.0042 * 2600;
            sellEth = 0.004022;
            sellUsd = 0.004022 * 2600;
          } else if (l.hash === '0x1257cabc11bb3146ce9c6a941609323fdb346b4ae3538a8cb4bc612ed0167505') {
            snipeEth = 0.0042;
            snipeUsd = 0.0042 * 2600;
            sellEth = 0.004115;
            sellUsd = 0.004115 * 2600;
          }

          const feeItem = byCurve.find(c => c.curve?.toLowerCase() === l.curve?.toLowerCase());
          const feeAmount = feeItem ? Number(feeItem.balanceFormatted || feeItem.balanceEth) : (l.hash === '0xee928cfd534d22d2dec01cd0c0f4e4aad04ea8c778507a73cbb6b82311bc0e93' ? 0.00003 : 0);
          const feeSymbol = feeItem?.stockSymbol || (l.country === 'us' ? 'SPCX' : 'ETH');
          const isEthFee = feeSymbol === 'ETH' || feeItem?.isNativeEth || l.country === 'eth';

          const feesUsd = isEthFee ? (feeAmount * 2600) : (feeAmount * 1.0);
          const feesEth = isEthFee ? feeAmount : (feesUsd / 2600);
          const feesStock = isEthFee ? 0 : feeAmount;
          const launchFeeEth = l.launchFeeEth || 0.0005;
          const launchCostUsd = launchFeeEth * 2600;

          const onchainPnlUsd = (sellUsd + feesUsd) - (launchCostUsd + snipeUsd);
          const netPnlEth = onchainPnlUsd / 2600;

          return {
            ...l,
            deployerPoints: pts?.deployerPoints || 0,
            pilotPoints: pts?.pilotPoints || 0,
            buyerPoints: pts?.buyerPoints || [],
            launchFeeEth,
            snipeEth,
            sellEth,
            snipeUsd,
            sellUsd,
            snipeStock,
            sellStock,
            snipeCurrency,
            feeAmount,
            feeSymbol,
            feesEth,
            feesStock,
            feesUsd,
            onchainPnlUsd,
            netPnlEth,
            hasPnlData: Boolean(snipeEth || sellEth || snipeStock || sellStock),
          };
        }));

        const pilotStats = await getLivePilotPoolStats(state.settings?.rewardVaultUsd);
        return send(200, {
          byCurve,
          byWallet,
          launches: enrichedLaunches,
          pilotStats,
          settings: state.settings || { pointValueMode: 'auto', customPointValueUsd: 0.02622, rewardVaultUsd: 1141245.2 },
        });
      }
      if (req.method === 'GET' && path === '/api/settings') {
        const pilotStats = await getLivePilotPoolStats(state.settings?.rewardVaultUsd);
        return send(200, {
          settings: state.settings || { pointValueMode: 'auto', customPointValueUsd: 0.02622, rewardVaultUsd: 1141245.2 },
          pilotStats,
        });
      }
      if (req.method === 'POST' && path === '/api/settings') {
        const input = await body(req);
        state.settings = {
          ...(state.settings || { pointValueMode: 'auto', customPointValueUsd: 0.02622, rewardVaultUsd: 1141245.2 }),
          ...input,
        };
        store.save();
        return send(200, { success: true, settings: state.settings });
      }
      if (req.method === 'POST' && path === '/api/fees/claim') {
        assert(vault.isUnlocked(), 'Tresor ist gesperrt.');
        const input = await body(req);
        const swapToEth = input.swapToEth !== false;

        if (input.walletAddress) {
          const walletAddr = input.walletAddress.toLowerCase();
          const wallet = vault.findWallet(walletAddr);
          assert(wallet, `Keine passende Tresor-Wallet (${input.walletAddress}) gefunden.`);
          const privateKey = vault.getPrivateKey(wallet.id);

          const curves = [...new Set([
            ...(state.launches || []).map(l => l.curve),
            ...(state.monitors || []).map(m => m.curve),
          ].filter(c => c && /^0x[0-9a-fA-F]{40}$/.test(c)))];
          const feeData = await getFeesFn(curves);
          const walletCurves = feeData.filter(f => f.feeRecipient?.toLowerCase() === walletAddr && Number(f.balanceEth) > 0);
          assert(walletCurves.length > 0, 'Keine claimbaren Gebühren für diese Wallet vorhanden.');

          const results = [];
          for (const item of walletCurves) {
            try {
              const res = await claimFeesFn({ curve: item.curve, privateKey, swapToEth });
              results.push({ curve: item.curve, amount: item.balanceEth, ...res });
              state.alerts.unshift({
                id: randomUUID(),
                name: `Gebühren geclaimt: ${wallet.label}`,
                message: `${item.balanceEth} ${item.stockSymbol} für Curve ${item.curve} abgeholt${res.swapResult?.swapped ? ' und in ETH umgetauscht' : ''} (TX: ${res.hash}).`,
                at: Date.now(),
                token: item.curve,
                metrics: {},
              });
            } catch (err) {
              results.push({ curve: item.curve, error: err.message });
            }
          }
          store.save();
          return send(200, { success: true, results, swapToEth });
        }

        const curve = input.curve;
        assert(curve && /^0x[0-9a-fA-F]{40}$/.test(curve), 'Ungültige Curve-Adresse.');
        const [feeInfo] = await getFeesFn([curve]);
        assert(feeInfo && feeInfo.feeRecipient, 'Curve oder Gebührenempfänger nicht gefunden.');
        const wallet = vault.findWallet(feeInfo.feeRecipient);
        assert(wallet, `Keine passende Empfänger-Wallet (${feeInfo.feeRecipient}) im Tresor gefunden.`);
        const privateKey = vault.getPrivateKey(wallet.id);
        const claimResult = await claimFeesFn({ curve, privateKey, swapToEth });
        state.alerts.unshift({
          id: randomUUID(),
          name: `Gebühren geclaimt: ${wallet.label}`,
          message: `${feeInfo.balanceEth} ${feeInfo.stockSymbol} für Curve ${curve} erfolgreich abgeholt${claimResult.swapResult?.swapped ? ' und in ETH umgetauscht' : ''} (TX: ${claimResult.hash}).`,
          at: Date.now(),
          token: curve,
          metrics: {},
        });
        store.save();
        return send(200, { ...claimResult, claimedAmount: feeInfo.balanceEth, stockSymbol: feeInfo.stockSymbol, swapToEth });
      }
      if (req.method === 'POST' && path === '/api/snipe') {
        assert(vault.isUnlocked(), 'Tresor ist gesperrt.');
        const input = await body(req);
        const defaultRef = state.autoLauncher?.defaultReferrer || '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7';
        const effectiveRef = (input.referrer && input.referrer !== '0x0000000000000000000000000000000000000000') ? input.referrer : defaultRef;
        const results = await snipeFn({
          curve: input.curve,
          token: input.token,
          country: input.country || 'us',
          snipeOrders: input.snipeOrders || [],
          antiFrontrun: input.antiFrontrun !== false,
          maxSlippagePct: typeof input.maxSlippagePct === 'number' ? input.maxSlippagePct : 1.0,
          referrer: effectiveRef,
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
        if (input.imagePath && !input.metadataURI) {
          try {
            const { basename } = await import('node:path');
            const hosted = await hostImageAndMetadata({
              name: input.name,
              symbol: input.symbol,
              description: input.description,
              website: input.website,
              sampleAsset: basename(input.imagePath),
            });
            if (hosted?.metadataURI) {
              input.metadataURI = hosted.metadataURI;
              input.image = hosted.image;
            }
          } catch (he) {
            console.warn('Auto-hosting metadata error:', he.message);
          }
        }
        const defaultRef = state.autoLauncher?.defaultReferrer || '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7';
        const effectiveRef = (input.referrer && input.referrer !== '0x0000000000000000000000000000000000000000') ? input.referrer : defaultRef;
        const launchDraft = { ...input, wallet: wallet.address, referrer: effectiveRef };
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
                  referrer: effectiveRef,
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
      if (req.method === 'POST' && path === '/api/auto-launcher/control') {
        const input = await body(req);
        return send(200, autoLauncher.control(input));
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
      if (req.method === 'GET' && path === '/api/queue/sync') {
        return send(200, queueWatcher.status());
      }
      if (req.method === 'POST' && path === '/api/queue/sync') {
        const input = await body(req);
        const result = await queueWatcher.syncFromFile(input.path);
        if (input.path) queueWatcher.startWatch(input.path);
        return send(200, result);
      }
      if (req.method === 'PUT' && /^\/api\/queue\/[^/]+$/.test(path)) {
        const id = path.split('/')[3];
        const idx = state.queue.findIndex((q, i) => q.id === id || String(i) === id);
        assert(idx !== -1, 'Queue-Eintrag nicht gefunden.');
        const existing = state.queue[idx];
        const input = await body(req);
        const validated = draft({
          name: input.name ?? existing.name,
          symbol: input.symbol ?? existing.symbol,
          description: input.description ?? existing.description,
          website: input.website ?? existing.website,
          image: input.image ?? existing.image ?? '',
          metadataURI: input.metadataURI ?? existing.metadataURI ?? '',
          country: input.country ?? existing.country,
          afterGraduates: input.afterGraduates ?? existing.afterGraduates,
          hook: input.hook ?? existing.hook,
          charterDrop: input.charterDrop ?? existing.charterDrop,
          payout: input.payout ?? existing.payout,
          devBuy: input.devBuy ?? existing.devBuy,
          snipeTax: input.snipeTax ?? existing.snipeTax,
          referrer: input.referrer ?? existing.referrer,
          wallet: input.wallet ?? existing.wallet,
        });
        let imagePath = existing.imagePath;
        if (input.imagePath) {
          try { imagePath = validateImagePath(input.imagePath, assetDir); } catch {}
        }
        state.queue[idx] = {
          ...existing,
          ...validated,
          imagePath,
          monitor: input.monitor && typeof input.monitor === 'object' ? { ...existing.monitor, ...input.monitor } : existing.monitor,
        };
        store.save();
        return send(200, state.queue[idx]);
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
      if (req.method === 'POST' && /^\/api\/monitors\/[^/]+\/(exit|sell)$/.test(path)) {
        const id = path.split('/')[3];
        const mon = state.monitors.find(m => m.id === id);
        assert(mon, 'Monitor nicht gefunden.');
        assert(vault.isUnlocked(), 'Der Tresor ist gesperrt. Bitte zuerst entsperren.');
        assert(mon.curve && mon.token, 'Monitor hat keine gültige Curve/Token-Adresse.');

        let targetPurchases = Array.isArray(mon.purchases) && mon.purchases.length > 0 ? [...mon.purchases] : [];
        if (targetPurchases.length === 0) {
          const vw = vault.getWallets();
          targetPurchases = vw.map(w => ({ walletId: w.id, label: w.label, address: w.address }));
        }

        const defaultRef = state.autoLauncher?.defaultReferrer || '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7';
        const effectiveRef = (mon.referrer && mon.referrer !== '0x0000000000000000000000000000000000000000') ? mon.referrer : defaultRef;
        const sellRes = await sellFn({
          curve: mon.curve,
          token: mon.token,
          country: mon.country || 'us',
          purchases: targetPurchases,
          autoSellMode: mon.autoSellMode || 'all',
          referrer: effectiveRef,
          vault,
        });

        mon.autoSellExecuted = true;
        mon.autoSellResults = sellRes;
        mon.sellResults = sellRes;
        
        const matchingLaunch = state.launches.find(l => (l.token || '').toLowerCase() === mon.token.toLowerCase());
        if (matchingLaunch) {
          matchingLaunch.sellResults = sellRes;
        }

        const succ = sellRes.filter(r => r.status === 'success');
        state.alerts.unshift({
          id: randomUUID(),
          category: succ.length ? 'success' : 'error',
          name: `Manueller Exit: ${mon.name}`,
          message: succ.length
            ? `Sofort-Verkauf erfolgreich ausgeführt für ${succ.length} Wallet(s).`
            : `Sofort-Verkauf fehlgeschlagen: ${sellRes[0]?.error || 'Kein Erlös erzielt.'}`,
          at: Date.now(),
          token: mon.token,
          metrics: {},
        });
        store.save();
        return send(200, { success: true, results: sellRes });
      }
      if (req.method === 'POST' && path === '/api/alerts/read') {
        for (const alert of state.alerts) alert.read = true;
        store.save(); return send(200, { ok: true });
      }
      // Delete launch history
      if (req.method === 'DELETE' && (path === '/api/launches' || path === '/api/launch')) {
        state.launches = [];
        store.save();
        return send(200, { ok: true, cleared: true });
      }
      if (req.method === 'DELETE' && /^\/api\/(launches|launch)\/[^/]+$/.test(path)) {
        const hash = path.split('/')[3].toLowerCase();
        const index = (state.launches || []).findIndex(l =>
          (l.hash || '').toLowerCase() === hash ||
          (l.token || '').toLowerCase() === hash ||
          (l.id || '').toLowerCase() === hash
        );
        assert(index >= 0, 'Launch nicht gefunden.');
        state.launches.splice(index, 1);
        store.save();
        return send(200, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/(wallets|drafts|monitors|queue)\/[^/]+$/.test(path)) {
        const [, , collection, id] = path.split('/');
        const itemIndex = state[collection].findIndex(x => x.id === id); assert(itemIndex >= 0, 'Eintrag nicht gefunden.');
        const [deletedItem] = state[collection].splice(itemIndex, 1);
        if (collection === 'queue' && deletedItem) {
          await queueWatcher.removeQueueItemFromFile({ name: deletedItem.name, symbol: deletedItem.symbol }).catch(() => {});
        }
        store.save(); return send(200, { ok: true });
      }
      if (path.startsWith('/api/')) return send(404, { error: 'Endpoint nicht gefunden.' });
      if (req.method === 'GET' && path === '/examples/launch-queue.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="launch-queue.csv"' });
        res.end(await readFile(resolve('examples/launch-queue.csv'))); return;
      }
      const files = {
        '/': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'text/javascript'],
        '/style.css': ['style.css', 'text/css'],
        '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
        '/favicon.ico': ['favicon.svg', 'image/svg+xml'],
      };
      if (req.method !== 'GET' || !files[path]) return send(404, { error: 'Nicht gefunden.' });
      const [file, type] = files[path], content = await readFile(resolve('dist', file));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache, no-store, must-revalidate' }); res.end(content);
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
    queueWatcher.stop();
    vault.close();
    store.close();
  }

  return { server, state, vault, autoLauncher, queueWatcher, poll, close };
}
