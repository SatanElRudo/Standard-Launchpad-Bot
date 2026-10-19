import { parseAbi, parseEther, formatEther, encodeFunctionData, maxUint256, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import signatures from '../shared/abi.json' with { type: 'json' };
import { deployment } from '../shared/deployment.mjs';
import { client, robinhoodChain } from './chain.mjs';
import { assert, address } from './validation.mjs';

export const routerAbi = parseAbi(signatures.router);
export const erc20Abi = parseAbi(signatures.erc20);
const zeroAddress = '0x0000000000000000000000000000000000000000';

export async function getStockBalances(addresses, country = 'us') {
  const stock = deployment.stocks[country]?.address;
  if (!stock) return {};
  const entries = await Promise.all(addresses.map(async addr => {
    try {
      const bal = await client.readContract({
        address: stock,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [addr],
      });
      return [addr.toLowerCase(), formatEther(bal)];
    } catch {
      return [addr.toLowerCase(), '0'];
    }
  }));
  return Object.fromEntries(entries);
}

export async function executeSnipeBuy({
  curve,
  country = 'us',
  walletId,
  amount,
  minTokensOut = 0n,
  vault,
  customClient = client,
  customWalletClient = null,
} = {}) {
  assert(curve && /^0x[0-9a-fA-F]{40}$/.test(curve), 'Ungültige Curve-Adresse.');
  const stock = deployment.stocks[country]?.address;
  assert(stock, `Unbekanntes Handelspaar: ${country}`);
  const stockSymbol = deployment.stocks[country].symbol;

  const wallet = vault.findWallet(walletId);
  assert(wallet, 'Sniper-Wallet nicht im Tresor gefunden.');

  const pk = vault.getPrivateKey(wallet.id);
  const account = privateKeyToAccount(pk);

  const numAmount = Number(amount);
  assert(Number.isFinite(numAmount) && numAmount > 0, 'Kaufbetrag muss eine positive Zahl sein.');
  const amountInWei = parseEther(String(amount));

  const walletClient = customWalletClient ?? createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(deployment.rpc, { timeout: 25_000, retryCount: 2 }),
  });

  // 1. Balance check
  const balance = await customClient.readContract({
    address: stock,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  assert(balance >= amountInWei, `Wallet ${wallet.label} hat nicht genug ${stockSymbol} (vorhanden: ${formatEther(balance)}, benötigt: ${amount}).`);

  // 2. Allowance check & approve if necessary
  const allowance = await customClient.readContract({
    address: stock,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, deployment.router],
  });

  if (allowance < amountInWei) {
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [deployment.router, maxUint256],
    });
    const approveHash = await walletClient.sendTransaction({
      to: stock,
      data: approveData,
    });
    if (customClient.waitForTransactionReceipt) {
      await customClient.waitForTransactionReceipt({ hash: approveHash });
    }
  }

  // 3. buyExactIn with on-chain minTokensOut protection
  const buyData = encodeFunctionData({
    abi: routerAbi,
    functionName: 'buyExactIn',
    args: [
      curve,
      stock,
      amountInWei,
      0n, // minStockOut
      minTokensOut, // on-chain frontrun & slippage protection
      account.address,
      zeroAddress,
      { recipient: zeroAddress, bps: 0 },
    ],
  });

  const hash = await walletClient.sendTransaction({
    to: deployment.router,
    data: buyData,
    value: 0n,
    gas: 350_000n,
  });

  if (customClient.waitForTransactionReceipt) {
    const receipt = await customClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      return {
        walletId: wallet.id,
        label: wallet.label,
        address: account.address,
        hash,
        amount,
        currency: stockSymbol,
        status: 'error',
        error: 'Kauf-Transaktion on-chain fehlgeschlagen (reverted).',
      };
    }
  }

  return {
    walletId: wallet.id,
    label: wallet.label,
    address: account.address,
    hash,
    amount,
    currency: stockSymbol,
    status: 'success',
  };
}

