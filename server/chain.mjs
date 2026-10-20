import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, decodeFunctionData, decodeEventLog, formatEther, numberToHex, ContractFunctionRevertedError, ContractFunctionZeroDataError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import signatures from '../shared/abi.json' with { type: 'json' };
import { deployment } from '../shared/deployment.mjs';
import { assert, address, draft, url } from './validation.mjs';
export const legacyAbi = parseAbi(signatures.legacy);
export const dropAbi = parseAbi([...signatures.drop, ...signatures.legacy.filter(s => /^function (launchFee|pairAsset|curveOfToken)/.test(s))]);
export const vhooksAbi = parseAbi(signatures.vhooks);
export const vhooksConfigAbi = parseAbi(signatures.vhooksConfig);
export const client = createPublicClient({ transport: http(deployment.rpc, { timeout: 12_000, retryCount: 1 }) });
export const robinhoodChain = {
  id: deployment.chainId,
  name: deployment.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpc] } }
};

export async function launchTerms() {
  const [chainId, code] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: deployment.factory }),
  ]);
  assert(chainId === deployment.chainId && code && code !== '0x', 'Chain oder Factory stimmt nicht mit der Konfiguration überein.');

  let version = 'vhooks';
  let feeWei = 0n;
  let config = {};

  try {
    const configAddress = await client.readContract({
      address: deployment.factory,
      abi: vhooksAbi,
      functionName: 'config',
    });
    const [c, s] = await client.readContract({
      address: configAddress,
      abi: vhooksConfigAbi,
      functionName: 'get',
    });
    version = 'vhooks';
    feeWei = c.launchFee;
    config = {
      baseFeeBps: c.baseFeeBps,
      creatorShareOfBaseBps: c.creatorShareOfBaseBps,
      snipeScheduleBps: c.snipeScheduleBps,
      allowSnipeOptOut: c.allowSnipeOptOut,
      creatorBuyCapBps: c.creatorBuyCapBps,
      sqrtPriceRunWad: c.sqrtPriceRunWad,
      poolTickSpacing: c.poolTickSpacing,
      maxNameBytes: c.maxNameBytes,
      maxSymbolBytes: c.maxSymbolBytes,
      maxUriBytes: c.maxUriBytes,
      launchFee: c.launchFee,
      weth: c.weth,
      maxCharterDropBps: c.maxCharterDropBps,
      curveSupply: s.curveSupply,
      poolSupply: s.poolSupply,
      virtualTokens: s.virtualTokens,
      endVirtualTokens: s.endVirtualTokens,
      creatorBuyCap: s.creatorBuyCap,
    };
  } catch (err) {
    version = 'drop';
    try {
      await client.readContract({ address: deployment.factory, abi: dropAbi, functionName: 'charterDrop' });
    } catch (e) {
      if (e.walk?.(cause => cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError)) {
        version = 'legacy';
      } else {
        throw e;
      }
    }
    const abi = version === 'drop' ? dropAbi : legacyAbi;
    [feeWei, config] = await Promise.all([
      client.readContract({ address: deployment.factory, abi: legacyAbi, functionName: 'launchFee' }),
      client.readContract({ address: deployment.factory, abi, functionName: 'launchConfig' }),
    ]);
  }

  const pairs = await Promise.all(Object.entries(deployment.stocks).map(async ([id, stock]) => {
    try {
      const pair = await client.readContract({
        address: deployment.factory,
        abi: legacyAbi,
        functionName: 'pairAsset',
        args: [stock.address],
      });
      return {
        id,
        ...stock,
        enabled: Boolean(pair.enabled),
        phantomReserve: pair.phantomReserve?.toString() || '0',
      };
    } catch {
      return { id, ...stock, enabled: true, phantomReserve: '0' };
    }
  }));

  return { version, feeWei: feeWei.toString(), feeEth: formatEther(feeWei), config, pairs, checkedAt: Date.now() };
}

