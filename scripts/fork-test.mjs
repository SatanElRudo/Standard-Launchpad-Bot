import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  formatEther,
  encodeFunctionData,
  decodeEventLog,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createVault } from '../server/vault.mjs';
import { executeMultiSnipe, executeMultiSell, erc20Abi } from '../server/sniper.mjs';
import { deployment } from '../shared/deployment.mjs';
import signatures from '../shared/abi.json' with { type: 'json' };

const vhooksAbi = parseAbi(signatures.vhooks);
const vhooksConfigAbi = parseAbi(signatures.vhooksConfig);
const dropAbi = parseAbi([
  ...signatures.drop,
  ...signatures.legacy.filter(s => /^function (launchFee|pairAsset|curveOfToken)/.test(s)),
]);
const legacyAbi = parseAbi(signatures.legacy);

const standardErc20Abi = parseAbi([
  ...signatures.erc20,
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const ANVIL_PATHS = [
  process.env.ANVIL_PATH,
  'E:\\AI Projekte\\DegenNexus\\.tools\\foundry\\anvil.exe',
  'anvil',
].filter(Boolean);

function findAnvil() {
  for (const p of ANVIL_PATHS) {
    if (existsSync(p)) return p;
  }
  return 'anvil';
}

const FORK_PORT = 8547;
const FORK_RPC = `http://127.0.0.1:${FORK_PORT}`;
const REMOTE_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const SPCX_WHALE = '0x047829087f9AC81fDb05F7b750458aFE3d72415f';

async function getLatestBlock() {
  const res = await fetch(REMOTE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const data = await res.json();
  return parseInt(data.result, 16);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAnvil() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(FORK_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('Anvil fork did not start in time');
}

async function rpcCall(method, params = []) {
  const res = await fetch(FORK_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function runForkTest() {
  console.log('--- STARTING ROBINHOOD CHAIN FORK TEST WITH ANVIL ---');

  const originalRpc = deployment.rpc;
  deployment.rpc = FORK_RPC;

  const anvilBin = findAnvil();
  console.log(`Using Anvil binary: ${anvilBin}`);

  const blockNumber = await getLatestBlock();
  const forkBlock = blockNumber - 10;
  console.log(`Remote RPC block: ${blockNumber}, forking at: ${forkBlock}`);

  const anvilProcess = spawn(anvilBin, [
    '--fork-url', REMOTE_RPC,
    '--fork-block-number', forkBlock.toString(),
    '--port', FORK_PORT.toString(),
    '--chain-id', '4663',
    '--silent',
  ], { stdio: 'inherit' });

  try {
    await waitForAnvil();
    console.log(`Anvil fork ready and listening at ${FORK_RPC}`);

    const forkChain = {
      id: 4663,
      name: 'Robinhood Chain Fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [FORK_RPC] } },
    };

    const client = createPublicClient({
      chain: forkChain,
      transport: http(FORK_RPC),
    });

    // 1. Setup in-memory Vault & test wallets
    const store = { state: { vault: { initialized: false, salt: null, verifier: null, wallets: [] } }, save: () => {} };
    const vault = createVault({ store });
    vault.init('masterpass123');

    const deployer = vault.createWallet('Deployer Wallet');
    const sniperA = vault.createWallet('Sniper A (First / Lowest Entry)');
    const sniperB = vault.createWallet('Sniper B (Second)');
    const sniperC = vault.createWallet('Sniper C (Third)');

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Sniper A: ${sniperA.address}`);
    console.log(`Sniper B: ${sniperB.address}`);
    console.log(`Sniper C: ${sniperC.address}`);

    // 2. Fund test wallets with native ETH
    for (const w of [deployer, sniperA, sniperB, sniperC, { address: SPCX_WHALE }]) {
      await rpcCall('anvil_setBalance', [w.address, '0x8AC7230489E80000']); // 10 ETH
    }

    // 3. Fund Snipers with SPCX tokens from whale via impersonation
    console.log('Impersonating SPCX whale to fund sniper wallets...');
    await rpcCall('anvil_impersonateAccount', [SPCX_WHALE]);
    const whaleClient = createWalletClient({
      account: SPCX_WHALE,
      chain: forkChain,
      transport: http(FORK_RPC),
    });

    const spcxAddress = deployment.stocks.us.address;
    for (const sniper of [sniperA, sniperB, sniperC]) {
      const transferData = encodeFunctionData({
        abi: standardErc20Abi,
        functionName: 'transfer',
        args: [sniper.address, parseEther('15')], // 15 SPCX each
      });
      await whaleClient.sendTransaction({
        to: spcxAddress,
        data: transferData,
      });
    }
    await rpcCall('anvil_stopImpersonatingAccount', [SPCX_WHALE]);

    // Verify SPCX balances
    for (const sniper of [sniperA, sniperB, sniperC]) {
      const bal = await client.readContract({
        address: spcxAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [sniper.address],
      });
      assert.equal(bal, parseEther('15'), 'Sniper must have 15 SPCX');
    }
    console.log('✅ Sniper wallets successfully funded with 15 SPCX each.');

    // 4. Token Launch on Factory
    console.log('Executing live token launch on Standard Factory...');
    const deployerPk = vault.getPrivateKey(deployer.id);
    const deployerAccount = privateKeyToAccount(deployerPk);
    const deployerClient = createWalletClient({
      account: deployerAccount,
      chain: forkChain,
      transport: http(FORK_RPC),
    });

    let version = 'vhooks';
    let launchFee = 500000000000000n;
    let factoryAbi = vhooksAbi;
    try {
      const cfgAddr = await client.readContract({
        address: deployment.factory,
        abi: vhooksAbi,
        functionName: 'config',
      });
      const [c] = await client.readContract({
        address: cfgAddr,
        abi: vhooksConfigAbi,
        functionName: 'get',
      });
      launchFee = c.launchFee;
      version = 'vhooks';
      factoryAbi = vhooksAbi;
    } catch {
      try {
        await client.readContract({ address: deployment.factory, abi: dropAbi, functionName: 'charterDrop' });
        version = 'drop';
        factoryAbi = dropAbi;
      } catch {
        version = 'legacy';
        factoryAbi = legacyAbi;
      }
      launchFee = await client.readContract({
        address: deployment.factory,
        abi: legacyAbi,
        functionName: 'launchFee',
      });
    }
    console.log(`Standard Factory version: ${version}, launch fee: ${formatEther(launchFee)} ETH`);

    const zero = '0x0000000000000000000000000000000000000000';
    let launchParams;
    if (version === 'vhooks') {
      launchParams = {
        stock: spcxAddress,
        name: 'Fork Test Token',
        symbol: 'FTK',
        metadataURI: deployment.metadataDefault.uri,
        snipeTaxOn: true,
        referrer: zero,
        charterDropBps: 0,
        dropMode: 0,
        module: zero,
        enforced: false,
      };
    } else if (version === 'drop') {
      launchParams = {
        stock: spcxAddress,
        name: 'Fork Test Token',
        symbol: 'FTK',
        metadataURI: deployment.metadataDefault.uri,
        creatorTaxBps: 0,
        snipeTaxOn: true,
        referrer: zero,
        charterDropBps: 0,
      };
    } else {
      launchParams = {
        stock: spcxAddress,
        name: 'Fork Test Token',
        symbol: 'FTK',
        metadataURI: deployment.metadataDefault.uri,
        creatorTaxBps: 0,
        snipeTaxOn: true,
        referrer: zero,
      };
    }
    const buyParams = {
      payAsset: zero,
      amountIn: 0n,
      minStockOut: 0n,
      minTokensOut: 0n,
    };

    const launchData = encodeFunctionData({
      abi: factoryAbi,
      functionName: 'launch',
      args: [launchParams, buyParams],
    });

    const launchTxHash = await deployerClient.sendTransaction({
      to: deployment.factory,
      data: launchData,
      value: launchFee,
      gas: 2_500_000n,
    });
    console.log(`Launch TX broadcast: ${launchTxHash}`);

    const launchReceipt = await client.waitForTransactionReceipt({ hash: launchTxHash });
    assert.equal(launchReceipt.status, 'success', 'Launch transaction must succeed');

    let launchedToken = null;
    let launchedCurve = null;
    const candidateAbis = [vhooksAbi, dropAbi, legacyAbi];
    for (const log of launchReceipt.logs) {
      for (const abi of candidateAbis) {
        try {
          const decoded = decodeEventLog({
            abi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'Launched') {
            launchedToken = decoded.args.token;
            launchedCurve = decoded.args.curve;
            break;
          }
        } catch {}
      }
      if (launchedToken) break;
    }

    assert.ok(launchedToken, 'Launched event must provide token address');
    assert.ok(launchedCurve, 'Launched event must provide curve address');
    console.log(`✅ Token successfully launched on fork!`);
    console.log(`   Token: ${launchedToken}`);
    console.log(`   Curve: ${launchedCurve}`);

    // 5. Execute Multi-Snipe Buy (Sniper A, B, C)
    console.log('\nExecuting Multi-Snipe buy on the fresh bonding curve...');
    const snipeOrders = [
      { walletId: sniperA.id, amount: '0,05' }, // 0.05 SPCX (comma decimal test)
      { walletId: sniperB.id, amount: '0.1' },  // 0.1 SPCX
      { walletId: sniperC.id, amount: '0.2' },  // 0.2 SPCX
    ];

    const snipeResults = await executeMultiSnipe({
      curve: launchedCurve,
      token: launchedToken,
      country: 'us',
      snipeOrders,
      vault,
      antiFrontrun: true,
      maxSlippagePct: 5.0,
      customClient: client,
    });

    console.log('Snipe results:', snipeResults);
    assert.equal(snipeResults.length, 3);
    for (const r of snipeResults) {
      const receipt = await client.getTransactionReceipt({ hash: r.hash });
      console.log(`Receipt for ${r.label} (TX ${r.hash}): status = ${receipt.status}, gasUsed = ${receipt.gasUsed}`);
      if (receipt.status === 'reverted') {
        // Trace or call to see revert reason
        try {
          const tx = await client.getTransaction({ hash: r.hash });
          await client.call({ ...tx, blockNumber: receipt.blockNumber - 1n });
        } catch (err) {
          console.error(`Revert reason for ${r.label}:`, err.message);
        }
      }
      assert.equal(r.status, 'success', `Snipe order for ${r.label} must succeed: ${r.error || ''}`);
      assert.ok(r.hash, 'Must have transaction hash');
    }

    // Check token balances
    const balTokenA = await client.readContract({ address: launchedToken, abi: erc20Abi, functionName: 'balanceOf', args: [sniperA.address] });
    const balTokenB = await client.readContract({ address: launchedToken, abi: erc20Abi, functionName: 'balanceOf', args: [sniperB.address] });
    const balTokenC = await client.readContract({ address: launchedToken, abi: erc20Abi, functionName: 'balanceOf', args: [sniperC.address] });

    console.log(`Tokens received - Sniper A: ${formatEther(balTokenA)} FTK`);
    console.log(`Tokens received - Sniper B: ${formatEther(balTokenB)} FTK`);
    console.log(`Tokens received - Sniper C: ${formatEther(balTokenC)} FTK`);

    assert.ok(balTokenA > 0n, 'Sniper A must have token balance');
    assert.ok(balTokenB > 0n, 'Sniper B must have token balance');
    assert.ok(balTokenC > 0n, 'Sniper C must have token balance');
    console.log('✅ All 3 snipers bought tokens successfully on-chain!');

    // 6. Test Auto-Exit in N-1 Mode (Leave Cheapest Entry / Moonbag)
    console.log('\n--- Testing Auto-Exit: N-1 Mode (Leave cheapest entry as Moonbag) ---');
    const multiSellResultsNMinus1 = await executeMultiSell({
      curve: launchedCurve,
      token: launchedToken,
      country: 'us',
      purchases: snipeResults,
      autoSellMode: 'n_minus_1',
      vault,
      customClient: client,
    });

    console.log('N-1 Sell results:', multiSellResultsNMinus1);
    assert.equal(multiSellResultsNMinus1.length, 3);

    // Sniper A (first buyer) must be kept as moonbag!
    const resA = multiSellResultsNMinus1.find(r => r.walletId === sniperA.id);
    assert.equal(resA.status, 'kept_best_entry', 'Sniper A must be kept as moonbag');

    // Sniper B and Sniper C must have successfully sold!
    const resB = multiSellResultsNMinus1.find(r => r.walletId === sniperB.id);
    const resC = multiSellResultsNMinus1.find(r => r.walletId === sniperC.id);
    assert.equal(resB.status, 'success', `Sniper B sell must succeed: ${resB.error || ''}`);
    assert.equal(resC.status, 'success', `Sniper C sell must succeed: ${resC.error || ''}`);

    // Check on-chain balances after N-1 sell
    const balTokenA_after = await client.readContract({ address: launchedToken, abi: erc20Abi, functionName: 'balanceOf', args: [sniperA.address] });
    const balTokenB_after = await client.readContract({ address: launchedToken, abi: erc20Abi, functionName: 'balanceOf', args: [sniperB.address] });
    const balTokenC_after = await client.readContract({ address: launchedToken, abi: erc20Abi, functionName: 'balanceOf', args: [sniperC.address] });

    assert.equal(balTokenA_after, balTokenA, 'Sniper A token balance must remain untouched (Moonbag)');
    assert.equal(balTokenB_after, 0n, 'Sniper B must have sold 100% of tokens');
    assert.equal(balTokenC_after, 0n, 'Sniper C must have sold 100% of tokens');

    const balSpcxB = await client.readContract({ address: spcxAddress, abi: erc20Abi, functionName: 'balanceOf', args: [sniperB.address] });
    const balSpcxC = await client.readContract({ address: spcxAddress, abi: erc20Abi, functionName: 'balanceOf', args: [sniperC.address] });
    console.log(`Sniper B SPCX balance after sell: ${formatEther(balSpcxB)} SPCX`);
    console.log(`Sniper C SPCX balance after sell: ${formatEther(balSpcxC)} SPCX`);
    assert.ok(balSpcxB > parseEther('12'), 'Sniper B received SPCX payout from sell');
    assert.ok(balSpcxC > parseEther('11'), 'Sniper C received SPCX payout from sell');
    console.log('✅ N-1 Auto-Exit successfully verified on fork!');

    // 7. Test Auto-Exit in 100% ("all") Mode for Sniper A
    console.log('\n--- Testing Auto-Exit: 100% ("all") Mode for remaining wallet ---');
    const multiSellResultsAll = await executeMultiSell({
      curve: launchedCurve,
      token: launchedToken,
      country: 'us',
      purchases: [snipeResults[0]], // Sniper A
      autoSellMode: 'all',
      vault,
      customClient: client,
    });

    console.log('All-Sell result for Sniper A:', multiSellResultsAll);
    assert.equal(multiSellResultsAll.length, 1);
    assert.equal(multiSellResultsAll[0].status, 'success');

    const balTokenA_final = await client.readContract({ address: launchedToken, abi: erc20Abi, functionName: 'balanceOf', args: [sniperA.address] });
    assert.equal(balTokenA_final, 0n, 'Sniper A must have sold 100% of tokens in all mode');
    const balSpcxA = await client.readContract({ address: spcxAddress, abi: erc20Abi, functionName: 'balanceOf', args: [sniperA.address] });
    console.log(`Sniper A final SPCX balance: ${formatEther(balSpcxA)} SPCX`);
    assert.ok(balSpcxA > parseEther('13'), 'Sniper A received SPCX payout');
    console.log('✅ 100% Auto-Exit successfully verified on fork!');

    console.log('\n🎉 ALL FORK TESTS PASSED SUCCESSFULLY! REAL FACTORY LAUNCH, MULTI-SNIPE BUY & AUTO-EXIT CONFIRMED ON FORK.');
  } finally {
    deployment.rpc = originalRpc;
    console.log('Stopping Anvil fork process...');
    anvilProcess.kill();
  }
}

runForkTest().catch(err => {
  console.error('❌ FORK TEST FAILED:', err);
  process.exit(1);
});
