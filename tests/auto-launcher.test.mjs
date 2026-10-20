import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoLauncher } from '../server/auto-launcher.mjs';
import { createVault } from '../server/vault.mjs';

function createMockStore() {
  const state = {
    queue: [],
    launches: [],
    alerts: [],
    vault: { initialized: false, salt: null, verifier: null, wallets: [] },
    autoLauncher: { enabled: false, intervalMinutes: 10, defaultWalletId: '', status: 'idle', nextRunAt: null, lastRunAt: null, lastError: null, lastSuccess: null }
  };
  return { state, save: () => {} };
}

test('auto launcher requires unlocked vault and matching wallet', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('masterpass123');

  const w1 = vault.createWallet('Deployer One');

  store.state.queue.push({
    id: 'item-1',
    name: 'Token Alpha',
    symbol: 'ALPHA',
    country: 'us',
    wallet: 'Deployer One',
  });

  let executed = false;
  const executeLaunch = async ({ draft, privateKey }) => {
    executed = true;
    assert.equal(draft.wallet, w1.address);
    assert.ok(privateKey);
    return { hash: '0x' + '1'.repeat(64) };
  };
  const inspectLaunch = async hash => ({
    status: 'success',
    hash,
    token: '0x' + '2'.repeat(40),
    name: 'Token Alpha',
    symbol: 'ALPHA',
    confirmedAt: Date.now(),
  });

  const launcher = createAutoLauncher({ store, vault, executeLaunch, inspectLaunch });

  // 1. When locked, fails gracefully and records alert
  vault.lock();
  const lockedRes = await launcher.executeNext();
  assert.match(lockedRes.error, /gesperrt/);
  assert.equal(store.state.queue.length, 1); // Not shifted
  assert.equal(store.state.alerts.length, 1);
  assert.equal(store.state.alerts[0].category, 'warning');

  // 2. Unlock vault and run
  vault.unlock('masterpass123');
  const successRes = await launcher.executeNext();
  assert.equal(successRes.success, true);
  assert.equal(executed, true);
  assert.equal(store.state.queue.length, 0); // Shifted
  assert.equal(store.state.launches.length, 1);
  assert.equal(store.state.alerts.length, 2);
  assert.equal(store.state.autoLauncher.status, 'idle');
});

test('auto launcher matches wallet by address or falls back to default', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Fallback Wallet');

  store.state.queue.push({
    id: 'item-2',
    name: 'Token Beta',
    symbol: 'BETA',
    country: 'us',
    wallet: '', // No wallet in CSV
  });

  let signedWallet = null;
  const executeLaunch = async ({ draft }) => {
    signedWallet = draft.wallet;
    return { hash: '0x' + '3'.repeat(64) };
  };
  const inspectLaunch = async hash => ({
    status: 'success',
    hash,
    token: '0x' + '4'.repeat(40),
    name: 'Token Beta',
    symbol: 'BETA',
    confirmedAt: Date.now(),
  });

  const launcher = createAutoLauncher({ store, vault, executeLaunch, inspectLaunch });
  launcher.configure({ enabled: true, intervalMinutes: 15, defaultWalletId: w1.id });

  assert.equal(launcher.status().intervalMinutes, 15);
  assert.equal(launcher.status().enabled, true);

  await launcher.executeNext();
  assert.equal(signedWallet, w1.address);
  assert.equal(store.state.queue.length, 0);
  assert.ok(launcher.status().nextRunAt > Date.now());
});

