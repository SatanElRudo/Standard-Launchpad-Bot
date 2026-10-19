import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, decodeFunctionData } from 'viem';
import { executeSnipeBuy, executeMultiSnipe, routerAbi, erc20Abi } from '../server/sniper.mjs';
import { createVault } from '../server/vault.mjs';
import { deployment } from '../shared/deployment.mjs';

function createMockStore() {
  const state = {
    vault: { initialized: false, salt: null, verifier: null, wallets: [] },
  };
  return { state, save: () => {} };
}

test('sniper limits to 10 wallets and validates inputs', async () => {
  const store = createMockStore();
  const vault = createVault({ store });
  vault.init('masterpass123');

  const tooMany = Array.from({ length: 11 }, (_, i) => ({ walletId: `w-${i}`, amount: 5 }));
  await assert.rejects(
    executeMultiSnipe({ curve: '0x' + '1'.repeat(40), country: 'us', snipeOrders: tooMany, vault }),
    /Maximal 10 Snipe-Wallets/
  );
});

test('sniper executes buyExactIn and approves stock if needed', async () => {
  const store = createMockStore();
  const vault = createVault({ store });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Sniper Wallet 1');
  const curve = '0x' + '9'.repeat(40);

  const sentTransactions = [];
  const customWalletClient = {
    async sendTransaction({ to, data, value }) {
      sentTransactions.push({ to, data, value });
      return '0x' + 'f'.repeat(64);
    },
  };

  let allowanceAmount = 0n;
  const customClient = {
    async readContract({ address, functionName, args }) {
      if (functionName === 'balanceOf') return parseEther('100'); // 100 SPCX
      if (functionName === 'allowance') return allowanceAmount;
      throw new Error(`Unexpected call ${functionName}`);
    },
  };

  const res = await executeSnipeBuy({
    curve,
    country: 'us',
    walletId: w1.id,
    amount: '10',
    vault,
    customClient,
    customWalletClient,
  });

  assert.equal(res.status, 'success');
  assert.equal(res.currency, 'SPCX');
  assert.equal(res.amount, '10');

  // Should have sent 2 transactions: 1 approve + 1 buyExactIn
  assert.equal(sentTransactions.length, 2);

  // 1. Approve
  const approveTx = sentTransactions[0];
  assert.equal(approveTx.to.toLowerCase(), deployment.stocks.us.address.toLowerCase());
  const decodedApprove = decodeFunctionData({ abi: erc20Abi, data: approveTx.data });
  assert.equal(decodedApprove.functionName, 'approve');

  // 2. Buy
  const buyTx = sentTransactions[1];
  assert.equal(buyTx.to.toLowerCase(), deployment.router.toLowerCase());
  const decodedBuy = decodeFunctionData({ abi: routerAbi, data: buyTx.data });
  assert.equal(decodedBuy.functionName, 'buyExactIn');
  assert.equal(decodedBuy.args[0].toLowerCase(), curve.toLowerCase());
  assert.equal(decodedBuy.args[1].toLowerCase(), deployment.stocks.us.address.toLowerCase());
  assert.equal(decodedBuy.args[2], parseEther('10'));
});

test('multi snipe executes up to 10 wallets concurrently and isolates errors', async () => {
  const store = createMockStore();
  const vault = createVault({ store });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Sniper 1');
  const w2 = vault.createWallet('Sniper 2');
  const curve = '0x' + '9'.repeat(40);

  const customWalletClient = {
    async sendTransaction() { return '0x' + 'a'.repeat(64); },
  };
  const customClient = {
    async readContract({ functionName, args }) {
      if (functionName === 'balanceOf') {
        // w1 has enough, w2 has 0
        if (args[0].toLowerCase() === w1.address.toLowerCase()) return parseEther('50');
        return parseEther('0');
      }
      if (functionName === 'allowance') return parseEther('1000');
      throw new Error('Unexpected');
    },
  };

  const orders = [
    { walletId: w1.id, amount: '5' },
    { walletId: w2.id, amount: '5' },
  ];

  const results = await executeMultiSnipe({
    curve,
    country: 'us',
    snipeOrders: orders,
    vault,
    customClient,
    customWalletClient,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'success');
  assert.equal(results[1].status, 'error');
  assert.match(results[1].error, /nicht genug SPCX/);
});