export async function prepareLaunch(input) {
  const details = draft(input), account = address(details.wallet);
  const metadataDefaultApplied = !details.metadataURI;
  if (metadataDefaultApplied) details.metadataURI = deployment.metadataDefault.uri;
  url(details.metadataURI, 'Metadata-URL', true);
  const terms = await launchTerms();
  const bytes = s => new TextEncoder().encode(s).length;
  for (const [key, limit] of [['name', 'maxNameBytes'], ['symbol', 'maxSymbolBytes'], ['metadataURI', 'maxUriBytes']]) {
    assert(bytes(details[key]) <= Number(terms.config[limit]), `${key}: Vertrag erlaubt maximal ${terms.config[limit]} UTF-8 Bytes.`);
  }
  const pairInfo = terms.pairs.find(p => p.id === details.country);
  assert(pairInfo?.enabled, 'Dieses Handelspaar ist deaktiviert.');
  const zero = '0x0000000000000000000000000000000000000000';
  let params;
  let abi;
  if (terms.version === 'vhooks') {
    abi = vhooksAbi;
    params = {
      stock: deployment.stocks[details.country].address,
      name: details.name,
      symbol: details.symbol,
      metadataURI: details.metadataURI,
      snipeTaxOn: details.snipeTaxOn ?? false,
      referrer: details.referrer || zero,
      charterDropBps: details.charterDropBps ?? 1000,
      dropMode: details.dropMode ?? 1,
      module: details.module || zero,
      enforced: details.enforced ?? true,
    };
  } else if (terms.version === 'drop') {
    abi = dropAbi;
    params = {
      stock: deployment.stocks[details.country].address,
      name: details.name,
      symbol: details.symbol,
      metadataURI: details.metadataURI,
      creatorTaxBps: 0,
      snipeTaxOn: details.snipeTaxOn ?? false,
      referrer: details.referrer || zero,
      charterDropBps: details.charterDropBps ?? 1000,
    };
  } else {
    abi = legacyAbi;
    params = {
      stock: deployment.stocks[details.country].address,
      name: details.name,
      symbol: details.symbol,
      metadataURI: details.metadataURI,
      creatorTaxBps: 0,
      snipeTaxOn: details.snipeTaxOn ?? false,
      referrer: details.referrer || zero,
    };
  }
  const args = [params, { payAsset: zero, amountIn: 0n, minStockOut: 0n, minTokensOut: 0n }];
  const request = { address: deployment.factory, abi, functionName: 'launch', account, args, value: BigInt(terms.feeWei) };
  await client.simulateContract(request);
  const data = encodeFunctionData({ abi, functionName: 'launch', args });
  const [gas, gasPrice, balance] = await Promise.all([
    client.estimateGas({ account, to: deployment.factory, data, value: request.value }),
    client.getGasPrice(), client.getBalance({ address: account }),
  ]);
  const gasLimit = gas * 120n / 100n;
  assert(balance >= request.value + gasLimit * gasPrice, 'Nicht genug ETH für Launch-Gebühr und geschätztes Gas.');
  return { details, terms, metadataDefaultApplied, expiresAt: Date.now() + 30_000,
    estimatedGasEth: formatEther(gasLimit * gasPrice),
    transaction: { from: account, to: deployment.factory, data, value: numberToHex(request.value), gas: numberToHex(gasLimit), chainId: numberToHex(deployment.chainId) } };
}

export async function inspectLaunch(hash) {
  assert(/^0x[0-9a-fA-F]{64}$/.test(hash), 'Ungültiger Transaktionshash.');
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash }); }
  catch (e) { if (e.name === 'TransactionReceiptNotFoundError') return { status: 'pending', hash }; throw e; }
  assert(receipt.to?.toLowerCase() === deployment.factory.toLowerCase(), 'Transaktion gehört nicht zur konfigurierten Factory.');
  if (receipt.status === 'reverted') return { status: 'reverted', hash };
  const transaction = await client.getTransaction({ hash });
  let decoded;
  const abis = [vhooksAbi, dropAbi, legacyAbi];
  for (const abi of abis) {
    try { const candidate = decodeFunctionData({ abi, data: transaction.input }); if (candidate.functionName === 'launch') decoded = candidate; } catch {}
  }
  assert(decoded, 'Keine Launch-Transaktion.');
  for (const log of receipt.logs.filter(log => log.address.toLowerCase() === deployment.factory.toLowerCase())) {
    for (const abi of abis) {
      try {
        const event = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (event.eventName === 'Launched') return { status: 'success', hash, token: event.args.token, curve: event.args.curve,
          wallet: transaction.from, name: decoded.args[0].name, symbol: decoded.args[0].symbol, confirmedAt: Date.now() };
      } catch {}
    }
  }
  throw new Error('Transaktion bestätigt, aber kein bekanntes Launched-Event gefunden. Im Explorer prüfen; nicht erneut senden.');
}

export async function executeDirectLaunch({ draft: draftInput, privateKey }) {
  const prepared = await prepareLaunch(draftInput);
  const account = privateKeyToAccount(privateKey);
  assert(account.address.toLowerCase() === prepared.transaction.from.toLowerCase(), 'Der Private Key gehört nicht zur angegebenen Deployer-Adresse.');
  const walletClient = createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(deployment.rpc, { timeout: 30_000, retryCount: 2 }),
  });
  const hash = await walletClient.sendTransaction({
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    value: BigInt(prepared.transaction.value),
    gas: BigInt(prepared.transaction.gas),
  });
  return { hash, prepared };
}

export async function getBalances(addresses) {
  const entries = await Promise.all(addresses.map(async addr => {
    try {
      const bal = await client.getBalance({ address: addr });
      return [addr.toLowerCase(), formatEther(bal)];
    } catch {
      return [addr.toLowerCase(), '0'];
    }
  }));
  return Object.fromEntries(entries);
}