test('auto launcher rotates through multiple selected wallets', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Wallet Alpha');
  const w2 = vault.createWallet('Wallet Beta');
  const w3 = vault.createWallet('Wallet Gamma');

  store.state.queue.push(
    { id: 'q-1', name: 'Token 1', symbol: 'TK1', country: 'us' },
    { id: 'q-2', name: 'Token 2', symbol: 'TK2', country: 'us' },
    { id: 'q-3', name: 'Token 3', symbol: 'TK3', country: 'us' },
    { id: 'q-4', name: 'Token 4', symbol: 'TK4', country: 'us' }
  );

  const usedWallets = [];
  const executeLaunch = async ({ draft }) => {
    usedWallets.push(draft.wallet);
    return { hash: '0x' + Math.random().toString(16).slice(2).padStart(64, '0') };
  };
  const inspectLaunch = async hash => ({
    status: 'success',
    hash,
    token: '0x' + '9'.repeat(40),
    name: 'Token',
    symbol: 'TK',
    confirmedAt: Date.now(),
  });

  const launcher = createAutoLauncher({ store, vault, executeLaunch, inspectLaunch });
  launcher.configure({
    enabled: true,
    intervalMinutes: 5,
    walletMode: 'rotate',
    rotationWalletIds: [w1.id, w2.id, w3.id],
  });

  assert.equal(launcher.status().walletMode, 'rotate');
  assert.equal(launcher.status().rotationWalletIds.length, 3);
  assert.equal(launcher.status().nextWallet?.id, w1.id);

  // Launch 1 -> should use w1
  await launcher.executeNext();
  assert.equal(usedWallets[0], w1.address);
  assert.equal(launcher.status().nextWallet?.id, w2.id);

  // Launch 2 -> should use w2
  await launcher.executeNext();
  assert.equal(usedWallets[1], w2.address);
  assert.equal(launcher.status().nextWallet?.id, w3.id);

  // Launch 3 -> should use w3
  await launcher.executeNext();
  assert.equal(usedWallets[2], w3.address);
  assert.equal(launcher.status().nextWallet?.id, w1.id); // Wrapped back to w1

  // Launch 4 -> should wrap back to w1
  await launcher.executeNext();
  assert.equal(usedWallets[3], w1.address);
  assert.equal(launcher.status().nextWallet?.id, w2.id);
});

test('auto launcher automatically creates and starts monitor on launch', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Deployer');

  const customRules = [
    { metric: 'marketCapUsd', operator: 'gte', threshold: 250000 },
    { metric: 'priceChangePct', operator: 'gte', threshold: 75 }
  ];

  store.state.queue.push({
    id: 'q-mon',
    name: 'Monitored Token',
    symbol: 'MON',
    country: 'us',
    monitor: {
      enabled: true,
      rules: customRules,
      mode: 'all',
      holdSeconds: 5,
      cooldownSeconds: 30,
      once: true,
    }
  });

  const createdMonitors = [];
  const createMonitorFn = ({ token, name, monitorConfig }) => {
    createdMonitors.push({ token, name, monitorConfig });
    return { id: 'mon-1', token, rules: monitorConfig.rules };
  };

  const executeLaunch = async () => ({ hash: '0x' + 'a'.repeat(64) });
  const inspectLaunch = async hash => ({
    status: 'success',
    hash,
    token: '0x' + 'b'.repeat(40),
    name: 'Monitored Token',
    symbol: 'MON',
    confirmedAt: Date.now(),
  });

  const launcher = createAutoLauncher({
    store,
    vault,
    executeLaunch,
    inspectLaunch,
    createMonitorFn,
  });
  launcher.configure({ enabled: true, intervalMinutes: 5, defaultWalletId: w1.id });

  await launcher.executeNext();

  assert.equal(createdMonitors.length, 1);
  assert.equal(createdMonitors[0].token, '0x' + 'b'.repeat(40));
  assert.equal(createdMonitors[0].name, 'Monitored Token ($MON)');
  assert.equal(createdMonitors[0].monitorConfig.mode, 'all');
  assert.deepEqual(createdMonitors[0].monitorConfig.rules, customRules);
});

test('auto launcher pauses queue immediately when wallet has insufficient funds', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Poor Wallet');

  store.state.queue.push({
    id: 'q-poor',
    name: 'Broke Token',
    symbol: 'BROKE',
    country: 'us',
    wallet: 'Poor Wallet',
  });

  const executeLaunch = async () => {
    throw new Error('Nicht genug ETH für Launch-Gebühr und geschätztes Gas.');
  };
  const inspectLaunch = async () => ({ status: 'pending' });

  const launcher = createAutoLauncher({ store, vault, executeLaunch, inspectLaunch });
  launcher.configure({ enabled: true, intervalMinutes: 5, defaultWalletId: w1.id });

  assert.equal(launcher.status().enabled, true);

  const res = await launcher.executeNext();
  assert.equal(res.paused, true);
  assert.match(res.error, /Queue angehalten/);

  // Queue must be paused now!
  assert.equal(launcher.status().enabled, false);
  assert.equal(launcher.status().status, 'paused_insufficient_funds');
  assert.equal(launcher.status().nextRunAt, null);
  assert.equal(store.state.queue.length, 1); // Queue item preserved
  assert.ok(store.state.alerts.some(a => a.name.includes('Guthaben unzureichend')));
});

