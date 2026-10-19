import { deployment } from '../shared/deployment.mjs';

export function createWalletSession(onChange) {
  let provider = null, account = null, chainId = null, revision = 0, detach = () => {};
  const snapshot = () => ({ provider, account, chainId, revision });
  const changed = reason => { revision++; onChange(snapshot(), reason); };
  function select(next) {
    if (next === provider) return;
    detach(); provider = next; account = null; chainId = null;
    const active = provider;
    const accountsChanged = accounts => {
      if (provider !== active) return;
      account = accounts[0] ?? null; changed('accounts');
    };
    const chainChanged = chain => {
      if (provider !== active) return;
      chainId = Number(chain); changed('chain'); // Account authorization survives a chain switch.
    };
    const disconnect = () => {
      if (provider !== active) return;
      account = null; chainId = null; changed('disconnect');
    };
    for (const [event, fn] of [['accountsChanged', accountsChanged], ['chainChanged', chainChanged], ['disconnect', disconnect]]) active?.on?.(event, fn);
    detach = () => {
      for (const [event, fn] of [['accountsChanged', accountsChanged], ['chainChanged', chainChanged], ['disconnect', disconnect]]) active?.removeListener?.(event, fn);
    };
    changed('provider');
  }
  async function connect(silent = false) {
    const active = provider;
    if (!active) throw new Error('Keine Browser-Wallet erkannt. Bitte einen Browser mit EVM-Wallet-Erweiterung verwenden.');
    const accounts = await active.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
    const chain = await active.request({ method: 'eth_chainId' });
    if (provider !== active) throw new Error('Wallet-Anbieter wurde während der Verbindung geändert.');
    account = accounts[0] ?? null; chainId = Number(chain); changed('connect');
    if (!silent && !account) throw new Error('Keine Wallet-Adresse freigegeben.');
    return snapshot();
  }
  async function ensureChain() {
    const active = provider;
    if (!active || !account) throw new Error('Zuerst eine Browser-Wallet verbinden.');
    const target = `0x${deployment.chainId.toString(16)}`;
    const chain = await active.request({ method: 'eth_chainId' });
    if (provider !== active) throw new Error('Wallet-Anbieter wurde geändert.');
    if (Number(chain) !== deployment.chainId) {
      try { await active.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] }); }
      catch (error) {
        const code = Number(error.code ?? error.data?.originalError?.code);
        if (code !== 4902) throw error;
        await active.request({ method: 'wallet_addEthereumChain', params: [{ chainId: target, chainName: deployment.name,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [deployment.rpc], blockExplorerUrls: [deployment.explorer] }] });
        await active.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
      }
    }
    if (provider !== active) throw new Error('Wallet-Anbieter wurde geändert.');
    await connect(true);
    if (!account || chainId !== deployment.chainId) throw new Error('Netzwerkwechsel nicht bestätigt. Bitte die Wallet prüfen.');
    return snapshot();
  }
  return { snapshot, select, connect, ensureChain };
}
