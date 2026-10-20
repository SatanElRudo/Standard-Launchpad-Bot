import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('fees API aggregates claimable fees by curve and by wallet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fees-test-'));
  const dummyWallet = '0x1111111111111111111111111111111111111111';
  const dummyCurve1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const dummyCurve2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const mockGetFees = async (curves) => {
    return curves.map(c => ({
      curve: c,
      escrow: '0x479B2997a7283f7d3baacc984558fe4e1D7467af',
      token: '0xcccccccccccccccccccccccccccccccccccccccc',
      pairingAddress: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa',
      stockSymbol: 'SPCX',
      feeRecipient: dummyWallet,
      balanceWei: '10000000000000000',
      balanceEth: '0.01',
    }));
  };

  const app = createApp({
    dataDir: dir,
    getFeesFn: mockGetFees,
  });

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const req = (path, body, method = 'POST') => fetch(base + path, {
    method,
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

  try {
    await req('/api/vault/init', { password: 'test-password-123' });
    await req('/api/vault/unlock', { password: 'test-password-123' });
    await req('/api/vault/wallets/import', {
      label: 'Deployer 1',
      privateKey: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    });

    app.state.launches = [
      {
        curve: dummyCurve1,
        token: '0xcccccccccccccccccccccccccccccccccccccccc',
        name: 'Alpha Coin',
        symbol: 'ALPHA',
        wallet: dummyWallet,
        hash: '0x123',
      },
      {
        curve: dummyCurve2,
        token: '0xdddddddddddddddddddddddddddddddddddddddd',
        name: 'Beta Coin',
        symbol: 'BETA',
        wallet: dummyWallet,
        hash: '0x456',
      }
    ];

    const res = await req('/api/fees', null, 'GET');
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(data.byCurve);
    assert.equal(data.byCurve.length, 2);
    assert.equal(data.byCurve[0].name, 'Alpha Coin');
    assert.equal(data.byCurve[1].name, 'Beta Coin');

    assert.ok(data.byWallet[dummyWallet]);
    assert.equal(data.byWallet[dummyWallet].curves.length, 2);
    assert.equal(data.byWallet[dummyWallet].totalBalanceEth, '0.02');

    // Test deleting single launch
    const delRes1 = await req('/api/launches/0x123', null, 'DELETE');
    assert.equal(delRes1.status, 200);
    assert.equal(app.state.launches.length, 1);
    assert.equal(app.state.launches[0].hash, '0x456');

    // Test clearing all launches
    const delAllRes = await req('/api/launches', null, 'DELETE');
    assert.equal(delAllRes.status, 200);
    assert.equal(app.state.launches.length, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('claim fees executes claim and respects swapToEth parameter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fees-claim-test-'));
  const testPk = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f360e79';
  const testAddr = '0x5c5Fca22FD1c2F8f92363915397a1228949eC5fb';
  const testCurve = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const mockGetFees = async () => [{
    curve: testCurve,
    escrow: '0x479B2997a7283f7d3baacc984558fe4e1D7467af',
    token: '0xcccccccccccccccccccccccccccccccccccccccc',
    pairingAddress: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa',
    stockSymbol: 'SPCX',
    feeRecipient: testAddr,
    balanceWei: '25000000000000000',
    balanceEth: '0.025',
  }];

  let claimCalls = [];
  const mockClaimFees = async (args) => {
    claimCalls.push(args);
    return {
      hash: '0xclaimhash123',
      status: 'success',
      swapResult: args.swapToEth ? { swapped: true, swapHash: '0xswaphash456', ethReceived: '0.005' } : null,
    };
  };

  const app = createApp({
    dataDir: dir,
    getFeesFn: mockGetFees,
    claimFeesFn: mockClaimFees,
  });

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const req = (path, body, method = 'POST') => fetch(base + path, {
    method,
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

  try {
    await req('/api/vault/init', { password: 'test-password-123' });
    await req('/api/vault/unlock', { password: 'test-password-123' });
    await req('/api/vault/wallets/import', {
      label: 'Claimer',
      privateKey: testPk
    });

    app.state.launches = [{
      curve: testCurve,
      token: '0xcccccccccccccccccccccccccccccccccccccccc',
      name: 'Test Meme',
      symbol: 'TMEME',
      wallet: testAddr,
      hash: '0x999',
    }];

    // 1. Single claim with default swapToEth (true)
    const claimRes1 = await req('/api/fees/claim', { curve: testCurve });
    assert.equal(claimRes1.status, 200);
    const data1 = await claimRes1.json();
    assert.equal(data1.hash, '0xclaimhash123');
    assert.equal(data1.swapToEth, true);
    assert.ok(data1.swapResult?.swapped);
    assert.equal(claimCalls[0].swapToEth, true);

    // 2. Single claim with explicit swapToEth = false
    const claimRes2 = await req('/api/fees/claim', { curve: testCurve, swapToEth: false });
    assert.equal(claimRes2.status, 200);
    const data2 = await claimRes2.json();
    assert.equal(data2.swapToEth, false);
    assert.equal(claimCalls[1].swapToEth, false);

    // 3. Claim all curves for a wallet
    const claimAllRes = await req('/api/fees/claim', { walletAddress: testAddr, swapToEth: true });
    assert.equal(claimAllRes.status, 200);
    const allData = await claimAllRes.json();
    assert.equal(allData.success, true);
    assert.equal(allData.results.length, 1);
    assert.equal(allData.results[0].curve, testCurve);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