test('auto launcher passes creator wallet and records snipe purchases on monitor', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('masterpass123');
  const deployer = vault.createWallet('Deployer Boss');
  const sniper = vault.createWallet('Sniper Wallet');

  store.state.queue.push({
    id: 'q-snipe',
    name: 'Snipe Me',
    symbol: 'SNIP',
    country: 'us',
    wallet: deployer.address,
  });

  let createdMonitorObj = null;
  const createMonitorFn = ({ token, name, monitorConfig, creatorWallet, creatorLabel }) => {
    createdMonitorObj = { token, name, creatorWallet, creatorLabel, purchases: [] };
    return createdMonitorObj;
  };

  const executeLaunch = async () => ({ hash: '0x' + 'c'.repeat(64) });
  const inspectLaunch = async hash => ({
    status: 'success',
    hash,
    token: '0x' + 'd'.repeat(40),
    curve: '0x' + 'e'.repeat(40),
    name: 'Snipe Me',
    symbol: 'SNIP',
    confirmedAt: Date.now(),
  });

  const mockSnipeFn = async ({ curve, snipeOrders }) => {
    return snipeOrders.map(o => ({
      walletId: o.walletId,
      label: 'Sniper Wallet',
      address: sniper.address,
      amount: o.amount,
      currency: 'SPCX',
      hash: '0x' + 'f'.repeat(64),
      status: 'success',
    }));
  };

  const launcher = createAutoLauncher({
    store,
    vault,
    executeLaunch,
    inspectLaunch,
    createMonitorFn,
    snipeFn: mockSnipeFn,
  });

  launcher.configure({
    enabled: true,
    intervalMinutes: 5,
    defaultWalletId: deployer.id,
    snipeOrders: [{ walletId: sniper.id, amount: 25 }],
  });

  await launcher.executeNext();

  assert.ok(createdMonitorObj);
  assert.equal(createdMonitorObj.creatorWallet, deployer.address);
  assert.equal(createdMonitorObj.creatorLabel, 'Deployer Boss');
  assert.equal(createdMonitorObj.purchases.length, 1);
  assert.equal(createdMonitorObj.purchases[0].amount, 25);
  assert.equal(createdMonitorObj.purchases[0].currency, 'SPCX');
});

test('auto launcher passes autoSell and autoSellMode to monitor', async () => {
  const store = createMockStore();
  const vault = createVault({ store });
  vault.init('masterpass123');
  const deployer = vault.createWallet('Deployer');

  store.state.queue.push({
    id: 'q-autosell',
    name: 'AutoSell Token',
    symbol: 'AST',
    country: 'us',
    wallet: deployer.address,
    monitor: {
      enabled: true,
      autoSell: true,
      autoSellMode: 'n_minus_1',
      rules: [{ metric: 'marketCapUsd', operator: 'gte', threshold: 100000 }],
    },
  });

  let createdMonitorObj = null;
  const createMonitorFn = ({ token, name, monitorConfig, creatorWallet, curve, country }) => {
    createdMonitorObj = { token, name, creatorWallet, curve, country, ...monitorConfig };
    return createdMonitorObj;
  };

  const executeLaunch = async () => ({ hash: '0x' + '1'.repeat(64) });
  const inspectLaunch = async hash => ({
    status: 'success',
    hash,
    token: '0x' + '2'.repeat(40),
    curve: '0x' + '3'.repeat(40),
    name: 'AutoSell Token',
    symbol: 'AST',
    confirmedAt: Date.now(),
  });

  const launcher = createAutoLauncher({
    store,
    vault,
    executeLaunch,
    inspectLaunch,
    createMonitorFn,
  });

  launcher.configure({
    enabled: true,
    intervalMinutes: 5,
    defaultWalletId: deployer.id,
  });

  await launcher.executeNext();

  assert.ok(createdMonitorObj);
  assert.equal(createdMonitorObj.autoSell, true);
  assert.equal(createdMonitorObj.autoSellMode, 'n_minus_1');
  assert.equal(createdMonitorObj.curve, '0x' + '3'.repeat(40));
  assert.equal(createdMonitorObj.country, 'us');
});

