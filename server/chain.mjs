import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, decodeFunctionData, decodeEventLog, formatEther, numberToHex, encodeAbiParameters, parseAbiParameters, maxUint256, ContractFunctionRevertedError, ContractFunctionZeroDataError } from 'viem';
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

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'
]);

export const permit2Abi = parseAbi([
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'
]);

export const erc20ExtendedAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function name() view returns (string)',
  'function symbol() view returns (string)'
]);

export const wethWithdrawAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function withdraw(uint256 wad) public'
]);

export async function getClaimableFees(curves = [], customClient = null) {
  if (!curves.length) return [];
  const pc = customClient || client;
  const configAddress = await pc.readContract({
    address: deployment.factory,
    abi: vhooksAbi,
    functionName: 'config',
  });
  const [c] = await pc.readContract({
    address: configAddress,
    abi: vhooksConfigAbi,
    functionName: 'get',
  });
  const escrow = c.feeEscrow;
  const escrowAbi = parseAbi([
    'function balanceOf(address curve) view returns (uint256)',
  ]);
  const curveAbi = parseAbi([
    'function feeRecipient() view returns (address)',
    'function poolKey() view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
    'function token() view returns (address)'
  ]);

  return Promise.all(curves.map(async curve => {
    try {
      const [recipient, bal, poolKey, tokenAddr] = await Promise.all([
        pc.readContract({ address: curve, abi: curveAbi, functionName: 'feeRecipient' }),
        pc.readContract({ address: escrow, abi: escrowAbi, functionName: 'balanceOf', args: [curve] }),
        pc.readContract({ address: curve, abi: curveAbi, functionName: 'poolKey' }).catch(() => null),
        pc.readContract({ address: curve, abi: curveAbi, functionName: 'token' }).catch(() => ''),
      ]);

      const pairingAddress = poolKey?.[0]?.toLowerCase() || '';
      let stockSymbol = 'SPCX';
      for (const stock of Object.values(deployment.stocks)) {
        if (stock.address.toLowerCase() === pairingAddress) {
          stockSymbol = stock.symbol;
          break;
        }
      }

      return {
        curve,
        escrow,
        token: tokenAddr,
        pairingAddress,
        stockSymbol,
        feeRecipient: recipient,
        balanceWei: bal.toString(),
        balanceEth: formatEther(bal),
      };
    } catch {
      return { curve, escrow, token: '', pairingAddress: '', stockSymbol: 'SPCX', feeRecipient: '', balanceWei: '0', balanceEth: '0' };
    }
  }));
}

