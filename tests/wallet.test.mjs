import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletSession } from '../web/wallet-session.mjs';
const address = '0x1111111111111111111111111111111111111111';
function provider({ chain = '0x1', missing = false, reject = false } = {}) {
  const events = new Map(), calls = []; let account = address;
  return {
    calls,
    on(event, fn) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(fn); },
    removeListener(event, fn) { events.get(event)?.delete(fn); },
    emit(event, value) { if (event === 'accountsChanged') account = value[0]; if (event === 'chainChanged') chain = value; events.get(event)?.forEach(fn => fn(value)); },
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return account ? [account] : [];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_addEthereumChain') { missing = false; return null; }
      if (method === 'wallet_switchEthereumChain') {
        if (reject) throw Object.assign(new Error('Rejected'), { code: 4001 });
        if (missing) throw Object.assign(new Error('Unknown chain'), { code: 4902 });
        this.emit('chainChanged', params[0].chainId); return null;
      }
      throw new Error(`Unexpected ${method}`);
    },
  };
}
test('chainChanged preserves authorized account and invalidates revision', async () => {
  const p = provider(), snapshots = [], session = createWalletSession(s => snapshots.push(s));
  session.select(p); await session.connect(); const before = session.snapshot().revision;
  p.emit('chainChanged', '0x1237');
  assert.equal(session.snapshot().account, address); assert.equal(session.snapshot().chainId, 4663);
  assert.ok(session.snapshot().revision > before);
  assert.equal(snapshots.at(-1).account, address);
  p.emit('accountsChanged', []); assert.equal(session.snapshot().account, null);
});
test('unknown chain is added then switched; no transaction or second permission request', async () => {
  const p = provider({ missing: true }), session = createWalletSession(() => {});
  session.select(p); await session.connect(); await session.ensureChain();
  assert.equal(session.snapshot().chainId, 4663); assert.equal(session.snapshot().account, address);
  const add = p.calls.find(c => c.method === 'wallet_addEthereumChain');
  assert.equal(add.params[0].chainId, '0x1237'); assert.equal(add.params[0].nativeCurrency.symbol, 'ETH');
  assert.equal(p.calls.filter(c => c.method === 'eth_requestAccounts').length, 1);
  assert.equal(p.calls.filter(c => c.method === 'eth_sendTransaction').length, 0);
});
test('rejected network switch keeps wallet connected and cannot continue', async () => {
  const p = provider({ reject: true }), session = createWalletSession(() => {});
  session.select(p); await session.connect(); await assert.rejects(session.ensureChain(), /Rejected/);
  assert.equal(session.snapshot().account, address); assert.equal(session.snapshot().chainId, 1);
});
test('old provider events cannot overwrite selected provider', async () => {
  const old = provider(), current = provider({ chain: '0x1237' }), session = createWalletSession(() => {});
  session.select(old); await session.connect(); session.select(current); await session.connect();
  old.emit('disconnect'); old.emit('accountsChanged', []);
  assert.equal(session.snapshot().account, address); assert.equal(session.snapshot().provider, current);
});
