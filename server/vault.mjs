import { scryptSync, randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assert, address, text } from './validation.mjs';

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const VERIFIER_PAYLOAD = 'standard-vault-verifier-v1';
const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;

function deriveKey(password, salt) {
  return scryptSync(password, salt, 32, SCRYPT_OPTIONS);
}

function encrypt(plainText, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let ciphertext = cipher.update(plainText, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { iv: iv.toString('hex'), tag, ciphertext };
}

function decrypt({ iv, tag, ciphertext }, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let plain = decipher.update(ciphertext, 'hex', 'utf8');
  plain += decipher.final('utf8');
  return plain;
}

export function createVault({ store, autoLockMs = DEFAULT_AUTO_LOCK_MS } = {}) {
  const state = store.state;
  state.vault ??= {
    initialized: false,
    salt: null,
    verifier: null,
    wallets: [],
  };

  let unlockedKey = null;
  let autoLockTimer = null;

  function resetAutoLock() {
    if (autoLockTimer) clearTimeout(autoLockTimer);
    if (unlockedKey && autoLockMs > 0) {
      autoLockTimer = setTimeout(() => lock(), autoLockMs);
      if (typeof autoLockTimer.unref === 'function') autoLockTimer.unref();
    }
  }

  function lock() {
    unlockedKey = null;
    if (autoLockTimer) {
      clearTimeout(autoLockTimer);
      autoLockTimer = null;
    }
  }

  function isInitialized() {
    return Boolean(state.vault.initialized && state.vault.salt && state.vault.verifier);
  }

  function isUnlocked() {
    return Boolean(unlockedKey);
  }

  function init(masterPassword) {
    assert(!isInitialized(), 'Der Tresor ist bereits initialisiert.');
    assert(typeof masterPassword === 'string' && masterPassword.length >= 8, 'Das Master-Passwort muss mindestens 8 Zeichen lang sein.');
    const salt = randomBytes(16).toString('hex');
    const key = deriveKey(masterPassword, Buffer.from(salt, 'hex'));
    const verifier = encrypt(VERIFIER_PAYLOAD, key);
    state.vault.initialized = true;
    state.vault.salt = salt;
    state.vault.verifier = verifier;
    state.vault.wallets = [];
    store.save();
    unlockedKey = key;
    resetAutoLock();
    return { initialized: true, unlocked: true };
  }

  function unlock(masterPassword) {
    assert(isInitialized(), 'Der Tresor wurde noch nicht initialisiert.');
    assert(typeof masterPassword === 'string' && masterPassword.length > 0, 'Passwort fehlt.');
    const salt = Buffer.from(state.vault.salt, 'hex');
    const key = deriveKey(masterPassword, salt);
    try {
      const verified = decrypt(state.vault.verifier, key);
      assert(verified === VERIFIER_PAYLOAD, 'Falsches Master-Passwort.');
    } catch {
      assert(false, 'Falsches Master-Passwort.');
    }
    unlockedKey = key;
    resetAutoLock();
    return { unlocked: true };
  }

  function getWallets() {
    return state.vault.wallets.map(w => ({
      id: w.id,
      label: w.label,
      address: w.address,
      createdAt: w.createdAt,
    }));
  }

  function findWallet(query) {
    if (!query) return null;
    const lower = String(query).toLowerCase().trim();
    return state.vault.wallets.find(w =>
      w.id === query ||
      w.address.toLowerCase() === lower ||
      w.label.toLowerCase() === lower
    ) || null;
  }

  function createWallet(label) {
    assert(isUnlocked(), 'Tresor ist gesperrt. Bitte zuerst mit dem Master-Passwort entsperren.');
    assert(state.vault.wallets.length < 100, 'Maximal 100 Wallets im Tresor erlaubt.');
    const lbl = text(label, 60, 'Wallet-Name');
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    assert(!state.vault.wallets.some(w => w.address.toLowerCase() === account.address.toLowerCase()), 'Diese Adresse existiert bereits im Tresor.');
    const encrypted = encrypt(privateKey, unlockedKey);
    const wallet = {
      id: randomUUID(),
      label: lbl,
      address: account.address,
      ...encrypted,
      createdAt: Date.now(),
    };
    state.vault.wallets.push(wallet);
    store.save();
    resetAutoLock();
    return { id: wallet.id, label: wallet.label, address: wallet.address, createdAt: wallet.createdAt };
  }

  function importWallet(label, privateKeyInput) {
    assert(isUnlocked(), 'Tresor ist gesperrt. Bitte zuerst mit dem Master-Passwort entsperren.');
    assert(state.vault.wallets.length < 100, 'Maximal 100 Wallets im Tresor erlaubt.');
    const lbl = text(label, 60, 'Wallet-Name');
    let pk = String(privateKeyInput ?? '').trim();
    if (!pk.startsWith('0x') && !pk.startsWith('0X')) pk = `0x${pk}`;
    assert(/^0x[0-9a-fA-F]{64}$/.test(pk), 'Ungültiger Private Key. Es werden 64 Hex-Zeichen erwartet.');
    let account;
    try {
      account = privateKeyToAccount(pk);
    } catch {
      assert(false, 'Ungültiger Private Key.');
    }
    assert(!state.vault.wallets.some(w => w.address.toLowerCase() === account.address.toLowerCase()), 'Diese Wallet ist bereits im Tresor gespeichert.');
    const encrypted = encrypt(pk, unlockedKey);
    const wallet = {
      id: randomUUID(),
      label: lbl,
      address: account.address,
      ...encrypted,
      createdAt: Date.now(),
    };
    state.vault.wallets.push(wallet);
    store.save();
    resetAutoLock();
    return { id: wallet.id, label: wallet.label, address: wallet.address, createdAt: wallet.createdAt };
  }

  function getPrivateKey(idOrAddress) {
    assert(isUnlocked(), 'Tresor ist gesperrt. Bitte zuerst mit dem Master-Passwort entsperren.');
    const wallet = findWallet(idOrAddress);
    assert(wallet, 'Wallet nicht im Tresor gefunden.');
    resetAutoLock();
    return decrypt(wallet, unlockedKey);
  }

  function exportWallet(id, masterPassword) {
    assert(isInitialized(), 'Tresor nicht initialisiert.');
    const wallet = state.vault.wallets.find(w => w.id === id);
    assert(wallet, 'Wallet nicht gefunden.');
    const salt = Buffer.from(state.vault.salt, 'hex');
    const key = deriveKey(masterPassword, salt);
    try {
      const verified = decrypt(state.vault.verifier, key);
      assert(verified === VERIFIER_PAYLOAD, 'Falsches Master-Passwort.');
    } catch {
      assert(false, 'Falsches Master-Passwort.');
    }
    const privateKey = decrypt(wallet, key);
    return { id: wallet.id, label: wallet.label, address: wallet.address, privateKey };
  }

  function deleteWallet(id) {
    assert(isUnlocked(), 'Tresor ist gesperrt.');
    const index = state.vault.wallets.findIndex(w => w.id === id);
    assert(index >= 0, 'Wallet nicht gefunden.');
    state.vault.wallets.splice(index, 1);
    store.save();
    resetAutoLock();
    return { ok: true };
  }

  function status() {
    return {
      initialized: isInitialized(),
      unlocked: isUnlocked(),
      walletCount: state.vault.wallets?.length ?? 0,
      autoLockMinutes: Math.round(autoLockMs / 60000),
    };
  }

  return {
    isInitialized,
    isUnlocked,
    init,
    unlock,
    lock,
    status,
    getWallets,
    findWallet,
    createWallet,
    importWallet,
    getPrivateKey,
    exportWallet,
    deleteWallet,
    close: () => lock(),
  };
}
