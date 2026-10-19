import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, decodeFunctionData } from 'viem';
import { executeSnipeBuy, executeMultiSnipe, executeSnipeSell, executeMultiSell, routerAbi, erc20Abi } from '../server/sniper.mjs';
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

test('anti-frontrun pre-flight check aborts all snipe buys when outsider already bought', async () => {
  const store = createMockStore();
  const vault = createVault({ store });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Sniper 1');
  const curve = '0x' + '8'.repeat(40);
  const token = '0x' + '7'.repeat(40);

  let txSent = false;
  const customWalletClient = {
    async sendTransaction() { txSent = true; return '0x' + 'a'.repeat(64); },
  };

  const initialSupply = 777777777777777777777777777n;
  const customClient = {
    async readContract({ address, functionName, args }) {
      if (functionName === 'balanceOf' && address.toLowerCase() === token.toLowerCase()) {
        // Curve balance is LESS than initial supply -> outsider bought!
        return initialSupply - parseEther('1000');
      }
      return parseEther('100');
    },
  };

  const results = await executeMultiSnipe({
    curve,
    token,
    country: 'us',
    snipeOrders: [{ walletId: w1.id, amount: 5 }],
    vault,
    antiFrontrun: true,
    expectedInitialSupply: initialSupply,
    customClient,
    customWalletClient,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'aborted_frontrun_detected');
  assert.match(results[0].error, /Anti-Frontrun.*Fremder Bot/);
  assert.equal(txSent, false); // No transactions were broadcast!
});

test('anti-frontrun sets minTokensOut to protect against same-block frontrunning', async () => {
  const store = createMockStore();
  const vault = createVault({ store });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Sniper 1');
  const curve = '0x' + '8'.repeat(40);
  const token = '0x' + '7'.repeat(40);

  const sentTransactions = [];
  const customWalletClient = {
    async sendTransaction({ to, data }) {
      sentTransactions.push({ to, data });
      return '0x' + 'a'.repeat(64);
    },
  };

  const initialSupply = 777777777777777777777777777n;
  const customClient = {
    async readContract({ address, functionName, args }) {
      if (functionName === 'balanceOf' && address.toLowerCase() === token.toLowerCase()) {
        return initialSupply; // Pristine curve!
      }
      if (functionName === 'balanceOf') return parseEther('100');
      if (functionName === 'allowance') return parseEther('1000');
      return 0n;
    },
  };

  const results = await executeMultiSnipe({
    curve,
    token,
    country: 'us',
    snipeOrders: [{ walletId: w1.id, amount: 5 }],
    vault,
    antiFrontrun: true,
    maxSlippagePct: 1.0,
    expectedInitialSupply: initialSupply,
    customClient,
    customWalletClient,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'success');
  assert.equal(sentTransactions.length, 1);

  const decoded = decodeFunctionData({ abi: routerAbi, data: sentTransactions[0].data });
  assert.equal(decoded.functionName, 'buyExactIn');
  // minTokensOut (arg index 4) must be strictly greater than 0!
  const minTokensOut = decoded.args[4];
  assert.ok(minTokensOut > 0n, 'minTokensOut must be positive for frontrun protection');
});

test('sniper executes sellExactIn and approves token if needed', async () => {
  const store = createMockStore();
  const vault = createVault({ store });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Sniper Wallet 1');
  const curve = '0x' + '9'.repeat(40);
  const token = '0x' + '8'.repeat(40);

  const sentTransactions = [];
  const customWalletClient = {
    async sendTransaction({ to, data, value }) {
      sentTransactions.push({ to, data, value });
      return '0x' + 'e'.repeat(64);
    },
  };

  let allowanceAmount = 0n;
  const customClient = {
    async readContract({ address, functionName, args }) {
      if (functionName === 'balanceOf') return parseEther('500'); // 500 tokens
      if (functionName === 'allowance') return allowanceAmount;
      throw new Error(`Unexpected call ${functionName}`);
    },
  };

  const res = await executeSnipeSell({
    curve,
    token,
    country: 'us',
    walletId: w1.id,
    vault,
    customClient,
    customWalletClient,
  });

  assert.equal(res.status, 'success');
  assert.equal(res.tokensSold, '500');
  assert.equal(sentTransactions.length, 3);

  // 1. Approve router on token
  const approveRouterTx = sentTransactions[0];
  assert.equal(approveRouterTx.to.toLowerCase(), token.toLowerCase());
  const decodedApproveRouter = decodeFunctionData({ abi: erc20Abi, data: approveRouterTx.data });
  assert.equal(decodedApproveRouter.functionName, 'approve');
  assert.equal(decodedApproveRouter.args[0].toLowerCase(), deployment.router.toLowerCase());

  // 2. Approve curve on token
  const approveCurveTx = sentTransactions[1];
  assert.equal(approveCurveTx.to.toLowerCase(), token.toLowerCase());
  const decodedApproveCurve = decodeFunctionData({ abi: erc20Abi, data: approveCurveTx.data });
  assert.equal(decodedApproveCurve.functionName, 'approve');
  assert.equal(decodedApproveCurve.args[0].toLowerCase(), curve.toLowerCase());

  // 3. Sell on router
  const sellTx = sentTransactions[2];
  assert.equal(sellTx.to.toLowerCase(), deployment.router.toLowerCase());
  const decodedSell = decodeFunctionData({ abi: routerAbi, data: sellTx.data });
  assert.equal(decodedSell.functionName, 'sellExactIn');
  assert.equal(decodedSell.args[0].toLowerCase(), curve.toLowerCase());
  assert.equal(decodedSell.args[1], parseEther('500'));
});

test('executeMultiSell with autoSellMode "all" executes sells for all wallets', async () => {
  const store = createMockStore();
  const vault = createVault({ store });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Buyer 1');
  const w2 = vault.createWallet('Buyer 2');
  const curve = '0x' + '9'.repeat(40);
  const token = '0x' + '8'.repeat(40);

  const customWalletClient = {
    async sendTransaction() { return '0x' + 'c'.repeat(64); },
  };
  const customClient = {
    async readContract({ functionName }) {
      if (functionName === 'balanceOf') return parseEther('200');
      if (functionName === 'allowance') return parseEther('1000000');
      throw new Error('Unexpected');
    },
  };

  const purchases = [
    { walletId: w1.id, label: w1.label, address: w1.address, status: 'success', amount: '10' },
    { walletId: w2.id, label: w2.label, address: w2.address, status: 'success', amount: '15' },
  ];

  const results = await executeMultiSell({
    curve,
    token,
    country: 'us',
    purchases,
    autoSellMode: 'all',
    vault,
    customClient,
    customWalletClient,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'success');
  assert.equal(results[1].status, 'success');
  assert.equal(results[0].walletId, w1.id);
  assert.equal(results[1].walletId, w2.id);
});

test('executeMultiSell with autoSellMode "n_minus_1" preserves cheapest entry wallet (moonbag)', async () => {
  const store = createMockStore();
  const vault = createVault({ store });
  vault.init('masterpass123');
  const w1 = vault.createWallet('Cheapest Entry Wallet (First Buyer)');
  const w2 = vault.createWallet('Second Buyer');
  const w3 = vault.createWallet('Third Buyer');
  const curve = '0x' + '9'.repeat(40);
  const token = '0x' + '8'.repeat(40);

  const customWalletClient = {
    async sendTransaction() { return '0x' + 'b'.repeat(64); },
  };
  const customClient = {
    async readContract({ functionName }) {
      if (functionName === 'balanceOf') return parseEther('100');
      if (functionName === 'allowance') return parseEther('1000000');
      throw new Error('Unexpected');
    },
  };

  const purchases = [
    { walletId: w1.id, label: w1.label, address: w1.address, status: 'success', amount: '10' },
    { walletId: w2.id, label: w2.label, address: w2.address, status: 'success', amount: '15' },
    { walletId: w3.id, label: w3.label, address: w3.address, status: 'success', amount: '20' },
  ];

  const results = await executeMultiSell({
    curve,
    token,
    country: 'us',
    purchases,
    autoSellMode: 'n_minus_1',
    vault,
    customClient,
    customWalletClient,
  });

  assert.equal(results.length, 3);
  // First item must be kept as moonbag
  assert.equal(results[0].walletId, w1.id);
  assert.equal(results[0].status, 'kept_best_entry');
  assert.match(results[0].message, /Günstigster Einstiegspreis behalten/);

  // Other 2 must be sold
  assert.equal(results[1].walletId, w2.id);
  assert.equal(results[1].status, 'success');
  assert.equal(results[2].walletId, w3.id);
  assert.equal(results[2].status, 'success');
});


