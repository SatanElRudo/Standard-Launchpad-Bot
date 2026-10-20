import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { encodeFunctionData, decodeFunctionData } from 'viem';
import { dropAbi, legacyAbi, vhooksAbi, client, prepareLaunch } from '../server/chain.mjs';
import { deployment } from '../shared/deployment.mjs';
const token = '0x0000000000000000000000000000000000000001';
const monitorInput = { token, name: 'Signal', mode: 'any', holdSeconds: 0, cooldownSeconds: 10, once: true, rules: [{ metric: 'marketCapUsd', operator: 'gte', threshold: 100 }] };
test('API validates inputs, rejects foreign origins and persists alerts across restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'standard-test-'));
  let fresh = true;
  const market = async () => ({ token, asOfTime: Date.now() / 1000, stale: !fresh, marketCapUsd: 200, priceUsd: 1 });
  let app = createApp({ dataDir: directory, market, interval: 999999 });
  const listen = async () => { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${app.server.address().port}`; };
  let base = await listen();
  const request = (path, body, method = 'POST', origin = base) => fetch(base + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await request('/api/wallets', { label: 'Test', address: token }, 'POST', 'https://foreign.example')).status, 400);
    assert.equal((await request('/api/wallets', { label: 'Test', address: 'bad' })).status, 400);
    assert.equal((await request('/api/monitors', { ...monitorInput, rules: [] })).status, 400);
    assert.equal((await request('/api/wallets', { label: 'Test', address: token })).status, 201);
    const created = await (await request('/api/monitors', monitorInput)).json();
    await app.poll();
    let state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.alerts.length, 1); assert.equal(state.monitors[0].enabled, false);
    await request(`/api/monitors/${created.id}/rearm`, {});
    fresh = false; await app.poll();
    state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.alerts.length, 1); assert.ok(state.monitors[0].error); assert.equal(state.monitors[0].conditionSince, null);
    await request('/api/alerts/read', {});
    await app.close();
    app = createApp({ dataDir: directory, market, interval: 999999 }); base = await listen();
    state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.wallets.length, 1); assert.equal(state.alerts[0].read, true);
    assert.equal(state.monitors[0].baselinePrice, null); // Rearm resets the baseline.
    assert.equal((await request(`/api/monitors/${created.id}`, { ...monitorInput, name: 'Changed' }, 'PUT')).status, 200);
    assert.equal((await request(`/api/monitors/${created.id}`, null, 'DELETE')).status, 200);
    assert.equal(app.state.monitors.length, 0);
    assert.equal((await fetch(base + '/../../package.json')).status, 404);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
test('all published launch ABIs encode a launch with no purchase', () => {
  const zero = '0x0000000000000000000000000000000000000000';
  for (const [abi, extra] of [
    [legacyAbi, { creatorTaxBps: 0, snipeTaxOn: true }],
    [dropAbi, { creatorTaxBps: 0, snipeTaxOn: true, charterDropBps: 0 }],
    [vhooksAbi, { snipeTaxOn: false, charterDropBps: 1000, dropMode: 1, module: zero, enforced: true }],
  ]) {
    const args = [{ stock: token, name: 'Orbit', symbol: 'ORB', metadataURI: 'https://example.com/meta.json', referrer: zero, ...extra }, { payAsset: zero, amountIn: 0n, minStockOut: 0n, minTokensOut: 0n }];
    const decoded = decodeFunctionData({ abi, data: encodeFunctionData({ abi, functionName: 'launch', args }) });
    assert.equal(decoded.functionName, 'launch'); assert.equal(decoded.args[1].amountIn, 0n); assert.equal(decoded.args[0].name, 'Orbit');
  }
});
test('blank metadata uses the verified default in prepared calldata; explicit URI wins', async t => {
  const fake = {
    getChainId: async () => 4663, getCode: async () => '0x01',
    readContract: async ({ functionName }) => {
      if (functionName === 'launchFee') return 500n;
      if (functionName === 'charterDrop') return token;
      if (functionName === 'launchConfig') return { maxNameBytes: 32, maxSymbolBytes: 10, maxUriBytes: 256 };
      if (functionName === 'pairAsset') return { enabled: true };
      throw new Error('Unexpected function');
    },
    simulateContract: async () => ({}), estimateGas: async () => 100n,
    getGasPrice: async () => 1n, getBalance: async () => 10n ** 18n,
  };
  for (const [name, fn] of Object.entries(fake)) t.mock.method(client, name, fn);
  for (const metadataURI of ['', '   ', 'https://example.com/my-own.json']) {
    const result = await prepareLaunch({ name: 'Test', symbol: 'TEST', country: 'us', wallet: token, metadataURI });
    const decoded = decodeFunctionData({ abi: dropAbi, data: result.transaction.data });
    assert.equal(decoded.args[0].metadataURI, metadataURI.trim() || deployment.metadataDefault.uri);
    assert.equal(result.metadataDefaultApplied, !metadataURI.trim());
  }
  const refRes = await prepareLaunch({ name: 'RefTest', symbol: 'REF', country: 'us', wallet: token, referrer: '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7' });
  const refDecoded = decodeFunctionData({ abi: dropAbi, data: refRes.transaction.data });
  assert.equal(refDecoded.args[0].referrer.toLowerCase(), '0xe26e33215e48e9a0e77b39e5856cfb87886cd7e7');
});

test('Vault and Auto-Launcher API endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'standard-vault-test-'));
  const market = async () => ({ token, asOfTime: Date.now() / 1000, marketCapUsd: 100 });
  const executeLaunch = async ({ draft, privateKey }) => ({ hash: '0x' + 'a'.repeat(64) });
  const inspectLaunchFn = async hash => ({ status: 'success', hash, token: '0x' + 'b'.repeat(40), name: 'AutoToken', symbol: 'ATK', confirmedAt: Date.now() });
  const balanceFn = async addresses => Object.fromEntries(addresses.map(a => [a.toLowerCase(), '2.5']));

  const assetsDir = join(directory, 'assets');
  await mkdir(assetsDir, { recursive: true });
  const app = createApp({ dataDir: directory, assetDir: assetsDir, market, interval: 999999, executeLaunch, inspectLaunchFn, balanceFn });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, body, method = 'POST') => fetch(base + path, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  try {
    // 1. Initial vault status
    const status1 = await (await fetch(base + '/api/vault/status')).json();
    assert.equal(status1.initialized, false);
    assert.equal(status1.unlocked, false);

    // 2. Initialize vault
    const initRes = await request('/api/vault/init', { password: 'masterpassword123' });
    assert.equal(initRes.status, 201);
    const status2 = await (await fetch(base + '/api/vault/status')).json();
    assert.equal(status2.initialized, true);
    assert.equal(status2.unlocked, true);

    // 3. Generate wallet
    const genRes = await request('/api/vault/wallets/generate', { label: 'Primary Deployer' });
    assert.equal(genRes.status, 201);
    const generated = await genRes.json();
    assert.equal(generated.label, 'Primary Deployer');
    assert.match(generated.address, /^0x[0-9a-fA-F]{40}$/);

    // 4. List wallets with balance
    const listRes = await (await fetch(base + '/api/vault/wallets')).json();
    assert.equal(listRes.length, 1);
    assert.equal(listRes[0].balanceEth, '2.5');

    // 5. Lock and Unlock
    await request('/api/vault/lock', {});
    const lockedStatus = await (await fetch(base + '/api/vault/status')).json();
    assert.equal(lockedStatus.unlocked, false);

    const failUnlock = await request('/api/vault/unlock', { password: 'wrong' });
    assert.equal(failUnlock.status, 400);

    const okUnlock = await request('/api/vault/unlock', { password: 'masterpassword123' });
    assert.equal(okUnlock.status, 200);

    // 6. Export wallet key
    const exportRes = await request(`/api/vault/wallets/${generated.id}/export`, { password: 'masterpassword123' });
    assert.equal(exportRes.status, 200);
    const exported = await exportRes.json();
    assert.match(exported.privateKey, /^0x[0-9a-fA-F]{64}$/);

    // 7. Auto-launcher configuration
    const configRes = await request('/api/auto-launcher/config', { enabled: true, intervalMinutes: 10, defaultWalletId: generated.id });
    assert.equal(configRes.status, 200);
    const cfg = await configRes.json();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.intervalMinutes, 10);
    assert.equal(cfg.defaultWalletId, generated.id);

    // 8. Queue an item, update it via PUT /api/queue/:id, and trigger auto-launcher
    app.state.queue.push({
      id: 'q-1',
      name: 'Queue Token',
      symbol: 'QTK',
      country: 'us',
      wallet: 'Primary Deployer',
    });

    const updateRes = await request('/api/queue/q-1', {
      name: 'Edited Space Kitty',
      symbol: 'ESKITTY',
      country: 'eth',
      charterDrop: '15%',
    }, 'PUT');
    assert.equal(updateRes.status, 200);
    const updatedItem = await updateRes.json();
    assert.equal(updatedItem.name, 'Edited Space Kitty');
    assert.equal(updatedItem.symbol, 'ESKITTY');
    assert.equal(updatedItem.country, 'eth');
    assert.equal(app.state.queue[0].name, 'Edited Space Kitty');

    // Test queue sync status endpoint
    const syncStatusRes = await request('/api/queue/sync', null, 'GET');
    assert.equal(syncStatusRes.status, 200);
    const syncStatus = await syncStatusRes.json();
    assert.ok(syncStatus.path);

    const triggerRes = await request('/api/auto-launcher/trigger', {});
    assert.equal(triggerRes.status, 200);
    const trig = await triggerRes.json();
    assert.equal(trig.success, true);
    assert.equal(app.state.queue.length, 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