export async function swapStockToEth({ stockAddress, amount, account, walletClient, publicClient = client, minEthOut = 1n }) {
  assert(stockAddress && /^0x[0-9a-fA-F]{40}$/.test(stockAddress), 'Ungültige Stock-Adresse.');
  assert(amount > 0n, 'Tauschbetrag muss größer als 0 sein.');

  const permit2Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  const universalRouterAddress = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
  const usdgAddress = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  const nativeEth = '0x0000000000000000000000000000000000000000';

  // 1. Token allowance check for Permit2
  const currentAllowance = await publicClient.readContract({
    address: stockAddress,
    abi: erc20ExtendedAbi,
    functionName: 'allowance',
    args: [account.address, permit2Address],
  });
  if (currentAllowance < amount) {
    const approveHash = await walletClient.writeContract({
      address: stockAddress,
      abi: erc20ExtendedAbi,
      functionName: 'approve',
      args: [permit2Address, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  // 2. Permit2 allowance / nonce check
  const [, , nonce] = await publicClient.readContract({
    address: permit2Address,
    abi: permit2Abi,
    functionName: 'allowance',
    args: [account.address, stockAddress, universalRouterAddress],
  });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const permitData = {
    details: {
      token: stockAddress,
      amount: amount > (2n ** 160n - 1n) ? (2n ** 160n - 1n) : amount,
      expiration: Number(deadline),
      nonce: Number(nonce),
    },
    spender: universalRouterAddress,
    sigDeadline: deadline,
  };

  const signature = await account.signTypedData({
    domain: {
      name: 'Permit2',
      chainId: robinhoodChain.id,
      verifyingContract: permit2Address,
    },
    types: {
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
    primaryType: 'PermitSingle',
    message: permitData,
  });

  // 3. Multi-hop V4 Swap Calldata: Stock -> USDG -> Native ETH
  const path = [
    {
      intermediateCurrency: usdgAddress,
      fee: 8388608,
      tickSpacing: 60,
      hooks: '0xC15b155a3094934171A15625d1a80Aba267B6080',
      hookData: '0x',
    },
    {
      intermediateCurrency: nativeEth,
      fee: 500,
      tickSpacing: 10,
      hooks: nativeEth,
      hookData: '0x',
    }
  ];

  const exactInType = {
    type: 'tuple',
    components: [
      { name: 'currencyIn', type: 'address' },
      {
        name: 'path',
        type: 'tuple[]',
        components: [
          { name: 'intermediateCurrency', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
          { name: 'hookData', type: 'bytes' }
        ]
      },
      { name: 'maxHopSlippage', type: 'uint256[]' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' }
    ]
  };

  const p1 = encodeAbiParameters([exactInType], [{
    currencyIn: stockAddress,
    path,
    maxHopSlippage: [],
    amountIn: amount,
    amountOutMinimum: minEthOut,
  }]);

  const p2 = encodeAbiParameters(
    parseAbiParameters('address, uint256'),
    [stockAddress, amount]
  );

  const p3 = encodeAbiParameters(
    parseAbiParameters('address, uint256'),
    [nativeEth, minEthOut]
  );

  const swapActions = '0x070c0f'; // SWAP_EXACT_IN (7), SETTLE (12), TAKE (15)
  const swapInput = encodeAbiParameters(
    parseAbiParameters('bytes, bytes[]'),
    [swapActions, [p1, p2, p3]]
  );

  const permitSingleType = [
    {
      name: 'details',
      type: 'tuple',
      components: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ]
    },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' }
  ];

  const permitInput = encodeAbiParameters(
    [{ type: 'tuple', components: permitSingleType }, { type: 'bytes' }],
    [permitData, signature]
  );

  const commands = '0x0a10'; // PERMIT2_PERMIT (0x0a) + V4_SWAP (0x10)
  const inputs = [permitInput, swapInput];

  const ethBefore = await publicClient.getBalance({ address: account.address });
  const swapHash = await walletClient.writeContract({
    address: universalRouterAddress,
    abi: universalRouterAbi,
    functionName: 'execute',
    args: [commands, inputs, deadline],
  });
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
  const ethAfter = await publicClient.getBalance({ address: account.address });
  const ethDiff = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;

  return {
    swapHash,
    status: swapReceipt.status,
    ethReceived: formatEther(ethDiff),
  };
}

export async function executeClaimFees({ curve, privateKey, swapToEth = true, customClient = null, customWalletClient = null }) {
  assert(curve && /^0x[0-9a-fA-F]{40}$/.test(curve), 'Ungültige Curve-Adresse.');
  const account = privateKeyToAccount(privateKey);
  const pc = customClient || client;
  const wc = customWalletClient || createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(deployment.rpc, { timeout: 30_000, retryCount: 2 }),
  });

  const configAddress = await pc.readContract({
    address: deployment.factory,
    abi: vhooksAbi,
    functionName: 'config',
  });
  const [c] = await pc.readContract({
    address: configAddress,
    abi: vhooksConfigAbi,
    functionName: 'get',
  });
  const escrow = c.feeEscrow;

  const curveAbi = parseAbi([
    'function feeRecipient() view returns (address)',
    'function poolKey() view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
    'function token() view returns (address)'
  ]);

  const [poolKey] = await Promise.all([
    pc.readContract({ address: curve, abi: curveAbi, functionName: 'poolKey' }).catch(() => null),
  ]);
  const pairingCurrency = poolKey?.[0] || deployment.stocks.us.address;

  const escrowAbi = parseAbi([
    'function claim(address curve) returns (uint256 amount)'
  ]);

  const claimHash = await wc.writeContract({
    address: escrow,
    abi: escrowAbi,
    functionName: 'claim',
    args: [curve],
  });
  const receipt = await pc.waitForTransactionReceipt({ hash: claimHash });

  let swapResult = null;
  if (swapToEth && receipt.status === 'success') {
    const isWeth = pairingCurrency.toLowerCase() === deployment.stocks.eth.address.toLowerCase();
    const isNativeEth = pairingCurrency === '0x0000000000000000000000000000000000000000';

    if (isNativeEth) {
      swapResult = { swapped: false, reason: 'already_native_eth' };
    } else if (isWeth) {
      const wethBal = await pc.readContract({
        address: pairingCurrency,
        abi: wethWithdrawAbi,
        functionName: 'balanceOf',
        args: [account.address]
      });
      if (wethBal > 0n) {
        const unwrapHash = await wc.writeContract({
          address: pairingCurrency,
          abi: wethWithdrawAbi,
          functionName: 'withdraw',
          args: [wethBal],
        });
        await pc.waitForTransactionReceipt({ hash: unwrapHash });
        swapResult = { swapHash: unwrapHash, swapped: true, ethReceived: formatEther(wethBal) };
      }
    } else {
      // Stock token (SPCX, BABA, SKHY)
      const stockBal = await pc.readContract({
        address: pairingCurrency,
        abi: erc20ExtendedAbi,
        functionName: 'balanceOf',
        args: [account.address]
      });
      if (stockBal > 0n) {
        const swapRes = await swapStockToEth({
          stockAddress: pairingCurrency,
          amount: stockBal,
          account,
          walletClient: wc,
          publicClient: pc
        });
        swapResult = { ...swapRes, swapped: true, claimedStock: formatEther(stockBal) };
      }
    }
  }

  return { hash: claimHash, status: receipt.status, swapResult };
}