test('auto launcher respects interval variance in seconds', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('masterpass123');
  const launcher = createAutoLauncher({ store, vault });

  launcher.configure({
    enabled: true,
    intervalMinutes: 10,
    intervalVarianceSeconds: 30,
  });

  const st = launcher.status();
  assert.equal(st.intervalMinutes, 10);
  assert.equal(st.intervalVarianceSeconds, 30);
});

test('auto launcher selects pair-specific snipe amounts based on token country', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('masterpass123');
  const deployer = vault.createWallet('Deployer');
  const sniper = vault.createWallet('Sniper');

  // Push an ETH token
  store.state.queue.push({
    name: 'Ether Cat',
    symbol: 'ECAT',
    country: 'eth',
    description: 'Cat on ETH',
  });

  let executedSnipeOrders = null;
  const mockSnipeFn = async ({ snipeOrders }) => {
    executedSnipeOrders = snipeOrders;
    return snipeOrders.map(o => ({ walletId: o.walletId, label: 'Sniper', amount: o.amount, currency: 'ETH', status: 'success', hash: '0xabc' }));
  };

  const launcher = createAutoLauncher({
    store,
    vault,
    executeLaunch: async () => ({ hash: '0x' + '1'.repeat(64) }),
    inspectLaunch: async hash => ({ status: 'success', hash, token: '0x' + '2'.repeat(40), curve: '0x' + '3'.repeat(40), name: 'Ether Cat', symbol: 'ECAT' }),
    snipeFn: mockSnipeFn,
  });

  launcher.configure({
    enabled: true,
    intervalMinutes: 5,
    defaultWalletId: deployer.id,
    pairAmounts: {
      us: '0.05',
      eth: '0.002',
      cn: '0.1',
      kr: '0.1',
    },
    snipeOrders: [
      {
        walletId: sniper.id,
        amounts: { us: '0.08', eth: '0.003' },
      }
    ],
  });

  await launcher.executeNext();
  assert.ok(executedSnipeOrders);
  assert.equal(executedSnipeOrders[0].amount, '0.003');
});

test('auto launcher forwards default and token-specific referrer to launch and snipe', async () => {
  const store = createMockStore();
  const vault = createVault({ store, autoLockMs: 60000 });
  vault.init('masterpass123');
  const deployer = vault.createWallet('Deployer');
  const sniper = vault.createWallet('Sniper');

  store.state.queue.push({
    id: 'item-ref-1',
    name: 'Token Ref',
    symbol: 'TREF',
    country: 'us',
    wallet: deployer.address,
  });

  let launchReferrer = null;
  let snipeReferrer = null;

  const launcher = createAutoLauncher({
    store,
    vault,
    executeLaunch: async ({ draft }) => {
      launchReferrer = draft.referrer;
      return { hash: '0x' + '1'.repeat(64) };
    },
    inspectLaunch: async hash => ({ status: 'success', hash, token: '0x' + '2'.repeat(40), curve: '0x' + '3'.repeat(40), name: 'Token Ref', symbol: 'TREF' }),
    snipeFn: async ({ referrer }) => {
      snipeReferrer = referrer;
      return [{ walletId: sniper.id, status: 'success' }];
    },
  });

  launcher.configure({
    enabled: true,
    defaultReferrer: '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7',
    snipeOrders: [{ walletId: sniper.id, amount: '0.05' }],
  });

  await launcher.executeNext();
  assert.equal(launchReferrer, '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7');
  assert.equal(snipeReferrer, '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7');
});