export async function executeMultiSnipe({
  curve,
  token = null,
  country = 'us',
  snipeOrders = [],
  vault,
  customClient = client,
  customWalletClient = null,
  antiFrontrun = true,
  maxSlippagePct = 1.0,
  expectedInitialSupply = 777777777777777777777777777n,
  phantomReserve = 29317145057324793856n,
  virtualTokens = 1088888888888888888888888887n,
} = {}) {
  assert(Array.isArray(snipeOrders), 'Snipe-Aufträge müssen als Liste übergeben werden.');
  assert(snipeOrders.length <= 10, 'Maximal 10 Snipe-Wallets erlaubt.');
  if (snipeOrders.length === 0) return [];

  const stockSymbol = deployment.stocks[country]?.symbol || 'SPCX';

  // 1. Pre-Flight Anti-Frontrun Check: verify no outsider has bought on the curve
  if (antiFrontrun && token && /^0x[0-9a-fA-F]{40}$/.test(token)) {
    try {
      const currentCurveBal = await customClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [curve],
      });
      if (currentCurveBal < expectedInitialSupply) {
        const diff = expectedInitialSupply - currentCurveBal;
        const msg = `Anti-Frontrun: Fremder Bot/Player hat bereits ${formatEther(diff)} Token vor uns auf der Curve gekauft. Snipe abgebrochen.`;
        return snipeOrders.map(order => {
          const w = vault.findWallet(order.walletId);
          return {
            walletId: order.walletId,
            label: w?.label || 'Wallet',
            address: w?.address || '',
            amount: order.amount,
            currency: stockSymbol,
            status: 'aborted_frontrun_detected',
            error: msg,
          };
        });
      }
    } catch (e) {
      console.warn('Anti-frontrun check failed to read curve balance, continuing with slippage protection:', e.message);
    }
  }

  // 2. Calculate sequential minTokensOut for each order in our own group
  const k = phantomReserve * virtualTokens;
  let runningReserve = phantomReserve;
  const ordersWithLimits = snipeOrders.map(order => {
    let minTokensOut = 0n;
    if (antiFrontrun) {
      const amountInWei = parseEther(String(order.amount));
      const amountAfterFee = amountInWei * 9900n / 10000n; // 1% base fee
      const nextReserve = runningReserve + amountAfterFee;
      const nextVirtualTokens = k / nextReserve;
      const curVirtualTokens = k / runningReserve;
      const expectedOut = curVirtualTokens - nextVirtualTokens;
      runningReserve = nextReserve;
      const slippageBps = BigInt(Math.max(0, Math.floor(maxSlippagePct * 100)));
      minTokensOut = expectedOut * (10000n - slippageBps) / 10000n;
    }
    return { ...order, minTokensOut };
  });

  // 3. Execute all buys in order so sequential price progression and nonces match minTokensOut
  const results = [];
  for (const order of ordersWithLimits) {
    try {
      const res = await executeSnipeBuy({
        curve,
        country,
        walletId: order.walletId,
        amount: order.amount,
        minTokensOut: order.minTokensOut,
        vault,
        customClient,
        customWalletClient,
      });
      results.push(res);
    } catch (e) {
      const w = vault.findWallet(order.walletId);
      const isSlippageRevert = /minTokensOut|slippage|revert/i.test(e.shortMessage || e.message);
      results.push({
        walletId: order.walletId,
        label: w?.label || 'Wallet',
        address: w?.address || '',
        amount: order.amount,
        currency: stockSymbol,
        status: isSlippageRevert ? 'reverted_frontrun_or_slippage' : 'error',
        error: isSlippageRevert
          ? 'Kauf on-chain abgewiesen: Fremder Bot hat vor uns gekauft oder Preisanstieg überschritten.'
          : (e.shortMessage || e.message || 'Kauf fehlgeschlagen'),
      });
    }
  }

  return results;
}

