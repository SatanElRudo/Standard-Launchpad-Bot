import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { hostImageAndMetadata } from './metadata.mjs';

export function createAutoLauncher({
  store,
  vault,
  executeLaunch,
  inspectLaunch,
  snipeFn,
  createMonitorFn,
} = {}) {
  const state = store.state;
  state.autoLauncher ??= {
    enabled: false,
    intervalMinutes: 5,
    intervalVarianceSeconds: 0,
    walletMode: 'single', // 'single' | 'rotate'
    defaultWalletId: '',
    rotationWalletIds: [],
    rotationIndex: 0,
    status: 'idle',
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    lastSuccess: null,
    inFlightTx: null,
    snipeOrders: [],
    pairAmounts: {
      us: '0.05',
      eth: '0.005',
      cn: '0.1',
      kr: '0.1'
    },
    defaultMonitor: {
      enabled: true,
      mode: 'any',
      holdSeconds: 10,
      cooldownSeconds: 60,
      once: true,
      rules: [
        { metric: 'marketCapUsd', operator: 'gte', threshold: 150000 },
        { metric: 'priceChangePct', operator: 'gte', threshold: 50 },
        { metric: 'drawdownPct', operator: 'gte', threshold: 30 }
      ]
    }
  };
  state.autoLauncher.intervalVarianceSeconds ??= 0;
  state.autoLauncher.walletMode ??= 'single';
  state.autoLauncher.rotationWalletIds ??= [];
  state.autoLauncher.rotationIndex ??= 0;
  state.autoLauncher.pairAmounts ??= {
    us: '0.05',
    eth: '0.005',
    cn: '0.1',
    kr: '0.1'
  };
  state.autoLauncher.defaultMonitor ??= {
    enabled: true,
    mode: 'any',
    holdSeconds: 10,
    cooldownSeconds: 60,
    once: true,
    rules: [
      { metric: 'marketCapUsd', operator: 'gte', threshold: 150000 },
      { metric: 'priceChangePct', operator: 'gte', threshold: 50 },
      { metric: 'drawdownPct', operator: 'gte', threshold: 30 }
    ]
  };

  let inProgress = false;

  function getNextDelayMs(al) {
    const baseSec = Math.max(1, al.intervalMinutes || 5) * 60;
    const varianceSec = Math.max(0, al.intervalVarianceSeconds || 0);
    if (varianceSec > 0) {
      const offset = Math.floor(Math.random() * (varianceSec * 2 + 1)) - varianceSec;
      return Math.max(5, baseSec + offset) * 1000;
    }
    return baseSec * 1000;
  }

  function peekNextWallet() {
    const al = state.autoLauncher;
    if (al.walletMode === 'rotate' && Array.isArray(al.rotationWalletIds) && al.rotationWalletIds.length > 0) {
      const list = al.rotationWalletIds;
      let idx = typeof al.rotationIndex === 'number' ? al.rotationIndex : 0;
      if (idx < 0 || idx >= list.length) idx = 0;
      for (let attempts = 0; attempts < list.length; attempts++) {
        const currentIdx = (idx + attempts) % list.length;
        const targetId = list[currentIdx];
        const targetWallet = vault.findWallet(targetId);
        if (targetWallet) {
          return { id: targetWallet.id, label: targetWallet.label, address: targetWallet.address, index: currentIdx };
        }
      }
    }
    if (al.defaultWalletId) {
      const def = vault.findWallet(al.defaultWalletId);
      if (def) return { id: def.id, label: def.label, address: def.address, index: 0 };
    }
    const all = vault.getWallets();
    if (all.length === 1) return { id: all[0].id, label: all[0].label, address: all[0].address, index: 0 };
    return null;
  }

  function status() {
    const al = state.autoLauncher;
    const now = Date.now();
    let countdownSeconds = 0;
    if (al.enabled && al.nextRunAt && al.nextRunAt > now) {
      countdownSeconds = Math.round((al.nextRunAt - now) / 1000);
    }
    return {
      enabled: Boolean(al.enabled),
      intervalMinutes: al.intervalMinutes ?? 5,
      intervalVarianceSeconds: al.intervalVarianceSeconds ?? 0,
      walletMode: al.walletMode ?? 'single',
      defaultWalletId: al.defaultWalletId ?? '',
      rotationWalletIds: Array.isArray(al.rotationWalletIds) ? al.rotationWalletIds : [],
      rotationIndex: al.rotationIndex ?? 0,
      nextWallet: peekNextWallet(),
      status: inProgress ? 'running' : al.status ?? 'idle',
      nextRunAt: al.nextRunAt ?? null,
      lastRunAt: al.lastRunAt ?? null,
      inProgress,
      lastError: al.lastError ?? null,
      lastSuccess: al.lastSuccess ?? null,
      inFlightTx: al.inFlightTx ?? null,
      countdownSeconds,
      queueLength: state.queue?.length ?? 0,
      snipeOrders: al.snipeOrders ?? [],
      pairAmounts: al.pairAmounts ?? { us: '0.05', eth: '0.005', cn: '0.1', kr: '0.1' },
      defaultMonitor: al.defaultMonitor ?? { enabled: true },
    };
  }

  function configure({ enabled, intervalMinutes, intervalVarianceSeconds, walletMode, defaultWalletId, rotationWalletIds, snipeOrders, pairAmounts, defaultMonitor }) {
    const al = state.autoLauncher;
    if (typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes) && intervalMinutes >= 1) {
      al.intervalMinutes = Math.min(1440, Math.max(1, Math.round(intervalMinutes)));
    }
    if (typeof intervalVarianceSeconds === 'number' && Number.isFinite(intervalVarianceSeconds) && intervalVarianceSeconds >= 0) {
      al.intervalVarianceSeconds = Math.min(3600, Math.max(0, Math.round(intervalVarianceSeconds)));
    }
    if (walletMode === 'single' || walletMode === 'rotate') {
      al.walletMode = walletMode;
    }
    if (typeof defaultWalletId === 'string') {
      al.defaultWalletId = defaultWalletId.trim();
    }
    if (Array.isArray(rotationWalletIds)) {
      al.rotationWalletIds = rotationWalletIds.map(id => String(id).trim()).filter(Boolean);
      if (al.rotationIndex >= al.rotationWalletIds.length) {
        al.rotationIndex = 0;
      }
    }
    if (pairAmounts && typeof pairAmounts === 'object') {
      al.pairAmounts = {
        us: String(pairAmounts.us ?? al.pairAmounts?.us ?? '0.05').trim().replace(',', '.'),
        eth: String(pairAmounts.eth ?? al.pairAmounts?.eth ?? '0.005').trim().replace(',', '.'),
        cn: String(pairAmounts.cn ?? al.pairAmounts?.cn ?? '0.1').trim().replace(',', '.'),
        kr: String(pairAmounts.kr ?? al.pairAmounts?.kr ?? '0.1').trim().replace(',', '.')
      };
    }
    if (Array.isArray(snipeOrders)) {
      al.snipeOrders = snipeOrders.slice(0, 10);
    }
    if (defaultMonitor && typeof defaultMonitor === 'object') {
      al.defaultMonitor = defaultMonitor;
    }
    if (typeof enabled === 'boolean') {
      const previouslyEnabled = al.enabled;
      al.enabled = enabled;
      if (enabled && !previouslyEnabled) {
        al.status = 'idle';
        al.lastError = null;
        // Schedule next execution promptly (after 3 seconds)
        al.nextRunAt = Date.now() + 3000;
      } else if (!enabled) {
        al.status = 'idle';
        al.nextRunAt = null;
      }
    }
    store.save();
    return status();
  }

  function resolveWallet(item) {
    const al = state.autoLauncher;
    if (al.walletMode === 'rotate' && Array.isArray(al.rotationWalletIds) && al.rotationWalletIds.length > 0) {
      const list = al.rotationWalletIds;
      let idx = typeof al.rotationIndex === 'number' ? al.rotationIndex : 0;
      if (idx < 0 || idx >= list.length) idx = 0;
      for (let attempts = 0; attempts < list.length; attempts++) {
        const currentIdx = (idx + attempts) % list.length;
        const targetId = list[currentIdx];
        const targetWallet = vault.findWallet(targetId);
        if (targetWallet) {
          return {
            wallet: targetWallet,
            advance: () => {
              al.rotationIndex = (currentIdx + 1) % list.length;
              store.save();
            },
          };
        }
      }
    }

    if (item.wallet) {
      const found = vault.findWallet(item.wallet);
      if (found) return { wallet: found, advance: null };
    }
    if (state.autoLauncher.defaultWalletId) {
      const def = vault.findWallet(state.autoLauncher.defaultWalletId);
      if (def) return { wallet: def, advance: null };
    }
    const all = vault.getWallets();
    if (all.length === 1) return { wallet: all[0], advance: null };
    return { wallet: null, advance: null };
  }

  async function executeNext(manual = false) {
    if (inProgress) return { skipped: 'In Ausführung' };
    const al = state.autoLauncher;
    if (!state.queue || state.queue.length === 0) {
      al.status = 'waiting';
      al.lastError = 'Entwurfs-Queue ist leer.';
      store.save();
      return { skipped: 'Queue ist leer' };
    }
    if (!vault.isUnlocked()) {
      al.enabled = false;
      al.status = 'paused_vault_locked';
      al.lastError = 'Queue angehalten: Der Tresor ist gesperrt. Bitte mit Master-Passwort entsperren und Queue fortsetzen.';
      al.nextRunAt = null;
      state.alerts.unshift({
        id: randomUUID(),
        category: 'warning',
        name: 'Queue angehalten: Tresor gesperrt 🔒',
        message: 'Die automatische Queue wurde angehalten, da der Tresor gesperrt ist. Bitte den Tresor in der Titelleiste entsperren und die Queue reaktivieren.',
        at: Date.now(),
        token: '0x0000000000000000000000000000000000000000',
        metrics: {},
      });
      store.save();
      return { error: al.lastError, paused: true };
    }

    const item = state.queue[0];
    const { wallet, advance } = resolveWallet(item);
    if (!wallet) {
      const err = al.walletMode === 'rotate'
        ? `Keine gültige Rotations-Wallet im Tresor für Eintrag „${item.name}“.`
        : `Keine passende Wallet im Tresor für Eintrag „${item.name}“ (gesucht: ${item.wallet || 'Standard-Wallet'}).`;
      al.status = 'error';
      al.lastError = err;
      al.nextRunAt = Date.now() + getNextDelayMs(al);
      state.alerts.unshift({
        id: randomUUID(),
        category: 'error',
        name: 'Auto-Launcher Fehler',
        message: err,
        at: Date.now(),
        token: '0x0000000000000000000000000000000000000000',
        metrics: {},
      });
      store.save();
      return { error: err };
    }

    inProgress = true;
    al.status = 'running';
    al.lastRunAt = Date.now();
    al.lastError = null;
    store.save();

    let privateKey;
    try {
      privateKey = vault.getPrivateKey(wallet.id);
    } catch (e) {
      inProgress = false;
      al.status = 'error';
      al.lastError = e.message;
      store.save();
      return { error: e.message };
    }

    try {
      if (item.imagePath && !item.metadataURI) {
        try {
          const hosted = await hostImageAndMetadata({
            name: item.name,
            symbol: item.symbol,
            description: item.description,
            website: item.website,
            sampleAsset: basename(item.imagePath),
          });
          if (hosted?.metadataURI) {
            item.metadataURI = hosted.metadataURI;
            item.image = hosted.image;
          }
        } catch (he) {
          console.warn('Auto-hosting metadata error:', he.message);
        }
      }
      const launchDraft = { ...item, wallet: wallet.address };
      const { hash } = await executeLaunch({ draft: launchDraft, privateKey });
      if (typeof advance === 'function') {
        advance();
      }
      al.inFlightTx = { hash, name: item.name, symbol: item.symbol, at: Date.now() };
      store.save();

      let result;
      const maxWaitMs = 120_000;
      const startWait = Date.now();
      while (Date.now() - startWait < maxWaitMs) {
        try {
          result = await inspectLaunch(hash);
          if (result.status === 'success' || result.status === 'reverted') break;
        } catch {
          // RPC delay or pending
        }
        await new Promise(r => setTimeout(r, 250));
      }

      if (result?.status === 'success') {
        state.queue.shift();
        if (!state.launches.some(l => l.hash === hash)) {
          state.launches.unshift(result);
        }
        al.lastSuccess = {
          name: item.name,
          symbol: item.symbol,
          hash,
          token: result.token,
          at: Date.now(),
        };
        al.lastError = null;
        state.alerts.unshift({
          id: randomUUID(),
          category: 'success',
          name: `Auto-Launch: ${item.name}`,
          message: `Token erfolgreich auf Robinhood Chain gelauncht: ${result.token}`,
          at: Date.now(),
          token: result.token,
          metrics: {},
        });

        let createdMon = null;
        if (typeof createMonitorFn === 'function') {
          try {
            const monCfg = item.monitor || al.defaultMonitor || { enabled: true };
            if (monCfg.enabled !== false) {
              createdMon = createMonitorFn({
                token: result.token,
                curve: result.curve,
                country: item.country || 'us',
                name: `${item.name} ($${item.symbol})`,
                monitorConfig: monCfg,
                creatorWallet: wallet.address,
                creatorLabel: wallet.label,
              });
              if (createdMon) {
                state.alerts.unshift({
                  id: randomUUID(),
                  category: 'info',
                  name: `Auto-Monitor aktiv: ${item.name}`,
                  message: `Monitoring für ${result.token} sofort gestartet (${createdMon.rules?.length || 1} Trigger-Regeln).`,
                  at: Date.now(),
                  token: result.token,
                  metrics: {},
                });
              }
            }
          } catch (me) {
            console.error('Auto-launcher monitor creation error:', me);
          }
        }

        if (typeof snipeFn === 'function' && Array.isArray(al.snipeOrders) && al.snipeOrders.length > 0 && result.curve) {
          try {
            const country = item.country || 'us';
            const effectiveSnipeOrders = al.snipeOrders.map(order => {
              const pairAmt = order.amounts?.[country] ?? order.amount ?? al.pairAmounts?.[country] ?? '0.05';
              return {
                ...order,
                amount: pairAmt,
              };
            });
            const snipeRes = await snipeFn({
              curve: result.curve,
              token: result.token,
              country: item.country,
              snipeOrders: effectiveSnipeOrders,
              antiFrontrun: true,
              vault,
            });
            if (createdMon) {
              createdMon.purchases = snipeRes;
              createdMon.curve = result.curve;
              createdMon.country = item.country || 'us';
            }
            for (const s of snipeRes) {
              state.alerts.unshift({
                id: randomUUID(),
                category: s.status === 'success' ? 'success' : 'error',
                name: s.status === 'success' ? `Auto-Snipe: ${s.label}` : `Auto-Snipe Fehler: ${s.label || 'Wallet'}`,
                message: s.status === 'success'
                  ? `${s.amount} ${s.currency} erfolgreich gekauft (TX: ${s.hash}).`
                  : `Kauf fehlgeschlagen: ${s.error}`,
                at: Date.now(),
                token: result.token,
                metrics: {},
              });
            }
          } catch (e) {
            console.error('Auto-launcher snipe error:', e);
          }
        }

        return { success: true, token: result.token, hash };
      } else if (result?.status === 'reverted') {
        throw new Error(`Transaktion ${hash} wurde on-chain zurückgewiesen (reverted).`);
      } else {
        throw new Error(`Transaktion ${hash} gesendet, aber Bestätigung steht noch aus. Im Explorer prüfen.`);
      }
    } catch (err) {
      const isFundsError = /nicht genug eth|insufficient funds|exceeds balance/i.test(err.message);
      if (isFundsError) {
        al.enabled = false;
        al.status = 'paused_insufficient_funds';
        al.lastError = `Queue angehalten: Wallet ${wallet.label} (${wallet.address}) hat nicht genügend ETH für Launch-Gebühr und Gas.`;
        al.nextRunAt = null;
        state.alerts.unshift({
          id: randomUUID(),
          category: 'warning',
          name: `Queue angehalten: Guthaben unzureichend (${wallet.label})`,
          message: `Die automatische Queue wurde angehalten: Wallet ${wallet.label} (${wallet.address}) hat nicht genügend ETH für Launch-Gebühr und Gas. Bitte Guthaben aufladen und Queue reaktivieren.`,
          at: Date.now(),
          token: '0x0000000000000000000000000000000000000000',
          metrics: {},
        });
        store.save();
        return { error: al.lastError, paused: true };
      }
      al.status = 'error';
      al.lastError = err.message;
      state.alerts.unshift({
        id: randomUUID(),
        category: 'error',
        name: `Auto-Launch Fehler (${item.name})`,
        message: err.message,
        at: Date.now(),
        token: '0x0000000000000000000000000000000000000000',
        metrics: {},
      });
      return { error: err.message };
    } finally {
      inProgress = false;
      al.inFlightTx = null;
      if (al.enabled) {
        al.status = al.lastError ? 'error' : 'idle';
        al.nextRunAt = Date.now() + getNextDelayMs(al);
      } else {
        if (al.status !== 'paused_insufficient_funds' && al.status !== 'paused_vault_locked') {
          al.status = 'idle';
        }
        al.nextRunAt = null;
      }
      store.save();
    }
  }

  async function tick() {
    if (inProgress) return;
    const al = state.autoLauncher;
    if (!al.enabled) return;
    if (!vault.isUnlocked()) {
      al.enabled = false;
      al.status = 'paused_vault_locked';
      al.lastError = 'Queue angehalten: Der Tresor wurde gesperrt.';
      al.nextRunAt = null;
      state.alerts.unshift({
        id: randomUUID(),
        category: 'warning',
        name: 'Queue angehalten: Tresor gesperrt 🔒',
        message: 'Die automatische Queue wurde angehalten, da der Tresor gesperrt wurde. Bitte den Tresor in der Titelleiste entsperren und die Queue reaktivieren.',
        at: Date.now(),
        token: '0x0000000000000000000000000000000000000000',
        metrics: {},
      });
      store.save();
      return;
    }
    if (al.nextRunAt && Date.now() >= al.nextRunAt) {
      await executeNext(false);
    }
  }

  return {
    status,
    configure,
    executeNext,
    tick,
  };
}
