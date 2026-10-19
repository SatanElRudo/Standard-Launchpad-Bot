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
    await walletClient.sendTransaction({
      to: stock,
      data: approveData,
    });
  }

  // 3. buyExactIn
  const buyData = encodeFunctionData({
    abi: routerAbi,
    functionName: 'buyExactIn',
    args: [
      curve,
      stock,
      amountInWei,
      0n, // minStockOut
      0n, // minTokensOut (0 so snipe succeeds immediately)
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
  country = 'us',
  snipeOrders = [],
  vault,
  customClient = client,
  customWalletClient = null,
} = {}) {
  assert(Array.isArray(snipeOrders), 'Snipe-Aufträge müssen als Liste übergeben werden.');
  assert(snipeOrders.length <= 10, 'Maximal 10 Snipe-Wallets erlaubt.');
  if (snipeOrders.length === 0) return [];

  // Execute all buys concurrently immediately after launch
  const executions = snipeOrders.map(async order => {
    try {
      return await executeSnipeBuy({
        curve,
        country,
        walletId: order.walletId,
        amount: order.amount,
        vault,
        customClient,
        customWalletClient,
      });
    } catch (e) {
      return {
        walletId: order.walletId,
        amount: order.amount,
        status: 'error',
        error: e.message,
      };
    }
  });

  return await Promise.all(executions);
}