export async function executeSnipeSell({
  curve,
  token,
  country = 'us',
  walletId,
  vault,
  customClient = client,
  customWalletClient = null,
} = {}) {
  assert(curve && /^0x[0-9a-fA-F]{40}$/.test(curve), 'Ungültige Curve-Adresse.');
  assert(token && /^0x[0-9a-fA-F]{40}$/.test(token), 'Ungültige Token-Adresse.');
  const stock = deployment.stocks[country]?.address;
  assert(stock, `Unbekanntes Handelspaar: ${country}`);

  const wallet = vault.findWallet(walletId);
  assert(wallet, 'Verkaufs-Wallet nicht im Tresor gefunden.');

  const pk = vault.getPrivateKey(wallet.id);
  const account = privateKeyToAccount(pk);

  const walletClient = customWalletClient ?? createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(deployment.rpc, { timeout: 25_000, retryCount: 2 }),
  });

  // 1. Check token balance
  const tokenBal = await customClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  if (tokenBal === 0n) {
    return {
      walletId: wallet.id,
      label: wallet.label,
      address: account.address,
      tokensSold: '0',
      status: 'skipped_zero_balance',
      message: 'Keine Token zum Verkaufen auf der Wallet.',
    };
  }

  // 2. Allowance check & approve if necessary (both router and curve)
  for (const spender of [deployment.router, curve]) {
    const allowance = await customClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, spender],
    });

    if (allowance < tokenBal) {
      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, maxUint256],
      });
      const approveHash = await walletClient.sendTransaction({
        to: token,
        data: approveData,
      });
      if (customClient.waitForTransactionReceipt) {
        await customClient.waitForTransactionReceipt({ hash: approveHash });
      }
    }
  }

  // 3. sellExactIn
  if (customClient.simulateContract) {
    try {
      await customClient.simulateContract({
        account: account.address,
        address: deployment.router,
        abi: routerAbi,
        functionName: 'sellExactIn',
        args: [
          curve,
          tokenBal,
          stock,
          0n, // minPayout
          account.address,
          zeroAddress,
          { recipient: zeroAddress, bps: 0 },
        ],
      });
    } catch (simErr) {
      console.error(`Simulation of sellExactIn failed for ${wallet.label}:`, simErr.shortMessage || simErr.message);
      if (simErr.data) console.error('Revert data:', simErr.data);
      throw simErr;
    }
  }

  const sellData = encodeFunctionData({
    abi: routerAbi,
    functionName: 'sellExactIn',
    args: [
      curve,
      tokenBal,
      stock,
      0n, // minPayout
      account.address,
      zeroAddress,
      { recipient: zeroAddress, bps: 0 },
    ],
  });

  const hash = await walletClient.sendTransaction({
    to: deployment.router,
    data: sellData,
    value: 0n,
    gas: 350_000n,
  });

  if (customClient.waitForTransactionReceipt) {
    const receipt = await customClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      return {
        walletId: wallet.id,
        label: wallet.label,
        address: account.address,
        hash,
        status: 'error',
        error: 'Verkaufs-Transaktion on-chain fehlgeschlagen (reverted).',
      };
    }
  }

  return {
    walletId: wallet.id,
    label: wallet.label,
    address: account.address,
    hash,
    tokensSold: formatEther(tokenBal),
    status: 'success',
  };
}

export async function executeMultiSell({
  curve,
  token,
  country = 'us',
  purchases = [],
  autoSellMode = 'all', // 'all' | 'n_minus_1'
  vault,
  customClient = client,
  customWalletClient = null,
} = {}) {
  assert(curve && /^0x[0-9a-fA-F]{40}$/.test(curve), 'Ungültige Curve-Adresse.');
  assert(token && /^0x[0-9a-fA-F]{40}$/.test(token), 'Ungültige Token-Adresse.');

  const valid = (purchases || []).filter(p => p.status === 'success' && p.walletId);
  if (valid.length === 0) return [];

  let toSell = valid;
  let kept = null;
  if (autoSellMode === 'n_minus_1' && valid.length > 1) {
    // Keep the wallet with the cheapest entry price (the first one that executed!)
    kept = valid[0];
    toSell = valid.slice(1);
  }

  const executions = toSell.map(async p => {
    try {
      return await executeSnipeSell({
        curve,
        token,
        country,
        walletId: p.walletId,
        vault,
        customClient,
        customWalletClient,
      });
    } catch (e) {
      return {
        walletId: p.walletId,
        label: p.label,
        address: p.address,
        status: 'error',
        error: e.shortMessage || e.message || 'Verkauf fehlgeschlagen',
      };
    }
  });

  const results = await Promise.all(executions);

  if (kept) {
    results.unshift({
      walletId: kept.walletId,
      label: kept.label,
      address: kept.address,
      status: 'kept_best_entry',
      message: 'Günstigster Einstiegspreis behalten (Moonbag)',
    });
  }

  return results;
}

